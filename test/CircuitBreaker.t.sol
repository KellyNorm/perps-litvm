// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Oracle circuit-breaker (additive money-path layer on PositionManager).
//
// RedStone stays the SOLE primary execution mark. A per-market SECONDARY feed
// (Chainlink AggregatorV3-shaped, e.g. DIA on LitVM) is read ONLY as an
// independent divergence bound — never as a price. Thresholds live in the
// Governance param store, packed per market as (stalenessSeconds << 128) | bandBps;
// a band of 0 (the default for every market) keeps the breaker dormant, so the
// pre-existing suite is unaffected.
//
// Gating: a FRESH secondary diverging beyond the band halts the RISK-ADDING fills
// (OPEN / INCREASE) — request stays active, self-heals on reconvergence. CLOSE /
// DECREASE are never gated (users can always exit). LIQUIDATION is OBSERVE-ONLY by
// default (emits Divergence, never reverts); a governable global flag can enable
// liquidation gating later, but a failed/stale/reverting secondary can NEVER block
// a liquidation regardless.
//
// Inherits PositionManagerTest for the harness, payload/FFI plumbing, the
// _open/_close/_execute/_liquidate helpers, and a Governance owned by this test.

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PositionManagerTest} from "./PositionManager.t.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Governance} from "../src/Governance.sol";

/// @dev Minimal mock of a Chainlink-AggregatorV3 secondary feed. `set` stamps an
///      absolute `updatedAt` (callers pass block.timestamp for fresh, an older
///      value for stale, a future value for the future-guard). `setRevert` makes
///      latestRoundData revert to exercise the wrapped-read abstain path.
contract MockAggregatorV3 {
    uint8 public immutable decimals;
    int256 internal _answer;
    uint256 internal _updatedAt;
    bool internal _down;

    constructor(uint8 d) {
        decimals = d;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function setRevert(bool down_) external {
        _down = down_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!_down, "feed down");
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }
}

