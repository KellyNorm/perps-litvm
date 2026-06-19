// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SignedMath} from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
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
 * @dev    SCOPE (PR-3 + PR-4a + PR-4b + PR-5 + PR-6): open/close of one full
 *         position per (owner, market, direction); P&L settled against the pool;
 *         LP-share valuation via a cached aggregate mark; reserved-liquidity
 *         solvency; a time-based borrow fee (PR-4a) charged on notional, accrued
 *         O(1) via a per-market cumulative index and deducted from payout at
 *         close; peer-to-peer funding (PR-4b) between longs and shorts;
 *         permissionless liquidation (PR-5) of positions that breach the
 *         maintenance margin, with residual bad-debt accounting when a loss (plus
 *         accrued fee and funding) exceeds the trader's collateral; and two-step
 *         deferred execution (PR-6) as the ONLY trader entry to open/close — a
 *         request queues here and a keeper fills it next block at a price relayed
 *         on-chain at execution, so the fill price is unknowable at request time
 *         (front-running / MEV protection). There is no direct, same-transaction
 *         open/close path: only {liquidate} still reads the oracle in the same
 *         transaction as the action, by design (a liquidator must act on a fresh
 *         mark, and has no position to front-run).
 *
 *         OUT OF SCOPE — deferred to later PRs:
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
contract PositionManager is MainDemoConsumerBase, ReentrancyGuard, Ownable {
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

    /// @notice Owner-extendable registry of tradeable markets (RedStone feed ids).
    ///         New opens are gated on this set; BTC and ETH are seeded at deploy.
    ///         Only {requestOpen} consults it — close and liquidate are never
    ///         gated, so a delisted market's existing positions stay closable.
    mapping(bytes32 => bool) public supportedMarkets;

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

    /**
     * @dev Transient (memory-only) settlement outcome of a partial close, packed
     *      into a struct so {_decreasePosition}'s 12-field {PositionDecreased} emit
     *      stays within the EVM stack limit. See {_decreasePosition}.
     */
    struct DecreaseResult {
        bool profit;
        uint256 pnl;
        uint256 borrowFee;
        int256 fundingOwed;
        uint256 payout;
        uint256 remainingSizeUsd;
        uint256 remainingCollateral;
    }

    /**
     * @dev Transient (memory-only) outcome of a position increase, packed into a
     *      struct so {_increasePosition}'s 9-field {PositionIncreased} emit stays
     *      within the EVM stack limit. See {_increasePosition}.
     */
    struct IncreaseResult {
        uint256 addSize;
        uint256 newSizeUsd;
        uint256 newCollateral;
        uint256 newEntryPrice;
        uint256 newEntryBorrow;
        int256 newEntryFunding;
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

    /// @notice Whether a queued request opens a new position, closes an existing
    ///         one in full, closes a fraction of it (decrease), or adds size and
    ///         collateral to it (increase). Open, Decrease, and Increase escrow
    ///         and/or move collateral; the three non-Open kinds share the
    ///         {closePending} position-edit mutex (see {closePending}).
    enum RequestKind {
        Open,
        Close,
        Decrease,
        Increase
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
     * @param  kind             Open, Close, Decrease, or Increase.
     * @param  collateral       Collateral escrowed: the posted collateral for Open,
     *                          the added collateral for Increase, 0 for Close/Decrease.
     * @param  leverage         OVERLOADED by kind to keep the struct arity (and the
     *                          {requests} getter / test destructures) unchanged:
     *                          for Open it is the leverage multiplier; for Increase
     *                          it is the leverage applied to the added collateral
     *                          (its natural meaning); for Decrease it carries
     *                          `closeBps`, the fraction to close in basis points; for
     *                          Close it is unused (0). Each kind reads it in exactly
     *                          one sense, so the overload is unambiguous per kind.
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

    /**
     * @notice The (price, direction) gate that turns a queued Close/Decrease into a
     *         RESTING trigger order (take-profit / stop-loss / limit / stop).
     * @dev    A NON-ZERO {triggerPrice} marks the matching request as a trigger
     *         order; a zero {triggerPrice} (the default for every market request)
     *         means "no gate", so the request fills like a plain market order. The
     *         direction picks which side of the threshold is executable:
     *         {triggerAbove} == true  ⇒ executable once `price >= triggerPrice`,
     *         {triggerAbove} == false ⇒ executable once `price <= triggerPrice`.
     *
     *         One (triggerPrice, triggerAbove) pair expresses ALL of TP / SL /
     *         limit / stop — the TP-vs-SL label is a frontend concern, not the
     *         contract's. A LONG take-profit rests ABOVE entry (triggerAbove=true);
     *         a LONG stop-loss rests BELOW entry (triggerAbove=false); a SHORT is
     *         the mirror.
     *
     *         MUTEX: trigger exits share the {closePending} position-edit mutex with
     *         plain closes/decreases/increases, so a position can rest AT MOST ONE
     *         exit at a time — no simultaneous TP+SL / OCO bracket yet (deferred).
     *
     *         STOP ORDERS: a stop-type order (e.g. a stop-loss, which fires INTO an
     *         adverse move) should be queued with a PERMISSIVE {Request.acceptablePrice}
     *         so the {_withinSlippage} bound does not keep it from firing when the
     *         market gaps through the trigger — otherwise the order would rest
     *         (revert) on a slippage miss exactly when it most needs to fire.
     * @param  triggerPrice Threshold mark (1e8); 0 ⇒ not a trigger order.
     * @param  triggerAbove True ⇒ fires at/above the threshold, false ⇒ at/below.
     */
    struct Trigger {
        uint256 triggerPrice;
        bool triggerAbove;
    }

    /// @notice Resting trigger gates keyed by requestId. Unset (triggerPrice == 0)
    ///         for every plain market request; set only by {requestTriggerClose} /
    ///         {requestTriggerDecrease} and cleared on fill or cancel.
    mapping(uint256 => Trigger) public triggers;

    /// @notice Monotonic id assigned to the next request.
    uint256 public nextRequestId;

    /// @notice General pending position-edit mutex: true while a position key has a
    ///         live Close, Decrease, OR Increase request, so at most one edit to an
    ///         existing position can be queued at a time (e.g. a close and an
    ///         increase cannot both be pending on one position). Open does not use
    ///         it (it creates a position rather than editing one). Set at request
    ///         time and cleared on fill or any cancel. Name kept for ABI/test
    ///         stability though its meaning is now broader than close-only.
    mapping(bytes32 => bool) public closePending;

    /// @dev Set ONLY for the duration of {executeRequest}'s oracle read to the
    ///      request's earliest-execution timestamp; the {validateTimestamp}
    ///      override rejects any price stamped before it (replay/freshness guard).
    ///      Always 0 on the {liquidate} path, so its timestamp validation is
    ///      completely unaffected.
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
    error InvalidCloseBps(uint256 bps);

    // trigger exits (PR-10a)
    error InvalidTriggerPrice();
    error TriggerNotMet(uint256 price, uint256 triggerPrice, bool triggerAbove);
    error SlippageNotMet(uint256 price, uint256 acceptablePrice);

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

    /// @dev `closeBps` is the fraction (basis points) to decrease, carried in the
    ///      request's overloaded `leverage` field. See {requestDecrease}.
    event DecreaseRequested(
        uint256 indexed requestId,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 closeBps,
        uint256 acceptablePrice,
        uint256 executionFee
    );

    /// @dev Emitted when a fraction `closeBps` of a position is closed. The
    ///      remainder keeps the original entry price and entry fee/funding indices;
    ///      `remainingSizeUsd`/`remainingCollateral` are the post-decrease values.
    event PositionDecreased(
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 closeBps,
        uint256 exitPrice,
        bool profit,
        uint256 pnl,
        uint256 borrowFee,
        int256 funding,
        uint256 payout,
        uint256 remainingSizeUsd,
        uint256 remainingCollateral
    );

    /// @dev `addCollateral` is escrowed (like an Open) and `addLeverage` carries
    ///      the natural leverage applied to it (carried in the request's `leverage`
    ///      field). See {requestIncrease}.
    event IncreaseRequested(
        uint256 indexed requestId,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 addCollateral,
        uint256 addLeverage,
        uint256 acceptablePrice,
        uint256 executionFee
    );

    /// @dev Emitted when size `addSize` and collateral `addCollateral` are merged
    ///      into a position at the keeper-filled `fillPrice`. The position keeps a
    ///      size-weighted blended entry price and blended entry fee/funding indices;
    ///      `newSizeUsd`/`newCollateral`/`newEntryPrice` are the post-merge values.
    event PositionIncreased(
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 fillPrice,
        uint256 addCollateral,
        uint256 addSize,
        uint256 newSizeUsd,
        uint256 newCollateral,
        uint256 newEntryPrice
    );

    // trigger exits (PR-10a)

    /// @dev Emitted when a RESTING trigger CLOSE is queued. The order fills only
    ///      once the mark crosses `triggerPrice` (side per `triggerAbove`) AND the
    ///      `acceptablePrice` slippage bound holds; until then a keeper's execute
    ///      reverts and the request stays active. See {requestTriggerClose}.
    event TriggerCloseRequested(
        uint256 indexed requestId,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove,
        uint256 executionFee
    );

    /// @dev Emitted when a RESTING trigger DECREASE is queued: a partial close of
    ///      fraction `closeBps` that fills only once the mark crosses `triggerPrice`
    ///      (side per `triggerAbove`) AND the slippage bound holds. See
    ///      {requestTriggerDecrease}.
    event TriggerDecreaseRequested(
        uint256 indexed requestId,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 closeBps,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove,
        uint256 executionFee
    );

    // trigger entries (PR-10b)

    /// @dev Emitted when a RESTING trigger OPEN is queued: a limit/stop entry that
    ///      fills only once the mark crosses `triggerPrice` (side per `triggerAbove`)
    ///      AND the `acceptablePrice` slippage bound holds; until then a keeper's
    ///      execute reverts and the request stays active. See {requestTriggerOpen}.
    event TriggerOpenRequested(
        uint256 indexed requestId,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove,
        uint256 executionFee
    );

    /// @dev Emitted when a RESTING trigger INCREASE is queued: a limit add of
    ///      `addCollateral`/`addLeverage` that fills only once the mark crosses
    ///      `triggerPrice` (side per `triggerAbove`) AND the slippage bound holds.
    ///      See {requestTriggerIncrease}.
    event TriggerIncreaseRequested(
        uint256 indexed requestId,
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 addCollateral,
        uint256 addLeverage,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove,
        uint256 executionFee
    );

    event RequestExecuted(uint256 indexed requestId, address indexed keeper, uint256 executionPrice);

    /// @dev `slippage` is true when the executor cancels on a bound miss; false on
    ///      an owner reclaim via {cancelRequest}. Either way the full escrow
    ///      refunds to the owner.
    event RequestCancelled(uint256 indexed requestId, address indexed owner, bool slippage);

    // market registry (PR-8)
    event MarketAdded(bytes32 indexed market);
    event MarketRemoved(bytes32 indexed market);

    /**
     * @param pool_ The deployed {LiquidityPool} counterparty.
     * @dev   Reads the pool's asset and pre-approves the pool to pull absorbed
     *        losses via {LiquidityPool.receiveLoss}. The pool must be linked to
     *        this manager separately via {LiquidityPool.setPositionManager}. The
     *        deployer becomes the {Ownable} owner — the sole, market-registry-only
     *        admin (see {addMarket}/{removeMarket}); it has no other privilege.
     *        BTC and ETH are seeded as supported so existing behavior is preserved.
     */
    constructor(LiquidityPool pool_) Ownable(msg.sender) {
        pool = pool_;
        IERC20 asset_ = IERC20(pool_.asset());
        asset = asset_;
        asset_.forceApprove(address(pool_), type(uint256).max);

        supportedMarkets[MARKET_BTC] = true;
        supportedMarkets[MARKET_ETH] = true;
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
        // while {executeRequest} has the slot set; it is 0 on the {liquidate}
        // path, so that path is completely unaffected.
        uint256 minTs = _minExecutionTimestamp;
        if (minTs != 0 && receivedSeconds < minTs) revert PriceBeforeRequest(receivedSeconds, minTs);
    }

    // --- market registry (owner-only; PR-8) ------------------------------

    /**
     * @notice Add `market` to the supported set so traders may open positions on
     *         it. Owner-only — this is the contract's sole admin power and is
     *         scoped strictly to the registry; it grants no control over funds,
     *         pricing, funding, or liquidation. Idempotent.
     * @dev    Affects only the {requestOpen} gate. Existing positions and the
     *         close/liquidate paths are unaffected.
     */
    function addMarket(bytes32 market) external onlyOwner {
        supportedMarkets[market] = true;
        emit MarketAdded(market);
    }

    /**
     * @notice Remove `market` from the supported set, blocking NEW opens on it.
     *         Owner-only (same scope as {addMarket}). Idempotent.
     * @dev    Delisting only blocks {requestOpen}; positions already open on
     *         `market` remain fully closable and liquidatable, since neither path
     *         consults {supportedMarkets}.
     */
    function removeMarket(bytes32 market) external onlyOwner {
        supportedMarkets[market] = false;
        emit MarketRemoved(market);
    }

    // --- trading ---------------------------------------------------------

    /**
     * @notice Price-parameterized core of the open path. Holds the current open
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
     * @notice Price-parameterized core of the close path. Holds the current
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
     * @notice Price-parameterized core of the partial-close (decrease) path:
     *         realize a fraction `closeBps` of a position at `exitPrice`, paying out
     *         that fraction's P&L / borrow fee / funding and returning that
     *         fraction's collateral, while leaving a SMALLER position behind.
     * @dev    The closed fraction is modeled as a SYNTHETIC sub-position that shares
     *         the original's entry price and entry fee/funding indices but has the
     *         scaled `sizeUsd`/`collateral`. It is then settled by EXACTLY the
     *         full-close rules — {_computePnl}, {_accrueFee}, {_accrueFundingOwed},
     *         and {_settle} are reused UNCHANGED — so a 50% decrease of a size-S
     *         position settles identically to a full close of an independent
     *         size-S/2 position with the same entry, collateral, and timing.
     *
     *         INVARIANTS (why there is no double-count):
     *         - The remainder keeps the ORIGINAL entry price and the ORIGINAL entry
     *           fee/funding indices. The closed fraction stops accruing at close
     *           time; the remainder keeps accruing from entry on its smaller size,
     *           so nothing is charged twice and nothing is dropped.
     *         - {_updateMarket} removes EXACTLY `closedSize` and its entry-priced
     *           weight `closedSize/entry`, leaving the remainder's book contribution
     *           intact (the surviving `sizeUsd`/`entry` are unchanged).
     *         - Reserve releases EXACTLY `closedCollateral * MAX_PROFIT_FACTOR`,
     *           matching the slice of reserve the closed collateral backed.
     *         - {_computePnl}'s cap/floor apply to the synthetic sub-position, so the
     *           profit cap / loss floor scale proportionally with the closed size.
     *
     *         CEI: compute P&L -> snapshot fee/funding & shrink storage (effects) ->
     *         settle the closed fraction (interaction). Runs under
     *         {executeRequest}'s `nonReentrant` guard (so it adds none of its own).
     * @param  owner     Position owner (the trader).
     * @param  market    Market feed id.
     * @param  isLong    Direction of the position to decrease.
     * @param  closeBps  Fraction to close, in basis points, in (0, 10000).
     * @param  exitPrice Exit mark price (1e8), supplied by the caller.
     * @return payout    Asset paid out to the trader for the closed fraction.
     */
    function _decreasePosition(address owner, bytes32 market, bool isLong, uint256 closeBps, uint256 exitPrice)
        internal
        returns (uint256 payout)
    {
        bytes32 key = _positionKey(owner, market, isLong);
        Position memory pos = positions[key];
        if (pos.sizeUsd == 0) revert NoOpenPosition();
        if (exitPrice == 0) revert InvalidPrice();

        uint256 closedSize = Math.mulDiv(pos.sizeUsd, closeBps, BPS_DENOMINATOR);
        uint256 closedCollateral = Math.mulDiv(pos.collateral, closeBps, BPS_DENOMINATOR);

        // Capture the remainder NOW, before the synthetic sub-position is built:
        // `closedPos = pos` aliases `pos`'s memory, so mutating `closedPos.sizeUsd`
        // below would also overwrite `pos.sizeUsd`. The remainder is what survives
        // in storage — same entry price & entry indices, smaller size/collateral.
        DecreaseResult memory d;
        d.remainingSizeUsd = pos.sizeUsd - closedSize;
        d.remainingCollateral = pos.collateral - closedCollateral;

        // Synthetic sub-position: same entry & indices, scaled size/collateral.
        Position memory closedPos = pos;
        closedPos.sizeUsd = closedSize;
        closedPos.collateral = closedCollateral;

        // Settlement outputs packed into the same memory struct so the 12-field emit
        // in the settle helper stays within the EVM stack limit.
        (d.profit, d.pnl) = _computePnl(closedPos, exitPrice); // proportional cap/floor
        d.borrowFee = _accrueFee(closedPos); // accrues market borrow index once
        d.fundingOwed = _accrueFundingOwed(closedPos); // accrues market funding index once

        // Effects: shrink in place; entry price & entry indices UNCHANGED.
        positions[key].sizeUsd = d.remainingSizeUsd;
        positions[key].collateral = d.remainingCollateral;
        _updateMarket(market, isLong, closedSize, pos.entryPrice, exitPrice, false);
        totalReserved -= closedCollateral * MAX_PROFIT_FACTOR;

        // Interaction + event in a helper to bound this frame's stack.
        payout = _settleDecrease(closedPos, closeBps, exitPrice, d);
    }

    /**
     * @dev Settles a decrease's closed fraction by the full-close rules ({_settle},
     *      reused UNCHANGED) and emits {PositionDecreased} with the post-shrink
     *      remainder read from storage. Interactions only — all state effects ran in
     *      {_decreasePosition} before this call, so it runs under that path's CEI
     *      ordering and the `nonReentrant` guard. Split out solely to keep the
     *      caller's stack within the EVM limit (mirrors {_settleLiquidation}).
     */
    function _settleDecrease(Position memory closedPos, uint256 closeBps, uint256 exitPrice, DecreaseResult memory d)
        internal
        returns (uint256 payout)
    {
        payout = _settle(closedPos, d.profit, d.pnl, d.borrowFee, d.fundingOwed);

        emit PositionDecreased(
            closedPos.owner,
            closedPos.market,
            closedPos.isLong,
            closeBps,
            exitPrice,
            d.profit,
            d.pnl,
            d.borrowFee,
            d.fundingOwed,
            payout,
            d.remainingSizeUsd,
            d.remainingCollateral
        );
    }

    /**
     * @notice Price-parameterized core of the INCREASE path: add `addCollateral` of
     *         collateral and `addCollateral * addLeverage` of notional to an open
     *         position at `fillPrice`, merging into it with a size-weighted blended
     *         entry price AND size-weighted blended entry borrow/funding indices.
     * @dev    THE KEY INVARIANT — blending the entry INDICES, not just the price,
     *         makes the future accrual EXACTLY equal to "the old portion accrues from
     *         its original entry index and the new portion accrues from this increase
     *         moment," as if the two legs aged independently. Concretely, for the
     *         borrow index, closing the merged size `N` at a future cumulative index
     *         `C` charges `N·(C − newEntryBorrow)`, and choosing
     *         `newEntryBorrow = (sizeUsd·entryBorrow + addSize·curBorrow)/N` makes that
     *         identically `sizeUsd·(C − entryBorrow) + addSize·(C − curBorrow)` — the
     *         sum of the two legs aging from their own entry moments. The funding
     *         index blends the same way (signed). This is WHY no mid-life
     *         fee/funding realization and no extra transfer are needed: nothing is
     *         settled now, only re-based.
     *
     *         The blended entry PRICE is chosen so the book weight stays additive:
     *         `newSize/newEntry == sizeUsd/entry + addSize/fillPrice`, i.e. the merged
     *         position's `Σ size/price` equals the old leg's plus a fresh
     *         `addSize/fillPrice` chunk — exactly what {_updateMarket} adds below. All
     *         rounding favors the pool: the entry price rounds UP for a long and DOWN
     *         for a short (worse cost basis for the trader), and the borrow-index
     *         increment floors (keeping the blended entry index lower ⇒ more fee owed).
     *
     *         Collateral was escrowed at request time, so there is NO pull here (like
     *         {_openPosition} with `pullCollateral=false`). Runs under
     *         {executeRequest}'s `nonReentrant` guard (adds none of its own). The
     *         market borrow/funding indices are advanced to NOW over the OLD skew
     *         (before this increase changes OI), realizing nothing — exactly the
     *         pre-trade accrual {_openPosition} performs.
     * @param  owner        Position owner (the trader).
     * @param  market       Market feed id.
     * @param  isLong       Direction of the position to increase.
     * @param  addCollateral Collateral added (asset units; already escrowed).
     * @param  addLeverage  Leverage applied to `addCollateral`.
     * @param  fillPrice    Increase mark price (1e8), supplied by the caller.
     */
    function _increasePosition(
        address owner,
        bytes32 market,
        bool isLong,
        uint256 addCollateral,
        uint256 addLeverage,
        uint256 fillPrice
    ) internal {
        bytes32 key = _positionKey(owner, market, isLong);
        Position memory pos = positions[key];
        if (pos.sizeUsd == 0) revert NoOpenPosition();
        if (fillPrice == 0) revert InvalidPrice();

        IncreaseResult memory res;
        res.addSize = addCollateral * addLeverage;
        res.newSizeUsd = pos.sizeUsd + res.addSize;
        res.newCollateral = pos.collateral + addCollateral;

        // Solvency gate on the incremental reserve (the SAME check {_openPosition}
        // performs): reserved liquidity must stay within the configured fraction of
        // the pool balance.
        uint256 reserve = addCollateral * MAX_PROFIT_FACTOR;
        if (totalReserved + reserve > Math.mulDiv(asset.balanceOf(address(pool)), MAX_UTILIZATION_BPS, BPS_DENOMINATOR))
        {
            revert ExceedsUtilization();
        }

        // Compute the blended entry price and the blended entry borrow/funding
        // indices (which also advances both market indices to NOW over the OLD skew,
        // before the OI below changes them). Split into a helper to bound this
        // frame's stack (no via-ir).
        _blendEntry(market, isLong, pos, fillPrice, res);

        // Effects: write the merged position (collateral, size, blended entry & both
        // blended entry indices) and bump the reserve.
        positions[key].collateral = res.newCollateral;
        positions[key].sizeUsd = res.newSizeUsd;
        positions[key].entryPrice = res.newEntryPrice;
        positions[key].entryCumBorrowRate = res.newEntryBorrow;
        positions[key].entryCumFunding = res.newEntryFunding;
        totalReserved += reserve;

        // Safety net: the merged leverage never exceeds the cap (both the prior leg
        // and the added chunk are individually <= MAX_LEVERAGE, so the sum is too).
        assert(res.newSizeUsd / res.newCollateral <= MAX_LEVERAGE);

        // Aggregates: add addSize to OI and addSize/fillPrice to the weight, exactly
        // the chunk the blended entry price accounts for. Collateral was escrowed at
        // request time -> no pull here (like Open with pullCollateral=false).
        _updateMarket(market, isLong, res.addSize, fillPrice, fillPrice, true);

        emit PositionIncreased(
            owner,
            market,
            isLong,
            fillPrice,
            addCollateral,
            res.addSize,
            res.newSizeUsd,
            res.newCollateral,
            res.newEntryPrice
        );
    }

    /**
     * @dev Advances `market`'s borrow & funding indices to now over the OLD skew
     *      (realizing nothing — the same pre-trade accrual {_openPosition} does),
     *      then fills `res` with the size-weighted blended entry price and blended
     *      entry borrow/funding indices for the merge. Split out of
     *      {_increasePosition} solely to keep that frame within the EVM stack limit
     *      (no via-ir). `res.addSize`/`res.newSizeUsd` must already be set.
     *
     *      Blended entry PRICE (pool-favorable: long UP / short DOWN) keeps the book
     *      weight additive — `newSizeUsd/newEntryPrice == sizeUsd/entry +
     *      addSize/fillPrice`. Blended entry BORROW/FUNDING indices are size-weighted
     *      so future accrual equals the two legs aging from their own entry moments
     *      (see {_increasePosition}); the borrow increment floors (pool-favorable),
     *      and the funding increment truncates its magnitude consistently with
     *      {_accrueFundingOwed} (sign preserved; magnitude negligible).
     */
    function _blendEntry(bytes32 market, bool isLong, Position memory pos, uint256 fillPrice, IncreaseResult memory res)
        internal
    {
        uint256 curBorrow = _accrueBorrow(market);
        _accrueFunding(market);
        int256 curFunding = isLong ? markets[market].longCumFunding : markets[market].shortCumFunding;

        res.newEntryPrice = Math.mulDiv(
            res.newSizeUsd,
            pos.entryPrice * fillPrice,
            pos.sizeUsd * fillPrice + res.addSize * pos.entryPrice,
            isLong ? Math.Rounding.Ceil : Math.Rounding.Floor
        );

        res.newEntryBorrow =
            pos.entryCumBorrowRate + Math.mulDiv(res.addSize, curBorrow - pos.entryCumBorrowRate, res.newSizeUsd);

        int256 fDelta = curFunding - pos.entryCumFunding;
        uint256 fInc = Math.mulDiv(res.addSize, SignedMath.abs(fDelta), res.newSizeUsd);
        res.newEntryFunding = pos.entryCumFunding + (fDelta >= 0 ? int256(fInc) : -int256(fInc));
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
     *      only from {_closePosition} after all state effects, so it runs under
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
     * @dev    The sole entry to open a position (front-running protection). CEI:
     *         validate -> record request (state) -> pull escrow (interaction).
     *         `nonReentrant`. Param checks mirror {_openPosition} so a bad request
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
     * @dev    The sole entry to close a position (front-running protection). CEI:
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
     * @notice Queue a deferred partial CLOSE (decrease) of the caller's open
     *         position: close a fraction `closeBps` of it at a keeper-filled price,
     *         leaving a SMALLER position with the SAME entry price and SAME entry
     *         fee/funding indices. Like {requestClose}, only the {EXECUTION_FEE} is
     *         escrowed (the position's collateral is already held). A keeper fills
     *         it later at a post-request price.
     * @dev    Rides the same two-step machinery as a full close: it sets
     *         {closePending} on the position key (so a decrease and a close cannot
     *         be queued at once) and the executor settles it via {_decreasePosition}.
     *         CEI: validate -> mark pending & record request (state) -> pull fee
     *         (interaction). `nonReentrant`.
     *
     *         The fraction is carried in the request's OVERLOADED `leverage` field
     *         (Close/Decrease never use it as leverage); see {Request} and
     *         {executeRequest}. `closeBps` is strictly within (0, 10000): a full
     *         close must go through {requestClose}, and a 0% close is a no-op.
     * @param  market          Market feed id.
     * @param  isLong          Direction of the position to decrease.
     * @param  closeBps        Fraction to close, in basis points, in (0, 10000).
     * @param  acceptablePrice Directional slippage bound (1e8); see {_withinSlippage}.
     * @return requestId       Id of the queued request.
     */
    function requestDecrease(bytes32 market, bool isLong, uint256 closeBps, uint256 acceptablePrice)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        if (closeBps == 0 || closeBps >= BPS_DENOMINATOR) revert InvalidCloseBps(closeBps);

        bytes32 key = _positionKey(msg.sender, market, isLong);
        Position memory pos = positions[key];
        if (pos.sizeUsd == 0) revert NoOpenPosition();
        if (closePending[key]) revert CloseAlreadyPending();

        // Dust guard: the remainder must still clear the minimum-collateral floor.
        uint256 remainingCollateral = pos.collateral - Math.mulDiv(pos.collateral, closeBps, BPS_DENOMINATOR);
        if (remainingCollateral < MIN_COLLATERAL) revert CollateralTooLow(remainingCollateral, MIN_COLLATERAL);

        // Effects.
        closePending[key] = true;
        requestId = nextRequestId++;
        requests[requestId] = Request({
            owner: msg.sender,
            market: market,
            isLong: isLong,
            kind: RequestKind.Decrease,
            collateral: 0,
            leverage: closeBps, // OVERLOAD: Decrease carries closeBps here (see {Request}).
            acceptablePrice: acceptablePrice,
            executionFee: EXECUTION_FEE,
            requestTimestamp: block.timestamp,
            active: true
        });

        // Interaction LAST (CEI).
        asset.safeTransferFrom(msg.sender, address(this), EXECUTION_FEE);

        emit DecreaseRequested(requestId, msg.sender, market, isLong, closeBps, acceptablePrice, EXECUTION_FEE);
    }

    /**
     * @notice Queue a deferred INCREASE of the caller's open position: add
     *         `addCollateral` of collateral and `addCollateral * addLeverage` of
     *         notional at a keeper-filled price, merging into the existing position
     *         with a size-weighted blended entry price and blended entry fee/funding
     *         indices. Mirrors {requestOpen}'s inputs (collateral + leverage): the
     *         `addCollateral` and the {EXECUTION_FEE} are escrowed here now, and a
     *         keeper fills it later at a post-request price.
     * @dev    Rides the same two-step machinery as a close/decrease: it sets the
     *         {closePending} position-edit mutex on the key (so an increase cannot be
     *         queued alongside a close or decrease) and the executor settles it via
     *         {_increasePosition}. CEI: validate fast (BEFORE escrow, mirroring
     *         {requestDecrease}) -> mark pending & record request (state) -> pull the
     *         collateral + fee escrow (interaction). `nonReentrant`.
     *
     *         The added leverage is carried in the request's OVERLOADED `leverage`
     *         field in its NATURAL sense (Increase reads it as leverage, never as
     *         closeBps); see {Request} and {executeRequest}.
     * @param  market          Market feed id.
     * @param  isLong          Direction of the position to increase.
     * @param  addCollateral   Collateral to add (asset units, >= MIN_COLLATERAL).
     * @param  addLeverage     Leverage applied to the added collateral, in
     *                         [MIN_LEVERAGE, MAX_LEVERAGE].
     * @param  acceptablePrice Directional slippage bound (1e8); an increase BUYS into
     *                         the position, so it uses the OPEN direction; see
     *                         {_withinSlippage}.
     * @return requestId       Id of the queued request.
     */
    function requestIncrease(
        bytes32 market,
        bool isLong,
        uint256 addCollateral,
        uint256 addLeverage,
        uint256 acceptablePrice
    ) external nonReentrant returns (uint256 requestId) {
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        if (addLeverage < MIN_LEVERAGE || addLeverage > MAX_LEVERAGE) revert LeverageOutOfRange(addLeverage);
        if (addCollateral < MIN_COLLATERAL) revert CollateralTooLow(addCollateral, MIN_COLLATERAL);

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
            kind: RequestKind.Increase,
            collateral: addCollateral,
            leverage: addLeverage, // natural meaning (leverage applied to addCollateral)
            acceptablePrice: acceptablePrice,
            executionFee: EXECUTION_FEE,
            requestTimestamp: block.timestamp,
            active: true
        });

        // Interaction LAST (CEI): escrow collateral + fee like an Open.
        asset.safeTransferFrom(msg.sender, address(this), addCollateral + EXECUTION_FEE);

        emit IncreaseRequested(
            requestId, msg.sender, market, isLong, addCollateral, addLeverage, acceptablePrice, EXECUTION_FEE
        );
    }

    /**
     * @notice Queue a RESTING trigger CLOSE of the caller's open position: an
     *         ordinary deferred full close PLUS a (triggerPrice, triggerAbove) gate.
     *         A keeper's execute fills it only once the mark crosses the trigger AND
     *         the slippage bound holds; until then the execute REVERTS and the
     *         request stays active (the keeper retries) — it never cancels on the
     *         trigger miss. This is the only behavioral difference from
     *         {requestClose}; the escrow, mutex, and fill core are identical.
     * @dev    Validation mirrors {requestClose} (non-zero acceptablePrice; position
     *         exists; the {closePending} mutex is free) PLUS a non-zero
     *         `triggerPrice`. CEI: validate -> mark pending & record request +
     *         trigger (state) -> pull fee (interaction). `nonReentrant`.
     *
     *         A take-profit rests on the favorable side of entry, a stop-loss on the
     *         adverse side; the contract does not distinguish them (see {Trigger}).
     *         For a stop-type order, pass a PERMISSIVE `acceptablePrice` so adverse
     *         slippage on the gap-through does not keep it from firing.
     * @param  market          Market feed id.
     * @param  isLong          Direction of the position to close.
     * @param  acceptablePrice Directional slippage bound (1e8); see {_withinSlippage}.
     * @param  triggerPrice    Threshold mark (1e8) the fill price must cross.
     * @param  triggerAbove    True ⇒ fires at/above the threshold, false ⇒ at/below.
     * @return requestId       Id of the queued request.
     */
    function requestTriggerClose(
        bytes32 market,
        bool isLong,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove
    ) external nonReentrant returns (uint256 requestId) {
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        if (triggerPrice == 0) revert InvalidTriggerPrice();

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
        triggers[requestId] = Trigger({triggerPrice: triggerPrice, triggerAbove: triggerAbove});

        // Interaction LAST (CEI).
        asset.safeTransferFrom(msg.sender, address(this), EXECUTION_FEE);

        emit TriggerCloseRequested(
            requestId, msg.sender, market, isLong, acceptablePrice, triggerPrice, triggerAbove, EXECUTION_FEE
        );
    }

    /**
     * @notice Queue a RESTING trigger DECREASE of the caller's open position: an
     *         ordinary deferred partial close of fraction `closeBps` PLUS a
     *         (triggerPrice, triggerAbove) gate. Like {requestTriggerClose}, a
     *         keeper's execute fills it only once the mark crosses the trigger AND
     *         the slippage bound holds; until then the execute REVERTS and the
     *         request stays active. The escrow, mutex, and decrease fill core are
     *         identical to {requestDecrease}.
     * @dev    Validation mirrors {requestDecrease} EXACTLY (non-zero acceptablePrice;
     *         `closeBps` in (0, 10000) else {InvalidCloseBps}; position exists; the
     *         {closePending} mutex is free; the dust guard requires the remaining
     *         collateral to clear {MIN_COLLATERAL}) PLUS a non-zero `triggerPrice`.
     *         CEI: validate -> mark pending & record request + trigger (state) ->
     *         pull fee (interaction). `nonReentrant`. The fraction is carried in the
     *         request's OVERLOADED `leverage` field (see {Request}).
     * @param  market          Market feed id.
     * @param  isLong          Direction of the position to decrease.
     * @param  closeBps        Fraction to close, in basis points, in (0, 10000).
     * @param  acceptablePrice Directional slippage bound (1e8); see {_withinSlippage}.
     * @param  triggerPrice    Threshold mark (1e8) the fill price must cross.
     * @param  triggerAbove    True ⇒ fires at/above the threshold, false ⇒ at/below.
     * @return requestId       Id of the queued request.
     */
    function requestTriggerDecrease(
        bytes32 market,
        bool isLong,
        uint256 closeBps,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove
    ) external nonReentrant returns (uint256 requestId) {
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        if (closeBps == 0 || closeBps >= BPS_DENOMINATOR) revert InvalidCloseBps(closeBps);
        if (triggerPrice == 0) revert InvalidTriggerPrice();

        bytes32 key = _positionKey(msg.sender, market, isLong);
        Position memory pos = positions[key];
        if (pos.sizeUsd == 0) revert NoOpenPosition();
        if (closePending[key]) revert CloseAlreadyPending();

        // Dust guard: the remainder must still clear the minimum-collateral floor.
        uint256 remainingCollateral = pos.collateral - Math.mulDiv(pos.collateral, closeBps, BPS_DENOMINATOR);
        if (remainingCollateral < MIN_COLLATERAL) revert CollateralTooLow(remainingCollateral, MIN_COLLATERAL);

        // Effects.
        closePending[key] = true;
        requestId = nextRequestId++;
        requests[requestId] = Request({
            owner: msg.sender,
            market: market,
            isLong: isLong,
            kind: RequestKind.Decrease,
            collateral: 0,
            leverage: closeBps, // OVERLOAD: Decrease carries closeBps here (see {Request}).
            acceptablePrice: acceptablePrice,
            executionFee: EXECUTION_FEE,
            requestTimestamp: block.timestamp,
            active: true
        });
        triggers[requestId] = Trigger({triggerPrice: triggerPrice, triggerAbove: triggerAbove});

        // Interaction LAST (CEI).
        asset.safeTransferFrom(msg.sender, address(this), EXECUTION_FEE);

        emit TriggerDecreaseRequested(
            requestId, msg.sender, market, isLong, closeBps, acceptablePrice, triggerPrice, triggerAbove, EXECUTION_FEE
        );
    }

    /**
     * @notice Queue a RESTING trigger OPEN: a limit/stop entry. An ordinary deferred
     *         open PLUS a (triggerPrice, triggerAbove) gate. A keeper's execute fills
     *         it only once the mark crosses the trigger AND the slippage bound holds;
     *         until then the execute REVERTS and the request stays active (the keeper
     *         retries) — it never cancels on the trigger miss. The escrow and fill core
     *         are identical to {requestOpen}; the only new behavior is the gate, which
     *         {executeRequest} already applies kind-agnostically from {triggers}.
     * @dev    Param checks: non-zero acceptablePrice; leverage in [MIN, MAX];
     *         collateral >= MIN_COLLATERAL; PLUS a non-zero `triggerPrice`. The
     *         supported-market gate is deferred to the fill: {_openPosition} calls
     *         {_requireSupportedMarket}, so a market delisted between request and fill
     *         is rejected at execution rather than rested forever. A position must NOT
     *         already exist on the key: a limit entry can't sit behind a live position
     *         on the same key — use a limit INCREASE for that. This is intentionally
     *         stricter than {requestOpen} (correct for a resting order; the fill would
     *         otherwise revert {PositionAlreadyOpen} forever).
     *
     *         NO {closePending} mutex: an open CREATES a position, it does not edit one,
     *         so it mirrors {requestOpen} and shares no mutex with closes/decreases/
     *         increases. CEI: validate -> record request + trigger (state) -> pull the
     *         collateral + fee escrow (interaction). `nonReentrant`.
     *
     *         For a stop-type entry (a breakout buy that fires INTO the move), pass a
     *         PERMISSIVE `acceptablePrice` so adverse slippage on the gap-through does
     *         not keep it from firing. See {Trigger}.
     * @param  market          Market feed id (MARKET_BTC or MARKET_ETH).
     * @param  isLong          True for long, false for short.
     * @param  collateral      Collateral to post (asset units, >= MIN_COLLATERAL).
     * @param  leverage        Leverage multiplier in [MIN_LEVERAGE, MAX_LEVERAGE].
     * @param  acceptablePrice Directional slippage bound (1e8); see {_withinSlippage}.
     * @param  triggerPrice    Threshold mark (1e8) the fill price must cross.
     * @param  triggerAbove    True ⇒ fires at/above the threshold, false ⇒ at/below.
     * @return requestId       Id of the queued request.
     */
    function requestTriggerOpen(
        bytes32 market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove
    ) external nonReentrant returns (uint256 requestId) {
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE) revert LeverageOutOfRange(leverage);
        if (collateral < MIN_COLLATERAL) revert CollateralTooLow(collateral, MIN_COLLATERAL);
        if (triggerPrice == 0) revert InvalidTriggerPrice();

        // A limit entry can't sit behind a live position on the same key — use a
        // limit INCREASE for that. Intentionally stricter than {requestOpen}: a
        // resting trigger-open must never overwrite a live position (the fill would
        // revert {PositionAlreadyOpen} anyway), so reject it up front.
        bytes32 key = _positionKey(msg.sender, market, isLong);
        if (positions[key].sizeUsd != 0) revert PositionAlreadyOpen();

        // Effects. No {closePending} mutex: an open creates a position, it does not
        // edit one (mirror {requestOpen}).
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
        triggers[requestId] = Trigger({triggerPrice: triggerPrice, triggerAbove: triggerAbove});

        // Interaction LAST (CEI): escrow collateral + fee like an Open.
        asset.safeTransferFrom(msg.sender, address(this), collateral + EXECUTION_FEE);

        emit TriggerOpenRequested(
            requestId,
            msg.sender,
            market,
            isLong,
            collateral,
            leverage,
            acceptablePrice,
            triggerPrice,
            triggerAbove,
            EXECUTION_FEE
        );
    }

    /**
     * @notice Queue a RESTING trigger INCREASE: a limit add to the caller's open
     *         position. An ordinary deferred increase PLUS a (triggerPrice,
     *         triggerAbove) gate. Like {requestTriggerOpen}, a keeper's execute fills
     *         it only once the mark crosses the trigger AND the slippage bound holds;
     *         until then the execute REVERTS and the request stays active. The escrow,
     *         mutex, and increase fill core are identical to {requestIncrease}.
     * @dev    Validation mirrors {requestIncrease} EXACTLY (non-zero acceptablePrice;
     *         `addLeverage` in [MIN, MAX]; `addCollateral` >= MIN_COLLATERAL; position
     *         exists; the {closePending} mutex is free) PLUS a non-zero `triggerPrice`.
     *         CEI: validate -> mark pending & record request + trigger (state) -> pull
     *         the collateral + fee escrow (interaction). `nonReentrant`. The added
     *         leverage is carried in the request's OVERLOADED `leverage` field in its
     *         NATURAL sense (see {Request}).
     * @param  market          Market feed id.
     * @param  isLong          Direction of the position to increase.
     * @param  addCollateral   Collateral to add (asset units, >= MIN_COLLATERAL).
     * @param  addLeverage     Leverage applied to the added collateral, in
     *                         [MIN_LEVERAGE, MAX_LEVERAGE].
     * @param  acceptablePrice Directional slippage bound (1e8); see {_withinSlippage}.
     * @param  triggerPrice    Threshold mark (1e8) the fill price must cross.
     * @param  triggerAbove    True ⇒ fires at/above the threshold, false ⇒ at/below.
     * @return requestId       Id of the queued request.
     */
    function requestTriggerIncrease(
        bytes32 market,
        bool isLong,
        uint256 addCollateral,
        uint256 addLeverage,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove
    ) external nonReentrant returns (uint256 requestId) {
        if (acceptablePrice == 0) revert InvalidAcceptablePrice();
        if (addLeverage < MIN_LEVERAGE || addLeverage > MAX_LEVERAGE) revert LeverageOutOfRange(addLeverage);
        if (addCollateral < MIN_COLLATERAL) revert CollateralTooLow(addCollateral, MIN_COLLATERAL);
        if (triggerPrice == 0) revert InvalidTriggerPrice();

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
            kind: RequestKind.Increase,
            collateral: addCollateral,
            leverage: addLeverage, // natural meaning (leverage applied to addCollateral)
            acceptablePrice: acceptablePrice,
            executionFee: EXECUTION_FEE,
            requestTimestamp: block.timestamp,
            active: true
        });
        triggers[requestId] = Trigger({triggerPrice: triggerPrice, triggerAbove: triggerAbove});

        // Interaction LAST (CEI): escrow collateral + fee like an Open.
        asset.safeTransferFrom(msg.sender, address(this), addCollateral + EXECUTION_FEE);

        emit TriggerIncreaseRequested(
            requestId,
            msg.sender,
            market,
            isLong,
            addCollateral,
            addLeverage,
            acceptablePrice,
            triggerPrice,
            triggerAbove,
            EXECUTION_FEE
        );
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

        // Slippage holds once for both paths; the gate below branches on whether
        // this is a RESTING trigger order (triggers[id] set) or a market order.
        Trigger memory tr = triggers[requestId];
        bool isTrigger = tr.triggerPrice != 0;
        bool slipOk = _withinSlippage(r.kind, r.isLong, price, r.acceptablePrice);

        if (isTrigger) {
            // Resting order: REVERT (never cancel) until both gates pass. The revert
            // rolls back the whole tx — including the `active = false` consumption
            // above — so the request stays active and the keeper simply retries. No
            // state write below a TriggerNotMet/SlippageNotMet revert may survive.
            bool met = tr.triggerAbove ? price >= tr.triggerPrice : price <= tr.triggerPrice;
            if (!met) revert TriggerNotMet(price, tr.triggerPrice, tr.triggerAbove);
            if (!slipOk) revert SlippageNotMet(price, r.acceptablePrice);
        } else if (!slipOk) {
            // Market order: cancel + full refund to the owner, keeper unpaid
            // (UNCHANGED from today). The escrow shape and the mutex cross-cut by
            // kind: every non-Open kind holds the closePending mutex (clear it),
            // while Open AND Increase escrowed collateral + fee (refund both);
            // Close/Decrease escrowed only the fee.
            if (r.kind != RequestKind.Open) closePending[key] = false;
            if (r.kind == RequestKind.Open || r.kind == RequestKind.Increase) {
                asset.safeTransfer(r.owner, r.collateral + r.executionFee);
            } else {
                asset.safeTransfer(r.owner, r.executionFee);
            }
            emit RequestCancelled(requestId, r.owner, true);
            return;
        }

        // Fill. Open is its own path (creates a position; pre-escrowed collateral);
        // Close/Decrease/Increase all edit an existing position, so they share the
        // closePending teardown and differ only in the settlement core.
        if (r.kind == RequestKind.Open) {
            // Collateral was pre-escrowed at request time -> pullCollateral=false.
            _openPosition(r.owner, r.market, r.isLong, r.collateral, r.leverage, price, false);
        } else {
            closePending[key] = false;
            if (r.kind == RequestKind.Increase) {
                // Collateral was pre-escrowed at request time (like Open).
                _increasePosition(r.owner, r.market, r.isLong, r.collateral, r.leverage, price);
            } else if (r.kind == RequestKind.Close) {
                _closePosition(r.owner, r.market, r.isLong, price);
            } else {
                // OVERLOAD: r.leverage carries closeBps for a Decrease (see {Request}).
                _decreasePosition(r.owner, r.market, r.isLong, r.leverage, price);
            }
        }

        // On a successful fill, clear the (harmless if unset) trigger slot.
        if (isTrigger) delete triggers[requestId];

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
        // Harmless no-op for a market order (slot unset); tears down a resting trigger.
        delete triggers[requestId];

        // Interaction: full escrow back to the owner. Every non-Open kind holds the
        // closePending mutex (clear it); Open AND Increase escrowed collateral + fee
        // (refund both), while Close/Decrease escrowed only the fee.
        if (r.kind != RequestKind.Open) closePending[_positionKey(r.owner, r.market, r.isLong)] = false;
        if (r.kind == RequestKind.Open || r.kind == RequestKind.Increase) {
            asset.safeTransfer(r.owner, r.collateral + r.executionFee);
        } else {
            asset.safeTransfer(r.owner, r.executionFee);
        }

        emit RequestCancelled(requestId, r.owner, false);
    }

    /**
     * @dev Directional slippage test for a fill at `price` against the request's
     *      `acceptable` bound (both 1e8). A long wants to BUY low / SELL high, a
     *      short the reverse. An Increase BUYS into the position, so it uses the
     *      SAME direction as Open; a Decrease SELLS a fraction, so it uses the Close
     *      direction:
     *        - Open/Increase long:  fill `price <= acceptable` (buy not above the cap).
     *        - Open/Increase short: fill `price >= acceptable` (buy not below the floor).
     *        - Close/Decrease long:  fill `price >= acceptable` (sell not below the floor).
     *        - Close/Decrease short: fill `price <= acceptable` (sell not above the cap).
     */
    function _withinSlippage(RequestKind kind, bool isLong, uint256 price, uint256 acceptable)
        internal
        pure
        returns (bool)
    {
        if (kind == RequestKind.Open || kind == RequestKind.Increase) {
            return isLong ? price <= acceptable : price >= acceptable;
        }
        return isLong ? price >= acceptable : price <= acceptable; // Close or Decrease
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
     *         collateral); {_closePosition} applies the cap on settlement.
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

    function _requireSupportedMarket(bytes32 market) internal view {
        if (!supportedMarkets[market]) revert MarketNotSupported(market);
    }
}
