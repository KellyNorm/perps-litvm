// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Governance tests (PR-9).
//
// Two halves:
//   1. Pure {Governance} unit tests — two-step ownership, the global pause flag,
//      and the fail-closed generic parameter store. No perp engine involved.
//   2. Integration tests proving the DORMANT pause gating wired into the
//      {PositionManager} and {LiquidityPool}: new-risk entries (open/increase and
//      their resting trigger variants, LP deposit) revert when paused, while every
//      risk-reducing / fund-returning path (close, decrease, cancel, liquidate, LP
//      withdraw, executing a pending close) still works. Executing a pending OPEN
//      reverts while paused yet the request stays cancellable for a full refund.
//
// FFI: like the other engine suites, prices come from the Node helper
// `test/ffi/redstone-mock-payload.js` and are appended to the calldata tail so
// RedStone verifies them on-chain. Block time is warped to the package timestamp.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Governance} from "../src/Governance.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {AuthorisedMockSignersBase} from "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";

/**
 * @dev Test-only subclass swapping the real demo signer for RedStone's mock
 *      signers (offline mock payloads verify), plus thin exposers that drive the
 *      position cores with a fixed price — identical to the harnesses in the
 *      other suites, so the pause gating is exercised against the real engine.
 */
contract GovHarness is PositionManager, AuthorisedMockSignersBase {
    constructor(LiquidityPool pool_, Governance governance_) PositionManager(pool_, governance_) {}

    function getAuthorisedSignerIndex(address signerAddress) public view virtual override returns (uint8) {
        return getAuthorisedMockSignerIndex(signerAddress);
    }

    function exposed_open(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 price) external {
        _openPosition(msg.sender, market, isLong, collateral, leverage, price, true);
    }
}

