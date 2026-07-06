// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";
import {SafeAggregatorReader} from "./SafeAggregatorReader.sol";
import {PredictionTwap} from "./PredictionTwap.sol";

/**
 * @title OracleResolvedMarket
 * @notice The oracle RESOLUTION layer for the parimutuel prediction market
 *         (design §4, §6, §7). It owns the price-driven lifecycle of a market and
 *         NOTHING about money: strike capture at creation, permissionless
 *         observation collection during a post-lock settlement window, and a
 *         permissionless settlement that either fixes a real outcome from a valid
 *         TWAP or VOIDs (so the money layer refunds) — it can never settle to a
 *         wrong outcome on a stale/thin feed (design §5.8, §14.5).
 *
 * @dev    Layering: this is an abstract base. The future `ParimutuelPredictions`
 *         inherits it and adds pools / bets / claims / factory in separate storage
 *         (design §8 keeps stakes in per-market mappings). No funds move here, so
 *         no ERC20 / ReentrancyGuard yet — the only external calls are `view`
 *         staticcalls into the feed via {SafeAggregatorReader}, which cannot
 *         reenter. Imports NOTHING from the perps money path.
 *
 *         Timing invariant (design §4): the settlement window `[tLock, tExpiry)`
 *         is CONSTRUCTED strictly after the betting lock — `tLock = t0 + betWindow`
 *         and `tExpiry = tLock + settleWindow` with both windows > 0 — so no sample
 *         that determines the result can ever be taken before betting closes.
 */
