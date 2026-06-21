// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Trigger-exit tests (PR-10a, Phase 2).
//
// Exercises the ADDITIVE requestTriggerClose / requestTriggerDecrease -> keeper-
// execute flow. A trigger order is an ORDINARY two-step Close/Decrease request PLUS
// a (triggerPrice, triggerAbove) gate; it reuses the existing fill cores unchanged.
// The ONLY new on-chain behavior is the gate in executeRequest: a trigger order
// RESTS (the keeper's execute REVERTS, leaving the request active) until BOTH the
// trigger and the slippage bound are met, whereas a plain market order CANCELS +
// refunds on a slippage miss. Market-order behavior and the Open/Close/Decrease/
// Increase suites are untouched; this file only adds the new surface.
//
// One (triggerPrice, triggerAbove) pair expresses TP / SL / limit / stop; the
// TP-vs-SL label is a frontend concern. For a LONG: a take-profit rests ABOVE entry
// (triggerAbove=true), a stop-loss BELOW (triggerAbove=false). For a SHORT it
// mirrors: TP below (false), SL above (true). A stop-type order is queued with a
// PERMISSIVE acceptablePrice so adverse slippage on the gap-through cannot keep it
// from firing.
//
// FFI: prices come from the Node helper `test/ffi/redstone-mock-payload.js` (same as
// the other suites). `executeRequest` reads the signed price from the *tail* of the
// calldata, so its calls are built as abi.encodeWithSelector(fn, args) ++ payload and
// `call`ed. The request functions take no oracle payload and are called directly.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Governance} from "../src/Governance.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {AuthorisedMockSignersBase} from "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";

/**
 * @dev Test-only subclass swapping the real demo signer for RedStone's mock signers
 *      so offline mock payloads verify (mirrors {PartialCloseHarness}). The thin
 *      exposer reproduces the OLD direct open core (PR-6c deleted the external
 *      entry) — used only to set up positions for the trigger flow; the core is
 *      unchanged so the comparison holds.
 */
contract TriggerExitsHarness is PositionManager, AuthorisedMockSignersBase {
    constructor(LiquidityPool pool_, Governance governance_) PositionManager(pool_, governance_) {}

    function getAuthorisedSignerIndex(address signerAddress) public view virtual override returns (uint8) {
        return getAuthorisedMockSignerIndex(signerAddress);
    }

    function exposed_open(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 price) external {
        _openPosition(msg.sender, market, isLong, collateral, leverage, price, true);
    }

    function exposed_close(bytes32 market, bool isLong, uint256 price) external returns (uint256) {
        return _closePosition(msg.sender, market, isLong, price);
    }
}

