// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MainDemoConsumerBase} from "@redstone-finance/evm-connector/contracts/data-services/MainDemoConsumerBase.sol";

import {LiquidityPool} from "./LiquidityPool.sol";

/**
 * @title PositionManager
 * @notice Perpetual position engine for the GMX-style perps DEX. Traders
 *         open and close leveraged long/short positions against the
 *         {LiquidityPool}, which is the sole counterparty. Entry and exit marks
 *         come from the RedStone Pull-Model oracle: the caller appends a fresh

 *         signed price payload to the transaction calldata, and this contract
 *         (via {MainDemoConsumerBase}) verifies the signer(s) and the package
 *         timestamp before using the value.
 *
 * @dev    SCOPE (PR-3 + PR-4a + PR-5): open/close of one full position per
 *         (owner, market, direction); P&L settled against the pool; LP-share
 *         valuation via a cached aggregate mark; reserved-liquidity solvency;
 *         a time-based borrow fee (PR-4a) charged on notional, accrued O(1) via
 *         a per-market cumulative index and deducted from payout at close;
 *         permissionless liquidation (PR-5) of positions that breach the
 *         maintenance margin, with residual bad-debt accounting when a loss
 *         (plus accrued fee) exceeds the trader's collateral.
 *
 *         OUT OF SCOPE — deferred to later PRs:
 *         - Funding rate between longs & shorts (PR-4b, sequenced AFTER PR-5 so
 *           liquidations can bound a funding payer who outruns its collateral).
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
     */
    struct Position {
        address owner;
        bytes32 market;
        bool isLong;
        uint256 collateral;
        uint256 sizeUsd;
        uint256 entryPrice;
        uint256 entryCumBorrowRate;
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
     */
    struct MarketState {
        uint256 longSizeUsd;
        uint256 longWeight;
        uint256 shortSizeUsd;
        uint256 shortWeight;
        uint256 lastMarkPrice;
        uint256 cumBorrowRate;
        uint256 lastBorrowAccrual;
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
     */
    event PositionLiquidated(
        address indexed owner,
        bytes32 indexed market,
        bool isLong,
        uint256 exitPrice,
        bool profit,
        uint256 pnl,
        uint256 borrowFee,
        uint256 toPool,
        uint256 liquidatorBonus,
        uint256 ownerRefund,
        uint256 badDebt,
        address indexed liquidator
    );

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
        _requireSupportedMarket(market);
        if (collateral < MIN_COLLATERAL) revert CollateralTooLow(collateral, MIN_COLLATERAL);
        if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE) revert LeverageOutOfRange(leverage);

        bytes32 key = _positionKey(msg.sender, market, isLong);
        if (positions[key].sizeUsd != 0) revert PositionAlreadyOpen();

        uint256 entryPrice = getOracleNumericValueFromTxMsg(market);
        if (entryPrice == 0) revert InvalidPrice();

        uint256 sizeUsd = collateral * leverage;
        uint256 reserve = collateral * MAX_PROFIT_FACTOR;

        // Solvency gate: reserved liquidity (incl. this position) must stay
        // within the configured fraction of the pool's balance.
        uint256 poolBalance = asset.balanceOf(address(pool));
        if (totalReserved + reserve > Math.mulDiv(poolBalance, MAX_UTILIZATION_BPS, BPS_DENOMINATOR)) {
            revert ExceedsUtilization();
        }

        // Effects. Accrue the borrow index to now so the position's entry
        // snapshot excludes fees that accrued before it existed.
        uint256 entryCumBorrowRate = _accrueBorrow(market);
        positions[key] = Position({
            owner: msg.sender,
            market: market,
            isLong: isLong,
            collateral: collateral,
            sizeUsd: sizeUsd,
            entryPrice: entryPrice,
            entryCumBorrowRate: entryCumBorrowRate
        });
        _updateMarket(market, isLong, sizeUsd, entryPrice, entryPrice, true);
        totalReserved += reserve;

        // Interaction.
        asset.safeTransferFrom(msg.sender, address(this), collateral);

        emit PositionOpened(msg.sender, market, isLong, collateral, sizeUsd, entryPrice);
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
        bytes32 key = _positionKey(msg.sender, market, isLong);
        Position memory pos = positions[key];
        if (pos.sizeUsd == 0) revert NoOpenPosition();

        uint256 exitPrice = getOracleNumericValueFromTxMsg(market);
        if (exitPrice == 0) revert InvalidPrice();

        (bool profit, uint256 pnl) = _computePnl(pos, exitPrice);

        // Effects. Accrue the borrow index to now and snapshot the fee owed over
        // this position's lifetime (Ceil favours the pool), then clear the
        // position's book state before any external interaction (CEI).
        uint256 borrowFee = _accrueFee(pos);
        _realizeClose(pos, key, exitPrice);

        // Interactions (kept in a helper to bound this frame's stack).
        uint256 payout = _settle(pos, profit, pnl, borrowFee);

        emit PositionClosed(pos.owner, market, isLong, exitPrice, profit, pnl, borrowFee, payout);
    }

    /**
     * @dev Settles a closing position's transfers and returns the trader payout.
     *      `A` = pre-fee proceeds (profit: collateral + pnl; loss:
     *      collateral - pnl). The fee is charged as `min(fee, A)` so payout
     *      `= A - charged` floors at 0 and never underflows; any uncollected
     *      remainder is left for PR-5. Pool flow is netted into a single
     *      {payProfit} (pool -> trader) or {receiveLoss} (-> pool) call, with the
     *      collected fee folded into that net. Called only from {closePosition}
     *      after all state effects, so it runs under that function's CEI ordering
     *      and `nonReentrant` guard.
     */
    function _settle(Position memory pos, bool profit, uint256 pnl, uint256 borrowFee)
        internal
        returns (uint256 payout)
    {
        uint256 available = profit ? pos.collateral + pnl : pos.collateral - pnl;
        uint256 feeCharged = borrowFee > available ? available : borrowFee;
        payout = available - feeCharged;

        // Net pool flow: pool pays profit, receives loss + the collected fee.
        uint256 poolOut = profit ? pnl : 0;
        uint256 poolIn = (profit ? 0 : pnl) + feeCharged;

        if (poolOut > poolIn) {
            // Pool nets a payment to the trader; full collateral returned by PM.
            pool.payProfit(pos.owner, poolOut - poolIn);
            asset.safeTransfer(pos.owner, pos.collateral);
        } else {
            // Pool nets an inflow (loss and/or fee); PM funds it from collateral.
            uint256 toPool = poolIn - poolOut;
            uint256 returned = pos.collateral - toPool; // toPool <= collateral by construction
            if (returned > 0) asset.safeTransfer(pos.owner, returned);
            if (toPool > 0) pool.receiveLoss(toPool);
        }
    }

    /**
     * @notice Permissionlessly liquidate an underwater position. ANYONE may
     *         call; the caller MUST append a fresh signed RedStone payload for
     *         `market` and is paid a bounty out of the position's collateral.
     * @dev    A position is liquidatable once its equity — collateral adjusted by
     *         the UNCAPPED P&L at the fresh mark and the accrued borrow fee —
     *         falls to at most {MAINTENANCE_MARGIN_BPS} of collateral. The
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

        // Accrue the borrow index to now and snapshot this position's fee
        // (exactly one _accrueBorrow call, as on the close path).
        uint256 borrowFee = _accrueFee(pos);

        // Equity check (everything favours the pool / against the trader).
        uint256 maintenance = Math.mulDiv(pos.collateral, MAINTENANCE_MARGIN_BPS, BPS_DENOMINATOR);
        uint256 equity;
        if (profit) {
            uint256 gross = pos.collateral + pnl;
            equity = gross > borrowFee ? gross - borrowFee : 0;
        } else {
            uint256 debit = pnl + borrowFee;
            equity = pos.collateral > debit ? pos.collateral - debit : 0;
        }
        if (equity > maintenance) revert NotLiquidatable(equity, maintenance);

        // Effects: clear book state and release reserves (CEI).
        _realizeClose(pos, key, exitPrice);

        // Settlement + interactions + event in a helper to bound this frame's stack.
        _settleLiquidation(pos, exitPrice, profit, pnl, borrowFee);
    }

    /**
     * @dev Settles a liquidation: splits the position's collateral into the
     *      pool's net claim, the liquidator's bounty, and any owner refund, then
     *      performs the transfers (interactions only — all state effects ran in
     *      {liquidate} before this call) and emits {PositionLiquidated}. The
     *      position is underwater by construction, so the pool only RECEIVES;
     *      {LiquidityPool.payProfit} is never called. In the profit branch the
     *      equity test in {liquidate} guarantees `borrowFee >= pnl`, so
     *      `borrowFee - pnl` cannot underflow. Conservation holds exactly:
     *      `toPool + liquidatorBonus + ownerRefund == pos.collateral`.
     */
    function _settleLiquidation(Position memory pos, uint256 exitPrice, bool profit, uint256 pnl, uint256 borrowFee)
        internal
    {
        uint256 netOwedToPool = profit ? (borrowFee - pnl) : (pnl + borrowFee);
        uint256 toPool = netOwedToPool > pos.collateral ? pos.collateral : netOwedToPool;
        uint256 remaining = pos.collateral - toPool;
        uint256 liquidatorBonus = Math.min(Math.mulDiv(pos.collateral, LIQUIDATION_FEE_BPS, BPS_DENOMINATOR), remaining);
        uint256 ownerRefund = remaining - liquidatorBonus;
        uint256 badDebt = netOwedToPool > pos.collateral ? netOwedToPool - pos.collateral : 0;

        if (toPool > 0) pool.receiveLoss(toPool);
        if (liquidatorBonus > 0) asset.safeTransfer(msg.sender, liquidatorBonus);
        if (ownerRefund > 0) asset.safeTransfer(pos.owner, ownerRefund);

        emit PositionLiquidated(
            pos.owner,
            pos.market,
            pos.isLong,
            exitPrice,
            profit,
            pnl,
            borrowFee,
            toPool,
            liquidatorBonus,
            ownerRefund,
            badDebt,
            msg.sender
        );
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

    // --- internal: helpers -----------------------------------------------

    function _positionKey(address owner, bytes32 market, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, market, isLong));
    }

    function _requireSupportedMarket(bytes32 market) internal pure {
        if (market != MARKET_BTC && market != MARKET_ETH) revert MarketNotSupported(market);
    }
}
