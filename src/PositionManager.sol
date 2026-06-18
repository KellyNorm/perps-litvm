// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MainDemoConsumerBase} from "@redstone-finance/evm-connector/contracts/data-services/MainDemoConsumerBase.sol";

import {LiquidityPool} from "./LiquidityPool.sol";

/**
 * @title PositionManager
 * @notice Perpetual position engine for the GMX-style perps DEX. Traders
 *         open and close leveraged long/short positions against the
 *         {LiquidityPool}, which is the sole counterparty. Entry and exit marks
 *         come from the RedStone Pull-Model oracle: the caller appends a fresh
 *
 *         signed price payload to the transaction calldata, and this contract
 *         (via {MainDemoConsumerBase}) verifies the signer(s) and the package
 *         timestamp before using the value.
 *
 * @dev    SCOPE (PR-3 + PR-4a + PR-4b + PR-5): open/close of one full position
 *         per (owner, market, direction); P&L settled against the pool; LP-share
 *         valuation via a cached aggregate mark; reserved-liquidity solvency;
 *         a time-based borrow fee (PR-4a) charged on notional, accrued O(1) via
 *         a per-market cumulative index and deducted from payout at close;
 *         peer-to-peer funding (PR-4b) between longs and shorts; permissionless
 *         liquidation (PR-5) of positions that breach the maintenance margin,
 *         with residual bad-debt accounting when a loss (plus accrued fee and
 *         funding) exceeds the trader's collateral.
 *
 *         OUT OF SCOPE — deferred to later PRs:
 *         - Two-step deferred execution / front-running protection (PR-6). This
 *           contract reads the price in the SAME transaction as the action.
 *         - Payload-aware LP deposit/withdraw to close the share-price fairness
 *           gap (its own PR; see TASK.md).
 *
 *         BORROW FEE (PR-4a): a flat per-second rate on each position's notional
 *         (`sizeUsd`) compensates LPs for the liquidity the position reserves.
 *         It is a pure trader -> pool transfer, recognized on close (never
 *         pre-credited to LP NAV — same conservative stance as unrealized
 *         losses). Accrual is O(1): a single per-market index accumulates
 *         `Σ rate·dt`; each position records the index at open; the fee owed is
 *         `sizeUsd · (indexNow − indexAtOpen)`. Because the rate is constant,
 *         lazy accrual is exact regardless of gaps between trades, so no keeper
 *         tick is required.
 *
 *         LIQUIDATION (PR-5): anyone may liquidate a position whose remaining
 *         equity (collateral + P&L − accrued fee) has fallen to or below the
 *         maintenance margin, priced against a fresh signed oracle mark. The
 *         liquidator earns a bonus drawn from the position's collateral buffer
 *         and the pool absorbs the trader's loss; if the loss exceeds collateral
 *         the shortfall is recognized as residual bad debt rather than reverting,
 *         keeping the engine solvent under gap moves. As with the borrow fee this
 *         is a pure settlement against the pool — no value is pre-credited.
 *
 *         FUNDING (PR-4b): true peer-to-peer funding moves value between longs
 *         and shorts to balance open-interest skew; the pool is a pure
 *         pass-through clearinghouse and is never a net payer or receiver.
 *         Funding accrues ONLY while BOTH sides hold open interest — a one-sided
 *         book accrues nothing (and one-sided gaps are never retro-charged,
 *         because the accrual timestamp always advances). It mirrors the borrow
 *         fee's O(1) index, but as a SIGNED per-side cumulative index: the heavy
 *         side's index rises (its positions OWE) while the light side's falls (its
 *         positions are OWED), with the total charged to the heavy side
 *         distributed across the light side's smaller notional. The per-second
 *         rate is proportional to skew (`FUNDING_COEFF · |skew|`) and clamped at
 *         {MAX_FUNDING_RATE_PER_SECOND} (reached at 50% skew). A position
 *         snapshots its side's index at open; the funding settled at close or
 *         liquidation is `sizeUsd · (indexNow − indexAtOpen)`, signed. All
 *         rounding favors the pool (a payer's charge rounds up, a receiver's
 *         credit rounds down), so the dust the pool clears is always ≥ 0.
 *
 *         COLLATERAL CUSTODY: trader collateral is held by THIS contract, never
 *         by the pool, so it is never counted as LP NAV. On close the pool pays
 *         profit (capped) or absorbs loss (capped at collateral); collateral is
 *         returned to the trader from this contract.
 *
 *         PRICE / DECIMAL CONVENTIONS: RedStone returns prices at 1e8. The
 *         collateral asset (Mock USD) uses 18 decimals and is treated as ~1 USD.
 *         `sizeUsd = collateral * leverage` is therefore 18-decimal USD. P&L =
 *         sizeUsd * |Δprice| / entryPrice keeps the 1e8 price scale internal and
 *         yields an 18-decimal asset amount, matching the collateral.
 */
