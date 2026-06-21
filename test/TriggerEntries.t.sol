// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Trigger-entry tests (PR-10b, Phase 2).
//
// Exercises the ADDITIVE requestTriggerOpen / requestTriggerIncrease -> keeper-
// execute flow: a limit/stop ENTRY (open) and a limit ADD (increase). A trigger
// entry is an ORDINARY two-step Open/Increase request PLUS a (triggerPrice,
// triggerAbove) gate; it reuses the existing fill cores AND the existing trigger
// gate in executeRequest entirely unchanged. PR-10a already made that gate
// kind-agnostic (it keys off triggers[id], not the kind) and taught cancelRequest
// to refund collateral+fee for Open/Increase, so this PR adds NO execution-machinery
// changes — only the two new request functions + their events.
//
// As with trigger EXITS, the ONLY new on-chain behavior versus a market order is the
// gate: a trigger entry RESTS (the keeper's execute REVERTS, leaving the request
// active) until BOTH the trigger and the slippage bound are met, whereas a plain
// market open/increase CANCELS + refunds on a slippage miss.
//
// An Open/Increase is on the BUY side of _withinSlippage: a LONG fills at
// price <= acceptable, a SHORT at price >= acceptable. The (triggerPrice,
// triggerAbove) pair expresses limit vs stop: a LIMIT long (buy the dip) rests
// BELOW spot (triggerAbove=false), a STOP long (breakout) rests ABOVE
// (triggerAbove=true); a SHORT mirrors. A stop-type entry is queued with a
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
 *      so offline mock payloads verify (mirrors {TriggerExitsHarness}). The thin
 *      exposer reproduces the OLD direct open core (PR-6c deleted the external
 *      entry) — used only to set up positions for the trigger-increase flow; the
 *      core is unchanged so the comparison holds.
 */
contract TriggerEntriesHarness is PositionManager, AuthorisedMockSignersBase {
    constructor(LiquidityPool pool_, Governance governance_) PositionManager(pool_, governance_) {}

    function getAuthorisedSignerIndex(address signerAddress) public view virtual override returns (uint8) {
        return getAuthorisedMockSignerIndex(signerAddress);
    }

    function exposed_open(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 price) external {
        _openPosition(msg.sender, market, isLong, collateral, leverage, price, true);
    }
}

