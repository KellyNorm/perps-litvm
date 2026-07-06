// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAggregatorV3} from "../../src/prediction/IAggregatorV3.sol";
import {SafeAggregatorReader} from "../../src/prediction/SafeAggregatorReader.sol";
import {MockAggregatorV3} from "./MockAggregatorV3.sol";

/**
 * @title SafeAggregatorReaderTest
 * @notice Guard tests for the ONE safe price read the whole prediction stack uses
 *         (design §3, invariant §14.5). Every failure mode must FAIL SAFE: the
 *         reader returns `(false, 0)` and NEVER a bad price, and never reverts.
 *         The single path that yields a usable `(true, price)` is a healthy,
 *         fresh, complete round. A bad price can never be coerced to a usable one.
 */
contract SafeAggregatorReaderTest is Test {
    /// Matches the design's testnet recommendation (§3). The exact value is a
    /// contract constant in the market; the reader takes it as a parameter.
    uint256 internal constant MAX_STALENESS = 120;

    /// A non-zero base timestamp so staleness / future arithmetic is meaningful.
    uint256 internal constant NOW = 1_000_000;

    MockAggregatorV3 internal feed;

    function setUp() public {
        feed = new MockAggregatorV3(8); // BTC-style 8-decimal feed by default
        vm.warp(NOW);
    }

    // Local alias so each test reads like a single call site.
    function _read() internal view returns (bool ok, int256 price) {
        return SafeAggregatorReader.readFreshPrice(IAggregatorV3(address(feed)), MAX_STALENESS);
    }

    // ---------------------------------------------------------------------
    // Happy path — the ONLY path that yields a usable price
    // ---------------------------------------------------------------------

    /// A healthy, fresh, complete round passes and returns the raw answer.
    function test_HealthyRead_Passes() public {
        feed.setHealthy(60_000e8, NOW); // fresh, stamped now
        (bool ok, int256 price) = _read();
        assertTrue(ok, "healthy read must pass");
        assertEq(price, 60_000e8, "price must be the raw feed answer");
    }

    /// A price stamped inside the window (but not exactly now) still passes.
    function test_FreshWithinWindow_Passes() public {
        feed.setHealthy(3_000e8, NOW - (MAX_STALENESS - 1)); // 119s old
        (bool ok, int256 price) = _read();
        assertTrue(ok, "fresh-within-window must pass");
        assertEq(price, 3_000e8, "price preserved");
    }

    // ---------------------------------------------------------------------
    // Staleness
    // ---------------------------------------------------------------------

    /// updatedAt older than maxStaleness is rejected.
    function test_StalePrice_Rejected() public {
        feed.setHealthy(60_000e8, NOW - (MAX_STALENESS + 1)); // 121s old
        (bool ok, int256 price) = _read();
        assertFalse(ok, "stale price must be rejected");
        assertEq(price, 0, "rejected read must yield 0");
    }

    /// Boundary: exactly maxStaleness old passes; one second older fails.
    function test_StalenessBoundary_IsInclusive() public {
        feed.setHealthy(60_000e8, NOW - MAX_STALENESS); // exactly at the edge
        (bool okEdge, int256 priceEdge) = _read();
        assertTrue(okEdge, "exactly maxStaleness must pass (<= window)");
        assertEq(priceEdge, 60_000e8, "edge price preserved");

        feed.setHealthy(60_000e8, NOW - MAX_STALENESS - 1); // one second past
        (bool okPast, int256 pricePast) = _read();
        assertFalse(okPast, "one second past window must fail");
        assertEq(pricePast, 0, "rejected read must yield 0");
    }

    // ---------------------------------------------------------------------
    // Zero / negative price
    // ---------------------------------------------------------------------

    /// answer == 0 is rejected.
    function test_ZeroPrice_Rejected() public {
        feed.setRound(1, 0, NOW, NOW, 1);
        (bool ok, int256 price) = _read();
        assertFalse(ok, "zero price must be rejected");
        assertEq(price, 0, "rejected read must yield 0");
    }

    /// answer < 0 is rejected.
    function test_NegativePrice_Rejected() public {
        feed.setRound(1, -1, NOW, NOW, 1);
        (bool ok, int256 price) = _read();
        assertFalse(ok, "negative price must be rejected");
        assertEq(price, 0, "rejected read must yield 0");
    }

    // ---------------------------------------------------------------------
    // updatedAt sanity
    // ---------------------------------------------------------------------

    /// updatedAt == 0 (never-updated feed) is rejected.
    function test_ZeroUpdatedAt_Rejected() public {
        feed.setRound(1, 60_000e8, 0, 0, 1);
        (bool ok, int256 price) = _read();
        assertFalse(ok, "never-updated feed must be rejected");
        assertEq(price, 0, "rejected read must yield 0");
    }

    /// A future-stamped updatedAt is rejected (and cannot underflow the reader).
    function test_FutureUpdatedAt_Rejected() public {
        feed.setRound(1, 60_000e8, NOW, NOW + 1, 1);
        (bool ok, int256 price) = _read();
        assertFalse(ok, "future-stamped price must be rejected");
        assertEq(price, 0, "rejected read must yield 0");
    }

    // ---------------------------------------------------------------------
    // Round completeness
    // ---------------------------------------------------------------------

    /// answeredInRound < roundId (carried-over / incomplete) is rejected.
    function test_IncompleteRound_Rejected() public {
        feed.setRound(5, 60_000e8, NOW, NOW, 4); // answered in an older round
        (bool ok, int256 price) = _read();
        assertFalse(ok, "incomplete round must be rejected");
        assertEq(price, 0, "rejected read must yield 0");
    }

    /// answeredInRound == roundId and answeredInRound > roundId both pass.
    function test_CompleteRound_Passes() public {
        feed.setRound(5, 60_000e8, NOW, NOW, 5); // answered in the same round
        (bool okEq, int256 priceEq) = _read();
        assertTrue(okEq, "answeredInRound == roundId must pass");
        assertEq(priceEq, 60_000e8, "price preserved");

        feed.setRound(5, 60_000e8, NOW, NOW, 6); // answeredInRound ahead is fine
        (bool okGt,) = _read();
        assertTrue(okGt, "answeredInRound > roundId must pass");
    }

    // ---------------------------------------------------------------------
    // Hostile / malformed feed — reader must not revert, must not decode garbage
    // ---------------------------------------------------------------------

    /// A reverting feed is caught by the staticcall wrapper; no revert propagates.
    function test_FeedReverts_HandledSafely() public {
        feed.setHealthy(60_000e8, NOW); // otherwise-healthy values...
        feed.setMode(MockAggregatorV3.Mode.Revert); // ...but the call reverts
        (bool ok, int256 price) = _read();
        assertFalse(ok, "reverting feed must fail safe");
        assertEq(price, 0, "rejected read must yield 0");
    }

    /// Short (< 160 byte) returndata is rejected before any ABI decode runs.
    function test_ShortReturnData_Rejected() public {
        feed.setHealthy(60_000e8, NOW);
        feed.setMode(MockAggregatorV3.Mode.ShortReturn);
        (bool ok, int256 price) = _read();
        assertFalse(ok, "short/garbage returndata must be rejected");
        assertEq(price, 0, "rejected read must yield 0");
    }

    /// Empty returndata (e.g. non-contract / wrong address) is rejected.
    function test_EmptyReturnData_Rejected() public {
        feed.setMode(MockAggregatorV3.Mode.EmptyReturn);
        (bool ok, int256 price) = _read();
        assertFalse(ok, "empty returndata must be rejected");
        assertEq(price, 0, "rejected read must yield 0");
    }

    /// Calling a feed address with no code at all fails safe (no revert).
    function test_NonContractFeed_Rejected() public view {
        (bool ok, int256 price) = SafeAggregatorReader.readFreshPrice(IAggregatorV3(address(0xdead)), MAX_STALENESS);
        assertFalse(ok, "EOA/non-contract feed must fail safe");
        assertEq(price, 0, "rejected read must yield 0");
    }

    // ---------------------------------------------------------------------
    // Decimals correctness — reader preserves the raw answer at native decimals
    // ---------------------------------------------------------------------

    /// The reader returns the raw integer answer unchanged for feeds of differing
    /// per-asset feedDecimals (design §2/§3: no normalization in the reader).
    function test_DecimalsPreserved_AcrossAssets() public {
        // BTC-style 8dp feed: $60,000.00000000
        MockAggregatorV3 btc = new MockAggregatorV3(8);
        btc.setHealthy(60_000e8, NOW);
        (bool okB, int256 pB) = SafeAggregatorReader.readFreshPrice(IAggregatorV3(address(btc)), MAX_STALENESS);
        assertTrue(okB, "btc read ok");
        assertEq(pB, 60_000e8, "8dp raw answer preserved");

        // DOGE-style 5dp feed: $0.12345
        MockAggregatorV3 doge = new MockAggregatorV3(5);
        doge.setHealthy(12_345, NOW); // 0.12345 * 1e5
        (bool okD, int256 pD) = SafeAggregatorReader.readFreshPrice(IAggregatorV3(address(doge)), MAX_STALENESS);
        assertTrue(okD, "doge read ok");
        assertEq(pD, 12_345, "5dp raw answer preserved, not rescaled");
    }

    // ---------------------------------------------------------------------
    // Invariant §14.5 — the ONLY usable-price path is a healthy read
    // ---------------------------------------------------------------------

    /// A single bad state combined with an otherwise-healthy round must still be
    /// rejected: no failure mode leaks a usable price.
    function test_EveryFailureMode_YieldsZeroAndFalse() public {
        // Each entry mutates exactly one guard away from healthy.
        feed.setRound(1, 0, NOW, NOW, 1); // zero price
        _assertRejected();
        feed.setRound(1, -5, NOW, NOW, 1); // negative price
        _assertRejected();
        feed.setRound(1, 60_000e8, NOW, 0, 1); // updatedAt == 0
        _assertRejected();
        feed.setRound(1, 60_000e8, NOW, NOW + 1, 1); // future stamp
        _assertRejected();
        feed.setRound(1, 60_000e8, NOW, NOW - MAX_STALENESS - 1, 1); // stale
        _assertRejected();
        feed.setRound(5, 60_000e8, NOW, NOW, 4); // incomplete round
        _assertRejected();
        feed.setMode(MockAggregatorV3.Mode.Revert); // hostile: revert
        _assertRejected();
        feed.setMode(MockAggregatorV3.Mode.ShortReturn); // hostile: short data
        _assertRejected();
        feed.setMode(MockAggregatorV3.Mode.EmptyReturn); // hostile: empty data
        _assertRejected();
    }

    function _assertRejected() internal view {
        (bool ok, int256 price) = _read();
        assertFalse(ok, "bad state must be rejected");
        assertEq(price, 0, "rejected read must yield exactly 0");
    }

    /// Fuzz the whole round tuple: whenever the reader reports `ok`, EVERY §3
    /// guard must hold and the price must equal the feed answer; whenever it
    /// reports not-ok, the price must be exactly 0. This nails the invariant
    /// that a usable price implies a healthy round and nothing else.
    function testFuzz_OkImpliesHealthy(uint80 roundId, int256 answer, uint256 updatedAt, uint80 answeredInRound)
        public
    {
        // Keep updatedAt in a plausible range around NOW so both fresh and stale
        // cases are well-represented without pathological huge values.
        updatedAt = bound(updatedAt, 0, NOW + MAX_STALENESS + 1_000);
        feed.setRound(roundId, answer, updatedAt, updatedAt, answeredInRound);

        (bool ok, int256 price) = _read();

        if (ok) {
            // Forward direction: a usable price means every guard held.
            assertGt(answer, 0, "ok => answer > 0");
            assertTrue(updatedAt != 0, "ok => updatedAt != 0");
            assertLe(updatedAt, block.timestamp, "ok => not future-stamped");
            assertLe(block.timestamp - updatedAt, MAX_STALENESS, "ok => within staleness");
            assertGe(answeredInRound, roundId, "ok => complete round");
            assertEq(price, answer, "ok => price is the raw answer");
        } else {
            // Fail-safe direction: a rejected read never leaks a price.
            assertEq(price, 0, "not ok => price is 0");
        }
    }
}
