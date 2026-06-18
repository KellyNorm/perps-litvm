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
 * @notice Perpetual position engine (PR-3) for the GMX-style perps DEX. Traders
 *         open and close leveraged long/short positions against the
 *         {LiquidityPool}, which is the sole counterparty. Entry and exit marks
 *         come from the RedStone Pull-Model oracle: the caller appends a fresh
 *         signed price payload to the transaction calldata, and this contract
 *         (via {MainDemoConsumerBase}) verifies the signer(s) and the package
 *         timestamp before using the value.
 *
 * @dev    SCOPE (PR-3): open/close of one full position per
 *         (owner, market, direction); P&L settled against the pool; LP-share
 *         valuation via a cached aggregate mark; reserved-liquidity solvency.
 *
 *         OUT OF SCOPE — deferred to later PRs:
 *         - Funding rate & fees (PR-4).
 *         - Liquidations AND residual bad debt beyond collateral (PR-5). Here a
 *           loss is floored at the trader's collateral; any deficit past it is
 *           simply not collected — PR-5 owns that path.
 *         - Two-step deferred execution / front-running protection (PR-6). This
 *           contract reads the price in the SAME transaction as the action.
 *         - Payload-aware LP deposit/withdraw to close the share-price fairness
 *           gap (its own PR; see TASK.md).
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
     */
    struct Position {
        address owner;
        bytes32 market;
        bool isLong;
        uint256 collateral;
        uint256 sizeUsd;
        uint256 entryPrice;
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
     */
    struct MarketState {
        uint256 longSizeUsd;
        uint256 longWeight;
        uint256 shortSizeUsd;
        uint256 shortWeight;
        uint256 lastMarkPrice;
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
        uint256 payout
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

        // Effects.
        positions[key] = Position({
            owner: msg.sender,
            market: market,
            isLong: isLong,
            collateral: collateral,
            sizeUsd: sizeUsd,
            entryPrice: entryPrice
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
        uint256 reserve = pos.collateral * MAX_PROFIT_FACTOR;

        // Effects.
        delete positions[key];
        _updateMarket(market, isLong, pos.sizeUsd, pos.entryPrice, exitPrice, false);
        totalReserved -= reserve;

        // Interactions.
        uint256 payout;
        if (profit) {
            payout = pos.collateral + pnl;
            if (pnl > 0) pool.payProfit(pos.owner, pnl);
            asset.safeTransfer(pos.owner, pos.collateral);
        } else {
            uint256 returned = pos.collateral - pnl; // pnl already capped to collateral
            payout = returned;
            if (returned > 0) asset.safeTransfer(pos.owner, returned);
            if (pnl > 0) pool.receiveLoss(pnl);
        }

        emit PositionClosed(pos.owner, market, isLong, exitPrice, profit, pnl, payout);
    }

    // --- views -----------------------------------------------------------

    /// @notice Returns the storage key for a position.
    function getPositionKey(address owner, bytes32 market, bool isLong) external pure returns (bytes32) {
        return _positionKey(owner, market, isLong);
    }

    // --- internal: P&L & aggregates --------------------------------------

    /**
     * @dev Computes a position's settled P&L against `exitPrice`, applying the
     *      profit cap (MAX_PROFIT_FACTOR*collateral) and the loss floor
     *      (collateral). Returns whether the position is in profit and the
     *      capped absolute P&L magnitude.
     *
     *      Rounding always favors the pool: profit is rounded DOWN (Floor) so the
     *      pool never overpays, and loss magnitude is rounded UP (Ceil) so the
     *      pool never under-collects. The cap and floor are applied afterwards.
     */
    function _computePnl(Position memory pos, uint256 exitPrice) internal pure returns (bool profit, uint256 pnl) {
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

        if (profit) {
            uint256 cap = pos.collateral * MAX_PROFIT_FACTOR;
            if (pnl > cap) pnl = cap;
        } else if (pnl > pos.collateral) {
            // Loss floored at collateral; residual bad debt is PR-5's concern.
            pnl = pos.collateral;
        }
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

    // --- internal: helpers -----------------------------------------------

    function _positionKey(address owner, bytes32 market, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, market, isLong));
    }

    function _requireSupportedMarket(bytes32 market) internal pure {
        if (market != MARKET_BTC && market != MARKET_ETH) revert MarketNotSupported(market);
    }
}
