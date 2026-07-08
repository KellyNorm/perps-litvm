// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAggregatorV3} from "../../src/prediction/IAggregatorV3.sol";
import {SafeAggregatorReader} from "../../src/prediction/SafeAggregatorReader.sol";
import {IDIAOracle} from "../../src/prediction/IDIAOracle.sol";
import {DIAAggregatorV3Adapter} from "../../src/prediction/DIAAggregatorV3Adapter.sol";
import {MockDIAOracle} from "./MockDIAOracle.sol";

/**
 * @title DIAAggregatorV3AdapterTest
 * @notice The adapter re-shapes DIA's native `getValue("SYMBOL/USD") -> (value, ts)`
 *         into the {IAggregatorV3} surface the proven prediction market reads. Two
 *         things must hold:
 *           1. A healthy DIA point maps EXACTLY — value→answer (18-dec preserved),
 *              ts→updatedAt, decimals()==18, completeness guard satisfied — and reads
 *              clean through {SafeAggregatorReader}.
 *           2. Every bad DIA state (zero value, stale/future ts, unknown symbol, dead
 *              feed) flows through as something SafeAggregatorReader REJECTS with
 *              (false, 0). The adapter never manufactures a usable price from a bad one.
 * @dev    Runs entirely against {MockDIAOracle} — never the live LitVM feed.
 */
contract DIAAggregatorV3AdapterTest is Test {
    /// The market's MAX_STALENESS constant (design §3 testnet recommendation).
    uint256 internal constant MAX_STALENESS = 120;

    /// Non-zero base time so staleness / future arithmetic is meaningful.
    uint256 internal constant NOW = 1_000_000;

    /// DIA publishes USD prices at 18 decimals (per the live-feed spec).
    uint8 internal constant DIA_DECIMALS = 18;

    string internal constant KEY = "BTC/USD";

    MockDIAOracle internal dia;
    DIAAggregatorV3Adapter internal adapter;

    function setUp() public {
        dia = new MockDIAOracle();
        adapter = new DIAAggregatorV3Adapter(IDIAOracle(address(dia)), KEY);
        vm.warp(NOW);
    }

    // Reader alias so each test reads like one call site — this is the exact path
    // the market uses (SafeAggregatorReader over the adapter).
    function _read() internal view returns (bool ok, int256 price) {
        return SafeAggregatorReader.readFreshPrice(IAggregatorV3(address(adapter)), MAX_STALENESS);
    }

    // ---------------------------------------------------------------------
    // Construction / introspection
    // ---------------------------------------------------------------------

    function test_Constructor_ExposesOracleAndSymbol() public view {
        assertEq(address(adapter.oracle()), address(dia), "oracle address");
        assertEq(adapter.symbol(), KEY, "symbol key");
    }

    function test_Constructor_RevertsOnZeroOracle() public {
        vm.expectRevert(DIAAggregatorV3Adapter.InvalidOracle.selector);
        new DIAAggregatorV3Adapter(IDIAOracle(address(0)), KEY);
    }

    function test_Constructor_RevertsOnEmptySymbol() public {
        vm.expectRevert(DIAAggregatorV3Adapter.InvalidSymbol.selector);
        new DIAAggregatorV3Adapter(IDIAOracle(address(dia)), "");
    }

    // ---------------------------------------------------------------------
    // decimals()
    // ---------------------------------------------------------------------

    /// The adapter reports DIA's native 18 decimals so the factory caches the
    /// right feedDecimals and the market scales prices correctly.
    function test_Decimals_Is18() public view {
        assertEq(adapter.decimals(), DIA_DECIMALS, "adapter must report 18 decimals");
    }

    // ---------------------------------------------------------------------
    // Happy path — exact mapping + clean read
    // ---------------------------------------------------------------------

    /// A healthy DIA point maps value→answer, ts→updatedAt/startedAt, and satisfies
    /// the completeness guard (answeredInRound >= roundId).
    function test_LatestRoundData_MapsValueAndTimestampExactly() public {
        dia.setValue(KEY, 60_000e18, NOW);

        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            adapter.latestRoundData();

        assertEq(answer, int256(60_000e18), "value -> answer, 18-dec preserved");
        assertEq(updatedAt, NOW, "ts -> updatedAt");
        assertEq(startedAt, NOW, "ts -> startedAt");
        assertGe(answeredInRound, roundId, "round must be complete (answeredInRound >= roundId)");
    }

    /// The full market path: a healthy DIA point reads clean through the reader,
    /// preserving the raw 18-dec answer.
    function test_HealthyRead_PassesThroughReader() public {
        dia.setValue(KEY, 60_000e18, NOW);
        (bool ok, int256 price) = _read();
        assertTrue(ok, "healthy DIA point must read ok");
        assertEq(price, int256(60_000e18), "raw 18-dec answer preserved");
    }

    /// Staleness anchor is exact: age == MAX_STALENESS passes, one second older fails.
    function test_StalenessBoundary_IsExact() public {
        dia.setValue(KEY, 60_000e18, NOW - MAX_STALENESS); // exactly at the edge
        (bool okEdge,) = _read();
        assertTrue(okEdge, "age == MAX_STALENESS must still pass");

        dia.setValue(KEY, 60_000e18, NOW - MAX_STALENESS - 1); // one second too old
        (bool okStale,) = _read();
        assertFalse(okStale, "age > MAX_STALENESS must be rejected");
    }

    // ---------------------------------------------------------------------
    // Bad DIA states — must reach the reader as a rejected (false, 0)
    // ---------------------------------------------------------------------

    /// DIA value == 0 → answer 0 → reader rejects (answer <= 0).
    function test_ZeroValue_RejectedByReader() public {
        dia.setValue(KEY, 0, NOW);
        (bool ok, int256 price) = _read();
        assertFalse(ok, "zero DIA value must be rejected");
        assertEq(price, 0, "rejected read yields price 0");
    }

    /// DIA stale ts → reader rejects (age > MAX_STALENESS).
    function test_StaleTimestamp_RejectedByReader() public {
        dia.setValue(KEY, 60_000e18, NOW - MAX_STALENESS - 1);
        (bool ok,) = _read();
        assertFalse(ok, "stale DIA timestamp must be rejected");
    }

    /// DIA future ts → reader rejects (updatedAt > block.timestamp).
    function test_FutureTimestamp_RejectedByReader() public {
        dia.setValue(KEY, 60_000e18, NOW + 1);
        (bool ok,) = _read();
        assertFalse(ok, "future-stamped DIA point must be rejected");
    }

    /// An unknown/unpublished symbol (DIA returns (0,0)) — the TRX/HYPE/ZCASH
    /// pre-finalization case — reaches the reader as a rejected (false, 0).
    function test_UnknownSymbol_RejectedByReader() public view {
        // Nothing set for KEY; MockDIAOracle returns (0, 0).
        (bool ok,) = _read();
        assertFalse(ok, "unpublished symbol must be rejected");
    }

    /// A dead/reverting DIA feed makes latestRoundData revert; the reader's
    /// staticcall catches it and fails safe — it must NEVER propagate the revert.
    function test_DeadFeed_FailsSafeThroughReader() public {
        dia.setValue(KEY, 60_000e18, NOW);
        dia.setRevert(true);
        (bool ok, int256 price) = _read();
        assertFalse(ok, "reverting DIA feed must fail safe as (false, 0)");
        assertEq(price, 0, "rejected read yields price 0");
    }
}
