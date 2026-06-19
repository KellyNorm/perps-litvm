// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Partial-close (decrease) tests (PR-9a, Phase 2).
//
// Exercises the ADDITIVE requestDecrease -> keeper-execute flow layered onto the
// two-step machinery. A decrease closes a FRACTION of an open position at a
// keeper-filled price, realizing that fraction's P&L / borrow fee / funding and
// returning that fraction's collateral, while leaving a SMALLER position behind
// with the SAME entry price and SAME entry fee/funding indices. Open/Close paths
// and their suites are untouched; this file only adds the new surface.
//
// FFI: prices come from the Node helper `test/ffi/redstone-mock-payload.js` (same
// as the other suites). `executeRequest` reads the signed price from the *tail*
// of the calldata, so its calls are built as
// abi.encodeWithSelector(fn, args) ++ redstonePayload and `call`ed. The request
// functions take no oracle payload and are called directly.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {AuthorisedMockSignersBase} from "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";

/**
 * @dev Test-only subclass swapping the real demo signer for RedStone's mock
 *      signers so offline mock payloads verify (mirrors the other suites). The
 *      thin exposers reproduce the OLD direct open/close cores (PR-6c deleted the
 *      external entries) — used only to set up positions and to provide the
 *      full-close baseline the equivalence test compares against; the cores are
 *      unchanged so the comparison holds.
 */
