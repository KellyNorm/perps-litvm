// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Exercises the per-market, per-side open-interest (exposure) cap layered onto
// the open/increase EXECUTE seam. Cap VALUES live in the external Governance
// param store under key keccak256(abi.encode("MAX_OI", market, isLong)); the
// PositionManager reads them at the single OI-increment seam (_updateMarket,
// isOpen branch) and reverts ExceedsMaxOI when a resulting side OI exceeds a
// non-zero cap. A cap of 0 (the default for an unconfigured market+side) is
// disabled, so the pre-existing suite trades unchanged.
//
// Inherits PositionManagerTest to reuse its harness, payload/FFI plumbing, and
// the _open/_close/_requestOpen/_execute helpers. The Governance instance is the
// one wired into `pm` (pm.governance()); this test contract is its owner (it is
// the deployer in _newSystem), so it can set bounds and values directly.

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {PositionManagerTest} from "./PositionManager.t.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Governance} from "../src/Governance.sol";

contract ExposureCapsTest is PositionManagerTest {
    // ENTRY (human-unit mark) and the alice/bob/keeper actors are inherited from
    // PositionManagerTest.

    // --- helpers ---------------------------------------------------------

    /// @dev The exact key the contract derives in {PositionManager._maxOiKey}.
    function _capKey(bytes32 market, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encode("MAX_OI", market, isLong));
    }

    /// @dev Owner-set a side cap: configure permissive bounds, then the value.
    function _setCap(bytes32 market, bool isLong, uint256 cap) internal {
        Governance gov = pm.governance();
        bytes32 key = _capKey(market, isLong);
        gov.setParamBounds(key, 0, type(uint256).max);
        gov.setParam(key, cap);
    }

    /// @dev Open via the REAL request->execute path and return whether it filled.
    ///      `collateral`/`leverage` set sizeUsd = collateral*leverage; mark = ENTRY.
    function _execOpen(address who, bytes32 market, bool isLong, uint256 collateral, uint256 leverage)
        internal
        returns (bool ok, bytes memory ret)
    {
        _fund(pm, who, collateral + EXECUTION_FEE);
        uint256 id = _requestOpen(pm, who, market, isLong, collateral, leverage, ENTRY * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (ok, ret) = _execute(pm, keeper, id, market, ENTRY);
    }

    // =====================================================================
    // 1. Open over the cap reverts AT EXECUTE; just under (at cap) succeeds.
    // =====================================================================

    function test_OpenAtCap_Succeeds() public {
        // cap = 100_000e18; alice's size = 10_000*10 = 100_000e18 == cap (allowed,
        // the gate is strict-greater).
        _setCap(BTC, true, 100_000e18);
        (bool ok,) = _execOpen(alice, BTC, true, 10_000e18, 10);
        assertTrue(ok, "open exactly at the cap must fill");
        (,,,, uint256 sizeUsd,,,) = pm.positions(keccak256(abi.encodePacked(alice, BTC, true)));
        assertEq(sizeUsd, 100_000e18, "position opened at cap");
    }

    function test_OpenOverCap_RevertsAtExecute() public {
        _setCap(BTC, true, 100_000e18);
        // alice fills the side to the cap.
        (bool okA,) = _execOpen(alice, BTC, true, 10_000e18, 10);
        assertTrue(okA, "first open at cap fills");

        // bob's open pushes the LONG side OI to 100_100e18 > cap -> revert at execute.
        (bool okB, bytes memory ret) = _execOpen(bob, BTC, true, 10e18, 10);
        assertFalse(okB, "open over the cap must revert at execute");
        assertEq(bytes4(ret), PositionManager.ExceedsMaxOI.selector, "ExceedsMaxOI selector");

        // The request stayed active (the whole execute tx rolled back): the keeper
        // never got paid and bob has no position.
        (,,,, uint256 sizeUsd,,,) = pm.positions(keccak256(abi.encodePacked(bob, BTC, true)));
        assertEq(sizeUsd, 0, "no position created on a capped revert");
    }

    // =====================================================================
    // 2. Per-side independence: a maxed long does NOT block shorts, and v.v.
    // =====================================================================

    function test_LongCap_DoesNotBlockShort() public {
        _setCap(BTC, true, 100_000e18); // only the LONG side is capped
        (bool okLong,) = _execOpen(alice, BTC, true, 10_000e18, 10); // maxes long
        assertTrue(okLong, "long fills to the cap");

        // A short of the same notional must fill: the short side has no cap (key
        // unset => 0 => disabled).
        (bool okShort,) = _execOpen(bob, BTC, false, 10_000e18, 10);
        assertTrue(okShort, "short must not be blocked by the long cap");
    }

    function test_ShortCap_DoesNotBlockLong() public {
        _setCap(BTC, false, 100_000e18); // only the SHORT side is capped
        (bool okShort,) = _execOpen(alice, BTC, false, 10_000e18, 10); // maxes short
        assertTrue(okShort, "short fills to the cap");

        (bool okLong,) = _execOpen(bob, BTC, true, 10_000e18, 10);
        assertTrue(okLong, "long must not be blocked by the short cap");
    }

    // =====================================================================
    // 3. cap == 0 (unset) => no limit. A large open within the utilization
    //    gate fills with no cap configured (the default for every market).
    // =====================================================================

    function test_CapUnset_NoLimit() public {
        // No _setCap call. Open a large long (size 500_000e18, reserve 250_000e18,
        // within the 80% utilization gate on the 1,000,000e18 pool).
        (bool ok,) = _execOpen(alice, BTC, true, 50_000e18, 10);
        assertTrue(ok, "with no cap set, the open is unconstrained by exposure caps");
    }

    // =====================================================================
    // 4. A decrease frees room: at cap, an over-cap open reverts; after a
    //    partial close, a fresh open within the freed room succeeds.
    // =====================================================================

    function test_DecreaseFreesRoom() public {
        _setCap(BTC, true, 100_000e18);
        // alice maxes the long side at the cap (direct open; the cap seam fires on
        // the exposed path too).
        _fund(pm, alice, 10_000e18);
        _open(pm, alice, BTC, true, 10_000e18, 10, ENTRY);

        // While at the cap, a new long open reverts (the cap seam fires before the
        // collateral pull, so bob needs no funding for the revert path).
        vm.expectRevert(PositionManager.ExceedsMaxOI.selector);
        _open(pm, bob, BTC, true, 10e18, 10, ENTRY);

        // alice partially closes 60% via the real request->execute decrease path,
        // dropping the long side OI to 40_000e18.
        _fund(pm, alice, EXECUTION_FEE);
        vm.prank(alice);
        uint256 id = pm.requestDecrease(BTC, true, 6_000, ENTRY * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool okDec,) = _execute(pm, keeper, id, BTC, ENTRY);
        assertTrue(okDec, "partial close fills");

        // Now a fresh long of size 50_000e18 fits: 40_000 + 50_000 = 90_000 <= cap.
        _fund(pm, bob, 5_000e18);
        _open(pm, bob, BTC, true, 5_000e18, 10, ENTRY);
        (,,,, uint256 sizeUsd,,,) = pm.positions(keccak256(abi.encodePacked(bob, BTC, true)));
        assertEq(sizeUsd, 50_000e18, "open within the freed room fills");
    }

    // =====================================================================
    // 5. Increase is capped on the SAME seam: an increase that pushes the side
    //    over the cap reverts at execute.
    // =====================================================================

    function test_IncreaseOverCap_RevertsAtExecute() public {
        _setCap(BTC, true, 100_000e18);
        // alice opens long at size 60_000e18 (under the cap).
        _fund(pm, alice, 6_000e18);
        _open(pm, alice, BTC, true, 6_000e18, 10, ENTRY);

        // Increase by 50_000e18 -> resulting long OI 110_000e18 > cap -> revert.
        _fund(pm, alice, 5_000e18 + EXECUTION_FEE);
        vm.prank(alice);
        uint256 id = pm.requestIncrease(BTC, true, 5_000e18, 10, ENTRY * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok, bytes memory ret) = _execute(pm, keeper, id, BTC, ENTRY);
        assertFalse(ok, "increase over the cap must revert at execute");
        assertEq(bytes4(ret), PositionManager.ExceedsMaxOI.selector, "ExceedsMaxOI selector");

        // The position is unchanged (size still 60_000e18) — the tx rolled back.
        (,,,, uint256 sizeUsd,,,) = pm.positions(keccak256(abi.encodePacked(alice, BTC, true)));
        assertEq(sizeUsd, 60_000e18, "increase did not apply on a capped revert");
    }

    // =====================================================================
    // 6. Governance authority over the cap: owner can set/raise/lower; a
    //    non-owner cannot; an out-of-bounds value reverts.
    // =====================================================================

    function test_Gov_OwnerCanSetRaiseLower() public {
        Governance gov = pm.governance();
        bytes32 key = _capKey(BTC, true);
        gov.setParamBounds(key, 0, type(uint256).max);

        gov.setParam(key, 100_000e18);
        assertEq(gov.getParam(key), 100_000e18, "cap set");
        gov.setParam(key, 200_000e18);
        assertEq(gov.getParam(key), 200_000e18, "cap raised");
        gov.setParam(key, 50_000e18);
        assertEq(gov.getParam(key), 50_000e18, "cap lowered");
    }

    function test_Gov_NonOwnerCannotSet() public {
        Governance gov = pm.governance();
        bytes32 key = _capKey(BTC, true);
        gov.setParamBounds(key, 0, type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.setParam(key, 100_000e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.setParamBounds(key, 0, 1);
    }

    function test_Gov_OutOfBoundsSetReverts() public {
        Governance gov = pm.governance();
        bytes32 key = _capKey(BTC, true);
        gov.setParamBounds(key, 100, 500);

        // Below min and above max both revert (fail-closed range check).
        vm.expectRevert(abi.encodeWithSelector(Governance.ParamOutOfBounds.selector, key, 99, 100, 500));
        gov.setParam(key, 99);
        vm.expectRevert(abi.encodeWithSelector(Governance.ParamOutOfBounds.selector, key, 501, 100, 500));
        gov.setParam(key, 501);

        // A key with no bounds configured rejects every set (fail-closed).
        bytes32 unbounded = _capKey(ETH, true);
        vm.expectRevert(abi.encodeWithSelector(Governance.ParamUnbounded.selector, unbounded));
        gov.setParam(unbounded, 1);
    }
}
