// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Two-step deferred execution tests (PR-6b).
//
// Exercises the ADDITIVE request -> keeper-execute -> owner-reclaim flow layered
// onto PositionManager. The existing direct openPosition/closePosition paths and
// their tests are untouched; this file only adds coverage for the new surface.
//
// FFI: prices come from the Node helper `test/ffi/redstone-mock-payload.js`
// (same as PositionManager.t.sol). `executeRequest` reads the signed price from
// the *tail* of the calldata, so its calls are built as
// abi.encodeWithSelector(fn, args) ++ redstonePayload and `call`ed. The request
// functions take no oracle payload, so they are called directly.
//
// Block time is warped past MIN_EXECUTION_DELAY before execution, and the
// package timestamp is chosen to satisfy both the staleness window and the
// deferred-execution freshness floor.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {Governance} from "../src/Governance.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {AuthorisedMockSignersBase} from "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";

/**
 * @dev Test-only subclass swapping the real demo signer for RedStone's mock
 *      signers so offline mock payloads verify (mirrors PositionManager.t.sol).
 */
contract TwoStepHarness is PositionManager, AuthorisedMockSignersBase {
    constructor(LiquidityPool pool_, Governance governance_) PositionManager(pool_, governance_) {}

    function getAuthorisedSignerIndex(address signerAddress) public view virtual override returns (uint8) {
        return getAuthorisedMockSignerIndex(signerAddress);
    }

    /**
     * @dev Thin exposers reproducing the OLD direct open/close path exactly (PR-6c
     *      deleted the external openPosition/closePosition). Used here only to set
     *      up positions and to provide the direct-close baseline these two-step
     *      tests compare against; the cores are unchanged so the comparison holds.
     */
    function exposed_open(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 price) external {
        _openPosition(msg.sender, market, isLong, collateral, leverage, price, true);
    }

    function exposed_close(bytes32 market, bool isLong, uint256 price) external returns (uint256) {
        return _closePosition(msg.sender, market, isLong, price);
    }
}

