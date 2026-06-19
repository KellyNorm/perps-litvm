// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Position-increase tests (PR-9b, Phase 2).
//
// Exercises the ADDITIVE requestIncrease -> keeper-execute flow layered onto the
// two-step machinery. An increase ADDS size + collateral to an open position at a
// keeper-filled price, escrowing the new collateral (like an Open) and merging
// into the existing position with a size-weighted blended entry price AND
// size-weighted blended entry fee/funding indices. The blended INDICES make the
// future accrual exactly equal to "old portion accrues from its original entry,
// new portion accrues from the increase moment", so there is no mid-life
// realization and no new transfer path. Open/Close/Decrease paths and their suites
// are untouched; this file only adds the new surface.
//
// FFI: prices come from the Node helper `test/ffi/redstone-mock-payload.js` (same
// as the other suites). `executeRequest` reads the signed price from the *tail* of
// the calldata, so its calls are built as
// abi.encodeWithSelector(fn, args) ++ redstonePayload and `call`ed. The request
// functions take no oracle payload and are called directly.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {AuthorisedMockSignersBase} from "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";

/**
 * @dev Test-only subclass swapping the real demo signer for RedStone's mock
 *      signers so offline mock payloads verify (mirrors {PartialCloseHarness}). The
 *      thin exposers reproduce the OLD direct open/close cores (PR-6c deleted the
 *      external entries) — used here to set up positions and to provide the
 *      independent baseline legs the index-weighting proof compares against; the
 *      cores are unchanged so the comparison holds.
 */