contract GovernanceTest is Test {
    MockERC20 internal asset;
    Governance internal gov;
    LiquidityPool internal pool;
    GovHarness internal pm;

    address internal owner = address(this); // the deployer / initial gov owner
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal liquidator = makeAddr("liquidator");
    address internal newOwner = makeAddr("newOwner");

    bytes32 internal constant BTC = bytes32("BTC");
    bytes32 internal constant ETH = bytes32("ETH");

    uint256 internal constant ONE8 = 1e8;
    uint256 internal constant LP_LIQUIDITY = 1_000_000e18;
    uint256 internal constant COL = 1_000e18;
    uint256 internal constant LEV = 5;
    uint256 internal constant ENTRY = 60_000;

    uint256 internal constant EXECUTION_FEE = 0.5e18;
    uint256 internal constant MIN_EXECUTION_DELAY = 3;
    uint256 internal constant CANCEL_DELAY = 180;

    // Generous slippage bounds so fills never fail for slippage in these tests.
    uint256 internal constant BUY_CAP = 1_000_000 * ONE8; // long open/increase: price <= cap
    uint256 internal constant SELL_FLOOR = 1; // long close/decrease: price >= floor

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        gov = new Governance(owner);
        pool = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP", gov);
        pm = new GovHarness(pool, gov);
        pool.setPositionManager(address(pm));

        asset.mint(address(this), LP_LIQUIDITY);
        asset.approve(address(pool), LP_LIQUIDITY);
        pool.deposit(LP_LIQUIDITY, lp);

        vm.warp(1_700_000_000);

        // Alice holds an open long so the close/decrease/liquidate-while-paused
        // paths have a live position to act on. Fund a little extra collateral so
        // she retains tokens to pay the EXECUTION_FEE on later close/decrease.
        _fund(alice, COL + 5e18);
        _open(alice, BTC, true, COL, LEV, ENTRY);
    }

    // =====================================================================
    // Pure Governance: ownership (Ownable2Step)
    // =====================================================================

    function test_Owner_IsDeployer() public view {
        assertEq(gov.owner(), owner);
        assertEq(gov.pendingOwner(), address(0));
    }

    function test_TwoStepTransfer_Succeeds() public {
        gov.transferOwnership(newOwner);
        assertEq(gov.owner(), owner, "owner unchanged until accept");
        assertEq(gov.pendingOwner(), newOwner, "pending set");

        vm.prank(newOwner);
        gov.acceptOwnership();
        assertEq(gov.owner(), newOwner, "owner rotated on accept");
        assertEq(gov.pendingOwner(), address(0), "pending cleared");

        // The new owner can pause; the old owner no longer can.
        vm.prank(newOwner);
        gov.pause();
        assertTrue(gov.paused());

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        gov.unpause();
    }

    function test_PendingOwner_CannotActBeforeAccept() public {
        gov.transferOwnership(newOwner);
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        gov.pause();
    }

    function test_RevertWhen_NonOwnerTransfers() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.transferOwnership(alice);
    }

    function test_RevertWhen_NonPendingAccepts() public {
        gov.transferOwnership(newOwner);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.acceptOwnership();
    }

    // =====================================================================
    // Pure Governance: pause
    // =====================================================================

    function test_Pause_OwnerOnly_EmitsAndToggles() public {
        assertFalse(gov.paused());

        vm.expectEmit(true, false, false, false, address(gov));
        emit Governance.Paused(owner);
        gov.pause();
        assertTrue(gov.paused());

        vm.expectEmit(true, false, false, false, address(gov));
        emit Governance.Unpaused(owner);
        gov.unpause();
        assertFalse(gov.paused());
    }

    function test_RevertWhen_NonOwnerPauses() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.pause();
    }

    function test_RevertWhen_NonOwnerUnpauses() public {
        gov.pause();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.unpause();
    }

    // =====================================================================
    // Pure Governance: fail-closed parameter store
    // =====================================================================

    bytes32 internal constant KEY = bytes32("MAX_OI");

    function test_SetParam_RevertWhen_NoBounds() public {
        vm.expectRevert(abi.encodeWithSelector(Governance.ParamUnbounded.selector, KEY));
        gov.setParam(KEY, 1);
    }

    function test_SetParamBounds_OwnerOnly_Emits() public {
        vm.expectEmit(true, false, false, true, address(gov));
        emit Governance.ParamBoundsSet(KEY, 100, 500);
        gov.setParamBounds(KEY, 100, 500);

        (uint256 min, uint256 max, bool isSet) = gov.getParamBounds(KEY);
        assertEq(min, 100);
        assertEq(max, 500);
        assertTrue(isSet);
    }

    function test_SetParamBounds_RevertWhen_MinAboveMax() public {
        vm.expectRevert(abi.encodeWithSelector(Governance.InvalidBounds.selector, 500, 100));
        gov.setParamBounds(KEY, 500, 100);
    }

    function test_SetParam_WithinBounds_StoresAndEmits() public {
        gov.setParamBounds(KEY, 100, 500);

        vm.expectEmit(true, false, false, true, address(gov));
        emit Governance.ParamSet(KEY, 300);
        gov.setParam(KEY, 300);
        assertEq(gov.getParam(KEY), 300);

        // Inclusive edges are accepted.
        gov.setParam(KEY, 100);
        assertEq(gov.getParam(KEY), 100);
        gov.setParam(KEY, 500);
        assertEq(gov.getParam(KEY), 500);
    }

    function test_SetParam_RevertWhen_OutOfBounds() public {
        gov.setParamBounds(KEY, 100, 500);
        vm.expectRevert(abi.encodeWithSelector(Governance.ParamOutOfBounds.selector, KEY, 99, 100, 500));
        gov.setParam(KEY, 99);
        vm.expectRevert(abi.encodeWithSelector(Governance.ParamOutOfBounds.selector, KEY, 501, 100, 500));
        gov.setParam(KEY, 501);
    }

    function test_SetParamBounds_RevertWhen_NonOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.setParamBounds(KEY, 1, 2);
    }

    function test_SetParam_RevertWhen_NonOwner() public {
        gov.setParamBounds(KEY, 1, 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        gov.setParam(KEY, 1);
    }

    function test_GetParam_DefaultsZero() public view {
        assertEq(gov.getParam(bytes32("NEVER_SET")), 0);
    }

    // =====================================================================
    // Integration: new-risk REQUEST entries revert when paused
    // =====================================================================

    function test_Paused_RequestOpen_Reverts() public {
        _fund(bob, COL + EXECUTION_FEE);
        gov.pause();
        vm.prank(bob);
        vm.expectRevert(PositionManager.Paused.selector);
        pm.requestOpen(ETH, true, COL, LEV, BUY_CAP);
    }

    function test_Paused_RequestIncrease_Reverts() public {
        _fund(alice, COL);
        gov.pause();
        vm.prank(alice);
        vm.expectRevert(PositionManager.Paused.selector);
        pm.requestIncrease(BTC, true, COL, LEV, BUY_CAP);
    }

    function test_Paused_RequestTriggerOpen_Reverts() public {
        _fund(bob, COL + EXECUTION_FEE);
        gov.pause();
        vm.prank(bob);
        vm.expectRevert(PositionManager.Paused.selector);
        pm.requestTriggerOpen(ETH, true, COL, LEV, BUY_CAP, ENTRY * ONE8, true);
    }

    function test_Paused_RequestTriggerIncrease_Reverts() public {
        _fund(alice, COL);
        gov.pause();
        vm.prank(alice);
        vm.expectRevert(PositionManager.Paused.selector);
        pm.requestTriggerIncrease(BTC, true, COL, LEV, BUY_CAP, ENTRY * ONE8, true);
    }

    // =====================================================================
    // Integration: risk-reducing entries STILL WORK when paused
    // =====================================================================

    function test_Paused_RequestClose_Succeeds() public {
        gov.pause();
        vm.prank(alice);
        uint256 id = pm.requestClose(BTC, true, SELL_FLOOR);
        assertTrue(_active(id), "close request queued while paused");
    }

    function test_Paused_RequestDecrease_Succeeds() public {
        gov.pause();
        vm.prank(alice);
        uint256 id = pm.requestDecrease(BTC, true, 5_000, SELL_FLOOR);
        assertTrue(_active(id), "decrease request queued while paused");
    }

    function test_Paused_CancelRequest_Succeeds() public {
        // Queue a close BEFORE pausing, then pause and cancel it for a refund.
        vm.prank(alice);
        uint256 id = pm.requestClose(BTC, true, SELL_FLOOR);

        gov.pause();
        vm.warp(block.timestamp + CANCEL_DELAY);
        uint256 balBefore = asset.balanceOf(alice);
        vm.prank(alice);
        pm.cancelRequest(id);
        assertEq(asset.balanceOf(alice), balBefore + EXECUTION_FEE, "fee refunded while paused");
        assertFalse(_active(id));
    }

    function test_Paused_Liquidate_Succeeds() public {
        gov.pause();
        // Exit 49_200 = -18% on 5x ⇒ equity == maintenance ⇒ liquidatable.
        (bool ok,) = _liquidateRaw(liquidator, alice, BTC, true, 49_200);
        assertTrue(ok, "liquidation must work while paused");
        assertEq(_sizeUsd(alice, BTC, true), 0, "position cleared");
    }

    function test_Paused_ExecutePendingClose_Succeeds() public {
        // Queue a close while unpaused, then pause and execute it.
        vm.prank(alice);
        uint256 id = pm.requestClose(BTC, true, SELL_FLOOR);

        gov.pause();
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(keeper, id, BTC, ENTRY);
        assertTrue(ok, "pending close executes while paused");
        assertEq(_sizeUsd(alice, BTC, true), 0, "position closed");
    }

    // =====================================================================
    // Integration: executing a pending OPEN reverts while paused, but the
    // request stays active and is fully refundable via cancel.
    // =====================================================================

    function test_Paused_ExecutePendingOpen_RevertsThenCancelRefunds() public {
        // Bob queues an open while UNPAUSED (escrow taken).
        _fund(bob, COL + EXECUTION_FEE);
        vm.prank(bob);
        uint256 id = pm.requestOpen(ETH, true, COL, LEV, BUY_CAP);
        uint256 balAfterRequest = asset.balanceOf(bob);

        // Pause, then a keeper's execute must revert (kind == Open).
        gov.pause();
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok, bytes memory ret) = _execute(keeper, id, ETH, ENTRY);
        assertFalse(ok, "open fill must revert while paused");
        assertEq(bytes4(ret), PositionManager.Paused.selector, "reverts with Paused");
        assertTrue(_active(id), "request stays active (tx rolled back)");
        assertEq(_sizeUsd(bob, ETH, true), 0, "no position opened");

        // The escrow is reclaimable: after CANCEL_DELAY bob cancels for a full refund.
        vm.warp(block.timestamp + CANCEL_DELAY);
        vm.prank(bob);
        pm.cancelRequest(id);
        assertEq(asset.balanceOf(bob), balAfterRequest + COL + EXECUTION_FEE, "collateral + fee refunded");
        assertFalse(_active(id));
    }

    // =====================================================================
    // Integration: LiquidityPool deposit gated, withdraw always allowed
    // =====================================================================

    function test_Paused_Deposit_Reverts() public {
        asset.mint(bob, COL);
        gov.pause();
        vm.startPrank(bob);
        asset.approve(address(pool), COL);
        vm.expectRevert(LiquidityPool.Paused.selector);
        pool.deposit(COL, bob);
        vm.stopPrank();
    }

    function test_Paused_Mint_Reverts() public {
        asset.mint(bob, COL);
        gov.pause();
        vm.startPrank(bob);
        asset.approve(address(pool), COL);
        vm.expectRevert(LiquidityPool.Paused.selector);
        pool.mint(1e18, bob);
        vm.stopPrank();
    }

    function test_Paused_Withdraw_Succeeds() public {
        // The LP (seeded in setUp) can still pull free liquidity while paused.
        gov.pause();
        uint256 maxOut = pool.maxWithdraw(lp);
        assertGt(maxOut, 0, "free liquidity available");
        uint256 balBefore = asset.balanceOf(lp);
        vm.prank(lp);
        pool.withdraw(maxOut, lp, lp);
        assertEq(asset.balanceOf(lp), balBefore + maxOut, "withdraw works while paused");
    }

    // =====================================================================
    // Control: with the engine UNPAUSED, the gated entries still work (the
    // gating is dormant — behavior unchanged when not paused).
    // =====================================================================

    function test_Unpaused_RequestOpen_Works() public {
        _fund(bob, COL + EXECUTION_FEE);
        vm.prank(bob);
        uint256 id = pm.requestOpen(ETH, true, COL, LEV, BUY_CAP);
        assertTrue(_active(id));
    }

    // --- helpers ---------------------------------------------------------

    function _fund(address who, uint256 amt) internal {
        asset.mint(who, amt);
        vm.prank(who);
        asset.approve(address(pm), type(uint256).max); // infinite approval never decrements
    }

    function _open(address who, bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 price)
        internal
    {
        vm.prank(who);
        pm.exposed_open(market, isLong, collateral, leverage, price * ONE8);
    }

    function _feedStr(bytes32 market) internal pure returns (string memory) {
        return market == BTC ? "BTC" : "ETH";
    }

    function _payload(uint256 tsMs, bytes32 market, uint256 price) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/redstone-mock-payload.js";
        cmd[2] = vm.toString(tsMs);
        cmd[3] = string.concat(_feedStr(market), ":", vm.toString(price));
        return vm.ffi(cmd);
    }

    function _execute(address who, uint256 requestId, bytes32 market, uint256 price)
        internal
        returns (bool ok, bytes memory ret)
    {
        bytes memory payload = _payload(block.timestamp * 1000, market, price);
        bytes memory data =
            abi.encodePacked(abi.encodeWithSelector(PositionManager.executeRequest.selector, requestId), payload);
        vm.prank(who);
        (ok, ret) = address(pm).call(data);
    }

    function _liquidateRaw(address caller, address posOwner, bytes32 market, bool isLong, uint256 price)
        internal
        returns (bool ok, bytes memory ret)
    {
        bytes memory payload = _payload(block.timestamp * 1000, market, price);
        bytes memory data = abi.encodePacked(
            abi.encodeWithSelector(PositionManager.liquidate.selector, posOwner, market, isLong), payload
        );
        vm.prank(caller);
        (ok, ret) = address(pm).call(data);
    }

    function _active(uint256 id) internal view returns (bool a) {
        (,,,,,,,,, a) = pm.requests(id);
    }

    function _sizeUsd(address who, bytes32 market, bool isLong) internal view returns (uint256 s) {
        (,,,, s,,,) = pm.positions(pm.getPositionKey(who, market, isLong));
    }
}
