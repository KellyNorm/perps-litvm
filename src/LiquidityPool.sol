// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
 *         - No admin powers: there is no owner, no pause, no parameter setter,
 *           and no privileged mint/burn. The only ways assets move are LP
 *           deposits and withdrawals.
 *         - Not upgradeable: no proxy, no upgrade hooks; the asset is
 *           `immutable` via the ERC4626 base.
 *         - Reentrancy-guarded: every fund-moving entry point is `nonReentrant`.
 *
 *         TRADER P&L: this PR implements LP accounting only. In a later PR the
 *         pool will gain trader-P&L hooks so that {totalAssets} reflects open
 *         positions' unrealized profit/loss (i.e. the pool's true net asset
 *         value as the trader counterparty). Those hooks are intentionally NOT
 *         added here. Until then, {totalAssets} is simply the pool's collateral
 *         balance.
 */
contract LiquidityPool is ERC4626, ReentrancyGuard {
    /**
     * @dev Decimal offset between the vault shares and the underlying asset.
     *      A non-zero offset scales up the virtual shares used in OZ's share
     *      math, making the inflation/donation attack orders of magnitude more
     *      expensive than it could ever be profitable, while keeping the
     *      initial 1:1 (asset:share, modulo offset) exchange rate intuitive.
     */
    uint8 private constant _DECIMALS_OFFSET = 6;

    /**
     * @dev Reverts a deposit/mint/withdraw/redeem whose asset or share amount
     *      resolves to zero. This blocks no-op spam and, more importantly,
     *      rejects dust deposits that would round down to zero shares (which
     *      would silently donate the depositor's assets to the pool).
     */
    error ZeroAmount();

    /**
     * @param asset_  The ERC20 collateral asset LPs deposit (e.g. Mock USD on
     *                testnet). Stored immutably by the ERC4626 base.
     * @param name_   Name of the LP share token (e.g. "Perps LP").
     * @param symbol_ Symbol of the LP share token (e.g. "pLP").
     */
    constructor(IERC20 asset_, string memory name_, string memory symbol_) ERC20(name_, symbol_) ERC4626(asset_) {}

    /**
     * @inheritdoc ERC4626
     * @dev Returns the configured decimal offset that powers OZ's virtual-share
     *      donation-attack mitigation.
     */
    function _decimalsOffset() internal pure override returns (uint8) {
        return _DECIMALS_OFFSET;
    }

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