contract TriggerEntriesTest is Test {
    MockERC20 internal asset;
    LiquidityPool internal pool;
    TriggerEntriesHarness internal pm;

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

    function _newSystem(uint256 liq) internal returns (LiquidityPool p, TriggerEntriesHarness m) {
        Governance gov = new Governance(address(this));
        p = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP", gov);
        m = new TriggerEntriesHarness(p, gov);
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

    function _requestTriggerOpen(
        address who,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove
    ) internal returns (uint256 id) {
        vm.prank(who);
        id = pm.requestTriggerOpen(
            BTC, isLong, collateral, leverage, acceptablePrice * ONE8, triggerPrice * ONE8, triggerAbove
        );
    }

    function _requestTriggerIncrease(
        address who,
        bool isLong,
        uint256 addCollateral,
        uint256 addLeverage,
        uint256 acceptablePrice,
        uint256 triggerPrice,
        bool triggerAbove
    ) internal returns (uint256 id) {
        vm.prank(who);
        id = pm.requestTriggerIncrease(
            BTC, isLong, addCollateral, addLeverage, acceptablePrice * ONE8, triggerPrice * ONE8, triggerAbove
        );
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

    function _entryPrice(address who, bool isLong) internal view returns (uint256 e) {
        (,,,,, e,,) = pm.positions(pm.getPositionKey(who, BTC, isLong));
    }

    function _triggerPrice(uint256 id) internal view returns (uint256 tp) {
        (tp,) = pm.triggers(id);
    }

    // =====================================================================
    // 1. Limit long entry (buy the dip): trigger BELOW spot, triggerAbove=false.
    //    Rests while price is above the trigger; fills at/below it. Opens a fresh
    //    position; keeper paid; trigger cleared; request consumed.
    // =====================================================================

    function test_LimitLongEntry_RestsThenOpens() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // Limit buy: trigger 54000 below spot, fires at/below (false). Acceptable
        // 55000 >= the fill -> a long buy at/below the trigger clears the bound.
        uint256 id = _requestTriggerOpen(alice, true, COL, LEV, 55_000, 54_000, false);
        assertFalse(pm.closePending(key), "an open never sets the closePending mutex");
        assertEq(_triggerPrice(id), 54_000 * ONE8, "trigger price recorded");
        assertEq(_sizeUsd(alice, true), 0, "no position yet (resting)");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Above the trigger -> rests (reverts), request STILL active, escrow intact.
        uint256 escrowed = asset.balanceOf(address(pm));
        (bool ok, bytes memory ret) = _execute(keeper, id, 57_000);
        assertFalse(ok, "execute above trigger must revert");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");
        assertTrue(_active(id), "request still active after a trigger miss");
        assertEq(asset.balanceOf(address(pm)), escrowed, "escrow (collateral+fee) intact while resting");

        // At/below the trigger and within slippage -> opens at the fill price.
        (bool ok2,) = _execute(keeper, id, 54_000);
        require(ok2, "execute at trigger should open");

        assertEq(_sizeUsd(alice, true), SIZE, "size = collateral * leverage");
        assertEq(_posCollateral(alice, true), COL, "collateral posted");
        assertEq(_entryPrice(alice, true), 54_000 * ONE8, "entry at the fill price");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid the execution fee");
        assertFalse(_active(id), "request consumed on fill");
        assertEq(_triggerPrice(id), 0, "trigger slot cleared on fill");
    }

    // =====================================================================
    // 2. Stop long entry (breakout): trigger ABOVE spot, triggerAbove=true.
    //    Rests below; fires at/above with a permissive acceptable.
    // =====================================================================

    function test_StopLongEntry_FiresAtBreakout() public {
        _fund(pm, alice, COL + EXECUTION_FEE);

        // Breakout buy: trigger 66000 above spot, fires at/above (true). Permissive
        // acceptable 70000 so the gap-through fill is not bounded out.
        uint256 id = _requestTriggerOpen(alice, true, COL, LEV, 70_000, 66_000, true);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Below the trigger -> rests.
        (bool ok, bytes memory ret) = _execute(keeper, id, 63_000);
        assertFalse(ok, "stop entry rests below the trigger");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");
        assertTrue(_active(id), "request still active while resting");

        // At/above the trigger -> opens.
        (bool ok2,) = _execute(keeper, id, 66_000);
        require(ok2, "stop entry fires at/above the trigger");
        assertEq(_sizeUsd(alice, true), SIZE, "position opened on the breakout");
        assertEq(_entryPrice(alice, true), 66_000 * ONE8, "entry at the fill price");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid on fill");
    }

    // =====================================================================
    // 3. Entry rest keeps the FULL escrow: after a TriggerNotMet the owner's
    //    balance stays DOWN collateral+fee (no refund, unlike a market cancel) and
    //    the request stays active; a later in-bound execute opens it.
    // =====================================================================

    function test_RestingEntry_KeepsFullEscrow() public {
        _fund(pm, alice, COL + EXECUTION_FEE);

        uint256 id = _requestTriggerOpen(alice, true, COL, LEV, 55_000, 54_000, false);
        // Funded exactly the escrow, so the trader's balance is now zero.
        assertEq(asset.balanceOf(alice), 0, "collateral + fee escrowed at request");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        (bool ok,) = _execute(keeper, id, 57_000);
        assertFalse(ok, "above trigger rests");
        assertEq(asset.balanceOf(alice), 0, "no refund on a rest (escrow stays put)");
        assertTrue(_active(id), "still active");

        (bool ok2,) = _execute(keeper, id, 54_000);
        require(ok2, "in-bound execute opens it");
        assertEq(_sizeUsd(alice, true), SIZE, "opened after the rest");
    }

    // =====================================================================
    // 4. Cancel a resting trigger-open after CANCEL_DELAY: refunds the FULL escrow
    //    (collateral + fee), trigger cleared, request inactive, NO position created
    //    and the closePending mutex was never set.
    // =====================================================================

    function test_CancelRestingTriggerOpen_RefundsFullEscrow() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        bytes32 key = pm.getPositionKey(alice, BTC, true);

        uint256 id = _requestTriggerOpen(alice, true, COL, LEV, 55_000, 54_000, false);
        assertEq(asset.balanceOf(alice), 0, "escrowed");

        vm.warp(block.timestamp + CANCEL_DELAY);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PositionManager.RequestCancelled(id, alice, false);
        vm.prank(alice);
        pm.cancelRequest(id);

        assertEq(asset.balanceOf(alice), COL + EXECUTION_FEE, "full escrow (collateral + fee) refunded");
        assertEq(_triggerPrice(id), 0, "trigger slot cleared on cancel");
        assertFalse(_active(id), "request inactive after cancel");
        assertFalse(pm.closePending(key), "mutex never set for an open");
        assertEq(_sizeUsd(alice, true), 0, "no position created");
    }

    // =====================================================================
    // 5. Limit add (trigger increase): open a position, then rest an increase.
    //    Rests below the trigger (position untouched); fires at/above -> size and
    //    collateral grow with a blended entry; trigger + mutex cleared, keeper paid.
    // =====================================================================

    function test_TriggerIncrease_RestsThenAdds() public {
        _fund(pm, alice, COL + COL + EXECUTION_FEE); // open COL + add COL + fee
        _open(alice, true, COL, LEV, ENTRY);
        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // Limit add fires at/above 66000 (true); permissive acceptable 70000.
        uint256 id = _requestTriggerIncrease(alice, true, COL, LEV, 70_000, 66_000, true);
        assertTrue(pm.closePending(key), "an increase sets the closePending mutex");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Below the trigger -> rests, position untouched.
        (bool ok, bytes memory ret) = _execute(keeper, id, 63_000);
        assertFalse(ok, "below trigger must revert");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");
        assertEq(_sizeUsd(alice, true), SIZE, "size untouched while resting");
        assertEq(_posCollateral(alice, true), COL, "collateral untouched while resting");

        // At/above the trigger -> increases.
        (bool ok2,) = _execute(keeper, id, 66_000);
        require(ok2, "at trigger should fire the increase");

        assertEq(_sizeUsd(alice, true), SIZE + COL * LEV, "size grew by addCollateral * addLeverage");
        assertEq(_posCollateral(alice, true), COL + COL, "collateral grew by the added collateral");
        uint256 entry = _entryPrice(alice, true);
        assertGt(entry, ENTRY * ONE8, "blended entry above the original");
        assertLt(entry, 66_000 * ONE8, "blended entry below the fill price");
        assertEq(_triggerPrice(id), 0, "trigger slot cleared on fill");
        assertFalse(_active(id), "request consumed");
        assertFalse(pm.closePending(key), "mutex cleared on fill");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid on fill");
    }

    // =====================================================================
    // 6. Slippage miss on a triggered entry -> SlippageNotMet rest (active, escrow
    //    intact, NOT cancelled); a later in-bound execute then opens it.
    // =====================================================================

    function test_TriggerEntry_SlippageMiss_RestsThenOpens() public {
        _fund(pm, alice, COL + EXECUTION_FEE);

        // Limit buy trigger 54000 (false), but a TIGHT acceptable 52000 below the
        // trigger -> a fill exactly at the trigger clears the trigger yet MISSES the
        // long-buy slippage bound (52000 cap).
        uint256 id = _requestTriggerOpen(alice, true, COL, LEV, 52_000, 54_000, false);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // 54000 <= trigger (met) but 54000 > acceptable 52000 (slippage miss).
        uint256 escrowed = asset.balanceOf(address(pm));
        (bool ok, bytes memory ret) = _execute(keeper, id, 54_000);
        assertFalse(ok, "slippage miss on a trigger entry must revert (not cancel)");
        assertEq(_selector(ret), PositionManager.SlippageNotMet.selector, "SlippageNotMet");
        assertTrue(_active(id), "request still active after a slippage revert");
        assertEq(_triggerPrice(id), 54_000 * ONE8, "trigger slot intact");
        assertEq(asset.balanceOf(address(pm)), escrowed, "escrow intact (no refund)");
        assertEq(asset.balanceOf(keeper), 0, "keeper unpaid while resting");

        // A later in-bound execute (<= acceptable 52000 and <= trigger) opens it.
        (bool ok2,) = _execute(keeper, id, 52_000);
        require(ok2, "in-bound execute should open");
        assertEq(_sizeUsd(alice, true), SIZE, "position opened");
        assertEq(_entryPrice(alice, true), 52_000 * ONE8, "entry at the in-bound fill");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid on the eventual fill");
    }

    // =====================================================================
    // 7. Mutex (increase): a resting trigger-increase blocks requestClose and
    //    requestDecrease on the key; and a pending close blocks requestTriggerIncrease.
    // =====================================================================

    function test_TriggerIncrease_Mutex() public {
        _fund(pm, alice, COL + COL + COL + 4 * EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY); // long position
        _open(alice, false, COL, LEV, ENTRY); // short position

        // A resting trigger-increase on the LONG blocks other edits on that key.
        _requestTriggerIncrease(alice, true, COL, LEV, 70_000, 66_000, true);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestClose(BTC, true, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestDecrease(BTC, true, 5_000, ENTRY * ONE8);

        // Conversely, a pending close on the SHORT blocks a trigger-increase there.
        vm.prank(alice);
        pm.requestClose(BTC, false, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestTriggerIncrease(BTC, false, COL, LEV, 50_000 * ONE8, 54_000 * ONE8, false);
    }

    // =====================================================================
    // 8. Short limit entry: short with trigger ABOVE spot, triggerAbove=true (sell
    //    high). Rests below the trigger; fires at/above it.
    // =====================================================================

    function test_ShortLimitEntry_RestsThenOpens() public {
        _fund(pm, alice, COL + EXECUTION_FEE);

        // Short limit (sell high): trigger 66000 above spot, fires at/above (true).
        // A short OPEN fills at price >= acceptable; acceptable 66000 <= the fill.
        uint256 id = _requestTriggerOpen(alice, false, COL, LEV, 66_000, 66_000, true);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Below the trigger -> rests.
        (bool ok, bytes memory ret) = _execute(keeper, id, 63_000);
        assertFalse(ok, "short limit rests below the trigger");
        assertEq(_selector(ret), PositionManager.TriggerNotMet.selector, "TriggerNotMet");
        assertTrue(_active(id), "still active while resting");

        // At/above the trigger and within slippage -> opens the short.
        (bool ok2,) = _execute(keeper, id, 66_000);
        require(ok2, "short limit fires at/above the trigger");
        assertEq(_sizeUsd(alice, false), SIZE, "short opened");
        assertEq(_entryPrice(alice, false), 66_000 * ONE8, "entry at the fill price");
        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid on fill");
    }

    // =====================================================================
    // 9. Position-exists guard: requestTriggerOpen reverts PositionAlreadyOpen when
    //    a position is already live on the key (use a limit INCREASE instead).
    // =====================================================================

    function test_RequestTriggerOpen_RevertWhen_PositionExists() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);

        vm.prank(alice);
        vm.expectRevert(PositionManager.PositionAlreadyOpen.selector);
        pm.requestTriggerOpen(BTC, true, COL, LEV, 55_000 * ONE8, 54_000 * ONE8, false);
    }

    // =====================================================================
    // 10. InvalidTriggerPrice: triggerPrice == 0 reverts at request time for both
    //     requestTriggerOpen and requestTriggerIncrease.
    // =====================================================================

    function test_RequestTriggerEntry_RevertWhen_ZeroTriggerPrice() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(alice, true, COL, LEV, ENTRY);

        // requestTriggerIncrease on the live long position.
        vm.prank(alice);
        vm.expectRevert(PositionManager.InvalidTriggerPrice.selector);
        pm.requestTriggerIncrease(BTC, true, COL, LEV, 55_000 * ONE8, 0, true);

        // requestTriggerOpen on a fresh key (short, no position).
        vm.prank(alice);
        vm.expectRevert(PositionManager.InvalidTriggerPrice.selector);
        pm.requestTriggerOpen(BTC, false, COL, LEV, 55_000 * ONE8, 0, false);
    }
}