contract PositionIncreaseHarness is PositionManager, AuthorisedMockSignersBase {
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

contract PositionIncreaseTest is Test {
    MockERC20 internal asset;
    LiquidityPool internal pool;
    PositionIncreaseHarness internal pm;

    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal keeper = makeAddr("keeper");

    bytes32 internal constant BTC = bytes32("BTC");
    bytes32 internal constant ETH = bytes32("ETH");

    uint256 internal constant ONE8 = 1e8; // RedStone numeric precision
    uint256 internal constant LP_LIQUIDITY = 1_000_000e18;

    // Mirrors of the manager's params for assertions.
    uint256 internal constant MIN_COLLATERAL = 10e18;
    uint256 internal constant MAX_LEVERAGE = 10;
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

    function _newSystem(uint256 liq) internal returns (LiquidityPool p, PositionIncreaseHarness m) {
        p = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP");
        m = new PositionIncreaseHarness(p);
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
        PositionIncreaseHarness(address(p)).exposed_open(market, isLong, collateral, leverage, price * ONE8);
    }

    function _closeDirect(PositionManager p, address who, bytes32 market, bool isLong, uint256 price)
        internal
        returns (uint256)
    {
        vm.prank(who);
        return PositionIncreaseHarness(address(p)).exposed_close(market, isLong, price * ONE8);
    }

    // --- request / execute helpers --------------------------------------

    function _requestIncrease(
        PositionManager p,
        address who,
        bytes32 market,
        bool isLong,
        uint256 addCollateral,
        uint256 addLeverage,
        uint256 acceptablePrice
    ) internal returns (uint256 id) {
        vm.prank(who);
        id = p.requestIncrease(market, isLong, addCollateral, addLeverage, acceptablePrice);
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

    /// @dev The size-weighted blended entry the contract stores on an increase:
    ///      newSize * entry * fill / (size*fill + addSize*entry), rounded UP for a
    ///      long / DOWN for a short (pool-favorable). All prices are 1e8-scaled.
    function _blend(uint256 size, uint256 entryScaled, uint256 addSize, uint256 fillScaled, bool isLong)
        internal
        pure
        returns (uint256)
    {
        uint256 newSize = size + addSize;
        return Math.mulDiv(
            newSize,
            entryScaled * fillScaled,
            size * fillScaled + addSize * entryScaled,
            isLong ? Math.Rounding.Ceil : Math.Rounding.Floor
        );
    }

    // =====================================================================
    // 1. Happy increase: size and collateral grow by the added chunk, the
    //    stored entry is the blended value, the keeper is paid, the request is
    //    consumed, and the position-edit mutex clears.
    // =====================================================================

    function test_Increase_Happy() public {
        // Open pulls COL; requestIncrease escrows COL + fee.
        _fund(pm, alice, 2 * COL + EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // A long increase BUYS in -> within bound when fill <= acceptable.
        uint256 id = _requestIncrease(pm, alice, BTC, true, COL, LEV, 70_000 * ONE8);
        assertTrue(pm.closePending(key), "closePending (edit mutex) set on a queued increase");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(pm, keeper, id, BTC, 66_000); // fill at 66000, within bound
        require(ok, "execute increase failed");

        uint256 expectedEntry = _blend(SIZE, ENTRY * ONE8, SIZE, 66_000 * ONE8, true);

        assertEq(_sizeUsd(pm, alice, BTC, true), SIZE + COL * LEV, "size grew by addCollateral*addLeverage");
        assertEq(_posCollateral(pm, alice, BTC, true), COL + COL, "collateral grew by addCollateral");
        assertEq(_entryPrice(pm, alice, BTC, true), expectedEntry, "stored entry is the blended value");

        assertEq(asset.balanceOf(keeper), EXECUTION_FEE, "keeper paid the execution fee on fill");
        assertFalse(_active(pm, id), "request consumed");
        assertFalse(pm.closePending(key), "closePending cleared after fill");
    }

    // =====================================================================
    // 2. Blended entry is the harmonic (weight-additive) blend, rounded UP for
    //    a long, and a later close prices P&L off that blended entry.
    // =====================================================================

    function test_Increase_BlendedEntryNumericAndPnl() public {
        // Open size S at 60000, increase by an EQUAL size S at 66000.
        _fund(pm, alice, 2 * COL + 2 * EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, 60_000);

        uint256 id = _requestIncrease(pm, alice, BTC, true, COL, LEV, 66_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(pm, keeper, id, BTC, 66_000);
        require(ok, "execute increase failed");

        // 2*60000*66000/126000 == 62857.142857..., rounded UP for the long.
        uint256 expectedEntry = _blend(SIZE, 60_000 * ONE8, SIZE, 66_000 * ONE8, true);
        assertEq(expectedEntry, 6_285_714_285_715, "harmonic blend rounded up (62857.14285715e8)");
        assertEq(_entryPrice(pm, alice, BTC, true), expectedEntry, "stored entry == harmonic blend");

        // Close the merged 2S position at 69000 and confirm the realized P&L is
        // priced off the BLENDED entry (net of the exact pending borrow fee; no
        // funding accrues with a one-sided book).
        uint256 newCollateral = 2 * COL;
        uint256 rawPnl = Math.mulDiv(2 * SIZE, (69_000 * ONE8) - expectedEntry, expectedEntry); // long profit, Floor

        uint256 closeId = _requestClose(pm, alice, BTC, true, 60_000 * ONE8);
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        // Capture the exact pending borrow fee AT the close block (it grows over the
        // execution delay); funding is zero with this one-sided book.
        uint256 borrowFee = pm.pendingBorrowFee(alice, BTC, true);
        uint256 before = asset.balanceOf(alice);
        (bool ok2,) = _execute(pm, keeper, closeId, BTC, 69_000);
        require(ok2, "execute close failed");
        uint256 payout = asset.balanceOf(alice) - before;

        // payout == collateral + profit - borrowFee (off the blended entry).
        assertApproxEqAbs(payout, newCollateral + rawPnl - borrowFee, 2, "P&L priced off the blended entry");
        assertEq(_sizeUsd(pm, alice, BTC, true), 0, "position fully closed");
    }

    // =====================================================================
    // 3. Weighted-index correctness (the core proof). A size-S leg increased by
    //    an equal size-S chunk at t1, then fully closed at t2, realizes the SAME
    //    total borrow fee + funding as two independent legs (size S aged t0->t2
    //    and size S aged t1->t2) closed at t2 at the same price. With every fill
    //    at the entry price, P&L is zero, so each payout is collateral net of the
    //    realized fee + funding; comparing payouts isolates the accrual.
    //
    //    Both systems share the global clock and an identical OI timeline, so
    //    their per-side funding/borrow indices evolve identically. A short leg in
    //    each system keeps the book two-sided (longs heavy) so funding is nonzero.
    // =====================================================================

    // Test-3 economics (lifted to constants to keep the test frame within the EVM
    // stack limit, no via-ir). Long leg 300e18 == the add chunk; short 100e18 keeps
    // longs the heavy side so funding is nonzero. P == every fill -> zero P&L.
    uint256 internal constant P3 = 60_000;
    uint256 internal constant LCOL = 100e18;
    uint256 internal constant LLEV = 3;
    uint256 internal constant SCOL = 100e18;
    uint256 internal constant SLEV = 1;

    function test_Increase_WeightedIndexEqualsTwoIndependentLegs() public {
        (, PositionIncreaseHarness mA) = _newSystem(LP_LIQUIDITY); // merged
        (, PositionIncreaseHarness mB) = _newSystem(LP_LIQUIDITY); // baseline legs

        // alice escrows: open(LCOL) + increase(LCOL + fee) + close(fee).
        _fund(mA, alice, 2 * LCOL + 2 * EXECUTION_FEE);
        _fund(mA, dave, SCOL);
        _fund(mB, bob, LCOL);
        _fund(mB, carol, LCOL);
        _fund(mB, dave, SCOL);

        // t0: open the long base + the short in both systems; queue the increase.
        _open(mA, alice, BTC, true, LCOL, LLEV, P3);
        _open(mA, dave, BTC, false, SCOL, SLEV, P3);
        _open(mB, bob, BTC, true, LCOL, LLEV, P3);
        _open(mB, dave, BTC, false, SCOL, SLEV, P3);
        uint256 incId = _requestIncrease(mA, alice, BTC, true, LCOL, LLEV, P3 * ONE8);

        // t1 = t0 + delay: execute the increase (mA) and open the second leg (mB).
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool okI,) = _execute(mA, keeper, incId, BTC, P3);
        require(okI, "execute increase failed");
        _open(mB, carol, BTC, true, LCOL, LLEV, P3);

        // Let both legs age, then queue the merged close.
        vm.warp(block.timestamp + 10);
        uint256 closeId = _requestClose(mA, alice, BTC, true, P3 * ONE8);

        // t2 = t1 + 10 + delay: close the merged position (mA) and both legs (mB)
        // at the same block time and price.
        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        uint256 aBefore = asset.balanceOf(alice);
        (bool okC,) = _execute(mA, keeper, closeId, BTC, P3);
        require(okC, "execute close failed");
        uint256 payoutMerged = asset.balanceOf(alice) - aBefore;

        uint256 payoutBaseline = _closeDirect(mB, bob, BTC, true, P3) + _closeDirect(mB, carol, BTC, true, P3);

        // Identical total fee + funding settled by the identical primitives -> the
        // payouts match within a few wei; the dominant blend-flooring drift is
        // pool-favorable (the merged trader receives no more than the legs would).
        assertApproxEqAbs(payoutMerged, payoutBaseline, 4, "merged accrual ~ two independent legs");
        assertLe(payoutMerged, payoutBaseline + 1, "drift is pool-favorable to within ceil dust");
    }

    // =====================================================================
    // 4. Slippage miss refunds the FULL collateral + fee (the key difference
    //    from a decrease miss, which only escrows the fee). A long increase BUYS
    //    in -> within bound only when fill <= acceptable; an acceptable below the
    //    fill misses. Position unchanged, keeper unpaid, edit mutex cleared.
    // =====================================================================

    function test_Increase_SlippageMissRefundsCollateralAndFee() public {
        _fund(pm, alice, 2 * COL + EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        uint256 afterOpen = asset.balanceOf(alice);

        bytes32 key = pm.getPositionKey(alice, BTC, true);

        // Acceptable BELOW the fill -> a long increase misses (66000 > 60000).
        uint256 id = _requestIncrease(pm, alice, BTC, true, COL, LEV, ENTRY * ONE8);
        assertTrue(pm.closePending(key), "edit mutex set after request");
        assertEq(asset.balanceOf(alice), afterOpen - (COL + EXECUTION_FEE), "collateral + fee escrowed at request");

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);

        vm.expectEmit(true, true, false, true, address(pm));
        emit PositionManager.RequestCancelled(id, alice, true);
        (bool ok,) = _execute(pm, keeper, id, BTC, 66_000); // 66000 > acceptable 60000 -> miss
        require(ok, "slippage cancel should not revert");

        assertEq(_sizeUsd(pm, alice, BTC, true), SIZE, "position size unchanged after an increase miss");
        assertEq(_posCollateral(pm, alice, BTC, true), COL, "position collateral unchanged after an increase miss");
        assertEq(asset.balanceOf(alice), afterOpen, "FULL collateral + fee refunded to owner");
        assertEq(asset.balanceOf(keeper), 0, "keeper unpaid on a slippage cancel");
        assertFalse(pm.closePending(key), "edit mutex cleared on cancel");
        assertFalse(_active(pm, id), "request consumed");
    }

    // =====================================================================
    // 5. Leverage guard: addLeverage == MAX_LEVERAGE+1 and == 0 both revert
    //    LeverageOutOfRange at request time (before any escrow moves).
    // =====================================================================

    function test_RequestIncrease_RevertWhen_LeverageOutOfRange() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.LeverageOutOfRange.selector, MAX_LEVERAGE + 1));
        pm.requestIncrease(BTC, true, COL, MAX_LEVERAGE + 1, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.LeverageOutOfRange.selector, uint256(0)));
        pm.requestIncrease(BTC, true, COL, 0, ENTRY * ONE8);
    }

    // =====================================================================
    // 6. Min-collateral guard: addCollateral < MIN_COLLATERAL reverts
    //    CollateralTooLow at request time.
    // =====================================================================

    function test_RequestIncrease_RevertWhen_CollateralTooLow() public {
        _fund(pm, alice, COL + EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        uint256 tooLow = MIN_COLLATERAL - 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.CollateralTooLow.selector, tooLow, MIN_COLLATERAL));
        pm.requestIncrease(BTC, true, tooLow, LEV, ENTRY * ONE8);
    }

    // =====================================================================
    // 7. Edit mutex: an increase shares the closePending mutex with close and
    //    decrease, so the three are mutually exclusive on one position key.
    // =====================================================================

    function test_RequestIncrease_MutexWithCloseAndDecrease() public {
        _fund(pm, alice, 3 * COL + 4 * EXECUTION_FEE);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // (a) increase then close / decrease are both blocked while it pends.
        _requestIncrease(pm, alice, BTC, true, COL, LEV, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestClose(BTC, true, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        pm.requestDecrease(BTC, true, 5_000, ENTRY * ONE8);

        // (b) a pending close blocks a new increase.
        (, PositionIncreaseHarness m2) = _newSystem(LP_LIQUIDITY);
        _fund(m2, alice, COL + 2 * EXECUTION_FEE);
        _open(m2, alice, BTC, true, COL, LEV, ENTRY);
        _requestClose(m2, alice, BTC, true, ENTRY * ONE8);

        vm.prank(alice);
        vm.expectRevert(PositionManager.CloseAlreadyPending.selector);
        m2.requestIncrease(BTC, true, COL, LEV, ENTRY * ONE8);
    }

    // =====================================================================
    // 8. An increase that would push reserved liquidity past MAX_UTILIZATION
    //    reverts ExceedsUtilization at execute (the request still queued fine).
    // =====================================================================

    function test_Increase_RevertWhen_ExceedsUtilizationAtExecute() public {
        // Small pool: 1000 liquidity -> 80% cap == 800 reservable. Each unit of
        // collateral reserves 5x, so ~160 collateral is the ceiling.
        (, PositionIncreaseHarness m) = _newSystem(1_000e18);
        _fund(m, alice, 200e18 + EXECUTION_FEE);

        // Open 100 collateral -> reserves 500 (<= 800). Increasing by another 100
        // collateral would reserve +500 = 1000 > 800.
        _open(m, alice, BTC, true, 100e18, 2, ENTRY);
        uint256 id = _requestIncrease(m, alice, BTC, true, 100e18, 2, 70_000 * ONE8);

        vm.warp(block.timestamp + MIN_EXECUTION_DELAY);
        (bool ok,) = _execute(m, keeper, id, BTC, 66_000);
        assertFalse(ok, "execute reverts when the merged reserve breaches utilization");

        // The request remains active and the position is untouched.
        assertTrue(_active(m, id), "request still active after the failed fill");
        assertEq(_sizeUsd(m, alice, BTC, true), 200e18, "position unchanged");
    }
}