abstract contract OracleResolvedMarket is ReentrancyGuard {
    using SafeAggregatorReader for IAggregatorV3;

    // ----------------------------------------------------------------- types

    /// Market lifecycle. Open→Locked at `tLock`; Settled/Void are terminal.
    enum Phase {
        Open,
        Locked,
        Settled,
        Void
    }

    /// Resolved direction. `None` until settled; a VOID keeps `None`.
    enum Outcome {
        None,
        Up,
        Down
    }

    struct Market {
        uint16 assetId; // display / registry index (registry itself is a later layer)
        IAggregatorV3 feed; // feed snapshotted at creation; observe/settle read THIS
        uint64 t0; // creation time
        uint64 tLock; // betting closes; settlement window opens
        uint64 tExpiry; // settlement window closes; settle allowed
        uint64 lastObsTs; // last accepted observation time (min-spacing anchor)
        int256 strike; // captured at creation, immutable for the market's life
        int256 settlePrice; // TWAP fixed at settle; 0 until then
        Phase phase;
        Outcome outcome;
    }

    // ------------------------------------------------------------- constants

    /// Tight staleness window for any fund-affecting price (design §3). Applied
    /// both at strike capture and to every settlement sample.
    uint256 internal constant MAX_STALENESS = 120;

    /// Minimum observations for a trustworthy TWAP (design §7.2).
    uint256 internal constant MIN_SAMPLES = 3;

    /// Samples must span >= 60% of the settlement window (design §7.2).
    uint256 internal constant MIN_COVERAGE_BPS = 6_000;

    /// Minimum spacing between accepted samples so one caller can't spam-weight a
    /// single instant (design §7.1).
    uint256 internal constant MIN_OBS_SPACING = 10;

    /// After `tExpiry + SETTLE_GRACE`, a market that still cannot form a valid
    /// TWAP is VOIDed so funds are never stranded (design §5.8).
    uint256 internal constant SETTLE_GRACE = 1 hours;

    /// Strike offset cap (design §6): the offset is a small % of spot, capped.
    uint256 internal constant OFFSET_CAP = 50; // 0.50%

    // --------------------------------------------------------------- storage

    Market[] internal _markets;
    mapping(uint256 => PredictionTwap.Obs[]) internal _observations;

    // ---------------------------------------------------------------- events

    event MarketCreated(
        uint256 indexed marketId,
        uint16 indexed assetId,
        address feed,
        uint64 t0,
        uint64 tLock,
        uint64 tExpiry,
        int256 strike
    );
    event Observed(uint256 indexed marketId, uint64 ts, int256 price, uint256 count);
    event MarketResolved(uint256 indexed marketId, Phase phase, Outcome outcome, int256 settlePrice);

    // ---------------------------------------------------------------- errors

    error FeedUnhealthyAtCreation();
    error BadWindow();
    error OffsetTooLarge();
    error NoSuchMarket();
    error NotInSettlementWindow();
    error ObservationTooSoon();
    error UnhealthySample();
    error AlreadyResolved();
    error BeforeExpiry();
    error AwaitGrace();

    // ------------------------------------------------------- market creation

    /**
     * @notice Create a market, capturing its strike from a fresh, healthy feed.
     * @dev Internal — the future factory / replenish layer drives this. Reverts
     *      {FeedUnhealthyAtCreation} if the feed is not fresh/valid: a market can
     *      never be born on a stale or invalid price (design §6).
     * @param assetId       Display/registry index for the asset.
     * @param feed          The AggregatorV3 feed (a DIA adapter in prod).
     * @param betWindow     Seconds of open betting: `tLock = t0 + betWindow`.
     * @param settleWindow  Seconds of settlement: `tExpiry = tLock + settleWindow`.
     * @param offsetBps     Strike offset in bps (design §6), capped at OFFSET_CAP.
     * @param offsetUp      Bias the strike above (true) or below (false) spot.
     * @return marketId     Index of the new market.
     */
    function _createMarket(
        uint16 assetId,
        IAggregatorV3 feed,
        uint64 betWindow,
        uint64 settleWindow,
        uint256 offsetBps,
        bool offsetUp
    ) internal returns (uint256 marketId) {
        if (betWindow == 0 || settleWindow == 0) revert BadWindow();
        if (offsetBps > OFFSET_CAP) revert OffsetTooLarge();

        // Strike capture — the ONLY price that must exist at creation. Reject
        // anything but a healthy, fresh read (design §3/§6).
        (bool ok, int256 spot) = feed.readFreshPrice(MAX_STALENESS);
        if (!ok) revert FeedUnhealthyAtCreation();

        int256 strike = _applyOffset(spot, offsetBps, offsetUp);

        uint64 t0 = uint64(block.timestamp);
        uint64 tLock = t0 + betWindow; // betting window sits BEFORE...
        uint64 tExpiry = tLock + settleWindow; // ...the settlement window. Disjoint by construction.

        _markets.push(
            Market({
                assetId: assetId,
                feed: feed,
                t0: t0,
                tLock: tLock,
                tExpiry: tExpiry,
                lastObsTs: 0,
                strike: strike,
                settlePrice: 0,
                phase: Phase.Open,
                outcome: Outcome.None
            })
        );
        marketId = _markets.length - 1;
        emit MarketCreated(marketId, assetId, address(feed), t0, tLock, tExpiry, strike);
    }

    /// strike = spot * (10_000 ± offsetBps) / 10_000 (design §6). Proportional so
    /// it is meaningful for a $100k BTC and a sub-cent asset alike.
    function _applyOffset(int256 spot, uint256 offsetBps, bool offsetUp) private pure returns (int256) {
        if (offsetBps == 0) return spot;
        int256 factor = offsetUp ? int256(10_000 + offsetBps) : int256(10_000 - offsetBps);
        return spot * factor / int256(10_000);
    }

    // ----------------------------------------------------------- observation

    /**
     * @notice Sample the feed into a market's settlement window. Permissionless
     *         (design §7.1, §9.4) — the dedicated keeper drives it, but anyone may
     *         call so a dead keeper cannot freeze settlement.
     * @dev Accepts ONLY within `[tLock, tExpiry)`, only a healthy read, and only
     *      after MIN_OBS_SPACING since the last accepted sample. An unhealthy read
     *      reverts {UnhealthySample} and is NOT recorded — stale/invalid ticks are
     *      excluded from the TWAP set entirely (design §7.1).
     */
    function observe(uint256 marketId) external {
        Market storage m = _market(marketId);

        uint64 nowTs = uint64(block.timestamp);
        if (nowTs < m.tLock || nowTs >= m.tExpiry) revert NotInSettlementWindow();

        // Lazy Open→Locked once the settlement window opens.
        if (m.phase == Phase.Open) m.phase = Phase.Locked;

        // Min spacing (only relevant once there is a prior sample).
        if (m.lastObsTs != 0 && nowTs < m.lastObsTs + MIN_OBS_SPACING) {
            revert ObservationTooSoon();
        }

        (bool ok, int256 price) = m.feed.readFreshPrice(MAX_STALENESS);
        if (!ok) revert UnhealthySample(); // excluded, not recorded

        _observations[marketId].push(PredictionTwap.Obs({ts: nowTs, price: price}));
        m.lastObsTs = nowTs;
        emit Observed(marketId, nowTs, price, _observations[marketId].length);
    }

    // ------------------------------------------------------------- settlement

    /**
     * @notice Resolve a market after expiry. Permissionless (design §9.4).
     * @dev Outcomes:
     *      - valid TWAP & `S > K` → Settled/Up
     *      - valid TWAP & `S < K` → Settled/Down
     *      - valid TWAP & `S == K` → VOID (exact tie, design §5.5)
     *      - no valid TWAP, and past `tExpiry + SETTLE_GRACE` → VOID (design §5.8)
     *      - no valid TWAP, still within grace → revert {AwaitGrace}
     *      A real outcome is fixed ONLY from a valid TWAP built of healthy samples;
     *      every ambiguous path lands on VOID (design §14.5).
     */
    function settle(uint256 marketId) external nonReentrant {
        Market storage m = _market(marketId);
        if (m.phase == Phase.Settled || m.phase == Phase.Void) revert AlreadyResolved();
        if (uint64(block.timestamp) < m.tExpiry) revert BeforeExpiry();

        // Pool-driven VOID (design §5.6/§5.7): a one-sided or empty book has no
        // real counterparty to win against, so it voids WITHOUT an oracle read —
        // cheaper and unmanipulable. The money layer overrides {_voidBeforeSettle};
        // the base default never short-circuits.
        if (_voidBeforeSettle(marketId)) {
            m.phase = Phase.Void;
            emit MarketResolved(marketId, m.phase, m.outcome, m.settlePrice);
            return;
        }

        (bool valid, int256 twap) = PredictionTwap.compute(
            _observations[marketId],
            PredictionTwap.Config({
                tLock: m.tLock,
                tExpiry: m.tExpiry,
                minSamples: MIN_SAMPLES,
                minCoverageBps: MIN_COVERAGE_BPS,
                maxStaleness: MAX_STALENESS
            })
        );

        if (valid) {
            m.settlePrice = twap;
            if (twap > m.strike) {
                m.outcome = Outcome.Up;
                m.phase = Phase.Settled;
            } else if (twap < m.strike) {
                m.outcome = Outcome.Down;
                m.phase = Phase.Settled;
            } else {
                m.phase = Phase.Void; // exact tie → void (§5.5); outcome stays None
            }
        } else {
            // Cannot form a trustworthy TWAP. Give the keeper until the grace
            // deadline, then VOID so funds are never stranded (§5.8).
            if (uint64(block.timestamp) < m.tExpiry + SETTLE_GRACE) revert AwaitGrace();
            m.phase = Phase.Void;
        }

        emit MarketResolved(marketId, m.phase, m.outcome, m.settlePrice);
    }

    // ------------------------------------------------------------- views

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _market(marketId);
    }

    function observationCount(uint256 marketId) external view returns (uint256) {
        _market(marketId); // bounds-check
        return _observations[marketId].length;
    }

    function observationAt(uint256 marketId, uint256 i) external view returns (uint64 ts, int256 price) {
        _market(marketId);
        PredictionTwap.Obs storage o = _observations[marketId][i];
        return (o.ts, o.price);
    }

    /// True while bets should be accepted (design §4): `[t0, tLock)`.
    function bettingOpen(uint256 marketId) external view returns (bool) {
        Market storage m = _market(marketId);
        return m.phase == Phase.Open && uint64(block.timestamp) < m.tLock;
    }

    /// True inside the settlement window `[tLock, tExpiry)` — when observe() works.
    function inSettlementWindow(uint256 marketId) external view returns (bool) {
        Market storage m = _market(marketId);
        uint64 nowTs = uint64(block.timestamp);
        return nowTs >= m.tLock && nowTs < m.tExpiry;
    }

    // ------------------------------------------------------------- internal

    function _market(uint256 marketId) internal view returns (Market storage) {
        if (marketId >= _markets.length) revert NoSuchMarket();
        return _markets[marketId];
    }

    /**
     * @notice Hook: force a VOID before any TWAP work is done (design §5.6/§5.7).
     * @dev The money layer overrides this to void a one-sided or zero-participant
     *      book (no real counterparty). The base — which knows nothing about pools
     *      — never short-circuits, so the pure resolution layer is unaffected.
     */
    function _voidBeforeSettle(uint256 marketId) internal view virtual returns (bool) {
        marketId; // silence unused-parameter warning in the base no-op
        return false;
    }
}
