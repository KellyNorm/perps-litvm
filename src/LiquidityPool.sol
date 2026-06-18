// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @notice Minimal view surface the {LiquidityPool} reads from the trusted
 *         {PositionManager} to value LP shares and gate withdrawals. Kept
 *         intentionally tiny so the pool depends on as little of the perp
 *         engine as possible.
 */
interface IPositionManager {
    /// @return Traders' aggregate *unrealized profit* (asset units), i.e. the
    ///         pool's contingent liability to currently-winning traders.
    function totalUnrealizedProfit() external view returns (uint256);

    /// @return Liquidity (asset units) the pool has reserved to guarantee it can
    ///         honour the capped max payout of every open position.
    function totalReserved() external view returns (uint256);
}

/**
 * @title LiquidityPool
 * @notice GLP-style liquidity pool for the perps DEX. Liquidity providers
 *         deposit a single ERC20 collateral asset and receive LP shares (the
 *         "LP token") in return; burning shares withdraws a proportional amount
 *         of the underlying assets. The pool is the counterparty to all
 *         traders.
 *
 * @dev    Implemented as an ERC-4626 tokenized vault on top of OpenZeppelin's
 *         audited {ERC4626} and {ReentrancyGuard}. We deliberately do NOT roll
 *         our own share math: deposit/withdraw conversions use OZ's built-in
 *         virtual-shares accounting, hardened further by a non-zero
 *         {_decimalsOffset}. This is the standard, audited mitigation for the
 *         ERC-4626 inflation / donation attack — see the OZ ERC4626 NatSpec.
 *
 *         Design constraints (per project constitution):
 *         - Minimal admin: there is no owner, no pause, and no parameter setter.
 *           The single privileged action is {setPositionManager}, a one-shot
 *           link callable only by the deployer exactly once (see below). After
 *           it is set there are no further privileged powers.
 *         - Not upgradeable: no proxy, no upgrade hooks; the asset is
 *           `immutable` via the ERC4626 base, and {deployer} is `immutable`.
 *         - Reentrancy-guarded: every fund-moving entry point is `nonReentrant`.
 *
 *         TRADER P&L (PR-3): the pool is the trader counterparty. Two trusted
 *         entry points — {payProfit} and {receiveLoss} — let the linked
 *         {PositionManager} move LP capital when a position closes (the pool
 *         pays a winning trader's capped profit, or absorbs a losing trader's
 *         loss as LP gain). Trader *collateral* is held by the PositionManager,
 *         never here, so it is never counted as LP NAV.
 *
 *         SHARE PRICING WHILE TRADES ARE OPEN: {totalAssets} = pool balance −
 *         the PositionManager's cached aggregate unrealized trader profit
 *         (`cachedU`). The cache is refreshed only when a position opens or
 *         closes (those calls carry a fresh signed price); it is NOT refreshed
 *         on LP deposit/withdraw. Consequence: between trades the mark can drift
 *         from the live price, so an LP entering/exiting mid-move transacts
 *         against a slightly stale share price. This is a pure LP-FAIRNESS gap,
 *         not a solvency risk — solvency is guaranteed independently by the
 *         reserved-liquidity accounting below. Closing that fairness gap
 *         (payload-aware LP deposit/withdraw) is deferred to its own PR; see
 *         TASK.md "PR: payload-aware LP pricing".
 *
 *         SOLVENCY: on open, the PositionManager reserves each position's capped
 *         max payout. {freeAssets} = pool balance − total reserved, and
 *         withdrawals are capped to it via {maxWithdraw}/{maxRedeem}. The pool
 *         therefore can always cover every open position's worst-case payout
 *         regardless of how stale the share-price cache is.
 */