contract CircuitBreakerTest is PositionManagerTest {
    // DIA-style 18-decimal secondary. Deployed in the constructor via this
    // state-variable initializer (it has no dependency on `pm`), so this suite
    // needs NO setUp() of its own: it inherits PositionManagerTest's setUp() and
    // full RedStone-signed money-path harness verbatim. PositionManagerTest.setUp()
    // is non-virtual and stays that way — we neither override nor touch it.
    MockAggregatorV3 internal feed = new MockAggregatorV3(18);

    // 5% band, 300s staleness window — the common config under test.
    uint256 internal constant BAND_BPS = 500;
    uint256 internal constant MAX_AGE = 300;

    // --- config helpers --------------------------------------------------

    function _cbKey(bytes32 market) internal pure returns (bytes32) {
        return keccak256(abi.encode("CB_PARAMS", market));
    }

    function _gateKey() internal pure returns (bytes32) {
        return keccak256(abi.encode("CB_GATE_LIQ"));
    }

    function _setCB(bytes32 market, uint256 bandBps, uint256 maxAge) internal {
        Governance gov = pm.governance();
        bytes32 key = _cbKey(market);
        gov.setParamBounds(key, 0, type(uint256).max);
        gov.setParam(key, (maxAge << 128) | bandBps);
    }

    function _setGateLiq(uint256 v) internal {
        Governance gov = pm.governance();
        gov.setParamBounds(_gateKey(), 0, type(uint256).max);
        gov.setParam(_gateKey(), v);
    }

    /// @dev Secondary value at the feed's own decimals (human price -> scaled).
    function _sec(uint256 humanPrice) internal view returns (int256) {
        return int256(humanPrice * (10 ** feed.decimals()));
    }

    /// @dev requestOpen -> warp past the delay -> set the secondary -> execute.
    ///      Returns the execute outcome. acceptablePrice is generous (70000) so
    ///      slippage never masks a breaker result.
    function _openWithSecondary(uint256 primaryMark, uint256 secHuman, uint256 updatedAt)
        internal
        returns (bool ok, bytes memory ret)
    {
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 70_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        feed.set(_sec(secHuman), updatedAt);
        (ok, ret) = _execute(pm, keeper, id, BTC, primaryMark);
    }

    // =====================================================================
    // 1. Secondary AGREES -> executes normally.
    // =====================================================================

    function test_SecondaryAgrees_OpenExecutes() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        (bool ok,) = _openWithSecondary(ENTRY, ENTRY, block.timestamp + MIN_EXECUTION_DELAY);
        assertTrue(ok, "agreeing fresh secondary -> open fills normally");
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, COL * LEV, "position opened");
    }

    // =====================================================================
    // 2. FRESH secondary diverges > band.
    // =====================================================================

    function test_FreshDiverge_OpenReverts() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        // primary 66000 vs secondary 60000 = +10% > 5% band.
        (bool ok, bytes memory ret) = _openWithSecondary(66_000, 60_000, block.timestamp + MIN_EXECUTION_DELAY);
        assertFalse(ok, "fresh divergence halts the open");
        assertEq(bytes4(ret), PositionManager.BreakerTripped.selector, "BreakerTripped selector");
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, 0, "no position on a tripped open");
    }

    function test_FreshDiverge_IncreaseReverts() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        // Seed a position via the direct exposer (no breaker on that path).
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        _fund(pm, alice, COL + EXECUTION_FEE);
        vm.prank(alice);
        uint256 id = pm.requestIncrease(BTC, true, COL, LEV, 70_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        feed.set(_sec(60_000), block.timestamp);
        (bool ok, bytes memory ret) = _execute(pm, keeper, id, BTC, 66_000);
        assertFalse(ok, "increase is gated like open");
        assertEq(bytes4(ret), PositionManager.BreakerTripped.selector, "BreakerTripped selector");
    }

    function test_FreshDiverge_CloseStillWorks() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        _fund(pm, alice, EXECUTION_FEE);
        vm.prank(alice);
        uint256 id = pm.requestClose(BTC, true, 50_000 * ONE8); // sell floor
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        feed.set(_sec(40_000), block.timestamp); // wildly diverges from primary 60000
        (bool ok,) = _execute(pm, keeper, id, BTC, ENTRY);
        assertTrue(ok, "close is never gated by the breaker (de-risking)");
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, 0, "position closed");
    }

    function test_FreshDiverge_DecreaseStillWorks() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        _fund(pm, alice, EXECUTION_FEE);
        vm.prank(alice);
        uint256 id = pm.requestDecrease(BTC, true, 5_000, 50_000 * ONE8); // 50% decrease
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        feed.set(_sec(40_000), block.timestamp);
        (bool ok,) = _execute(pm, keeper, id, BTC, ENTRY);
        assertTrue(ok, "decrease is never gated by the breaker (de-risking)");
    }

    function test_FreshDiverge_LiquidationExecutesAndEmitsDivergence() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        feed.set(_sec(60_000), block.timestamp); // diverges from the liq mark 49200
        // Observe-only: Divergence emitted, liquidation still executes.
        vm.expectEmit(true, false, false, true, address(pm));
        emit PositionManager.Divergence(BTC, 49_200 * ONE8, 60_000 * ONE8);
        _liquidate(pm, liquidator, alice, BTC, true, 49_200);
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, 0, "liquidation executed despite divergence (observe-only)");
    }

    // =====================================================================
    // 3. STALE secondary -> abstain (proceed on primary), emit BreakerAbstained.
    // =====================================================================

    function test_StaleSecondary_AbstainsOpenProceeds() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 70_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        // Diverging price BUT stale (updatedAt 301s old, window 300s) -> abstain.
        feed.set(_sec(40_000), block.timestamp - (MAX_AGE + 1));
        vm.expectEmit(true, false, false, true, address(pm));
        emit PositionManager.BreakerAbstained(BTC, 66_000 * ONE8);
        (bool ok,) = _execute(pm, keeper, id, BTC, 66_000);
        assertTrue(ok, "stale secondary -> abstain -> open proceeds on the validated primary");
    }

    function test_ZeroAnswerSecondary_Abstains() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 70_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        feed.set(0, block.timestamp); // zero/uninitialized answer -> abstain
        (bool ok,) = _execute(pm, keeper, id, BTC, 66_000);
        assertTrue(ok, "non-positive secondary answer -> abstain -> open proceeds");
    }

    // =====================================================================
    // 4. DORMANT (band unset, even with a feed wired) -> no gating.
    // =====================================================================

    function test_Dormant_NoBreakerEvenWithFeedSet() public {
        pm.setSecondaryFeed(BTC, address(feed));
        // No _setCB -> band 0 -> disabled. A wildly diverging fresh secondary is ignored.
        (bool ok,) = _openWithSecondary(66_000, 40_000, block.timestamp + MIN_EXECUTION_DELAY);
        assertTrue(ok, "dormant breaker (band 0) -> open fills regardless of divergence");
    }

    function test_Dormant_NoSecondaryConfigured() public {
        // Band set but NO secondary feed wired -> still disabled (no read attempted).
        _setCB(BTC, BAND_BPS, MAX_AGE);
        (bool ok,) = _openWithSecondary(66_000, 40_000, block.timestamp + MIN_EXECUTION_DELAY);
        assertTrue(ok, "no secondary feed -> breaker is a no-op");
    }

    // =====================================================================
    // 5. Reconvergence -> a tripped request self-heals on the next execute.
    // =====================================================================

    function test_Reconvergence_TripClears() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 70_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // First fill: primary 66000 vs secondary 60000 -> trip, request stays active.
        feed.set(_sec(60_000), block.timestamp);
        (bool ok1, bytes memory ret) = _execute(pm, keeper, id, BTC, 66_000);
        assertFalse(ok1, "diverged fill reverts");
        assertEq(bytes4(ret), PositionManager.BreakerTripped.selector, "BreakerTripped selector");

        // Feeds reconverge: primary 61000 vs secondary 60000 = 1.67% < 5% -> fills.
        (bool ok2,) = _execute(pm, keeper, id, BTC, 61_000);
        assertTrue(ok2, "same request self-heals once the feeds reconverge");
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, COL * LEV, "position opened on the reconverged fill");
    }

    // =====================================================================
    // 6. Per-feed normalization: an 8-decimal secondary (LitOracle-style swap-in)
    //    is compared correctly against the 1e8 primary.
    // =====================================================================

    function test_Normalization_8DecimalSecondary() public {
        MockAggregatorV3 feed8 = new MockAggregatorV3(8);
        pm.setSecondaryFeed(BTC, address(feed8));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 70_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        feed8.set(int256(60_000 * 1e8), block.timestamp); // 8-dec secondary = 60000e8
        (bool ok, bytes memory ret) = _execute(pm, keeper, id, BTC, 66_000); // 10% > band
        assertFalse(ok, "8-dec secondary normalized correctly -> divergence trips");
        assertEq(bytes4(ret), PositionManager.BreakerTripped.selector, "BreakerTripped selector");
    }

    // =====================================================================
    // 7. LIQUIDATION can NEVER be blocked by the secondary.
    // =====================================================================

    function test_Liquidation_BrokenSecondary_NeverBlocks_EvenWhenGated() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _setGateLiq(1); // liquidation gating ENABLED...
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        feed.setRevert(true); // ...but the secondary read reverts -> must abstain, not block.
        _liquidate(pm, liquidator, alice, BTC, true, 49_200);
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, 0, "liquidation proceeds despite a reverting secondary (solvency never blocked)");
    }

    function test_Liquidation_StaleSecondary_NeverBlocks_EvenWhenGated() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _setGateLiq(1);
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // Fresh-looking divergence but stale stamp -> abstain -> liquidation proceeds.
        feed.set(_sec(60_000), block.timestamp - (MAX_AGE + 1));
        _liquidate(pm, liquidator, alice, BTC, true, 49_200);
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, 0, "liquidation proceeds despite a stale secondary");
    }

    function test_Liquidation_GateOn_FreshDiverge_Reverts() public {
        // Proves the opt-in flag actually gates: gate ON + fresh divergence -> revert.
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _setGateLiq(1);
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        feed.set(_sec(60_000), block.timestamp); // fresh, diverges from liq mark 49200
        (bool ok, bytes memory ret) = _liquidateRaw(pm, liquidator, alice, BTC, true, 49_200);
        assertFalse(ok, "with gating ON, a fresh divergence halts liquidation");
        assertEq(bytes4(ret), PositionManager.BreakerTripped.selector, "BreakerTripped selector");
    }

    /// @dev Closes the `answer <= 0` abstain branch ON the gated liquidation path.
    ///      A zero/uninitialized secondary, even with gating ON, must abstain (not
    ///      block) — solvency can never hinge on a feed that has no value to report.
    function test_Liquidation_ZeroAnswerSecondary_NeverBlocks_EvenWhenGated() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _setGateLiq(1); // gating ENABLED...
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        feed.set(0, block.timestamp); // ...but non-positive answer -> abstain, not block.
        _liquidate(pm, liquidator, alice, BTC, true, 49_200);
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, 0, "liquidation proceeds despite a zero-answer secondary");
    }

    /// @dev Closes the `updatedAt > block.timestamp` (future-stamped) abstain branch
    ///      ON the gated liquidation path. A secondary stamped in the future is treated
    ///      as untrustworthy -> abstain -> liquidation still proceeds.
    function test_Liquidation_FutureStampedSecondary_NeverBlocks_EvenWhenGated() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        _setGateLiq(1);
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // Fresh-looking divergence but stamped 1s in the future -> abstain.
        feed.set(_sec(60_000), block.timestamp + 1);
        _liquidate(pm, liquidator, alice, BTC, true, 49_200);
        (,,,, uint256 sizeUsd,,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(sizeUsd, 0, "liquidation proceeds despite a future-stamped secondary");
    }

    // =====================================================================
    // 8. Governance authority + config validation.
    // =====================================================================

    function test_Gov_CBParamsSettable() public {
        Governance gov = pm.governance();
        bytes32 key = _cbKey(BTC);
        gov.setParamBounds(key, 0, type(uint256).max);
        uint256 packed = (MAX_AGE << 128) | BAND_BPS;
        gov.setParam(key, packed);
        assertEq(gov.getParam(key), packed, "packed thresholds stored");

        // The global liquidation-gate key is an independent, separately-bounded
        // param (fail-closed: needs its own bounds before it can be set).
        _setGateLiq(1);
        assertEq(gov.getParam(_gateKey()), 1, "gate flag stored under a distinct key");
    }

    function test_Gov_NonOwnerCannotSetThresholds() public {
        Governance gov = pm.governance();
        bytes32 key = _cbKey(BTC);
        gov.setParamBounds(key, 0, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.setParam(key, 1);
    }

    function test_SetSecondaryFeed_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pm.setSecondaryFeed(BTC, address(feed));
    }

    function test_SetSecondaryFeed_RejectsHighDecimals() public {
        MockAggregatorV3 feed19 = new MockAggregatorV3(19);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.SecondaryDecimalsTooHigh.selector, uint8(19)));
        pm.setSecondaryFeed(BTC, address(feed19));
    }

    function test_SetSecondaryFeed_ClearDisablesBreaker() public {
        pm.setSecondaryFeed(BTC, address(feed));
        _setCB(BTC, BAND_BPS, MAX_AGE);
        pm.setSecondaryFeed(BTC, address(0)); // clear -> breaker no-op again
        (bool ok,) = _openWithSecondary(66_000, 40_000, block.timestamp + MIN_EXECUTION_DELAY);
        assertTrue(ok, "clearing the secondary disables the breaker");
    }
}
