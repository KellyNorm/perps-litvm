// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAggregatorV3} from "../../src/prediction/IAggregatorV3.sol";
import {OracleResolvedMarket} from "../../src/prediction/OracleResolvedMarket.sol";
import {PredictionTwap} from "../../src/prediction/PredictionTwap.sol";
import {MockAggregatorV3} from "./MockAggregatorV3.sol";
import {ResolverHarness} from "./ResolverHarness.sol";

/**
 * @title OracleResolvedMarketTest
 * @notice Tests for the prediction market's oracle RESOLUTION layer (design §4,
 *         §6, §7). Covers strike capture, the post-lock settlement window, TWAP
 *         validity gates, and the outcome/void matrix. Every ambiguous or
 *         unhealthy path must resolve to VOID — never a wrong outcome (§5.8,
 *         §14.5) — and the settlement window must sit ENTIRELY after the lock.
 */
contract OracleResolvedMarketTest is Test {
    ResolverHarness internal h;
    MockAggregatorV3 internal feed;

    uint16 internal constant ASSET = 0;
    uint256 internal constant NOW = 1_000_000;

    // Default 15m-style split: bet 600s, settle 300s (design §4 ⅔/⅓).
    uint64 internal constant BET = 600;
    uint64 internal constant SETTLE = 300;

    int256 internal constant SPOT = 60_000e8; // BTC-style 8dp

    function setUp() public {
        h = new ResolverHarness();
        feed = new MockAggregatorV3(8);
        vm.warp(NOW);
    }

    // --- helpers -------------------------------------------------------------

    function _create(int256 spot) internal returns (uint256 id) {
        feed.setHealthy(spot, block.timestamp); // fresh strike source
        id = h.createMarket(ASSET, IAggregatorV3(address(feed)), BET, SETTLE, 0, false);
    }

    /// Warp to `ts`, stamp the feed fresh at `price`, and record a sample.
    function _observe(uint256 id, uint256 ts, int256 price) internal {
        vm.warp(ts);
        feed.setHealthy(price, ts);
        h.observe(id);
    }

    function _phase(uint256 id) internal view returns (OracleResolvedMarket.Phase) {
        return h.getMarket(id).phase;
    }

    /// Default TWAP config matching the contract's constants + default window.
    function _cfg() internal pure returns (PredictionTwap.Config memory) {
        return PredictionTwap.Config({
            tLock: uint64(NOW + BET),
            tExpiry: uint64(NOW + BET + SETTLE),
            minSamples: 3,
            minCoverageBps: 6_000,
            maxStaleness: 120
        });
    }

    // =========================================================================
    // Strike capture (design §6)
    // =========================================================================

    function test_CreateCapturesStrike_WhenHealthy() public {
        uint256 id = _create(SPOT);
        OracleResolvedMarket.Market memory m = h.getMarket(id);

        assertEq(m.strike, SPOT, "strike = fresh spot at creation");
        assertEq(uint256(m.t0), NOW, "t0 = now");
        assertEq(uint256(m.tLock), NOW + BET, "tLock = t0 + betWindow");
        assertEq(uint256(m.tExpiry), NOW + BET + SETTLE, "tExpiry = tLock + settleWindow");
        assertEq(uint256(m.phase), uint256(OracleResolvedMarket.Phase.Open), "starts Open");
        assertEq(uint256(m.outcome), uint256(OracleResolvedMarket.Outcome.None), "no outcome yet");
        assertEq(m.settlePrice, 0, "no settle price yet");
    }

    function test_CreateReverts_WhenFeedStale() public {
        // Feed last updated well outside the staleness window at creation time.
        feed.setHealthy(SPOT, block.timestamp - (h.maxStaleness() + 1));
        vm.expectRevert(OracleResolvedMarket.FeedUnhealthyAtCreation.selector);
        h.createMarket(ASSET, IAggregatorV3(address(feed)), BET, SETTLE, 0, false);
    }

    function test_CreateReverts_WhenFeedZeroPrice() public {
        feed.setRound(1, 0, block.timestamp, block.timestamp, 1);
        vm.expectRevert(OracleResolvedMarket.FeedUnhealthyAtCreation.selector);
        h.createMarket(ASSET, IAggregatorV3(address(feed)), BET, SETTLE, 0, false);
    }

    function test_CreateReverts_WhenFeedReverts() public {
        feed.setHealthy(SPOT, block.timestamp);
        feed.setMode(MockAggregatorV3.Mode.Revert);
        vm.expectRevert(OracleResolvedMarket.FeedUnhealthyAtCreation.selector);
        h.createMarket(ASSET, IAggregatorV3(address(feed)), BET, SETTLE, 0, false);
    }

    function test_CreateAppliesOffset() public {
        feed.setHealthy(SPOT, block.timestamp);
        uint256 up = h.createMarket(ASSET, IAggregatorV3(address(feed)), BET, SETTLE, 50, true);
        uint256 down = h.createMarket(ASSET, IAggregatorV3(address(feed)), BET, SETTLE, 50, false);

        assertEq(h.getMarket(up).strike, SPOT * 10_050 / 10_000, "strike biased up");
        assertEq(h.getMarket(down).strike, SPOT * 9_950 / 10_000, "strike biased down");
    }

    function test_CreateReverts_WhenOffsetAboveCap() public {
        feed.setHealthy(SPOT, block.timestamp);
        vm.expectRevert(OracleResolvedMarket.OffsetTooLarge.selector);
        h.createMarket(ASSET, IAggregatorV3(address(feed)), BET, SETTLE, 51, true);
    }

    function test_CreateReverts_WhenZeroWindow() public {
        feed.setHealthy(SPOT, block.timestamp);
        vm.expectRevert(OracleResolvedMarket.BadWindow.selector);
        h.createMarket(ASSET, IAggregatorV3(address(feed)), 0, SETTLE, 0, false);
    }

    // =========================================================================
    // Window timing — settlement window is ENTIRELY after the lock (design §4)
    // =========================================================================

    function test_SettlementWindowSitsEntirelyAfterLock() public {
        uint256 id = _create(SPOT);
        OracleResolvedMarket.Market memory m = h.getMarket(id);

        // Structural: betting window [t0,tLock) is strictly before settlement
        // window [tLock,tExpiry); they meet only at the boundary tLock.
        assertLt(uint256(m.t0), uint256(m.tLock), "betting before lock");
        assertLt(uint256(m.tLock), uint256(m.tExpiry), "settlement after lock");

        // Betting-open only before lock; settlement-window only at/after lock.
        assertTrue(h.bettingOpen(id), "bettable at t0");
        assertFalse(h.inSettlementWindow(id), "not sampling at t0");

        vm.warp(m.tLock);
        assertFalse(h.bettingOpen(id), "not bettable at lock");
        assertTrue(h.inSettlementWindow(id), "sampling opens at lock");
    }

    function test_Observe_RejectedBeforeLock() public {
        uint256 id = _create(SPOT);
        vm.warp(NOW + BET - 1); // one second before lock, still betting
        feed.setHealthy(SPOT, block.timestamp);
        vm.expectRevert(OracleResolvedMarket.NotInSettlementWindow.selector);
        h.observe(id);
    }

    function test_Observe_RejectedAtAndAfterExpiry() public {
        uint256 id = _create(SPOT);
        vm.warp(NOW + BET + SETTLE); // exactly tExpiry — window is half-open [tLock,tExpiry)
        feed.setHealthy(SPOT, block.timestamp);
        vm.expectRevert(OracleResolvedMarket.NotInSettlementWindow.selector);
        h.observe(id);
    }

    function test_Observe_AcceptedInsideWindow_AndLocksPhase() public {
        uint256 id = _create(SPOT);
        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Open), "Open before window");

        _observe(id, NOW + BET, SPOT); // exactly at tLock
        assertEq(h.observationCount(id), 1, "sample recorded at tLock");
        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Locked), "Open->Locked on observe");
    }

    // =========================================================================
    // Observation guards (design §7.1)
    // =========================================================================

    function test_Observe_EnforcesMinSpacing() public {
        uint256 id = _create(SPOT);
        _observe(id, NOW + BET, SPOT); // t = tLock

        // Too soon: < MIN_OBS_SPACING after the last sample.
        vm.warp(NOW + BET + (h.minObsSpacing() - 1));
        feed.setHealthy(SPOT, block.timestamp);
        vm.expectRevert(OracleResolvedMarket.ObservationTooSoon.selector);
        h.observe(id);

        // Exactly at the spacing boundary: accepted.
        _observe(id, NOW + BET + h.minObsSpacing(), SPOT);
        assertEq(h.observationCount(id), 2, "second sample accepted at spacing boundary");
    }

    function test_Observe_RejectsUnhealthySample_NotRecorded() public {
        uint256 id = _create(SPOT);

        // Inside the window but the feed is stale → sample excluded, not stored.
        uint256 ts = NOW + BET + 20;
        vm.warp(ts);
        feed.setHealthy(SPOT, ts - (h.maxStaleness() + 1)); // stale answer
        vm.expectRevert(OracleResolvedMarket.UnhealthySample.selector);
        h.observe(id);
        assertEq(h.observationCount(id), 0, "stale sample never recorded");

        // A fresh read at the same instant is accepted.
        feed.setHealthy(SPOT, ts);
        h.observe(id);
        assertEq(h.observationCount(id), 1, "healthy sample recorded");
    }

    // =========================================================================
    // Settlement — valid TWAP resolves correctly (design §5.2, §7.2)
    // =========================================================================

    function test_Settle_ValidTwap_Up() public {
        uint256 id = _create(SPOT); // strike = 60_000e8
        _observe(id, NOW + BET + 10, 61_000e8);
        _observe(id, NOW + BET + 150, 61_000e8);
        _observe(id, NOW + BET + 290, 61_000e8);

        vm.warp(NOW + BET + SETTLE);
        h.settle(id);

        OracleResolvedMarket.Market memory m = h.getMarket(id);
        assertEq(uint256(m.phase), uint256(OracleResolvedMarket.Phase.Settled), "settled");
        assertEq(uint256(m.outcome), uint256(OracleResolvedMarket.Outcome.Up), "UP wins (S>K)");
        assertEq(m.settlePrice, 61_000e8, "settle price = TWAP");
        assertGt(m.settlePrice, m.strike, "invariant: Up => settlePrice > strike");
    }

    function test_Settle_ValidTwap_Down() public {
        uint256 id = _create(SPOT);
        _observe(id, NOW + BET + 10, 59_000e8);
        _observe(id, NOW + BET + 150, 59_000e8);
        _observe(id, NOW + BET + 290, 59_000e8);

        vm.warp(NOW + BET + SETTLE);
        h.settle(id);

        OracleResolvedMarket.Market memory m = h.getMarket(id);
        assertEq(uint256(m.phase), uint256(OracleResolvedMarket.Phase.Settled), "settled");
        assertEq(uint256(m.outcome), uint256(OracleResolvedMarket.Outcome.Down), "DOWN wins (S<K)");
        assertEq(m.settlePrice, 59_000e8, "settle price = TWAP");
        assertLt(m.settlePrice, m.strike, "invariant: Down => settlePrice < strike");
    }

    /// Known-value check of the stepwise TWAP math via a real settle.
    function test_Settle_TwapMath_Exact() public {
        uint256 id = _create(100e8); // strike = 100e8
        _observe(id, NOW + BET + 10, 100e8);
        _observe(id, NOW + BET + 150, 200e8);
        _observe(id, NOW + BET + 290, 300e8);
        // Σ price_i*(t_{i+1}-t_i) / span
        // = (100e8*140 + 200e8*140) / 280 = 42000e8/280 = 150e8
        vm.warp(NOW + BET + SETTLE);
        h.settle(id);

        OracleResolvedMarket.Market memory m = h.getMarket(id);
        assertEq(m.settlePrice, 150e8, "stepwise TWAP exact");
        assertEq(uint256(m.outcome), uint256(OracleResolvedMarket.Outcome.Up), "150 > 100 => Up");
    }

    // =========================================================================
    // Settlement — VOID paths (design §5.5, §5.8, §14.5)
    // =========================================================================

    function test_Settle_ExactTie_Void() public {
        uint256 id = _create(SPOT); // strike = 60_000e8
        _observe(id, NOW + BET + 10, SPOT);
        _observe(id, NOW + BET + 150, SPOT);
        _observe(id, NOW + BET + 290, SPOT); // constant == strike => S == K

        vm.warp(NOW + BET + SETTLE);
        h.settle(id);

        OracleResolvedMarket.Market memory m = h.getMarket(id);
        assertEq(uint256(m.phase), uint256(OracleResolvedMarket.Phase.Void), "exact tie => VOID");
        assertEq(uint256(m.outcome), uint256(OracleResolvedMarket.Outcome.None), "no side wins on a tie");
    }

    function test_Settle_InsufficientSamples_VoidAfterGrace() public {
        uint256 id = _create(SPOT);
        _observe(id, NOW + BET + 10, 61_000e8);
        _observe(id, NOW + BET + 150, 61_000e8); // only 2 < MIN_SAMPLES

        // Before grace: cannot settle, cannot yet void.
        vm.warp(NOW + BET + SETTLE);
        vm.expectRevert(OracleResolvedMarket.AwaitGrace.selector);
        h.settle(id);

        // After grace: safety void.
        vm.warp(NOW + BET + SETTLE + h.settleGrace());
        h.settle(id);

        OracleResolvedMarket.Market memory m = h.getMarket(id);
        assertEq(uint256(m.phase), uint256(OracleResolvedMarket.Phase.Void), "thin feed => VOID");
        assertEq(uint256(m.outcome), uint256(OracleResolvedMarket.Outcome.None), "no outcome on void");
        assertEq(m.settlePrice, 0, "unsettleable void leaves settlePrice 0");
    }

    function test_Settle_ZeroSamples_VoidAfterGrace() public {
        uint256 id = _create(SPOT); // nobody ever observes
        vm.warp(NOW + BET + SETTLE + h.settleGrace());
        h.settle(id);
        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Void), "no samples => VOID");
    }

    function test_Settle_InsufficientCoverage_VoidAfterGrace() public {
        uint256 id = _create(SPOT);
        // 3 samples but bunched late: span 20s << 60% of the 300s window (180s),
        // while the last sample is still fresh vs tExpiry (isolates coverage).
        _observe(id, NOW + BET + 165, 61_000e8);
        _observe(id, NOW + BET + 175, 61_000e8);
        _observe(id, NOW + BET + 185, 61_000e8);

        vm.warp(NOW + BET + SETTLE);
        vm.expectRevert(OracleResolvedMarket.AwaitGrace.selector);
        h.settle(id);

        vm.warp(NOW + BET + SETTLE + h.settleGrace());
        h.settle(id);
        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Void), "thin coverage => VOID");
    }

    function test_Settle_StaleLastObs_VoidAfterGrace() public {
        // Wide window so coverage can pass while the feed goes quiet well before
        // expiry — isolating the late-freshness gate (§7.2). bet 100s, settle 1000s.
        uint64 bet = 100;
        uint64 settle = 1_000;
        feed.setHealthy(SPOT, block.timestamp);
        uint256 id = h.createMarket(ASSET, IAggregatorV3(address(feed)), bet, settle, 0, false);
        uint256 tLock = NOW + bet;
        uint256 tExpiry = tLock + settle;

        // Span 700s (>= 60% of 1000) but last is 290s before expiry (> 120 stale).
        _observe(id, tLock + 10, 61_000e8);
        _observe(id, tLock + 360, 61_000e8);
        _observe(id, tLock + 710, 61_000e8); // tExpiry - last = 290 > MAX_STALENESS

        vm.warp(tExpiry);
        vm.expectRevert(OracleResolvedMarket.AwaitGrace.selector);
        h.settle(id);

        vm.warp(tExpiry + h.settleGrace());
        h.settle(id);
        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Void), "quiet-late feed => VOID");
    }

    /// Unhealthy samples are excluded but do not corrupt an otherwise-valid TWAP.
    function test_Settle_ExcludesUnhealthy_StillResolves() public {
        uint256 id = _create(SPOT);
        _observe(id, NOW + BET + 10, 61_000e8);

        // A stale read mid-window is rejected (excluded), not recorded.
        uint256 badTs = NOW + BET + 150;
        vm.warp(badTs);
        feed.setHealthy(61_000e8, badTs - (h.maxStaleness() + 1));
        vm.expectRevert(OracleResolvedMarket.UnhealthySample.selector);
        h.observe(id);

        // Healthy samples still form a valid, correct TWAP.
        _observe(id, NOW + BET + 160, 61_000e8);
        _observe(id, NOW + BET + 290, 61_000e8);
        assertEq(h.observationCount(id), 3, "only healthy samples counted");

        vm.warp(NOW + BET + SETTLE);
        h.settle(id);
        OracleResolvedMarket.Market memory m = h.getMarket(id);
        assertEq(uint256(m.outcome), uint256(OracleResolvedMarket.Outcome.Up), "resolves on healthy subset");
        assertEq(m.settlePrice, 61_000e8, "TWAP unaffected by excluded ticks");
    }

    // =========================================================================
    // Settlement guards
    // =========================================================================

    function test_Settle_RevertsBeforeExpiry() public {
        uint256 id = _create(SPOT);
        _observe(id, NOW + BET + 10, 61_000e8);
        vm.warp(NOW + BET + SETTLE - 1); // one second before expiry
        vm.expectRevert(OracleResolvedMarket.BeforeExpiry.selector);
        h.settle(id);
    }

    function test_Settle_TwiceReverts() public {
        uint256 id = _create(SPOT);
        _observe(id, NOW + BET + 10, 61_000e8);
        _observe(id, NOW + BET + 150, 61_000e8);
        _observe(id, NOW + BET + 290, 61_000e8);
        vm.warp(NOW + BET + SETTLE);
        h.settle(id);
        vm.expectRevert(OracleResolvedMarket.AlreadyResolved.selector);
        h.settle(id);
    }

    function test_Observe_UnknownMarketReverts() public {
        vm.expectRevert(OracleResolvedMarket.NoSuchMarket.selector);
        h.observe(999);
    }

    // =========================================================================
    // Library math — direct property checks (design §7.2)
    // =========================================================================

    /// A constant price over a valid window yields exactly that price.
    function testFuzz_Twap_ConstantPriceEqualsPrice(int256 price) public pure {
        price = bound(price, int256(1), int256(1e30));
        PredictionTwap.Obs[] memory obs = new PredictionTwap.Obs[](3);
        obs[0] = PredictionTwap.Obs(uint64(NOW + BET + 10), price);
        obs[1] = PredictionTwap.Obs(uint64(NOW + BET + 150), price);
        obs[2] = PredictionTwap.Obs(uint64(NOW + BET + 290), price);

        (bool valid, int256 twap) = PredictionTwap.compute(obs, _cfg());
        assertTrue(valid, "constant-price valid window");
        assertEq(twap, price, "TWAP of a constant is the constant");
    }

    /// Fewer than MIN_SAMPLES is never valid, whatever the prices.
    function testFuzz_Twap_TooFewSamplesNeverValid(int256 p0, int256 p1) public pure {
        p0 = bound(p0, int256(1), int256(1e30));
        p1 = bound(p1, int256(1), int256(1e30));
        PredictionTwap.Obs[] memory obs = new PredictionTwap.Obs[](2);
        obs[0] = PredictionTwap.Obs(uint64(NOW + BET + 10), p0);
        obs[1] = PredictionTwap.Obs(uint64(NOW + BET + 290), p1);

        (bool valid, int256 twap) = PredictionTwap.compute(obs, _cfg());
        assertFalse(valid, "2 < MIN_SAMPLES => invalid");
        assertEq(twap, 0, "invalid => 0");
    }
}