contract LiquidityPool is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /**
     * @dev Decimal offset between the vault shares and the underlying asset.
     *      A non-zero offset scales up the virtual shares used in OZ's share
     *      math, making the inflation/donation attack orders of magnitude more
     *      expensive than it could ever be profitable, while keeping the
     *      initial 1:1 (asset:share, modulo offset) exchange rate intuitive.
     */
    uint8 private constant _DECIMALS_OFFSET = 6;

    /// @notice Deployer address captured at construction; the only account
    ///         permitted to perform the one-shot {setPositionManager} link.
    address public immutable deployer;

    /// @notice The trusted perp engine allowed to call {payProfit} and
    ///         {receiveLoss}, and whose accounting drives {totalAssets} and
    ///         {freeAssets}. Set exactly once via {setPositionManager}.
    address public positionManager;

    /**
     * @dev Reverts a deposit/mint/withdraw/redeem whose asset or share amount
     *      resolves to zero. This blocks no-op spam and, more importantly,
     *      rejects dust deposits that would round down to zero shares (which
     *      would silently donate the depositor's assets to the pool).
     */
    error ZeroAmount();

    /// @dev Caller of a trusted settlement function is not the PositionManager.
    error NotPositionManager();

    /// @dev {setPositionManager} called by an account other than the deployer.
    error NotDeployer();

    /// @dev {setPositionManager} called more than once.
    error PositionManagerAlreadySet();

    /// @dev {setPositionManager} called with the zero address.
    error ZeroAddress();

    /// @notice Emitted once when the PositionManager is linked.
    event PositionManagerSet(address indexed positionManager);

    /// @notice Emitted when the pool pays a winning trader's profit.
    event ProfitPaid(address indexed to, uint256 amount);

    /// @notice Emitted when the pool absorbs a losing trader's loss.
    event LossAbsorbed(uint256 amount);

    /// @dev Restricts a function to the linked PositionManager.
    modifier onlyPositionManager() {
        if (msg.sender != positionManager) revert NotPositionManager();
        _;
    }

    /**
     * @param asset_  The ERC20 collateral asset LPs deposit (e.g. Mock USD on
     *                testnet). Stored immutably by the ERC4626 base.
     * @param name_   Name of the LP share token (e.g. "Perps LP").
     * @param symbol_ Symbol of the LP share token (e.g. "pLP").
     */
    constructor(IERC20 asset_, string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC4626(asset_) {
        deployer = msg.sender;
    }

    /**
     * @notice One-shot link of the trusted {PositionManager}. Callable only by
     *         the deployer and only while unset. There is no unset/relink path:
     *         once linked, the engine is fixed for the life of the pool.
     * @dev    Resolves the pool<->PositionManager constructor cycle without a
     *         standing admin power. This is the pool's ONLY privileged function.
     * @param  positionManager_ Address of the deployed PositionManager.
     */
    function setPositionManager(address positionManager_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (positionManager != address(0)) revert PositionManagerAlreadySet();
        if (positionManager_ == address(0)) revert ZeroAddress();
        positionManager = positionManager_;
        emit PositionManagerSet(positionManager_);
    }

    /**
     * @inheritdoc ERC4626
     * @dev Returns the configured decimal offset that powers OZ's virtual-share
     *      donation-attack mitigation.
     */
    function _decimalsOffset() internal pure override returns (uint8) {
        return _DECIMALS_OFFSET;
    }

    // --- LP share valuation ---------------------------------------------

    /**
     * @inheritdoc ERC4626
     * @dev Net asset value backing the LP shares = the pool's collateral balance
     *      minus the PositionManager's cached aggregate unrealized trader profit
     *      (the pool's contingent liability to currently-winning traders).
     *      Losing traders are NOT credited as assets until their loss is
     *      realized on close — a deliberately conservative stance for LPs.
     *      Before the PositionManager is linked, NAV is just the balance.
     *      Clamped at zero for safety; reserved-liquidity accounting keeps the
     *      cached liability strictly below the balance in practice.
     */
    function totalAssets() public view override returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        address pm = positionManager;
        if (pm == address(0)) return balance;
        uint256 unrealizedProfit = IPositionManager(pm).totalUnrealizedProfit();
        return unrealizedProfit >= balance ? 0 : balance - unrealizedProfit;
    }

    /**
     * @notice Assets currently free to be withdrawn by LPs: the pool balance
     *         minus liquidity reserved against open positions' capped payouts.
     * @dev    This is the solvency backstop: reserved funds cannot be withdrawn,
     *         so the pool can always honour every open position's worst case.
     */
    function freeAssets() public view returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        address pm = positionManager;
        if (pm == address(0)) return balance;
        uint256 reserved = IPositionManager(pm).totalReserved();
        return reserved >= balance ? 0 : balance - reserved;
    }

    /**
     * @inheritdoc ERC4626
     * @dev Caps a holder's withdrawable assets to the pool's {freeAssets} so a
     *      withdrawal can never dip into liquidity reserved for open positions.
     */
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 byShares = super.maxWithdraw(owner);
        uint256 free = freeAssets();
        return byShares < free ? byShares : free;
    }

    /**
     * @inheritdoc ERC4626
     * @dev Mirror of {maxWithdraw} for share-denominated redemptions: caps to
     *      the share-equivalent of {freeAssets}.
     */
    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 byShares = super.maxRedeem(owner);
        uint256 freeInShares = _convertToShares(freeAssets(), Math.Rounding.Floor);
        return byShares < freeInShares ? byShares : freeInShares;
    }

    // --- trader settlement (PositionManager only) ------------------------

    /**
     * @notice Pay a winning trader's (already capped) profit out of LP capital.
     * @dev    Only the PositionManager may call. The PositionManager is
     *         responsible for enforcing the per-position profit cap before
     *         calling; the reserved-liquidity invariant guarantees the balance
     *         can cover it. CEI: the transfer is the sole external interaction;
     *         `nonReentrant` hardens the money path.
     * @param  to     Recipient (the trader closing in profit).
     * @param  amount Profit to pay, in asset units.
     */
    function payProfit(address to, uint256 amount) external onlyPositionManager nonReentrant {
        if (amount == 0) revert ZeroAmount();
        emit ProfitPaid(to, amount);
        IERC20(asset()).safeTransfer(to, amount);
    }

    /**
     * @notice Absorb a losing trader's (already capped) loss into LP capital.
     * @dev    Only the PositionManager may call. Pulls `amount` from the
     *         PositionManager (which holds trader collateral and pre-approves
     *         the pool). The inflow simply raises {totalAssets}, accruing the
     *         loss to LPs. `nonReentrant` hardens the money path.
     * @param  amount Loss to absorb, in asset units.
     */
    function receiveLoss(uint256 amount) external onlyPositionManager nonReentrant {
        if (amount == 0) revert ZeroAmount();
        emit LossAbsorbed(amount);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }

    // --- LP deposit / withdraw -------------------------------------------

    /**
     * @dev Reentrancy-guarded override of the shared deposit/mint workflow.
     *      Guarding the internal `_deposit` covers both {deposit} and {mint}
     *      with a single guard, exactly as OZ recommends for overriding the
     *      deposit mechanism. Effects (mint) precede the only external
     *      interaction within OZ's flow; the guard adds defense-in-depth for
     *      the money path.
     */
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override nonReentrant {
        if (assets == 0 || shares == 0) revert ZeroAmount();
        super._deposit(caller, receiver, assets, shares);
    }

    /**
     * @dev Reentrancy-guarded override of the shared withdraw/redeem workflow.
     *      Guarding the internal `_withdraw` covers both {withdraw} and
     *      {redeem} with a single guard. Shares are burned before assets are
     *      transferred out (checks-effects-interactions); the guard hardens the
     *      money path against any reentrant withdrawal.
     */
    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        if (assets == 0 || shares == 0) revert ZeroAmount();
        super._withdraw(caller, receiver, owner, assets, shares);
    }
}
