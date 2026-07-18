// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";
import {OracleResolvedMarket} from "./OracleResolvedMarket.sol";

/**
 * @title ParimutuelPredictions
 * @notice The PARIMUTUEL money layer (design §5, §8, §11) on top of the verified
 *         {OracleResolvedMarket} resolution layer. Bettors stake mUSD on UP/DOWN
 *         before lock; winners split the pool pro-rata minus a fee taken only from
 *         the losing side; every ambiguous outcome (tie, one-sided, empty,
 *         unsettleable feed) VOIDs and refunds in full with the fee waived.
 *
 * @dev    Money-path discipline (constitution + design §5):
 *         - Funds are FULLY SEGREGATED from the perps: this contract holds its own
 *           mUSD and never reads/writes/calls perps storage. It imports nothing
 *           from the perps money path — only OpenZeppelin + the local prediction
 *           resolution layer.
 *         - CEI + {ReentrancyGuard} (inherited) on every fund-moving function.
 *           `settle` moves no funds but is guarded anyway (it flips state `claim`
 *           reads). `claim` is NEVER pausable — users can always exit (§11).
 *         - `SafeERC20`; payouts round DOWN so the contract can never owe more
 *           than it holds (design §14.2). The tiny rounding remainder is the only
 *           residual and is owner-sweepable to the segregated treasury.
 *         - The fee rate is snapshotted at market creation (like the strike), so a
 *           later {setFeeBps} can never alter a live market's economics.
 *
 *         Interim entry: {createMarket} is owner-gated here. The permissionless
 *         auto-factory (`replenish`) that will call it is a later step; the money
 *         mechanics do not depend on how markets are created.
 */