contract TwoStepExecutionTest is Test {
    MockERC20 internal asset;
    LiquidityPool internal pool;
    TwoStepHarness internal pm;

    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    bytes32 internal constant BTC = bytes32("BTC");
    bytes32 internal constant ETH = bytes32("ETH");

    uint256 internal constant ONE8 = 1e8; // RedStone numeric precision
    uint256 internal constant LP_LIQUIDITY = 1_000_000e18;

    // Mirrors of the manager's params for assertions.
    uint256 internal constant MIN_COLLATERAL = 10e18;
    uint256 internal constant MAX_PROFIT_FACTOR = 5;
    uint256 internal constant EXECUTION_FEE = 0.5e18;
    uint256 internal constant MIN_EXECUTION_DELAY = 3;
    uint256 internal constant CANCEL_DELAY = 180;

    // Position economics: collateral 1000, leverage 5 -> size 5000, entry 60000.
    uint256 internal constant COL = 1_000e18;
    uint256 internal constant LEV = 5;
    uint256 internal constant ENTRY = 60_000;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        (pool, pm) = _newSystem(LP_LIQUIDITY);
        vm.warp(1_700_000_000); // base block time (seconds)
    }

    // --- system / payload helpers ---------------------------------------

    function _newSystem(uint256 liq) internal returns (LiquidityPool p, TwoStepHarness m) {
        Governance gov = new Governance(address(this));
        p = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP", gov);
        m = new TwoStepHarness(p, gov);
        p.setPositionManager(address(m));
        asset.mint(address(this), liq);
        asset.approve(address(p), liq);
        p.deposit(liq, lp);
    }

    function _feedStr(bytes32 market) internal pure returns (string memory) {
        return market == BTC ? "BTC" : "ETH";
    }

    /// @dev Build a mock signed payload at `tsMs` carrying one feed at `price`
    ///      (human units; on-chain value is price*1e8).
    function _payload(uint256 tsMs, bytes32 market, uint256 price) internal returns (bytes memory) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "test/ffi/redstone-mock-payload.js";
        cmd[2] = vm.toString(tsMs);
        cmd[3] = string.concat(_feedStr(market), ":", vm.toString(price));
        return vm.ffi(cmd);
    }

    function _fund(PositionManager p, address who, uint256 amt) internal {
        asset.mint(who, amt);
        vm.prank(who);
        asset.approve(address(p), amt);
    }

    // Direct open/close via the harness exposers (PR-6c deleted the external
    // openPosition/closePosition; the cores are unchanged). Used to set up
    // positions and to provide the direct-close baseline for comparison. `price`
    // is the human-unit mark, scaled to 1e8 as the oracle would on-chain.
    function _open(
        PositionManager p,
        address who,
        bytes32 market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 price
    ) internal {
        vm.prank(who);
        TwoStepHarness(address(p)).exposed_open(market, isLong, collateral, leverage, price * ONE8);
    }

    function _closeDirect(PositionManager p, address who, bytes32 market, bool isLong, uint256 price) internal {
        vm.prank(who);
        TwoStepHarness(address(p)).exposed_close(market, isLong, price * ONE8);
    }

    // --- request / execute helpers --------------------------------------

    function _requestOpen(
        PositionManager p,
        address who,
        bytes32 market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 acceptablePrice
    ) internal returns (uint256 id) {
        vm.prank(who);
        id = p.requestOpen(market, isLong, collateral, leverage, acceptablePrice);
    }

    function _requestClose(PositionManager p, address who, bytes32 market, bool isLong, uint256 acceptablePrice)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = p.requestClose(market, isLong, acceptablePrice);
    }

    /// @dev Execute a request with a payload stamped at the current block time.
    function _execute(PositionManager p, address who, uint256 requestId, bytes32 market, uint256 price)
        internal
        returns (bool ok, bytes memory ret)
    {
        (ok, ret) = _executeAtTs(p, who, requestId, market, price, block.timestamp * 1000);
    }

    /// @dev Execute a request with an explicitly-stamped payload (freshness test).
    function _executeAtTs(
        PositionManager p,
        address who,
        uint256 requestId,
        bytes32 market,
        uint256 price,
        uint256 tsMs
    ) internal returns (bool ok, bytes memory ret) {
        bytes memory payload = _payload(tsMs, market, price);
        bytes memory data =
            abi.encodePacked(abi.encodeWithSelector(PositionManager.executeRequest.selector, requestId), payload);
        vm.prank(who);
        (ok, ret) = address(p).call(data);
    }

    // --- view helpers ----------------------------------------------------

    function _active(PositionManager p, uint256 id) internal view returns (bool a) {
        (,,,,,,,,, a) = p.requests(id);
    }

    function _sizeUsd(PositionManager p, address who, bytes32 market, bool isLong) internal view returns (uint256 s) {
        (,,,, s,,,) = p.positions(p.getPositionKey(who, market, isLong));
    }

    function _posCollateral(PositionManager p, address who, bytes32 market, bool isLong)
        internal
        view
        returns (uint256 c)
    {
        (,,, c,,,,) = p.positions(p.getPositionKey(who, market, isLong));
    }

    // =====================================================================
    // 1. requestOpen escrows collateral + fee; request is active
    // =====================================================================

    function test_RequestOpen_EscrowsCollateralAndFee() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 aliceStart = asset.balanceOf(alice);
        uint256 pmStart = asset.balanceOf(address(pm));

        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, ENTRY * ONE8);

        assertEq(asset.balanceOf(alice), aliceStart - (COL + EXECUTION_FEE), "trader debited collateral + fee");
        assertEq(asset.balanceOf(address(pm)), pmStart + COL + EXECUTION_FEE, "PM escrows collateral + fee");
        assertTrue(_active(pm, id), "request active");
        assertEq(pm.nextRequestId(), id + 1, "id counter advanced");
        // No position exists yet — only on a fill.
        assertEq(_sizeUsd(pm, alice, BTC, true), 0, "no position before execution");
    }

    // =====================================================================
    // 2. Happy open: execute within bound -> position at executed price,
    //    keeper paid, request inactive
    // =====================================================================

    function test_ExecuteOpen_HappyPath() public {
        _fund(pm, alice, COL + EXECUTION_FEE);

        // Acceptable above the fill price -> within bound for a long open.
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 61_000 * ONE8);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(pm, keeper, id, BTC, ENTRY); // fill at 60000
        require(ok, "execute failed");

        assertEq(_posCollateral(pm, alice, BTC, true), COL, "position collateral");
        assertEq(_sizeUsd(pm, alice, BTC, true), COL * LEV, "size = collateral * leverage");
        (,,,,, uint256 entryPrice,,) = pm.positions(pm.getPositionKey(alice, BTC, true));
        assertEq(entryPrice, ENTRY * ONE8, "opened at the executed price");

        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid the execution fee on fill");
        assertFalse(_active(pm, id), "request consumed");
        // Escrowed collateral is now the position's; only it remains in the PM.
        assertEq(asset.balanceOf(address(pm)), COL, "PM holds only the position collateral");
    }

    // =====================================================================
    // 3. Execute before MIN_EXECUTION_DELAY reverts TooEarlyToExecute
    // =====================================================================

    function test_ExecuteOpen_RevertWhen_TooEarly() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 61_000 * ONE8);

        // Same block as the request: elapsed 0 < MIN_EXECUTION_DELAY.
        (bool ok, bytes memory ret) = _execute(pm, keeper, id, BTC, ENTRY);
        assertFalse(ok, "execute before delay must revert");
        assertEq(bytes4(ret), PositionManager.TooEarlyToExecute.selector, "too-early selector");
    }

    // =====================================================================
    // 4. SECURITY — freshness guard: a price stamped before the execution
    //    floor (but within the staleness window) reverts PriceBeforeRequest
    // =====================================================================

    function test_ExecuteOpen_RevertWhen_PriceBeforeRequest() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 t0 = block.timestamp;
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 61_000 * ONE8);

        // Warp exactly to the earliest execution time; block.timestamp now
        // satisfies the floor. But supply a payload stamped at t0 (< t0 + delay,
        // yet only `delay` seconds old, so it PASSES the staleness window).
        vm.warp(t0 + MIN_EXECUTION_DELAY);
        (bool ok, bytes memory ret) = _executeAtTs(pm, keeper, id, BTC, ENTRY, t0 * 1000);

        assertFalse(ok, "stale-vs-request price must revert");
        assertEq(
            bytes4(ret), PositionManager.PriceBeforeRequest.selector, "must be PriceBeforeRequest, not PriceTooStale"
        );
        assertTrue(_active(pm, id), "request stays active after a freshness revert");
    }

    // =====================================================================
    // 5. Open slippage: long with acceptablePrice below fill -> cancel,
    //    full refund to owner, no position, keeper unpaid
    // =====================================================================

    function test_ExecuteOpen_SlippageCancelsAndRefunds() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 aliceStart = asset.balanceOf(alice);

        // Acceptable BELOW the fill price -> long open misses the bound.
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, 59_000 * ONE8);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PositionManager.RequestCancelled(id, alice, true);
        (bool ok,) = _execute(pm, keeper, id, BTC, ENTRY); // fill 60000 > acceptable 59000
        require(ok, "slippage cancel should not revert");

        assertEq(_sizeUsd(pm, alice, BTC, true), 0, "no position opened on a slippage miss");
        assertEq(asset.balanceOf(alice), aliceStart, "owner fully refunded collateral + fee");
        assertEq(asset.balanceOf(keeper), 0, "keeper unpaid on a slippage cancel");
        assertFalse(_active(pm, id), "request consumed");
        assertEq(asset.balanceOf(address(pm)), 0, "no escrow stranded in the PM");
    }

    // =====================================================================
    // 6. Happy close: settlement matches a direct close; keeper paid;
    //    closePending cleared
    // =====================================================================

    function test_ExecuteClose_HappyPath_MatchesDirectClose() public {
        // System A: alice closes via the two-step flow.
        (LiquidityPool poolA, TwoStepHarness mA) = _newSystem(LP_LIQUIDITY);
        // System B: bob closes directly, identical timing.
        (LiquidityPool poolB, TwoStepHarness mB) = _newSystem(LP_LIQUIDITY);

        _fund(mA, alice, COL + EXECUTION_FEE);
        _fund(mB, bob, COL);

        _open(mA, alice, BTC, true, COL, LEV, ENTRY);
        _open(mB, bob, BTC, true, COL, LEV, ENTRY);

        // Queue alice's close (acceptable below the exit -> within bound on a long).
        uint256 id = _requestClose(mA, alice, BTC, true, 60_000 * ONE8);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        (bool ok,) = _execute(mA, keeper, id, BTC, 66_000); // +10%
        require(ok, "execute close failed");
        _closeDirect(mB, bob, BTC, true, 66_000); // same exit, same elapsed

        // Alice (two-step) and bob (direct) each funded exactly what they needed,
        // so both end holding only the settlement payout — they must be equal.
        assertEq(asset.balanceOf(alice), asset.balanceOf(bob), "two-step close payout == direct close payout");
        assertEq(
            asset.balanceOf(address(poolA)),
            asset.balanceOf(address(poolB)),
            "pool settlement identical to direct close"
        );

        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid on close fill");
        assertEq(_sizeUsd(mA, alice, BTC, true), 0, "position closed");
        assertFalse(mA.closePending(mA.getPositionKey(alice, BTC, true)), "closePending cleared");
        assertFalse(_active(mA, id), "request consumed");
    }

    // =====================================================================
    // 7. Close slippage: out of bound -> cancel, position stays open, fee
    //    refunded, closePending cleared (a re-request then succeeds)
    // =====================================================================

    function test_ExecuteClose_SlippageKeepsPositionAndClearsPending() public {
        _fund(pm, alice, COL + 2 * EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        uint256 afterOpen = asset.balanceOf(alice);

        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // Acceptable ABOVE the exit -> long close misses the bound.
        uint256 id = _requestClose(pm, alice, BTC, true, 70_000 * ONE8);
        assertTrue(pm.closePending(key), "close pending after request");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(pm, keeper, id, BTC, 66_000); // 66000 < acceptable 70000 -> miss
        require(ok, "slippage cancel should not revert");

        assertEq(_sizeUsd(pm, alice, BTC, true), COL * LEV, "position remains open after a close miss");
        // requestClose pulled the fee; the slippage cancel refunds it -> net zero.
        assertEq(asset.balanceOf(alice), afterOpen, "execution fee refunded to owner");
        assertEq(asset.balanceOf(keeper), 0, "keeper unpaid on a slippage cancel");
        assertFalse(pm.closePending(key), "closePending cleared on cancel");
        assertFalse(_active(pm, id), "request consumed");

        // closePending cleared -> a fresh close request succeeds.
        uint256 id2 = _requestClose(pm, alice, BTC, true, 60_000 * ONE8);
        assertTrue(pm.closePending(key), "re-request re-arms closePending");
        assertTrue(_active(pm, id2), "re-requested close is active");
    }

    // =====================================================================
    // 8. requestClose twice -> second reverts CloseAlreadyPending
    // =====================================================================

    function test_RequestClose_RevertWhen_AlreadyPending() public {
        _fund(pm, alice, COL + 2 * EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        _requestClose(pm, alice, BTC, true, 60_000 * ONE8);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestClose(BTC, true, 60_000 * ONE8);
    }

    // =====================================================================
    // 9. cancelRequest: too-early reverts; non-owner reverts; after the
    //    delay refunds collateral + fee and marks inactive
    // =====================================================================

    function test_CancelRequest_Lifecycle() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 aliceStart = asset.balanceOf(alice);
        uint256 id = _requestOpen(pm, alice, BTC, true, COL, LEV, ENTRY * ONE8);

        // Too early for the owner to reclaim.
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PositionManager.TooEarlyToCancel.selector, block.timestamp, block.timestamp + CANCEL_DELAY
            )
        );
        pm.cancelRequest(id);

        // Non-owner can never reclaim (checked before the time gate).
        vm.warp(block.timestamp + CANCEL_DELAY);
        vm.prank(bob);
        vm.expectRevert(PositionManager.NotRequestOwner.selector);
        pm.cancelRequest(id);

        // Owner reclaims after the delay: full escrow back, request inactive.
        vm.prank(alice);
        pm.cancelRequest(id);

        assertEq(asset.balanceOf(alice), aliceStart, "collateral + fee refunded on reclaim");
        assertFalse(_active(pm, id), "request marked inactive");
        assertEq(asset.balanceOf(address(pm)), 0, "no escrow stranded after reclaim");
    }

    // =====================================================================
    // 10. Escrow conservation: nothing stranded in the PM beyond open
    //     positions' collateral, across a fill and across a cancel
    // =====================================================================

    function test_EscrowConservation_AcrossFillAndCancel() public {
        // --- fill: escrow becomes position collateral, fee leaves to keeper ---
        _fund(pm, alice, COL + EXECUTION_FEE);
        uint256 idA = _requestOpen(pm, alice, BTC, true, COL, LEV, 61_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(pm, keeper, idA, BTC, ENTRY);
        require(ok, "fill failed");

        // After the fill, the PM holds exactly the open position's collateral.
        uint256 openCollateral = _posCollateral(pm, alice, BTC, true);
        assertEq(openCollateral, COL, "alice position collateral");
        assertEq(asset.balanceOf(address(pm)), openCollateral, "PM holds only open collateral after a fill");
        assertEq(asset.balanceOf(address(pm)), pm.totalReserved() / MAX_PROFIT_FACTOR, "balance ties to reserved book");

        // --- cancel: a second request's escrow fully refunds on reclaim -------
        _fund(pm, bob, COL + EXECUTION_FEE);
        uint256 idB = _requestOpen(pm, bob, ETH, false, COL, LEV, ENTRY * ONE8);
        // While idB is queued, the PM also holds bob's escrow.
        assertEq(
            asset.balanceOf(address(pm)),
            openCollateral + COL + EXECUTION_FEE,
            "PM holds open collateral + queued escrow"
        );

        vm.warp(block.timestamp + CANCEL_DELAY);
        vm.prank(bob);
        pm.cancelRequest(idB);

        // Back to exactly the open position's collateral — nothing stranded by
        // either the fill or the cancel.
        assertEq(asset.balanceOf(address(pm)), openCollateral, "PM holds only open collateral after a cancel");
        assertEq(_sizeUsd(pm, alice, BTC, true), COL * LEV, "alice's filled position is untouched");
    }

    // =====================================================================
    // Validation-order asymmetry (order-pinning; refactor invariant)
    //
    // requestOpen and requestTriggerOpen check the SAME amount validations but
    // in a DIFFERENT order: requestOpen checks collateral BEFORE acceptablePrice,
    // requestTriggerOpen checks acceptablePrice BEFORE collateral. With BOTH
    // inputs bad, each reverts with the FIRST check it reaches. The _queueRequest
    // refactor leaves all validation in the wrappers, so this asymmetry must hold
    // byte-for-byte. These pins guard that.
    // =====================================================================

    // requestOpen: bad collateral AND bad acceptablePrice -> CollateralTooLow
    // (collateral is checked first; acceptablePrice==0 is never reached).
    function test_requestOpen_validationOrder_collateralBeforeAcceptablePrice() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PositionManager.CollateralTooLow.selector, MIN_COLLATERAL - 1, MIN_COLLATERAL)
        );
        pm.requestOpen(BTC, true, MIN_COLLATERAL - 1, LEV, 0);
    }

    // requestTriggerOpen: bad collateral AND bad acceptablePrice ->
    // InvalidAcceptablePrice (acceptablePrice is checked first; the collateral
    // check is never reached).
    function test_requestTriggerOpen_validationOrder_acceptablePriceBeforeCollateral() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        vm.prank(alice);
        vm.expectRevert(PositionManager.InvalidAcceptablePrice.selector);
        pm.requestTriggerOpen(BTC, true, MIN_COLLATERAL - 1, LEV, 0, ENTRY * ONE8, true);
    }
}