contract PositionManager is MainDemoConsumerBase, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- risk parameters (immutable economics; all constant) -------------

    /// @notice Minimum collateral per position (asset units, 18 dp). Blocks
    ///         dust positions and rounding abuse.
    uint256 public constant MIN_COLLATERAL = 10e18;

    /// @notice Minimum leverage multiplier (inclusive).
    uint256 public constant MIN_LEVERAGE = 1;

    /// @notice Maximum leverage multiplier (inclusive). Conservative for a
    ///         pooled counterparty.
    uint256 public constant MAX_LEVERAGE = 10;

    /// @notice Per-position profit cap as a multiple of collateral. A position's
    ///         payout from the pool can never exceed MAX_PROFIT_FACTOR *
    ///         collateral, which bounds the reserved liquidity required on open.
    uint256 public constant MAX_PROFIT_FACTOR = 5;

    /// @notice Maintenance-margin threshold (basis points of collateral). A
    ///         position is liquidatable once its remaining equity — collateral
    ///         net of uncapped P&L and the accrued borrow fee — falls to at most
    ///         this fraction of its posted collateral (10%).
    uint256 public constant MAINTENANCE_MARGIN_BPS = 1_000;

    /// @notice Liquidator bounty (basis points of collateral) paid from the
    ///         liquidated position's collateral (5%). Kept <= the maintenance
    ///         margin so the bounty always fits inside the residual buffer left
    ///         above the pool's net claim for a position liquidated exactly at
    ///         the threshold.
    uint256 public constant LIQUIDATION_FEE_BPS = 500;

    /// @notice Maximum fraction (in basis points) of the pool's balance that may
    ///         be reserved against open positions. Leaves a buffer of free LP
    ///         capital and bounds aggregate exposure.
    uint256 public constant MAX_UTILIZATION_BPS = 8_000; // 80%

    /// @notice Basis-points denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Tight staleness window (seconds) for any oracle price used on the
    ///         money path. Tighter than RedStone's 3-minute default because this
    ///         price sets a trader's cost basis / realized P&L.
    uint256 public constant MAX_PRICE_AGE = 60;

    /// @dev Fixed-point scale for per-side weight accumulators (`Σ size/price`),
    ///      chosen large enough to preserve precision through integer division.
    uint256 private constant WEIGHT_PRECISION = 1e18;

    /// @dev Fixed-point scale for the borrow-fee index (accumulated
    ///      `Σ rate·dt`, a dimensionless fraction of notional). 1e18 keeps the
    ///      per-second rate well above the integer-truncation floor.
    uint256 private constant FEE_PRECISION = 1e18;

    /// @notice Borrow-fee rate per second, scaled by {FEE_PRECISION}, charged on
    ///         a position's notional (`sizeUsd`). Conservative starting value:
    ///         `0.10 / 31_536_000 · 1e18 ≈ 3.17e9`, i.e. ~10%/yr on notional.
    ///         Flat (utilization-independent) so the index advance is exact.
    uint256 public constant BORROW_RATE_PER_SECOND = 3_170_979_198;

    /// @dev Fixed-point scale for the signed per-side funding indices
    ///      (accumulated `Σ rate·dt`, a dimensionless fraction of notional).
    uint256 private constant FUNDING_PRECISION = 1e18;

    /// @notice Cap on the funding rate per second, scaled by {FUNDING_PRECISION}.
    ///         `0.03 / 86_400 · 1e18 ≈ 3.47e11`, i.e. ~3%/day on notional at the
    ///         clamp. Bounds how fast a crowded-side position bleeds funding.
    uint256 public constant MAX_FUNDING_RATE_PER_SECOND = 347_222_222_222;

    /// @notice Slope mapping skew to the funding rate: `rate = FUNDING_COEFF ·
    ///         |skew|`, scaled by {FUNDING_PRECISION}. Set to `2 ·
    ///         MAX_FUNDING_RATE_PER_SECOND` so the rate reaches its clamp at 50%
    ///         skew and is linear below it.
    uint256 public constant FUNDING_COEFF = 694_444_444_444;

    // --- two-step deferred execution (PR-6b) -----------------------------

    /// @notice Flat fee (asset units, 18 dp) escrowed at request time and paid to
    ///         the keeper that fills the request. Refunded to the owner on any
    ///         cancel (slippage miss or owner reclaim) — the keeper earns it ONLY
    ///         on a successful fill.
    uint256 public constant EXECUTION_FEE = 0.5e18;

    /// @notice Minimum seconds that must elapse between a request and its
    ///         execution. The executor's price must postdate this floor, which is
    ///         what makes the fill price unknowable to the trader at request time
    ///         (the front-running / MEV protection).
    uint256 public constant MIN_EXECUTION_DELAY = 3;

    /// @notice Seconds after a request before its owner may reclaim it via
    ///         {cancelRequest}. Gives keepers a window to fill before the owner can
    ///         pull the escrow back.
    uint256 public constant CANCEL_DELAY = 180;

    // --- supported markets (RedStone feed ids) ---------------------------

    /// @notice Supported market feed id for BTC.
    bytes32 public constant MARKET_BTC = bytes32("BTC");

    /// @notice Supported market feed id for ETH.
    bytes32 public constant MARKET_ETH = bytes32("ETH");

    // --- wiring ----------------------------------------------------------

    /// @notice The liquidity pool that is the counterparty to all positions.
    LiquidityPool public immutable pool;

    /// @notice The collateral asset (must equal the pool's asset).
    IERC20 public immutable asset;

    // --- position & aggregate state --------------------------------------

    /**
     * @notice A single leveraged position.
     * @param  owner      Trader who opened it.
     * @param  market     RedStone feed id of the traded market.
     * @param  isLong     True for long, false for short.
     * @param  collateral Collateral posted, in asset units (18 dp).
     * @param  sizeUsd    Notional size = collateral * leverage (18 dp).
     * @param  entryPrice Entry mark price (1e8).
     * @param  entryCumBorrowRate Borrow-fee index ({MarketState.cumBorrowRate})
     *                    snapshotted at open; the fee owed at close is
     *                    `sizeUsd · (cumBorrowRate − entryCumBorrowRate)`.
     * @param  entryCumFunding This side's signed funding index
     *                    ({MarketState.longCumFunding}/{shortCumFunding})
     *                    snapshotted at open; the funding settled at close is
     *                    `sizeUsd · (sideCumFunding − entryCumFunding)` (signed:
     *                    positive ⇒ the position owes, negative ⇒ it is owed).
     */
    struct Position {
        address owner;
        bytes32 market;
        bool isLong;
        uint256 collateral;
        uint256 sizeUsd;
        uint256 entryPrice;
        uint256 entryCumBorrowRate;
        int256 entryCumFunding;
    }

    /**
     * @notice Per-market aggregates enabling O(1) book-wide unrealized-P&L
     *         valuation. For each side, `weight = Σ size_i / entry_i` (scaled by
     *         {WEIGHT_PRECISION}); aggregate long P&L at price P is
     *         `P*weight - sizeUsd`, short P&L is `sizeUsd - P*weight`.
     * @param  longSizeUsd  Σ long notional.
     * @param  longWeight   Σ longSize/longEntry (scaled).
     * @param  shortSizeUsd Σ short notional.
     * @param  shortWeight  Σ shortSize/shortEntry (scaled).
     * @param  lastMarkPrice Most recent mark for this market (1e8), refreshed on
     *                       every open/close.
     * @param  cumBorrowRate Cumulative borrow-fee index for this market:
     *                       `Σ BORROW_RATE_PER_SECOND·dt` scaled by
     *                       {FEE_PRECISION}. Monotonically non-decreasing.
     * @param  lastBorrowAccrual Timestamp the index last advanced; 0 until the
     *                       market's first touch.
     * @param  longCumFunding  Signed cumulative funding index for the LONG side
     *                       (scaled by {FUNDING_PRECISION}): rises when longs are
     *                       the heavy side (they pay), falls when longs are light
     *                       (they receive).
     * @param  shortCumFunding Signed cumulative funding index for the SHORT side,
     *                       symmetric to {longCumFunding}.
     * @param  lastFundingAccrual Timestamp the funding indices last advanced; 0
     *                       until the market's first touch. Always advances on
     *                       accrual so one-sided gaps are never retro-charged.
     */
    struct MarketState {
        uint256 longSizeUsd;
        uint256 longWeight;
        uint256 shortSizeUsd;
        uint256 shortWeight;
        uint256 lastMarkPrice;
        uint256 cumBorrowRate;
        uint256 lastBorrowAccrual;
        int256 longCumFunding;
        int256 shortCumFunding;
        uint256 lastFundingAccrual;
    }

    /**
     * @dev Transient (memory-only) result of splitting a liquidated position's
     *      collateral. Packed into a struct so {_settleLiquidation}'s event emit
     *      stays within the EVM stack limit. See {_splitLiquidation}.
     */
    struct LiquidationSplit {
        uint256 toPool;
        uint256 liquidatorBonus;
        uint256 ownerRefund;
        uint256 badDebt;
    }

    /// @notice Open positions keyed by keccak256(owner, market, isLong).
    mapping(bytes32 => Position) public positions;

    /// @notice Aggregates keyed by market feed id.
    mapping(bytes32 => MarketState) public markets;

    /// @notice Cached aggregate unrealized trader profit across all markets
    ///         (asset units). Read by the pool as its contingent liability.
    ///         Refreshed only on open/close (see contract NatSpec).
    uint256 public totalUnrealizedProfit;

    /// @notice Total liquidity reserved against open positions' capped payouts
    ///         (asset units). Read by the pool to gate withdrawals.
    uint256 public totalReserved;

    // --- two-step deferred execution state (PR-6b) -----------------------

    /// @notice Whether a queued request opens a new position or closes an
    ///         existing one.
    enum RequestKind {
        Open,
        Close
    }

    /**
     * @notice A queued open/close awaiting a keeper fill at a post-request price.
     * @dev    ESCROW INVARIANT: every wei pulled in at request time leaves as
     *         exactly one of — position collateral (fill), owner refund (cancel),
     *         or keeper fee (fill). The execution fee flows to the keeper ONLY on a
     *         fill; on ANY cancel (slippage miss or owner reclaim) the full escrow
     *         (collateral + fee for opens, fee for closes) refunds to the owner.
     * @param  owner            Trader who queued the request and owns the escrow.
     * @param  market           Market feed id (MARKET_BTC or MARKET_ETH).
     * @param  isLong           Direction of the position to open/close.
     * @param  kind             Open or Close.
     * @param  collateral       Collateral escrowed (Open only; 0 for Close).
     * @param  leverage         Leverage multiplier (Open only; 0 for Close).
     * @param  acceptablePrice  Directional slippage bound (1e8); see {_withinSlippage}.
     * @param  executionFee     Keeper fee escrowed at request ({EXECUTION_FEE}).
     * @param  requestTimestamp `block.timestamp` when the request was queued.
     * @param  active           True until the request is filled or cancelled.
     */
    struct Request {
        address owner;
        bytes32 market;
        bool isLong;
        RequestKind kind;
        uint256 collateral;
        uint256 leverage;
        uint256 acceptablePrice;
        uint256 executionFee;
        uint256 requestTimestamp;
        bool active;
    }

    /// @notice Queued requests by id.
    mapping(uint256 => Request) public requests;

    /// @notice Monotonic id assigned to the next request.
    uint256 public nextRequestId;

    /// @notice Whether a position key already has a live close request, so a
    ///         position cannot be double-queued for close.
    mapping(bytes32 => bool) public closePending;

    /// @dev Set ONLY for the duration of {executeRequest}'s oracle read to the
    ///      request's earliest-execution timestamp; the {validateTimestamp}
    ///      override rejects any price stamped before it (replay/freshness guard).
    ///      Always 0 on the direct open/close and liquidate paths, so their
    ///      timestamp validation is completely unaffected.
    uint256 private _minExecutionTimestamp;

    // --- errors ----------------------------------------------------------

    error MarketNotSupported(bytes32 market);
    error CollateralTooLow(uint256 provided, uint256 minimum);
    error LeverageOutOfRange(uint256 provided);
    error PositionAlreadyOpen();
    error NoOpenPosition();
    error InvalidPrice();
    error ExceedsUtilization();
    error PriceTooStale(uint256 priceTimestampSeconds, uint256 blockTimestamp);
    error PriceFromFuture(uint256 priceTimestampSeconds, uint256 blockTimestamp);
    error NotLiquidatable(uint256 equity, uint256 maintenance);

    // two-step deferred execution (PR-6b)
    error RequestNotActive();
    error TooEarlyToExecute(uint256 nowTs, uint256 earliest);
    error TooEarlyToCancel(uint256 nowTs, uint256 earliest);
    error NotRequestOwner();
    error PriceBeforeRequest(uint256 priceTs, uint256 minTs);
    error InvalidAcceptablePrice();
    error CloseAlreadyPending();

    // --- events ----------------------------------------------------------

    event PositionOpened(
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 collateral,
        uint256 sizeUsd,
        uint256 entryPrice
    );

    event PositionClosed(
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 exitPrice,
        bool profit,
        uint256 pnl,
        uint256 borrowFee,
        int256 funding,
        uint256 payout
    );

    /**
     * @notice Emitted when a position is liquidated.
     * @param  pnl Raw, UNCAPPED P&L magnitude at the liquidation mark (the value
     *         the equity check used), not the close-path capped figure.
     * @param  toPool Net amount routed into the pool (loss + fee, capped at
     *         collateral).
     * @param  liquidatorBonus Bounty paid to `liquidator` from the residual.
     * @param  ownerRefund Collateral dust returned to `owner` after the pool
     *         claim and the bounty.
     * @param  badDebt Net owed beyond the position's collateral that the pool
     *         could not collect (0 unless deeply underwater).
     * @param  funding Signed funding settled at liquidation (positive ⇒ the
     *         position owed funding, negative ⇒ it was owed funding); folded into
     *         the pool's net claim.
     */
    event PositionLiquidated(
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 exitPrice,
        bool profit,
        uint256 pnl,
        uint256 borrowFee,
        int256 funding,
        uint256 toPool,
        uint256 liquidatorBonus,
        uint256 ownerRefund,
        uint256 badDebt,
        address indexed liquidator
    );

    // two-step deferred execution (PR-6b)

    event OpenRequested(
        uint256 indexed requestId,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 executionFee
    );

    event CloseRequested(
        uint256 indexed requestId,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 acceptablePrice,
        uint256 executionFee
    );

    event RequestExecuted(uint256 indexed requestId, address indexed keeper, uint256 executionPrice);

    /// @dev `slippage` is true when the executor cancels on a bound miss; false on
    ///      an owner reclaim via {cancelRequest}. Either way the full escrow
    ///      refunds to the owner.
    event RequestCancelled(uint256 indexed requestId, address indexed owner, bool slippage);

    /**
     * @param pool_ The deployed {LiquidityPool} counterparty.
     * @dev   Reads the pool's asset and pre-approves the pool to pull absorbed
     *        losses via {LiquidityPool.receiveLoss}. The pool must be linked to
     *        this manager separately via {LiquidityPool.setPositionManager}.
     */
    constructor(LiquidityPool pool_) {
        pool = pool_;
        IERC20 asset_ = IERC20(pool_.asset());
        asset = asset_;
        asset_.forceApprove(address(pool_), type(uint256).max);
    }

    // --- oracle staleness override ---------------------------------------

    /**
     * @notice Validate a RedStone package timestamp against the tight money-path
     *         staleness window. Overrides the RedStone consumer base default.
     * @dev Tightens RedStone's default timestamp validation to {MAX_PRICE_AGE}
     *      in both directions. Any money-path price older (or further in the
     *      future) than this window is rejected.
     */
    function validateTimestamp(uint256 receivedTimestampMilliseconds) public view override {
        uint256 receivedSeconds = receivedTimestampMilliseconds / 1000;
        if (block.timestamp > receivedSeconds) {
            if (block.timestamp - receivedSeconds > MAX_PRICE_AGE) {
                revert PriceTooStale(receivedSeconds, block.timestamp);
            }
        } else if (receivedSeconds - block.timestamp > MAX_PRICE_AGE) {
            revert PriceFromFuture(receivedSeconds, block.timestamp);
        }

        // Deferred-execution freshness/replay guard (PR-6b): reject any price
        // stamped before the request's earliest-execution floor. This fires ONLY
        // while {executeRequest} has the slot set; it is 0 on the direct
        // open/close and liquidate paths, so those are completely unaffected.
        uint256 minTs = _minExecutionTimestamp;
        if (minTs != 0 && receivedSeconds < minTs) revert PriceBeforeRequest(receivedSeconds, minTs);
    }

    // --- trading ---------------------------------------------------------

    /**
     * @notice Open a leveraged position. The caller MUST append a fresh signed
     *         RedStone payload for `market` to the transaction calldata.
     * @dev    CEI: validate -> read & validate price -> reserve & record (state)
     *         -> pull collateral (interaction). `nonReentrant`.
     * @param  market   Market feed id (MARKET_BTC or MARKET_ETH).
     * @param  isLong   True for long, false for short.
     * @param  collateral Collateral to post (asset units, >= MIN_COLLATERAL).
     * @param  leverage Leverage multiplier in [MIN_LEVERAGE, MAX_LEVERAGE].
     */
    function openPosition(bytes32 market, bool isLong, uint256 collateral, uint256 leverage) external nonReentrant {
        // Hoist the param-validation checks ahead of the oracle read so that
        // typed calls with NO appended payload still surface the same revert they
        // do today (the oracle read would otherwise revert first on a missing
        // payload). These checks are pure and idempotent; they re-run inside
        // {_openPosition}, which holds the open logic verbatim.
        _requireSupportedMarket(market);
        if (collateral < MIN_COLLATERAL) revert CollateralTooLow(collateral, MIN_COLLATERAL);
        if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE) revert LeverageOutOfRange(leverage);

        uint256 entryPrice = getOracleNumericValueFromTxMsg(market);
        _openPosition(msg.sender, market, isLong, collateral, leverage, entryPrice, true);
    }

    /**
     * @notice Price-parameterized core of {openPosition}. Holds the current open
     *         logic verbatim, with the inline oracle read replaced by the passed
     *         `entryPrice` and the collateral pull gated by `pullCollateral`.
     * @dev    The direct path passes `pullCollateral = true`, so its behavior is
     *         identical to the pre-refactor inline body and fully covered by the
     *         existing tests. The `false` branch is the seam for PR-6b's deferred
     *         executor, where collateral is pre-escrowed at request time; it stays
     *         in the SAME CEI position (after effects, before the emit).
     *
     *         CEI: validate -> reserve & record (state) -> (gated) pull collateral
     *         (interaction).
     * @param  owner          Position owner (the trader); used everywhere the
     *                        direct path uses `msg.sender`.
     * @param  market         Market feed id (MARKET_BTC or MARKET_ETH).
     * @param  isLong         True for long, false for short.
     * @param  collateral     Collateral to post (asset units, >= MIN_COLLATERAL).
     * @param  leverage       Leverage multiplier in [MIN_LEVERAGE, MAX_LEVERAGE].
     * @param  entryPrice     Entry mark price (1e8), supplied by the caller.
     * @param  pullCollateral Whether to pull `collateral` from `owner` (true on
     *                        the direct path; false when pre-escrowed).
     */
    function _openPosition(
        address owner,
        bytes32 market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 entryPrice,
        bool pullCollateral
    ) internal {
        _requireSupportedMarket(market);
        if (collateral < MIN_COLLATERAL) revert CollateralTooLow(collateral, MIN_COLLATERAL);
        if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE) revert LeverageOutOfRange(leverage);

        bytes32 key = _positionKey(owner, market, isLong);
        if (positions[key].sizeUsd != 0) revert PositionAlreadyOpen();

        if (entryPrice == 0) revert InvalidPrice();

        uint256 sizeUsd = collateral * leverage;
        uint256 reserve = collateral * MAX_PROFIT_FACTOR;

        // Solvency gate: reserved liquidity (incl. this position) must stay
        // within the configured fraction of the pool's balance.
        uint256 poolBalance = asset.balanceOf(address(pool));
        if (totalReserved + reserve > Math.mulDiv(poolBalance, MAX_UTILIZATION_BPS, BPS_DENOMINATOR)) {
            revert ExceedsUtilization();
        }

        // Effects. Accrue both indices to now (over the PRE-trade skew, before
        // this position joins the book) so the entry snapshots exclude fees and
        // funding that accrued before it existed.
        uint256 entryCumBorrowRate = _accrueBorrow(market);
        _accrueFunding(market);
        int256 entryCumFunding = isLong ? markets[market].longCumFunding : markets[market].shortCumFunding;
        positions[key] = Position({
            owner: owner,
            market: market,
            isLong: isLong,
            collateral: collateral,
            sizeUsd: sizeUsd,
            entryPrice: entryPrice,
            entryCumBorrowRate: entryCumBorrowRate,
            entryCumFunding: entryCumFunding
        });
        _updateMarket(market, isLong, sizeUsd, entryPrice, entryPrice, true);
        totalReserved += reserve;

        // Interaction.
        if (pullCollateral) asset.safeTransferFrom(owner, address(this), collateral);

        emit PositionOpened(owner, market, isLong, collateral, sizeUsd, entryPrice);
    }

    /**
     * @notice Close the caller's open position in `market`/`isLong`. The caller
     *         MUST append a fresh signed RedStone payload for `market`.
     * @dev    CEI: read & validate price -> compute P&L -> delete & release
     *         (state) -> settle transfers (interactions). `nonReentrant`.
     *
     *         Settlement (S = sizeUsd, E = entry, X = exit):
     *           long  P&L = S*(X-E)/E ; short P&L = S*(E-X)/E.
     *         Profit is paid by the pool, capped at MAX_PROFIT_FACTOR*collateral,
     *         and collateral is returned in full. Loss is capped at collateral
     *         (any deficit beyond it is left for PR-5); the trader receives
     *         collateral - loss and the loss is pushed into the pool.
     *
     *         BORROW FEE (PR-4a): the position's accrued borrow fee is then
     *         deducted from the amount the trader would otherwise receive and
     *         routed to the pool. With A = the trader's pre-fee proceeds
     *         (profit: collateral + pnl; loss: collateral - pnl) the fee charged
     *         is `min(fee, A)`, so payout = A - charged floors at 0 and never
     *         underflows. If the fee alone exceeds A, the uncollected remainder
     *         is simply not taken — the same bad-debt seam as a loss past
     *         collateral, owned by PR-5. Net pool flow combines pnl and the fee
     *         into a single {payProfit}/{receiveLoss} call (no new pool ABI).
     * @param  market Market feed id.
     * @param  isLong Direction of the position to close.
     */
    function closePosition(bytes32 market, bool isLong) external nonReentrant {
        uint256 exitPrice = getOracleNumericValueFromTxMsg(market);
        _closePosition(msg.sender, market, isLong, exitPrice);
    }

    /**
     * @notice Price-parameterized core of {closePosition}. Holds the current
     *         close logic verbatim, with the inline oracle read replaced by the
     *         passed `exitPrice`.
     * @dev    The seam for PR-6b's deferred executor, which supplies the price
     *         relayed on-chain at execution. CEI: compute P&L -> snapshot fee &
     *         funding & clear book state (effects) -> settle transfers
     *         (interactions). Returns the trader payout.
     * @param  owner     Position owner (the trader); used everywhere the direct
     *                  path uses `msg.sender`.
     * @param  market    Market feed id.
     * @param  isLong    Direction of the position to close.
     * @param  exitPrice Exit mark price (1e8), supplied by the caller.
     */
    function _closePosition(address owner, bytes32 market, bool isLong, uint256 exitPrice)
        internal
        returns (uint256 payout)
    {
        bytes32 key = _positionKey(owner, market, isLong);
        Position memory pos = positions[key];
        if (pos.sizeUsd == 0) revert NoOpenPosition();

        if (exitPrice == 0) revert InvalidPrice();

        (bool profit, uint256 pnl) = _computePnl(pos, exitPrice);

        // Effects. Accrue both indices to now (over the pre-trade skew, while
        // this position is still in the book) and snapshot the fee and signed
        // funding owed over this position's lifetime, then clear the position's
        // book state before any external interaction (CEI).
        uint256 borrowFee = _accrueFee(pos);
        int256 fundingOwed = _accrueFundingOwed(pos);
        _realizeClose(pos, key, exitPrice);

        // Interactions (kept in a helper to bound this frame's stack).
        payout = _settle(pos, profit, pnl, borrowFee, fundingOwed);

        emit PositionClosed(pos.owner, market, isLong, exitPrice, profit, pnl, borrowFee, fundingOwed, payout);
    }

    /**
     * @dev Settles a closing position's transfers and returns the trader payout,
     *      folding the signed P&L, the borrow fee, and the signed funding into a
     *      single net pool flow. `netToPool` is the pool's net claim (positive ⇒
     *      the pool RECEIVES, negative ⇒ the pool PAYS): a profit is the only term
     *      that pays the trader, while a loss, the borrow fee, and positive
     *      funding all flow to the pool.
     *
     *      - `netToPool < 0`: the pool pays `-netToPool` via {payProfit} and the
     *        trader's full collateral is returned; payout = collateral + poolPay.
     *      - `netToPool >= 0`: the pool's claim is capped at the collateral
     *        (`toPool = min(owed, collateral)`), the remainder is returned to the
     *        trader, and payout floors at 0 — any owed beyond collateral is the
     *        bad-debt seam left uncollected (bounded on the liquidation path).
     *
     *      Reduces EXACTLY to the PR-4a behavior when `fundingOwed == 0`. Called
     *      only from {closePosition} after all state effects, so it runs under
     *      that function's CEI ordering and `nonReentrant` guard.
     */
    function _settle(Position memory pos, bool profit, uint256 pnl, uint256 borrowFee, int256 fundingOwed)
        internal
        returns (uint256 payout)
    {
        int256 netToPool = (profit ? -int256(pnl) : int256(pnl)) + int256(borrowFee) + fundingOwed;
        if (netToPool < 0) {
            // Pool nets a payment to the trader; full collateral returned by PM.
            uint256 poolPay = uint256(-netToPool);
            pool.payProfit(pos.owner, poolPay);
            asset.safeTransfer(pos.owner, pos.collateral);
            payout = pos.collateral + poolPay;
        } else {
            // Pool nets an inflow; PM funds it from collateral, capped at it.
            uint256 owed = uint256(netToPool);
            uint256 toPool = owed > pos.collateral ? pos.collateral : owed;
            uint256 returned = pos.collateral - toPool;
            if (returned > 0) asset.safeTransfer(pos.owner, returned);
            if (toPool > 0) pool.receiveLoss(toPool);
            payout = returned;
        }
    }

    /**
     * @notice Permissionlessly liquidate an underwater position. ANYONE may
     *         call; the caller MUST append a fresh signed RedStone payload for
     *         `market` and is paid a bounty out of the position's collateral.
     * @dev    A position is liquidatable once its equity — collateral adjusted by
     *         the UNCAPPED P&L at the fresh mark, the accrued borrow fee, and the
     *         signed funding owed — falls to at most {MAINTENANCE_MARGIN_BPS} of
     *         collateral. The
     *         uncapped P&L is used here (not the close-path capped figure) so the
     *         trigger reflects true solvency: a loss past collateral must still
     *         liquidate. By construction the position is underwater, so the pool
     *         only ever RECEIVES at settlement — {LiquidityPool.payProfit} is
     *         never called on this path.
     *
     *         Settlement splits the collateral three ways with exact
     *         conservation (`toPool + liquidatorBonus + ownerRefund == collateral`):
     *           - `toPool`          = min(net owed to pool, collateral),
     *           - `liquidatorBonus` = min({LIQUIDATION_FEE_BPS} of collateral,
     *                                     collateral - toPool),
     *           - `ownerRefund`     = the remainder.
     *         Any net owed beyond collateral is uncollectable `badDebt` (emitted,
     *         not collected) — the residual bad-debt seam this PR owns.
     *
     *         CEI: read & validate price -> compute uncapped P&L + fee -> equity
     *         check -> delete & release book state -> settle transfers.
     *         `nonReentrant`; all effects precede all interactions.
     * @param  owner  Owner of the position to liquidate.
     * @param  market Market feed id.
     * @param  isLong Direction of the position.
     */
    function liquidate(address owner, bytes32 market, bool isLong) external nonReentrant {
        bytes32 key = _positionKey(owner, market, isLong);
        Position memory pos = positions[key];
        if (pos.sizeUsd == 0) revert NoOpenPosition();

        uint256 exitPrice = getOracleNumericValueFromTxMsg(market);
        if (exitPrice == 0) revert InvalidPrice();

        // Uncapped P&L: solvency must see the true deficit, including any loss
        // beyond collateral that the close path would have floored.
        (bool profit, uint256 pnl) = _computeRawPnl(pos, exitPrice);

        // Accrue both indices to now and snapshot this position's fee and signed
        // funding (exactly one accrual of each, as on the close path). Computed
        // ONCE here and reused at settlement so the check and the split agree.
        uint256 borrowFee = _accrueFee(pos);
        int256 fundingOwed = _accrueFundingOwed(pos);

        // Equity check (everything favours the pool / against the trader): the
        // signed equity nets uncapped P&L, the fee, and signed funding owed.
        int256 signedEquity =
            int256(pos.collateral) + (profit ? int256(pnl) : -int256(pnl)) - int256(borrowFee) - fundingOwed;
        uint256 equity = signedEquity > 0 ? uint256(signedEquity) : 0;
        uint256 maintenance = Math.mulDiv(pos.collateral, MAINTENANCE_MARGIN_BPS, BPS_DENOMINATOR);
        if (equity > maintenance) revert NotLiquidatable(equity, maintenance);

        // Effects: clear book state and release reserves (CEI).
        _realizeClose(pos, key, exitPrice);

        // Settlement + interactions + event in a helper to bound this frame's stack.
        _settleLiquidation(pos, exitPrice, profit, pnl, borrowFee, fundingOwed);
    }

    /**
     * @dev Settles a liquidation: splits the position's collateral into the
     *      pool's net claim, the liquidator's bounty, and any owner refund, then
     *      performs the transfers (interactions only — all state effects ran in
     *      {liquidate} before this call) and emits {PositionLiquidated}. The
     *      net claim folds the uncapped P&L, the borrow fee, and the signed
     *      funding owed. The equity check in {liquidate} guarantees a position is
     *      only liquidatable once `signedEquity <= maintenance < collateral`, and
     *      since `signedEquity = collateral - netOwed`, the net owed is strictly
     *      positive here — so the pool only ever RECEIVES; {LiquidityPool.payProfit}
     *      is never called. Conservation holds exactly:
     *      `toPool + liquidatorBonus + ownerRefund == pos.collateral`.
     */
    function _settleLiquidation(
        Position memory pos,
        uint256 exitPrice,
        bool profit,
        uint256 pnl,
        uint256 borrowFee,
        int256 fundingOwed
    ) internal {
        // The split is packed into one memory struct so the 13-field emit below
        // stays within the stack limit (one slot, not four).
        LiquidationSplit memory s = _splitLiquidation(pos.collateral, profit, pnl, borrowFee, fundingOwed);

        if (s.toPool > 0) pool.receiveLoss(s.toPool);
        if (s.liquidatorBonus > 0) asset.safeTransfer(msg.sender, s.liquidatorBonus);
        if (s.ownerRefund > 0) asset.safeTransfer(pos.owner, s.ownerRefund);

        emit PositionLiquidated(
            pos.owner,
            pos.market,
            pos.isLong,
            exitPrice,
            profit,
            pnl,
            borrowFee,
            fundingOwed,
            s.toPool,
            s.liquidatorBonus,
            s.ownerRefund,
            s.badDebt,
            msg.sender
        );
    }

    /**
     * @dev Pure split of a liquidated position's collateral into the pool's net
     *      claim, the liquidator's bounty, and the owner refund (plus any
     *      uncollectable bad debt). `netOwed` folds the uncapped P&L, the borrow
     *      fee, and the signed funding; the equity check in {liquidate} has
     *      already guaranteed `netOwed > 0`, so the cast to uint256 is safe.
     *      Conservation: `toPool + liquidatorBonus + ownerRefund == collateral`.
     */
    function _splitLiquidation(uint256 collateral, bool profit, uint256 pnl, uint256 borrowFee, int256 fundingOwed)
        internal
        pure
        returns (LiquidationSplit memory s)
    {
        uint256 netOwedToPool = uint256((profit ? -int256(pnl) : int256(pnl)) + int256(borrowFee) + fundingOwed);
        s.toPool = netOwedToPool > collateral ? collateral : netOwedToPool;
        uint256 remaining = collateral - s.toPool;
        s.liquidatorBonus = Math.min(Math.mulDiv(collateral, LIQUIDATION_FEE_BPS, BPS_DENOMINATOR), remaining);
        s.ownerRefund = remaining - s.liquidatorBonus;
        s.badDebt = netOwedToPool > collateral ? netOwedToPool - collateral : 0;
    }

    // --- two-step deferred execution (PR-6b) -----------------------------

    /**
     * @notice Queue a deferred OPEN. The collateral and the {EXECUTION_FEE} are
     *         escrowed here now; a keeper fills it later at a price relayed
     *         on-chain at execution (front-running protection — the trader does
     *         not pick the fill price).
     * @dev    Purely additive: the direct {openPosition} path is unchanged. CEI:
     *         validate -> record request (state) -> pull escrow (interaction).
     *         `nonReentrant`. Param checks mirror {openPosition} so a bad request
     *         fails fast before any escrow moves.
     *
     *         ESCROW INVARIANT: the `collateral + EXECUTION_FEE` pulled here leaves
     *         only as position collateral + keeper fee (fill) or a full owner
     *         refund (cancel). See {Request}.
     * @param  market          Market feed id (MARKET_BTC or MARKET_ETH).
     * @param  isLong          True for long, false for short.
     * @param  collateral      Collateral to post (asset units, >= MIN_COLLATERAL).
     * @param  leverage        Leverage multiplier in [MIN_LEVERAGE, MAX_LEVERAGE].
     * @param  acceptablePrice Directional slippage bound (1e8); see {_withinSlippage}.
     * @return requestId       Id of the queued request.
     */
    function requestOpen(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 acceptablePrice)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        _requireSupportedMarket(market);
        if (collateral < MIN_COLLATERAL) revert CollateralTooLow(collateral, MIN_COLLATERAL);
        if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE) revert LeverageOutOfRange(leverage);
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        if (positions[_positionKey(msg.sender, market, isLong)].sizeUsd != 0) revert PositionAlreadyOpen();

        // Effects.
        requestId = nextRequestId++;
        requests[requestId] = Request({
            owner: msg.sender,
            market: market,
            isLong: isLong,
            kind: RequestKind.Open,
            collateral: collateral,
            leverage: leverage,
            acceptablePrice: acceptablePrice,
            executionFee: EXECUTION_FEE,
            requestTimestamp: block.timestamp,
            active: true
        });

        // Interaction LAST (CEI).
        asset.safeTransferFrom(msg.sender, address(this), collateral + EXECUTION_FEE);

        emit OpenRequested(requestId, msg.sender, market, isLong, collateral, leverage, acceptablePrice, EXECUTION_FEE);
    }

    /**
     * @notice Queue a deferred CLOSE of the caller's open position. Only the
     *         {EXECUTION_FEE} is escrowed (the collateral is already held against
     *         the open position). A keeper fills it later at a post-request price.
     * @dev    Purely additive: the direct {closePosition} path is unchanged. CEI:
     *         validate -> mark pending & record request (state) -> pull fee
     *         (interaction). `nonReentrant`. One live close request per position
     *         key at a time.
     * @param  market          Market feed id.
     * @param  isLong          Direction of the position to close.
     * @param  acceptablePrice Directional slippage bound (1e8); see {_withinSlippage}.
     * @return requestId       Id of the queued request.
     */
    function requestClose(bytes32 market, bool isLong, uint256 acceptablePrice)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        bytes32 key = _positionKey(msg.sender, market, isLong);
        if (positions[key].sizeUsd == 0) revert NoOpenPosition();
        if (closePending[key]) revert CloseAlreadyPending();

        // Effects.
        closePending[key] = true;
        requestId = nextRequestId++;
        requests[requestId] = Request({
            owner: msg.sender,
            market: market,
            isLong: isLong,
            kind: RequestKind.Close,
            collateral: 0,
            leverage: 0,
            acceptablePrice: acceptablePrice,
            executionFee: EXECUTION_FEE,
            requestTimestamp: block.timestamp,
            active: true
        });

        // Interaction LAST (CEI).
        asset.safeTransferFrom(msg.sender, address(this), EXECUTION_FEE);

        emit CloseRequested(requestId, msg.sender, market, isLong, acceptablePrice, EXECUTION_FEE);
    }

    /**
     * @notice Keeper-fill a queued request at a fresh post-request price. The
     *         caller MUST append a fresh signed RedStone payload for the request's
     *         market. On a successful fill the keeper earns the escrowed
     *         {EXECUTION_FEE}; on a slippage miss the request is cancelled and the
     *         full escrow refunds to the owner (keeper paid nothing).
     * @dev    The fill price must postdate `requestTimestamp + MIN_EXECUTION_DELAY`
     *         — enforced both by the `block.timestamp` floor (the keeper cannot
     *         execute too early) and by the {validateTimestamp} override via
     *         `_minExecutionTimestamp` (the price itself must be stamped after the
     *         floor, not merely fresh). `nonReentrant`; the internal cores run
     *         under this guard (so they must NOT add their own).
     *
     *         If {_openPosition} reverts at fill time (e.g. utilization full or the
     *         position already open), the whole tx reverts and the request stays
     *         active; the owner reclaims after {CANCEL_DELAY}. That is intended —
     *         there is deliberately no pre-check here.
     * @param  requestId Id of the request to fill.
     */
    function executeRequest(uint256 requestId) external nonReentrant {
        Request memory r = requests[requestId];
        if (!r.active) revert RequestNotActive();

        uint256 earliest = r.requestTimestamp + MIN_EXECUTION_DELAY;
        if (block.timestamp < earliest) revert TooEarlyToExecute(block.timestamp, earliest);

        // Freshness/replay guard: the price must be stamped at/after `earliest`.
        // Scoped strictly around the oracle read so only this path is affected.
        _minExecutionTimestamp = earliest;
        uint256 price = getOracleNumericValueFromTxMsg(r.market);
        _minExecutionTimestamp = 0;
        if (price == 0) revert InvalidPrice();

        // Effect first (CEI): the request is consumed regardless of the outcome.
        requests[requestId].active = false;

        bytes32 key = _positionKey(r.owner, r.market, r.isLong);

        if (!_withinSlippage(r.kind, r.isLong, price, r.acceptablePrice)) {
            // Slippage miss: cancel + full refund to the owner, keeper unpaid.
            if (r.kind == RequestKind.Close) {
                closePending[key] = false;
                asset.safeTransfer(r.owner, r.executionFee);
            } else {
                asset.safeTransfer(r.owner, r.collateral + r.executionFee);
            }
            emit RequestCancelled(requestId, r.owner, true);
            return;
        }

        // Fill.
        if (r.kind == RequestKind.Open) {
            // Collateral was pre-escrowed at request time -> pullCollateral=false.
            _openPosition(r.owner, r.market, r.isLong, r.collateral, r.leverage, price, false);
        } else {
            closePending[key] = false;
            _closePosition(r.owner, r.market, r.isLong, price);
        }

        // Keeper earns the fee ONLY on a successful fill.
        asset.safeTransfer(msg.sender, r.executionFee);

        emit RequestExecuted(requestId, msg.sender, price);
    }

    /**
     * @notice Owner-reclaim a stale request after {CANCEL_DELAY}, refunding the
     *         full escrow. The keeper is paid nothing (this is not a fill).
     * @dev    CEI: validate -> deactivate (state) -> refund (interaction).
     *         `nonReentrant`. Only the request owner may reclaim, and only once
     *         the cancel window has passed.
     * @param  requestId Id of the request to reclaim.
     */
    function cancelRequest(uint256 requestId) external nonReentrant {
        Request memory r = requests[requestId];
        if (!r.active) revert RequestNotActive();
        if (msg.sender != r.owner) revert NotRequestOwner();
        uint256 earliest = r.requestTimestamp + CANCEL_DELAY;
        if (block.timestamp < earliest) revert TooEarlyToCancel(block.timestamp, earliest);

        // Effect.
        requests[requestId].active = false;

        // Interaction: full escrow back to the owner.
        if (r.kind == RequestKind.Close) {
            closePending[_positionKey(r.owner, r.market, r.isLong)] = false;
            asset.safeTransfer(r.owner, r.executionFee);
        } else {
            asset.safeTransfer(r.owner, r.collateral + r.executionFee);
        }

        emit RequestCancelled(requestId, r.owner, false);
    }

    /**
     * @dev Directional slippage test for a fill at `price` against the request's
     *      `acceptable` bound (both 1e8). A long wants to BUY low / SELL high, a
     *      short the reverse:
     *        - Open  long:  fill `price <= acceptable` (entry not above the cap).
     *        - Open  short: fill `price >= acceptable` (entry not below the floor).
     *        - Close long:  fill `price >= acceptable` (exit not below the floor).
     *        - Close short: fill `price <= acceptable` (exit not above the cap).
     */
    function _withinSlippage(RequestKind kind, bool isLong, uint256 price, uint256 acceptable)
        internal
        pure
        returns (bool)
    {
        if (kind == RequestKind.Open) {
            return isLong ? price <= acceptable : price >= acceptable;
        }
        return isLong ? price >= acceptable : price <= acceptable;
    }

    // --- views -----------------------------------------------------------

    /// @notice Returns the storage key for a position.
    function getPositionKey(address owner, bytes32 market, bool isLong) external pure returns (bytes32) {
        return _positionKey(owner, market, isLong);
    }

    /**
     * @notice Borrow fee a currently-open position would owe if closed at the
     *         current block time. View-only: projects the market's index forward
     *         by the elapsed interval without mutating state. Returns 0 if no
     *         such position is open. Uncapped (does not floor against
     *         collateral); {closePosition} applies the cap on settlement.
     */
    function pendingBorrowFee(address owner, bytes32 market, bool isLong) external view returns (uint256) {
        Position memory pos = positions[_positionKey(owner, market, isLong)];
        if (pos.sizeUsd == 0) return 0;
        MarketState storage m = markets[market];
        uint256 cum = m.cumBorrowRate;
        uint256 last = m.lastBorrowAccrual;
        if (last != 0 && block.timestamp > last) {
            cum += BORROW_RATE_PER_SECOND * (block.timestamp - last);
        }
        return Math.mulDiv(pos.sizeUsd, cum - pos.entryCumBorrowRate, FEE_PRECISION, Math.Rounding.Ceil);
    }

    /**
     * @notice Signed funding a currently-open position would settle if closed at
     *         the current block time (positive ⇒ the position OWES funding,
     *         negative ⇒ it is OWED). View-only: projects both per-side indices
     *         forward by the elapsed interval without mutating state, using the
     *         same accrual math as {_accrueFunding}. Returns 0 if no such position
     *         is open. Rounding favors the pool (owed ⇒ Ceil, owed-to ⇒ Floor).
     */
    function pendingFunding(address owner, bytes32 market, bool isLong) external view returns (int256) {
        Position memory pos = positions[_positionKey(owner, market, isLong)];
        if (pos.sizeUsd == 0) return 0;

        MarketState storage m = markets[market];
        int256 longCum = m.longCumFunding;
        int256 shortCum = m.shortCumFunding;
        uint256 last = m.lastFundingAccrual;
        uint256 longSize = m.longSizeUsd;
        uint256 shortSize = m.shortSizeUsd;
        if (last != 0 && longSize > 0 && shortSize > 0 && block.timestamp > last) {
            (int256 longDelta, int256 shortDelta) = _fundingDeltas(longSize, shortSize, block.timestamp - last);
            longCum += longDelta;
            shortCum += shortDelta;
        }

        int256 cumNow = isLong ? longCum : shortCum;
        int256 delta = cumNow - pos.entryCumFunding;
        uint256 mag = SignedMath.abs(delta);
        uint256 amt =
            Math.mulDiv(pos.sizeUsd, mag, FUNDING_PRECISION, delta >= 0 ? Math.Rounding.Ceil : Math.Rounding.Floor);
        return delta >= 0 ? int256(amt) : -int256(amt);
    }

    // --- internal: P&L & aggregates --------------------------------------

    /**
     * @dev Raw, UNCAPPED P&L of a position against `exitPrice`. Returns whether
     *      the position is in profit and the absolute P&L magnitude, with no
     *      profit cap or loss floor applied.
     *
     *      Rounding always favors the pool: profit is rounded DOWN (Floor) so the
     *      pool never overpays, and loss magnitude is rounded UP (Ceil) so the
     *      pool never under-collects.
     */
    function _computeRawPnl(Position memory pos, uint256 exitPrice) internal pure returns (bool profit, uint256 pnl) {
        uint256 delta;
        if (pos.isLong) {
            profit = exitPrice >= pos.entryPrice;
            delta = profit ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
        } else {
            profit = exitPrice <= pos.entryPrice;
            delta = profit ? pos.entryPrice - exitPrice : exitPrice - pos.entryPrice;
        }

        Math.Rounding rounding = profit ? Math.Rounding.Floor : Math.Rounding.Ceil;
        pnl = Math.mulDiv(pos.sizeUsd, delta, pos.entryPrice, rounding);
    }

    /**
     * @dev Settled P&L for the CLOSE path: the raw P&L with the profit cap
     *      (MAX_PROFIT_FACTOR*collateral) and the loss floor (collateral)
     *      applied. Output is identical to PR-4a's `_computePnl`.
     */
    function _computePnl(Position memory pos, uint256 exitPrice) internal pure returns (bool profit, uint256 pnl) {
        (profit, pnl) = _computeRawPnl(pos, exitPrice);

        if (profit) {
            uint256 cap = pos.collateral * MAX_PROFIT_FACTOR;
            if (pnl > cap) pnl = cap;
        } else if (pnl > pos.collateral) {
            // Loss floored at collateral; residual bad debt is PR-5's concern.
            pnl = pos.collateral;
        }
    }

    /**
     * @dev Accrues `pos`'s market borrow index to now (exactly ONE
     *      {_accrueBorrow} call) and returns the fee this position owes over its
     *      lifetime, `sizeUsd · (cumBorrowRate − entryCumBorrowRate)`, Ceil so
     *      the pool never under-collects. Shared by close and liquidate.
     */
    function _accrueFee(Position memory pos) internal returns (uint256) {
        return
            Math.mulDiv(
                pos.sizeUsd, _accrueBorrow(pos.market) - pos.entryCumBorrowRate, FEE_PRECISION, Math.Rounding.Ceil
            );
    }

    /**
     * @dev Book effects shared by close and liquidate: delete the position,
     *      remove its size/weight from the market aggregates (refreshing the
     *      mark to `exitPrice`), and release its reserved liquidity. Performs NO
     *      borrow accrual (callers do that once via {_accrueFee}) and NO
     *      transfers — settlement follows under the caller's CEI ordering.
     */
    function _realizeClose(Position memory pos, bytes32 key, uint256 exitPrice) internal {
        delete positions[key];
        _updateMarket(pos.market, pos.isLong, pos.sizeUsd, pos.entryPrice, exitPrice, false);
        totalReserved -= pos.collateral * MAX_PROFIT_FACTOR;
    }

    /**
     * @dev Applies a position's size to its market's per-side aggregates and
     *      refreshes the cached aggregate unrealized profit.
     *      `weightPrice` is the price the weight is computed against — the entry
     *      price (same on add and remove so the contribution cancels exactly).
     *      `markPrice` is the fresh price to store as the new mark.
     */
    function _updateMarket(
        bytes32 market,
        bool isLong,
        uint256 sizeUsd,
        uint256 weightPrice,
        uint256 markPrice,
        bool isOpen
    ) internal {
        MarketState storage m = markets[market];

        uint256 oldUnrealized = _marketUnrealizedProfit(m);

        uint256 weight = Math.mulDiv(sizeUsd, WEIGHT_PRECISION, weightPrice);
        if (isLong) {
            if (isOpen) {
                m.longSizeUsd += sizeUsd;
                m.longWeight += weight;
            } else {
                m.longSizeUsd -= sizeUsd;
                m.longWeight -= weight;
            }
        } else {
            if (isOpen) {
                m.shortSizeUsd += sizeUsd;
                m.shortWeight += weight;
            } else {
                m.shortSizeUsd -= sizeUsd;
                m.shortWeight -= weight;
            }
        }

        m.lastMarkPrice = markPrice;

        uint256 newUnrealized = _marketUnrealizedProfit(m);
        totalUnrealizedProfit = totalUnrealizedProfit + newUnrealized - oldUnrealized;
    }

    /**
     * @dev Aggregate unrealized *profit* (>=0) of a market at its stored mark.
     *      Only the side that is in aggregate profit is counted; the losing
     *      side contributes nothing until realized (conservative for LPs).
     */
    function _marketUnrealizedProfit(MarketState storage m) internal view returns (uint256 unrealized) {
        uint256 price = m.lastMarkPrice;
        uint256 longValue = Math.mulDiv(price, m.longWeight, WEIGHT_PRECISION);
        if (longValue > m.longSizeUsd) unrealized += longValue - m.longSizeUsd;
        uint256 shortValue = Math.mulDiv(price, m.shortWeight, WEIGHT_PRECISION);
        if (m.shortSizeUsd > shortValue) unrealized += m.shortSizeUsd - shortValue;
    }

    // --- internal: borrow-fee accrual ------------------------------------

    /**
     * @dev Advances `market`'s borrow-fee index to the current block time and
     *      returns the up-to-date cumulative value. Because the rate is flat
     *      (size-independent), the advance `rate · elapsed` is exact for any
     *      interval, so this lazy accrual is correct with no keeper tick — gaps
     *      between trades are captured in full on the next touch. The first
     *      touch only seeds the timestamp (no retroactive accrual).
     *
     *      Touches only `cumBorrowRate`/`lastBorrowAccrual`; it never moves
     *      `totalUnrealizedProfit` or `totalReserved`, so pure time passing
     *      cannot shift LP NAV or reserved liquidity — the fee is recognized
     *      only when a close realizes it.
     */
    function _accrueBorrow(bytes32 market) internal returns (uint256) {
        MarketState storage m = markets[market];
        uint256 last = m.lastBorrowAccrual;
        if (last == 0) {
            m.lastBorrowAccrual = block.timestamp;
            return m.cumBorrowRate;
        }
        uint256 elapsed = block.timestamp - last;
        if (elapsed != 0) {
            m.cumBorrowRate += BORROW_RATE_PER_SECOND * elapsed;
            m.lastBorrowAccrual = block.timestamp;
        }
        return m.cumBorrowRate;
    }

    // --- internal: funding accrual ---------------------------------------

    /**
     * @dev Advances `market`'s signed per-side funding indices to the current
     *      block time. Funding accrues ONLY while BOTH sides hold open interest;
     *      a one-sided book (or `lastFundingAccrual == 0` first touch) accrues
     *      nothing. The heavy side's index rises by `rate·elapsed` per unit
     *      notional and the light side's falls by the same total spread over its
     *      smaller notional (credit rounded DOWN so the dust the pool clears is
     *      ≥ 0). The timestamp ALWAYS advances, so a gap during which the book was
     *      one-sided is never retro-charged when the other side later returns.
     *
     *      Like the borrow index, this touches only funding state — it never
     *      moves `totalUnrealizedProfit` or `totalReserved`, so pure time passing
     *      cannot shift LP NAV or reserved liquidity; funding is a peer-to-peer
     *      transfer recognized only when a close/liquidation realizes it.
     */
    function _accrueFunding(bytes32 market) internal {
        MarketState storage m = markets[market];
        uint256 last = m.lastFundingAccrual;
        uint256 longSize = m.longSizeUsd;
        uint256 shortSize = m.shortSizeUsd;
        if (last != 0 && longSize > 0 && shortSize > 0 && block.timestamp > last) {
            (int256 longDelta, int256 shortDelta) = _fundingDeltas(longSize, shortSize, block.timestamp - last);
            m.longCumFunding += longDelta;
            m.shortCumFunding += shortDelta;
        }
        // Always advance so one-sided gaps are never retro-charged.
        m.lastFundingAccrual = block.timestamp;
    }

    /**
     * @dev Pure core of the funding accrual: the signed increments to each side's
     *      cumulative index over `elapsed` seconds given both sides' notionals.
     *      The per-second rate is proportional to the skew magnitude
     *      (`FUNDING_COEFF · |L-S|/(L+S)`) clamped at {MAX_FUNDING_RATE_PER_SECOND}.
     *      Shared by {_accrueFunding} (mutating) and {pendingFunding} (read-only)
     *      so the two can never diverge. Assumes `L > 0 && S > 0`; returns
     *      `(0, 0)` when the book is balanced (`L == S`).
     */
    function _fundingDeltas(uint256 L, uint256 S, uint256 elapsed)
        internal
        pure
        returns (int256 longDelta, int256 shortDelta)
    {
        if (L == S) return (0, 0);

        uint256 absSkew = Math.mulDiv(L > S ? L - S : S - L, FUNDING_PRECISION, L + S); // [0, 1e18]
        uint256 rate = Math.mulDiv(FUNDING_COEFF, absSkew, FUNDING_PRECISION); // per-sec, 1e18
        if (rate > MAX_FUNDING_RATE_PER_SECOND) rate = MAX_FUNDING_RATE_PER_SECOND;

        uint256 chargePerUnit = rate * elapsed; // index increment for the heavy side
        if (L > S) {
            // Longs pay; the total (chargePerUnit·L) is spread over the smaller
            // short notional (Floor favours the pool).
            uint256 creditPerUnit = Math.mulDiv(chargePerUnit, L, S);
            longDelta = int256(chargePerUnit);
            shortDelta = -int256(creditPerUnit);
        } else {
            // Shorts pay; symmetric.
            uint256 creditPerUnit = Math.mulDiv(chargePerUnit, S, L);
            shortDelta = int256(chargePerUnit);
            longDelta = -int256(creditPerUnit);
        }
    }

    /**
     * @dev Accrues `pos`'s market funding indices to now (exactly ONE
     *      {_accrueFunding} call) and returns the SIGNED funding this position
     *      settles over its lifetime, `sizeUsd · (sideCumFunding − entryCumFunding)`
     *      (positive ⇒ the position OWES, negative ⇒ it is OWED). Rounding favours
     *      the pool: a charge rounds UP (Ceil), a credit rounds DOWN (Floor).
     *      Shared by close and liquidate.
     */
    function _accrueFundingOwed(Position memory pos) internal returns (int256 fundingOwed) {
        _accrueFunding(pos.market);
        int256 cumNow = pos.isLong ? markets[pos.market].longCumFunding : markets[pos.market].shortCumFunding;
        int256 delta = cumNow - pos.entryCumFunding; // > 0 trader OWES, < 0 trader is OWED
        uint256 mag = SignedMath.abs(delta);
        uint256 amt =
            Math.mulDiv(pos.sizeUsd, mag, FUNDING_PRECISION, delta >= 0 ? Math.Rounding.Ceil : Math.Rounding.Floor);
        fundingOwed = delta >= 0 ? int256(amt) : -int256(amt);
    }

    // --- internal: helpers -----------------------------------------------

    function _positionKey(address owner, bytes32 market, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, market, isLong));
    }

    function _requireSupportedMarket(bytes32 market) internal pure {
        if (market != MARKET_BTC && market != MARKET_ETH) revert MarketNotSupported(market);
    }
}