contract ParimutuelPredictions is OracleResolvedMarket, Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    enum Side {
        Up,
        Down
    }

    struct Pool {
        uint256 upPool; // total staked UP
        uint256 downPool; // total staked DOWN
        uint16 feeBps; // fee snapshot at creation; fixed for the market's life
        bool swept; // residual (fee + dust) swept to treasury once
        uint256 distributed; // running total transferred OUT (payouts + refunds + sweep)
        uint256 winClaimed; // winning-side stake already claimed (sweep gate)
        mapping(address => uint256) upStake;
        mapping(address => uint256) downStake;
    }

    // -------------------------------------------------------------- constants

    /// Max protocol fee (design §11): 3%.
    uint256 public constant FEE_CAP = 300;

    /// Minimum bet to bound dust/griefing (design §5.1). mUSD is 18-decimal.
    uint256 public constant MIN_BET = 1e18;

    // ---------------------------------------------------------------- storage

    /// Segregated bet currency. Immutable — this contract's own balance only.
    IERC20 public immutable musd;

    /// Default fee applied to NEW markets (design §11 default 0). Capped at FEE_CAP.
    uint256 public feeBps;

    /// Fee/dust sink — inside this contract's own segregated accounting (§5.3).
    address public treasury;

    mapping(uint256 => Pool) internal _pools;

    // ----------------------------------------------------------------- events

    event MarketOpened(uint256 indexed marketId, uint16 feeBps);
    event BetPlaced(uint256 indexed marketId, address indexed better, Side side, uint256 amount);
    event Claimed(uint256 indexed marketId, address indexed claimer, Phase phase, uint256 amount);
    event DustSwept(uint256 indexed marketId, address indexed treasury, uint256 amount);
    event FeeBpsSet(uint256 feeBps);
    event TreasurySet(address treasury);

    // ----------------------------------------------------------------- errors

    error ZeroAddress();
    error FeeAboveCap();
    error BettingClosed();
    error BelowMinBet();
    error NotResolved();
    error NothingToSweep();
    error AlreadySwept();
    error ClaimsPending();

    // ------------------------------------------------------------ constructor

    constructor(IERC20 musd_, address treasury_, uint256 feeBps_, address owner_, uint256 maxStaleness_)
        Ownable(owner_)
        OracleResolvedMarket(maxStaleness_)
    {
        if (address(musd_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > FEE_CAP) revert FeeAboveCap();
        musd = musd_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    // ------------------------------------------------------- market creation

    /**
     * @notice Open a market, capturing its strike (resolution layer) and freezing
     *         its fee. Owner-gated interim entry; the auto-factory replaces the
     *         gating in a later step. Cannot open while paused (design §11).
     */
    function createMarket(
        uint16 assetId,
        IAggregatorV3 feed,
        uint64 betWindow,
        uint64 settleWindow,
        uint256 offsetBps,
        bool offsetUp
    ) external onlyOwner whenNotPaused returns (uint256 marketId) {
        return _openMarket(assetId, feed, betWindow, settleWindow, offsetBps, offsetUp);
    }

    /**
     * @notice Shared market-open path: capture strike (resolution layer), freeze
     *         the fee, then fire {_onMarketCreated}. Reused by the owner entry
     *         above and by the auto-factory layer, so every market — however it is
     *         created — snapshots its fee identically and is tracked identically.
     */
    function _openMarket(
        uint16 assetId,
        IAggregatorV3 feed,
        uint64 betWindow,
        uint64 settleWindow,
        uint256 offsetBps,
        bool offsetUp
    ) internal returns (uint256 marketId) {
        marketId = _createMarket(assetId, feed, betWindow, settleWindow, offsetBps, offsetUp);
        uint16 fee = uint16(feeBps); // feeBps <= FEE_CAP (300) so the cast is exact
        _pools[marketId].feeBps = fee;
        emit MarketOpened(marketId, fee);
        _onMarketCreated(marketId);
    }

    /**
     * @notice Hook: a market has just been opened. The auto-factory overrides this
     *         to register the market in its active-set. Base is a no-op.
     */
    function _onMarketCreated(uint256 marketId) internal virtual {
        marketId; // silence unused-parameter warning in the base no-op
    }

    // ------------------------------------------------------------------- bet

    /**
     * @notice Stake mUSD on a side of an OPEN market (design §5.1). CEI: credit
     *         the pool/stake first, then pull funds under the reentrancy guard.
     */
    function bet(uint256 marketId, Side side, uint256 amount) external nonReentrant whenNotPaused {
        Market storage m = _market(marketId);
        // Betting is open only strictly before lock; the settlement window that
        // decides the result sits entirely after it (resolution layer §4).
        if (uint64(block.timestamp) >= m.tLock || m.phase != Phase.Open) revert BettingClosed();
        if (amount < MIN_BET) revert BelowMinBet();

        Pool storage p = _pools[marketId];
        if (side == Side.Up) {
            p.upPool += amount;
            p.upStake[msg.sender] += amount;
        } else {
            p.downPool += amount;
            p.downStake[msg.sender] += amount;
        }

        musd.safeTransferFrom(msg.sender, address(this), amount);
        emit BetPlaced(marketId, msg.sender, side, amount);
    }

    // ----------------------------------------------------------------- claim

    /**
     * @notice Claim a payout (winner) or refund (void). ALWAYS available — never
     *         gated by pause, so users can always exit (design §11). Idempotent:
     *         a second claim pays 0; a loser's claim pays 0. CEI + nonReentrant.
     */
    function claim(uint256 marketId) external nonReentrant {
        Market storage m = _market(marketId);
        Phase ph = m.phase;
        if (ph != Phase.Settled && ph != Phase.Void) revert NotResolved();

        Pool storage p = _pools[marketId];
        uint256 amount;

        if (ph == Phase.Void) {
            // Full refund of both sides (fee waived on every void path, §5.5-5.8).
            amount = p.upStake[msg.sender] + p.downStake[msg.sender];
            p.upStake[msg.sender] = 0;
            p.downStake[msg.sender] = 0;
        } else {
            // Settled: the winning side pays pro-rata; the losing side is forfeit.
            bool upWon = m.outcome == Outcome.Up;
            uint256 winStake = upWon ? p.upStake[msg.sender] : p.downStake[msg.sender];
            p.upStake[msg.sender] = 0; // zero BOTH before any transfer (CEI)
            p.downStake[msg.sender] = 0;
            if (winStake != 0) {
                p.winClaimed += winStake;
                amount = _payout(p, winStake, upWon);
            }
        }

        if (amount != 0) {
            p.distributed += amount;
            musd.safeTransfer(msg.sender, amount);
        }
        emit Claimed(marketId, msg.sender, ph, amount);
    }

    /**
     * @notice Pro-rata payout for a winning stake (design §5.3):
     *         `payout = winStake * (P - fee) / W`, rounded DOWN, where the fee is
     *         taken only from the losing pool L. `W > 0` is guaranteed: a Settled
     *         market always had both pools funded (else it would have voided).
     */
    function _payout(Pool storage p, uint256 winStake, bool upWon) private view returns (uint256) {
        (uint256 w, uint256 l) = upWon ? (p.upPool, p.downPool) : (p.downPool, p.upPool);
        uint256 pot = w + l;
        uint256 fee = l * p.feeBps / 10_000;
        uint256 distributable = pot - fee; // >= W, so a winner never gets less than stake
        return winStake * distributable / w; // round down
    }

    // ------------------------------------------------------------- treasury

    /**
     * @notice Sweep a market's residual (fee + rounding dust) to the treasury
     *         (design §5.3, §11). Allowed only once, and only once every rightful
     *         claim is out: for a Settled market all winning stake must be claimed;
     *         a Void market has no residual (fee waived, full refunds). This makes
     *         it impossible to touch a single wei of any unclaimed user payout.
     */
    function sweepDust(uint256 marketId) external onlyOwner {
        Market storage m = _market(marketId);
        Pool storage p = _pools[marketId];
        if (m.phase != Phase.Settled && m.phase != Phase.Void) revert NotResolved();
        if (p.swept) revert AlreadySwept();

        if (m.phase == Phase.Settled) {
            uint256 w = m.outcome == Outcome.Up ? p.upPool : p.downPool;
            if (p.winClaimed != w) revert ClaimsPending(); // all winners must be out first
        } else {
            // Void: everything is refundable; sweep only once fully refunded (→ 0).
            if (p.distributed != p.upPool + p.downPool) revert ClaimsPending();
        }

        uint256 residual = (p.upPool + p.downPool) - p.distributed; // = fee + dust (settled) or 0 (void)
        if (residual == 0) revert NothingToSweep();

        p.swept = true;
        p.distributed += residual;
        musd.safeTransfer(treasury, residual);
        emit DustSwept(marketId, treasury, residual);
    }

    // ----------------------------------------------------- admin (design §11)

    /// Pause new bets/markets. `claim`/`settle` are NEVER gated (users always exit).
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// Set the default fee for FUTURE markets; capped, never retroactive (§11).
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > FEE_CAP) revert FeeAboveCap();
        feeBps = newFeeBps;
        emit FeeBpsSet(newFeeBps);
    }

    /// Move the fee/dust sink. Non-zero; segregated (never the perps LP) (§11).
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    /// @notice Governance: tune the oracle staleness window (design §3). Bounded
    ///         in {_setMaxStaleness}; emits {MaxStalenessSet}.
    function setMaxStaleness(uint256 newMaxStaleness) external onlyOwner {
        _setMaxStaleness(newMaxStaleness);
    }

    // ------------------------------------------------------------- pool views

    /// One-sided or zero-participant book → VOID before any oracle read (§5.6/§5.7).
    function _voidBeforeSettle(uint256 marketId) internal view override returns (bool) {
        Pool storage p = _pools[marketId];
        return p.upPool == 0 || p.downPool == 0;
    }

    function pools(uint256 marketId) external view returns (uint256 upPool, uint256 downPool, uint16 marketFeeBps) {
        _market(marketId);
        Pool storage p = _pools[marketId];
        return (p.upPool, p.downPool, p.feeBps);
    }

    function stakeOf(uint256 marketId, address who) external view returns (uint256 upStake, uint256 downStake) {
        _market(marketId);
        Pool storage p = _pools[marketId];
        return (p.upStake[who], p.downStake[who]);
    }

    /// The claimable amount for `who` right now (0 if unresolved or already out).
    function claimable(uint256 marketId, address who) external view returns (uint256) {
        Market storage m = _market(marketId);
        Pool storage p = _pools[marketId];
        if (m.phase == Phase.Void) {
            return p.upStake[who] + p.downStake[who];
        }
        if (m.phase == Phase.Settled) {
            bool upWon = m.outcome == Outcome.Up;
            uint256 winStake = upWon ? p.upStake[who] : p.downStake[who];
            return winStake == 0 ? 0 : _payout(p, winStake, upWon);
        }
        return 0;
    }
}