contract TriggerExitsTest is Test {
    MockERC20 internal asset;
    LiquidityPool internal pool;
    TriggerExitsHarness internal pm;

    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal keeper = makeAddr("keeper");

    bytes32 internal constant BTC = bytes32("BTC");

    uint256 internal constant ONE8 = 1e8; // RedStone numeric precision
    uint256 internal constant LP_LIQUIDITY = 1_000_000e18;

    // Mirrors of the manager's params for assertions.
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant EXECUTION_FEE = 0.5e18;
    uint256 internal constant MIN_EXECUTION_DELAY = 3;
    uint256 internal constant CANCEL_DELAY = 180;

    // Position economics: collateral 1000, leverage 5 -> size 5000, entry 60000.
    uint256 internal constant COL = 1_000e18;
    uint256 internal constant LEV = 5;
    uint256 internal constant SIZE = COL * LEV; // 5000e18
    uint256 internal constant ENTRY = 60_000;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        (pool, pm) = _newSystem(LP_LIQUIDITY);
        vm.warp(1_700_000_000); // base block time (seconds)
    }

    // --- system / payload helpers ---------------------------------------

    function _newSystem(uint256 liq) internal returns (LiquidityPool p, TriggerExitsHarness m) {
        Governance gov = new Governance(address(this));
        p = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP", gov);
        m = new TriggerExitsHarness(p, gov);
        p.setPositionManager(address(m));
        asset.mint(address(this), liq);
        asset.approve(address(p), liq);
        p.deposit(liq, lp);
    }

    /// @dev Build a mock signed payload at `tsMs` carrying BTC at `price` (human
    ///      units; on-chain value is price*1e8).
    function _payload(uint256 tsMs, uint256 price) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/redstone-mock-payload.js";
        cmd[2] = vm.toString(tsMs);
        cmd[3] = string.concat("BTC:", vm.toString(price));
        return vm.ffi(cmd);
    }

    function _fund(PositionManager p, address who, uint256 amt) internal {
        asset.mint(who, amt);
        vm.prank(who);
        asset.approve(address(p), amt);
    }

    // Direct open via the harness exposer. `price` is the human-unit mark, scaled to
    // 1e8 as the oracle would on-chain.
    function _open(address who, bool isLong, uint256 collateral, uint256 leverage, uint256 price) internal {
        vm.prank(who);
        pm.exposed_open(BTC, isLong, collateral, leverage, price * ONE8);
    }

    // --- request / execute helpers --------------------------------------

    function _requestTriggerClose(
        address who,
        bool isLong,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove
    ) internal returns (uint256 id) {
        vm.prank(who);
        id = pm.requestTriggerClose(BTC, isLong, acceptablePrice * ONE8, triggerPrice * ONE8, triggerAbove);
    }

    function _requestTriggerDecrease(
        address who,
        bool isLong,
        uint256 closeBps,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove
    ) internal returns (uint256 id) {
        vm.prank(who);
        id = pm.requestTriggerDecrease(BTC, isLong, closeBps, acceptablePrice * ONE8, triggerPrice * ONE8, triggerAbove);
    }

    /// @dev Execute a request with a payload stamped at the current block time.
    ///      Returns the raw (ok, ret) so callers can assert a fill or a revert.
    function _execute(address who, uint256 requestId, uint256 price) internal returns (bool ok, bytes memory ret) {
        bytes memory payload = _payload(block.timestamp * 1000, price);
        bytes memory data =
            abi.encodePacked(abi.encodeWithSelector(PositionManager.executeRequest.selector, requestId), payload);
        vm.prank(who);
        (ok, ret) = address(pm).call(data);
    }

    /// @dev The 4-byte error selector at the head of a revert blob.
    function _selector(bytes memory ret) internal pure returns (bytes4 s) {
        require(ret.length >= 4, "no revert data");
        assembly {
            s := mload(add(ret, 0x20))
        }
    }

    // --- view helpers ----------------------------------------------------

    function _active(uint256 id) internal view returns (bool a) {
        (,,,,,,,,, a) = pm.requests(id);
    }

    function _sizeUsd(address who, bool isLong) internal view returns (uint256 s) {
        (,,,, s,,,) = pm.positions(pm.getPositionKey(who, BTC, isLong));
    }

    function _posCollateral(address who, bool isLong) internal view returns (uint256 c) {
        (,,, c,,,,) = pm.positions(pm.getPositionKey(who, BTC, isLong));
    }

    function _triggerPrice(uint256 id) internal view returns (uint256 tp) {
        (tp,) = pm.triggers(id);
    }

    // =====================================================================
    // 1. Long take-profit: rests below the trigger, fills at/above it with
    //    profit. Keeper paid; trigger + mutex cleared.
    // =====================================================================

    function test_LongTakeProfit_RestsThenFills() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);
        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // TP rests ABOVE entry: trigger 66000, fires at/above (triggerAbove=true).
        // Acceptable 60000 -> a long sell at/above the trigger clears the bound.
        uint256 id = _requestTriggerClose(alice, true, ENTRY, 66_000, true);
        assertTrue(pm.closePending(key), "closePending set on a resting trigger");
        assertEq(_triggerPrice(id), 66_000 * ONE8, "trigger price recorded");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Below the trigger -> rests (reverts), request STILL active.
        (bool ok, bytes memory ret) = _execute(keeper, id, 63_000);
        assertFalse(ok, "execute below trigger must revert");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");
        assertTrue(_active(id), "request still active after a trigger miss");
        assertTrue(pm.closePending(key), "mutex still held while resting");

        // At/above the trigger and within slippage -> fills with profit.
        uint256 aliceBefore = asset.balanceOf(alice);
        (bool ok2,) = _execute(keeper, id, 66_000);
        require(ok2, "execute at trigger should fill");

        assertEq(_sizeUsd(alice, true), 0, "position closed on the trigger fill");
        assertGt(asset.balanceOf(alice) - aliceBefore, 0, "trader paid out a profit");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid the execution fee");
        assertFalse(_active(id), "request consumed on fill");
        assertFalse(pm.closePending(key), "mutex cleared on fill");
        assertEq(_triggerPrice(id), 0, "trigger slot cleared on fill");
    }

    // =====================================================================
    // 2. Long stop-loss: rests above the trigger, fills at/below it with a
    //    loss. Permissive acceptable so the adverse fill is not bounded out.
    // =====================================================================

    function test_LongStopLoss_RestsThenFillsAtLoss() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);

        // SL rests BELOW entry: trigger 54000, fires at/below (triggerAbove=false).
        // Permissive acceptable (1) -> any long-sell price clears the bound.
        uint256 id = _requestTriggerClose(alice, true, 1, 54_000, false);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Above the trigger -> rests.
        (bool ok, bytes memory ret) = _execute(keeper, id, 57_000);
        assertFalse(ok, "execute above trigger must revert");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");
        assertTrue(_active(id), "request still active while resting");

        // At/below the trigger -> fills at a loss (collateral mostly consumed).
        uint256 aliceBefore = asset.balanceOf(alice);
        (bool ok2,) = _execute(keeper, id, 54_000);
        require(ok2, "execute at trigger should fill");

        assertEq(_sizeUsd(alice, true), 0, "position closed on the stop");
        // -10% on 5x size = -50% of collateral; payout is a partial collateral return.
        uint256 payout = asset.balanceOf(alice) - aliceBefore;
        assertGt(payout, 0, "some collateral returned");
        assertLt(payout, COL, "but less than the posted collateral (a realized loss)");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid on fill");
        assertFalse(pm.closePending(pm.getPositionKey(alice, BTC, true)), "mutex cleared on fill");
    }

    // =====================================================================
    // 3. Triggered but slippage missed -> SlippageNotMet revert, request
    //    STILL active and escrow intact (NOT cancelled). A later in-bound
    //    execute then fills it.
    // =====================================================================

    function test_TriggerMet_SlippageMiss_RestsThenFills() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);
        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // Trigger 66000 above; demand a HIGH sell price (acceptable 70000) so a fill
        // exactly at the trigger clears the trigger but MISSES the slippage bound.
        uint256 id = _requestTriggerClose(alice, true, 70_000, 66_000, true);
        uint256 aliceAfterRequest = asset.balanceOf(alice);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // 66000 >= trigger (met) but 66000 < acceptable 70000 (slippage miss).
        (bool ok, bytes memory ret) = _execute(keeper, id, 66_000);
        assertFalse(ok, "slippage miss on a trigger must revert (not cancel)");
        assertEq(_selector(ret), PositionManager.SlippageNotMet.selector, "SlippageNotMet");
        assertTrue(_active(id), "request still active after a slippage revert");
        assertTrue(pm.closePending(key), "mutex still held (not cancelled)");
        assertEq(_triggerPrice(id), 66_000 * ONE8, "trigger slot intact");
        assertEq(asset.balanceOf(alice), aliceAfterRequest, "escrow intact (no refund)");
        assertEq(asset.balanceOf(keeper), 0, "keeper unpaid while resting");

        // A later in-bound execute (>= acceptable 70000 and >= trigger) fills it.
        (bool ok2,) = _execute(keeper, id, 71_000);
        require(ok2, "in-bound execute should fill");
        assertEq(_sizeUsd(alice, true), 0, "position closed");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid on the eventual fill");
        assertFalse(pm.closePending(key), "mutex cleared on fill");
    }

    // =====================================================================
    // 4. Trigger partial decrease: rests, then fires -> remaining size and
    //    collateral halved, trigger cleared, position still open.
    // =====================================================================

    function test_TriggerDecrease_RestsThenHalves() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);
        bytes32 key = pm.getPositionKey(alice, BTC, true);

        uint256 id = _requestTriggerDecrease(alice, true, 5_000, ENTRY, 66_000, true);
        assertTrue(pm.closePending(key), "closePending set on a resting trigger decrease");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Below the trigger -> rests.
        (bool ok, bytes memory ret) = _execute(keeper, id, 63_000);
        assertFalse(ok, "below trigger must revert");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");
        assertEq(_sizeUsd(alice, true), SIZE, "position untouched while resting");

        // At the trigger -> fires; half is closed, half remains open.
        (bool ok2,) = _execute(keeper, id, 66_000);
        require(ok2, "at trigger should fire the decrease");

        assertEq(_sizeUsd(alice, true), SIZE / 2, "remaining size halved");
        assertEq(_posCollateral(alice, true), COL / 2, "remaining collateral halved");
        assertEq(_triggerPrice(id), 0, "trigger slot cleared on fill");
        assertFalse(_active(id), "request consumed");
        assertFalse(pm.closePending(key), "mutex cleared (position still open)");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid on fill");
    }

    // =====================================================================
    // 5. Cancel a resting trigger after CANCEL_DELAY: fee refunded, mutex +
    //    trigger cleared, request inactive, position untouched.
    // =====================================================================

    function test_CancelRestingTrigger_RefundsAndTearsDown() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);
        bytes32 key = pm.getPositionKey(alice, BTC, true);

        uint256 id = _requestTriggerClose(alice, true, ENTRY, 66_000, true);
        uint256 aliceAfterRequest = asset.balanceOf(alice);

        vm.warp(block.timestamp + CANCEL_DELAY);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PositionManager.RequestCancelled(id, alice, false);
        vm.prank(alice);
        pm.cancelRequest(id);

        assertEq(asset.balanceOf(alice), aliceAfterRequest + EXECUTION_FEE, "execution fee refunded");
        assertFalse(pm.closePending(key), "mutex cleared on cancel");
        assertEq(_triggerPrice(id), 0, "trigger slot cleared on cancel");
        assertFalse(_active(id), "request inactive after cancel");
        assertEq(_sizeUsd(alice, true), SIZE, "position untouched");
        assertEq(_posCollateral(alice, true), COL, "collateral untouched");
    }

    // =====================================================================
    // 6. Mutex: a resting trigger close blocks requestClose, requestDecrease,
    //    AND requestTriggerDecrease on the same key (CloseAlreadyPending).
    // =====================================================================

    function test_RestingTrigger_BlocksOtherExits() public {
        _fund(pm, alice, COL + 4 * EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);

        _requestTriggerClose(alice, true, ENTRY, 66_000, true);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestClose(BTC, true, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestDecrease(BTC, true, 5_000, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestTriggerDecrease(BTC, true, 5_000, ENTRY * ONE8, 66_000 * ONE8, true);
    }

    // =====================================================================
    // 7. Short direction: short TP (triggerAbove=false, below entry) and short
    //    SL (triggerAbove=true, above entry) fire on the correct side.
    // =====================================================================

    function test_ShortTakeProfit_FiresBelowEntry() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, false, COL, LEV, ENTRY);

        // Short TP: profit as price FALLS -> trigger 54000, fires at/below (false).
        // Short close clears the bound when price <= acceptable; 60000 is permissive.
        uint256 id = _requestTriggerClose(alice, false, ENTRY, 54_000, false);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Above the trigger -> rests.
        (bool ok, bytes memory ret) = _execute(keeper, id, 57_000);
        assertFalse(ok, "short TP rests above the trigger");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");

        // At/below the trigger -> fills with profit.
        uint256 aliceBefore = asset.balanceOf(alice);
        (bool ok2,) = _execute(keeper, id, 54_000);
        require(ok2, "short TP fills at/below the trigger");
        assertEq(_sizeUsd(alice, false), 0, "short position closed");
        assertGt(asset.balanceOf(alice) - aliceBefore, COL, "trader took a profit (payout > collateral)");
    }

    function test_ShortStopLoss_FiresAboveEntry() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, false, COL, LEV, ENTRY);

        // Short SL: loss as price RISES -> trigger 66000, fires at/above (true).
        // Permissive acceptable (1e9) so the adverse short-buy is not bounded out.
        uint256 id = _requestTriggerClose(alice, false, 1_000_000_000, 66_000, true);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Below the trigger -> rests.
        (bool ok, bytes memory ret) = _execute(keeper, id, 63_000);
        assertFalse(ok, "short SL rests below the trigger");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");

        // At/above the trigger -> fills at a loss.
        uint256 aliceBefore = asset.balanceOf(alice);
        (bool ok2,) = _execute(keeper, id, 66_000);
        require(ok2, "short SL fills at/above the trigger");
        assertEq(_sizeUsd(alice, false), 0, "short position closed");
        uint256 payout = asset.balanceOf(alice) - aliceBefore;
        assertGt(payout, 0, "some collateral returned");
        assertLt(payout, COL, "but a realized loss");
    }

    // =====================================================================
    // 8. InvalidTriggerPrice: triggerPrice == 0 reverts at request time for
    //    both trigger entries.
    // =====================================================================

    function test_RequestTrigger_RevertWhen_ZeroTriggerPrice() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);

        vm.prank(alice);
        vm.expectRevert(PositionManager.InvalidTriggerPrice.selector);
        pm.requestTriggerClose(BTC, true, ENTRY * ONE8, 0, true);

        vm.prank(alice);
        vm.expectRevert(PositionManager.InvalidTriggerPrice.selector);
        pm.requestTriggerDecrease(BTC, true, 5_000, ENTRY * ONE8, 0, true);
    }

    // =====================================================================
    // 9. Market regression: a plain requestClose still CANCELS on a slippage
    //    miss (does not rest) — the market path is unchanged by the trigger gate.
    // =====================================================================

    function test_MarketClose_StillCancelsOnSlippageMiss() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);
        uint256 afterOpen = asset.balanceOf(alice);
        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // Acceptable ABOVE the exit -> a long close misses the bound.
        vm.prank(alice);
        uint256 id = pm.requestClose(BTC, true, 70_000 * ONE8);
        assertEq(_triggerPrice(id), 0, "a plain close is not a trigger order");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PositionManager.RequestCancelled(id, alice, true);
        (bool ok,) = _execute(keeper, id, 66_000); // 66000 < acceptable 70000 -> miss
        require(ok, "market slippage cancel must not revert (it cancels, not rests)");

        assertEq(_sizeUsd(alice, true), SIZE, "position unchanged after a market cancel");
        assertEq(asset.balanceOf(alice), afterOpen, "execution fee refunded on cancel");
        assertEq(asset.balanceOf(keeper), 0, "keeper unpaid on a slippage cancel");
        assertFalse(pm.closePending(key), "mutex cleared on cancel");
        assertFalse(_active(id), "request consumed (cancelled, not resting)");
    }
}