contract PartialCloseHarness is PositionManager, AuthorisedMockSignersBase {
    constructor(LiquidityPool pool_) PositionManager(pool_) {}

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

contract PartialCloseTest is Test {
    MockERC20 internal asset;
    LiquidityPool internal pool;
    PartialCloseHarness internal pm;

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
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant EXECUTION_FEE = 0.5e18;
    uint256 internal constant MIN_EXECUTION_DELAY = 3;

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

    function _newSystem(uint256 liq) internal returns (LiquidityPool p, PartialCloseHarness m) {
        p = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP");
        m = new PartialCloseHarness(p);
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

    // Direct open/close via the harness exposers. `price` is the human-unit mark,
    // scaled to 1e8 as the oracle would on-chain.
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
        PartialCloseHarness(address(p)).exposed_open(market, isLong, collateral, leverage, price * ONE8);
    }

    function _closeDirect(PositionManager p, address who, bytes32 market, bool isLong, uint256 price)
        internal
        returns (uint256)
    {
        vm.prank(who);
        return PartialCloseHarness(address(p)).exposed_close(market, isLong, price * ONE8);
    }

    // --- request / execute helpers --------------------------------------

    function _requestDecrease(
        PositionManager p,
        address who,
        bytes32 market,
        bool isLong,
        uint256 closeBps,
        uint256 acceptablePrice
    ) internal returns (uint256 id) {
        vm.prank(who);
        id = p.requestDecrease(market, isLong, closeBps, acceptablePrice);
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
        bytes memory payload = _payload(block.timestamp * 1000, market, price);
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

    function _entryPrice(PositionManager p, address who, bytes32 market, bool isLong)
        internal
        view
        returns (uint256 e)
    {
        (,,,,, e,,) = p.positions(p.getPositionKey(who, market, isLong));
    }

    // =====================================================================
    // 1. Happy 50% decrease: remainder is exactly half size & collateral at
    //    the same entry; keeper paid; request consumed; closePending cleared.
    // =====================================================================

    function test_Decrease_HappyHalf() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // Acceptable at/below the exit -> within bound for a long close (decrease
        // uses the same close-direction slippage test).
        uint256 id = _requestDecrease(pm, alice, BTC, true, 5_000, ENTRY * ONE8);
        assertTrue(pm.closePending(key), "closePending set on a queued decrease");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(pm, keeper, id, BTC, ENTRY); // fill at entry -> zero PnL
        require(ok, "execute decrease failed");

        assertEq(_sizeUsd(pm, alice, BTC, true), SIZE / 2, "remaining size is half");
        assertEq(_posCollateral(pm, alice, BTC, true), COL / 2, "remaining collateral is half");
        assertEq(_entryPrice(pm, alice, BTC, true), ENTRY * ONE8, "entry price unchanged on the remainder");

        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid the execution fee on fill");
        assertFalse(_active(pm, id), "request consumed");
        assertFalse(pm.closePending(key), "closePending cleared after fill");
    }

    // =====================================================================
    // 2. Closed-fraction equivalence: a 50% decrease of a size-S position
    //    pays the trader exactly what a FULL close of an independent size-S/2
    //    position pays at the SAME price and SAME timing (rounding pool-fav).
    // =====================================================================

    function test_Decrease_ClosedFractionEqualsFullCloseOfHalf() public {
        // System A: alice opens size S, then decreases 50%.
        (, PartialCloseHarness mA) = _newSystem(LP_LIQUIDITY);
        // System B: bob opens size S/2, then fully closes — same entry & timing.
        (, PartialCloseHarness mB) = _newSystem(LP_LIQUIDITY);

        _fund(mA, alice, COL + EXECUTION_FEE);
        _fund(mB, bob, COL / 2);

        _open(mA, alice, BTC, true, COL, LEV, ENTRY); // size S, collateral C
        _open(mB, bob, BTC, true, COL / 2, LEV, ENTRY); // size S/2, collateral C/2

        uint256 id = _requestDecrease(mA, alice, BTC, true, 5_000, 60_000 * ONE8);

        // Identical elapsed borrow-fee interval for both systems.
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        // Alice receives the decrease payout during execution.
        uint256 aliceBefore = asset.balanceOf(alice);
        (bool ok,) = _execute(mA, keeper, id, BTC, 66_000); // +10%
        require(ok, "execute decrease failed");
        uint256 payoutDecrease = asset.balanceOf(alice) - aliceBefore;

        // Bob fully closes his size-S/2 position at the same price and block time.
        uint256 payoutFullClose = _closeDirect(mB, bob, BTC, true, 66_000);

        // Identical inputs (size S/2, collateral C/2, entry, price, elapsed) settled
        // by the identical primitives -> equal to the wei; assert within a few wei
        // and that any drift is pool-favorable (trader receives no more).
        assertApproxEqAbs(payoutDecrease, payoutFullClose, 3, "decrease payout ~ full close of the half");
        assertLe(payoutDecrease, payoutFullClose, "any rounding drift favors the pool");
    }

    // =====================================================================
    // 3. The remainder is fully closable: requestClose on it succeeds and
    //    clears the position.
    // =====================================================================

    function test_Decrease_RemainderFullyClosable() public {
        _fund(pm, alice, COL + 2 * EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        uint256 id = _requestDecrease(pm, alice, BTC, true, 5_000, ENTRY * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(pm, keeper, id, BTC, ENTRY);
        require(ok, "execute decrease failed");
        assertEq(_sizeUsd(pm, alice, BTC, true), SIZE / 2, "remainder open after decrease");

        // Now fully close the remainder via the two-step close path.
        uint256 id2 = _requestClose(pm, alice, BTC, true, ENTRY * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok2,) = _execute(pm, keeper, id2, BTC, ENTRY);
        require(ok2, "execute close failed");

        assertEq(_sizeUsd(pm, alice, BTC, true), 0, "remainder fully closed");
        assertFalse(pm.closePending(pm.getPositionKey(alice, BTC, true)), "closePending cleared");
    }

    // =====================================================================
    // 4. Slippage miss: the fill misses the bound -> request cancelled, fee
    //    refunded, closePending cleared, position UNCHANGED (full size).
    // =====================================================================

    function test_Decrease_SlippageMissKeepsPositionWhole() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        uint256 afterOpen = asset.balanceOf(alice);

        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // Acceptable ABOVE the exit -> a long close/decrease misses the bound.
        uint256 id = _requestDecrease(pm, alice, BTC, true, 5_000, 70_000 * ONE8);
        assertTrue(pm.closePending(key), "closePending set after request");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PositionManager.RequestCancelled(id, alice, true);
        (bool ok,) = _execute(pm, keeper, id, BTC, 66_000); // 66000 < acceptable 70000 -> miss
        require(ok, "slippage cancel should not revert");

        assertEq(_sizeUsd(pm, alice, BTC, true), SIZE, "position unchanged after a decrease miss");
        assertEq(_posCollateral(pm, alice, BTC, true), COL, "collateral unchanged after a decrease miss");
        assertEq(asset.balanceOf(alice), afterOpen, "execution fee refunded to owner");
        assertEq(asset.balanceOf(keeper), 0, "keeper unpaid on a slippage cancel");
        assertFalse(pm.closePending(key), "closePending cleared on cancel");
        assertFalse(_active(pm, id), "request consumed");
    }

    // =====================================================================
    // 5. Dust guard: a closeBps leaving remaining collateral < MIN_COLLATERAL
    //    reverts CollateralTooLow with the would-be remainder.
    // =====================================================================

    function test_RequestDecrease_RevertWhen_RemainderDust() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // closeBps 9950 -> closed 995, remaining 5 < MIN_COLLATERAL (10).
        uint256 remaining = COL - (COL * 9_950) / BPS_DENOMINATOR;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.CollateralTooLow.selector, remaining, MIN_COLLATERAL));
        pm.requestDecrease(BTC, true, 9_950, ENTRY * ONE8);
    }

    // =====================================================================
    // 6. closeBps bounds: 0 and 10000 (a full close) both revert
    //    InvalidCloseBps — a full close must use requestClose.
    // =====================================================================

    function test_RequestDecrease_RevertWhen_BpsOutOfRange() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.InvalidCloseBps.selector, uint256(0)));
        pm.requestDecrease(BTC, true, 0, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.InvalidCloseBps.selector, uint256(BPS_DENOMINATOR)));
        pm.requestDecrease(BTC, true, BPS_DENOMINATOR, ENTRY * ONE8);
    }

    // =====================================================================
    // 7. One pending close at a time: requestDecrease then requestClose
    //    reverts CloseAlreadyPending (and so does a second requestDecrease).
    // =====================================================================

    function test_RequestDecrease_RevertWhen_AlreadyPending() public {
        _fund(pm, alice, COL + 3 * EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        _requestDecrease(pm, alice, BTC, true, 5_000, ENTRY * ONE8);

        // A full-close request on the same key is blocked while the decrease pends.
        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestClose(BTC, true, ENTRY * ONE8);

        // A second decrease is likewise blocked.
        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestDecrease(BTC, true, 2_500, ENTRY * ONE8);
    }
}
