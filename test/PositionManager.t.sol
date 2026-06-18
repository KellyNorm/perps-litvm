// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// PositionManager tests (PR-3).
//
// These exercise the perp engine end-to-end against the ERC-4626 LiquidityPool,
// using RedStone's deterministic mock signers for prices (no network access).
//
// FFI: like the PR-1 oracle test, prices are produced by the Node helper
// `test/ffi/redstone-mock-payload.js` (needs `npm install` and `node` on PATH;
// `ffi = true` is set in foundry.toml). Each open/close builds calldata =
// abi.encodeWithSelector(fn, args) ++ redstonePayload and `call`s the manager,
// because RedStone reads the signed price from the *tail* of the calldata.
//
// Block time is warped to the package timestamp so prices pass the manager's
// tightened (<= MAX_PRICE_AGE) staleness window.

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PositionManager} from "../src/PositionManager.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {AuthorisedMockSignersBase} from "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";

/**
 * @dev Test-only subclass swapping the real demo signer for RedStone's mock
 *      signers so offline mock payloads verify. The tightened staleness window,
 *      single-signer threshold, and all settlement logic are exercised exactly
 *      as in production.
 */
contract PositionManagerHarness is PositionManager, AuthorisedMockSignersBase {
    constructor(LiquidityPool pool_) PositionManager(pool_) {}

    function getAuthorisedSignerIndex(address signerAddress) public view virtual override returns (uint8) {
        return getAuthorisedMockSignerIndex(signerAddress);
    }
}

contract PositionManagerTest is Test {
    MockERC20 internal asset;
    LiquidityPool internal pool;
    PositionManagerHarness internal pm;

    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    bytes32 internal constant BTC = bytes32("BTC");
    bytes32 internal constant ETH = bytes32("ETH");

    uint256 internal constant ONE8 = 1e8; // RedStone numeric precision
    uint256 internal constant LP_LIQUIDITY = 1_000_000e18;

    // Mirror of the manager's risk params for assertions.
    uint256 internal constant MIN_COLLATERAL = 10e18;
    uint256 internal constant MAX_PROFIT_FACTOR = 5;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        (pool, pm) = _newSystem(LP_LIQUIDITY);
        vm.warp(1_700_000_000); // base block time (seconds)
    }

    // --- system / payload helpers ---------------------------------------

    function _newSystem(uint256 liq) internal returns (LiquidityPool p, PositionManagerHarness m) {
        p = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP");
        m = new PositionManagerHarness(p);
        p.setPositionManager(address(m)); // this contract is the deployer
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

    function _open(
        PositionManager p,
        address who,
        bytes32 market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 price
    ) internal {
        bytes memory payload = _payload(block.timestamp * 1000, market, price);
        bytes memory data = abi.encodePacked(
            abi.encodeWithSelector(PositionManager.openPosition.selector, market, isLong, collateral, leverage), payload
        );
        vm.prank(who);
        (bool ok,) = address(p).call(data);
        require(ok, "open failed");
    }

    function _close(PositionManager p, address who, bytes32 market, bool isLong, uint256 price) internal {
        bytes memory payload = _payload(block.timestamp * 1000, market, price);
        bytes memory data =
            abi.encodePacked(abi.encodeWithSelector(PositionManager.closePosition.selector, market, isLong), payload);
        vm.prank(who);
        (bool ok,) = address(p).call(data);
        require(ok, "close failed");
    }

    function _openRaw(
        PositionManager p,
        address who,
        bytes32 market,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        bytes memory payload
    ) internal returns (bool ok, bytes memory ret) {
        bytes memory data = abi.encodePacked(
            abi.encodeWithSelector(PositionManager.openPosition.selector, market, isLong, collateral, leverage), payload
        );
        vm.prank(who);
        (ok, ret) = address(p).call(data);
    }

    // =====================================================================
    // Four P&L quadrants
    // =====================================================================

    // collateral 1000, leverage 5 -> size 5000. entry 60000.
    uint256 internal constant COL = 1_000e18;
    uint256 internal constant LEV = 5;
    uint256 internal constant ENTRY = 60_000;

    function test_LongProfit_PriceUp() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        _close(pm, alice, BTC, true, 66_000); // +10% -> +500 pnl

        // Trader nets +500; pool (LPs) pays it.
        assertEq(asset.balanceOf(alice), aliceStart + 500e18, "long-up trader pnl");
        assertEq(asset.balanceOf(address(pool)), poolBefore - 500e18, "long-up pool pays");
        assertEq(pm.totalUnrealizedProfit(), 0, "cachedU reset after close");
        assertEq(pm.totalReserved(), 0, "reserve released");
    }

    function test_LongLoss_PriceDown() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        _close(pm, alice, BTC, true, 54_000); // -10% -> -500 pnl

        assertEq(asset.balanceOf(alice), aliceStart - 500e18, "long-down trader loss");
        assertEq(asset.balanceOf(address(pool)), poolBefore + 500e18, "long-down pool gains");
    }

    function test_ShortLoss_PriceUp() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, false, COL, LEV, ENTRY);
        _close(pm, alice, BTC, false, 66_000); // +10% -> short loses 500

        assertEq(asset.balanceOf(alice), aliceStart - 500e18, "short-up trader loss");
        assertEq(asset.balanceOf(address(pool)), poolBefore + 500e18, "short-up pool gains");
    }

    function test_ShortProfit_PriceDown() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, false, COL, LEV, ENTRY);
        _close(pm, alice, BTC, false, 54_000); // -10% -> short wins 500

        assertEq(asset.balanceOf(alice), aliceStart + 500e18, "short-down trader pnl");
        assertEq(asset.balanceOf(address(pool)), poolBefore - 500e18, "short-down pool pays");
    }

    // =====================================================================
    // Caps: profit cap and loss floor (bad debt)
    // =====================================================================

    function test_ProfitCappedAtMaxProfitFactor() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        // entry 60000 -> 130000 would be +5833 pnl, but cap = 5*COL = 5000.
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        _close(pm, alice, BTC, true, 130_000);

        uint256 cap = COL * MAX_PROFIT_FACTOR;
        assertEq(asset.balanceOf(alice), aliceStart + cap, "profit capped to 5x collateral");
        assertEq(asset.balanceOf(address(pool)), poolBefore - cap, "pool pays only the cap");
    }

    function test_LossExactlyCollateral() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        // entry 60000 -> 48000 is -20% on 5x = -100% of collateral.
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        _close(pm, alice, BTC, true, 48_000);

        assertEq(asset.balanceOf(alice), aliceStart - COL, "trader loses exactly collateral");
        assertEq(asset.balanceOf(address(pool)), poolBefore + COL, "pool absorbs full collateral");
    }

    function test_LossFlooredAtCollateral_BadDebtNotCollected() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        // entry 60000 -> 40000 is -33% on 5x = -166% of collateral; floored to 100%.
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        _close(pm, alice, BTC, true, 40_000);

        // Trader cannot lose more than collateral; residual deficit left for PR-5.
        assertEq(asset.balanceOf(alice), aliceStart - COL, "loss floored at collateral");
        assertEq(asset.balanceOf(address(pool)), poolBefore + COL, "pool gains only collateral (no bad debt)");
    }

    // =====================================================================
    // Leverage / collateral bounds & size accounting
    // =====================================================================

    function test_SizeIsCollateralTimesLeverage() public {
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, 10, ENTRY); // max leverage
        bytes32 key = pm.getPositionKey(alice, BTC, true);
        (,,, uint256 collateral, uint256 sizeUsd, uint256 entryPrice,) = pm.positions(key);
        assertEq(collateral, COL, "stored collateral");
        assertEq(sizeUsd, COL * 10, "size = collateral * leverage");
        assertEq(entryPrice, ENTRY * ONE8, "entry price scaled 1e8");
    }

    function test_RevertWhen_LeverageZero() public {
        _fund(pm, alice, COL);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.LeverageOutOfRange.selector, 0));
        pm.openPosition(BTC, true, COL, 0);
    }

    function test_RevertWhen_LeverageAboveMax() public {
        _fund(pm, alice, COL);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.LeverageOutOfRange.selector, 11));
        pm.openPosition(BTC, true, COL, 11);
    }

    function test_MinAndMaxLeverageSucceed() public {
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, 1, ENTRY); // min leverage
        _fund(pm, bob, COL);
        _open(pm, bob, ETH, true, COL, 10, 3_000); // max leverage, different market
        assertGt(pm.totalReserved(), 0, "positions opened");
    }

    function test_RevertWhen_CollateralBelowMin() public {
        _fund(pm, alice, MIN_COLLATERAL);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PositionManager.CollateralTooLow.selector, MIN_COLLATERAL - 1, MIN_COLLATERAL)
        );
        pm.openPosition(BTC, true, MIN_COLLATERAL - 1, 2);
    }

    function test_MinCollateralSucceeds() public {
        _fund(pm, alice, MIN_COLLATERAL);
        _open(pm, alice, BTC, true, MIN_COLLATERAL, 1, ENTRY);
        bytes32 key = pm.getPositionKey(alice, BTC, true);
        (,,,, uint256 sizeUsd,,) = pm.positions(key);
        assertEq(sizeUsd, MIN_COLLATERAL, "min collateral position opened");
    }

    function test_RevertWhen_MarketUnsupported() public {
        _fund(pm, alice, COL);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PositionManager.MarketNotSupported.selector, bytes32("DOGE")));
        pm.openPosition(bytes32("DOGE"), true, COL, 2);
    }

    function test_RevertWhen_DuplicatePosition() public {
        _fund(pm, alice, COL * 2);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        bytes memory payload = _payload(block.timestamp * 1000, BTC, ENTRY);
        (bool ok, bytes memory ret) = _openRaw(pm, alice, BTC, true, COL, LEV, payload);
        assertFalse(ok, "duplicate open should revert");
        assertEq(bytes4(ret), PositionManager.PositionAlreadyOpen.selector, "duplicate selector");
    }

    function test_RevertWhen_CloseWithoutPosition() public {
        bytes memory payload = _payload(block.timestamp * 1000, BTC, ENTRY);
        bytes memory data =
            abi.encodePacked(abi.encodeWithSelector(PositionManager.closePosition.selector, BTC, true), payload);
        vm.prank(alice);
        (bool ok, bytes memory ret) = address(pm).call(data);
        assertFalse(ok, "close of missing position should revert");
        assertEq(bytes4(ret), PositionManager.NoOpenPosition.selector, "no-position selector");
    }

    // =====================================================================
    // Pool accounting: NAV reflects open positions; reserves gate withdrawals
    // =====================================================================

    function test_TotalAssetsReflectsOpenUnrealizedProfit() public {
        // Open at entry: mark == entry, so no unrealized profit yet.
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        assertEq(pool.totalAssets(), LP_LIQUIDITY, "no UPnL right after open");

        // A second open in the same market refreshes the mark to 66000, which
        // puts alice's long +500 in profit -> NAV drops by 500 for LPs.
        _fund(pm, bob, COL);
        _open(pm, bob, BTC, true, COL, LEV, 66_000);

        assertApproxEqAbs(pm.totalUnrealizedProfit(), 500e18, 1e12, "cachedU = aggregate UPnL");
        assertApproxEqAbs(pool.totalAssets(), LP_LIQUIDITY - 500e18, 1e12, "NAV reflects open profit");
    }

    function test_LosingPositionsDoNotInflateNav() public {
        // Open then refresh the mark adversely: a losing long must NOT raise NAV
        // (loss is only credited to LPs when realized on close).
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        _fund(pm, bob, COL);
        _open(pm, bob, BTC, true, COL, LEV, 54_000); // mark down -> alice losing

        assertEq(pm.totalUnrealizedProfit(), 0, "losing side not counted as profit");
        assertEq(pool.totalAssets(), LP_LIQUIDITY, "NAV not inflated by unrealized loss");
    }

    function test_ReservedLiquidityCapsWithdrawals() public {
        (LiquidityPool p, PositionManagerHarness m) = _newSystem(10_000e18);
        // One position: reserve = 5 * 1000 = 5000 -> free = 10000 - 5000.
        _fund(m, alice, COL);
        _open(m, alice, BTC, true, COL, LEV, ENTRY);

        assertEq(m.totalReserved(), 5_000e18, "reserved = capped max payout");
        assertEq(p.freeAssets(), 5_000e18, "free = balance - reserved");

        // lp deposited 10000 but can only withdraw the free 5000.
        assertEq(p.maxWithdraw(lp), 5_000e18, "maxWithdraw capped to free");
        assertEq(p.maxRedeem(lp), p.convertToShares(5_000e18), "maxRedeem capped to free");

        // Withdrawing beyond free reverts via the ERC4626 max check.
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp, 5_000e18 + 1, 5_000e18));
        p.withdraw(5_000e18 + 1, lp, lp);

        // Withdrawing within free succeeds.
        vm.prank(lp);
        p.withdraw(5_000e18, lp, lp);
        assertEq(asset.balanceOf(lp), 5_000e18, "lp withdrew the free portion");
    }

    function test_RevertWhen_OpenExceedsUtilization() public {
        // Pool 10000, cap 80% -> max reserved 8000. Each position reserves 5000.
        (, PositionManagerHarness m) = _newSystem(10_000e18);
        _fund(m, alice, COL);
        _open(m, alice, BTC, true, COL, LEV, ENTRY); // reserved 5000 <= 8000 OK

        _fund(m, bob, COL);
        bytes memory payload = _payload(block.timestamp * 1000, BTC, ENTRY);
        (bool ok, bytes memory ret) = _openRaw(m, bob, BTC, true, COL, LEV, payload); // 10000 > 8000
        assertFalse(ok, "over-utilization open should revert");
        assertEq(bytes4(ret), PositionManager.ExceedsUtilization.selector, "utilization selector");
    }

    // =====================================================================
    // Oracle freshness / integrity
    // =====================================================================

    function test_RevertWhen_OpenWithoutPayload() public {
        _fund(pm, alice, COL);
        // Typed call with valid params but NO appended payload -> oracle read reverts.
        vm.prank(alice);
        vm.expectRevert();
        pm.openPosition(BTC, true, COL, LEV);
    }

    function test_RevertWhen_PriceStale() public {
        _fund(pm, alice, COL);
        // Package 61s older than block time -> beyond MAX_PRICE_AGE (60s).
        uint256 staleTsMs = (block.timestamp - 61) * 1000;
        bytes memory payload = _payload(staleTsMs, BTC, ENTRY);
        (bool ok, bytes memory ret) = _openRaw(pm, alice, BTC, true, COL, LEV, payload);
        assertFalse(ok, "stale price should revert");
        assertEq(bytes4(ret), PositionManager.PriceTooStale.selector, "stale selector");
    }

    function test_RevertWhen_PriceFromFuture() public {
        _fund(pm, alice, COL);
        uint256 futureTsMs = (block.timestamp + 61) * 1000;
        bytes memory payload = _payload(futureTsMs, BTC, ENTRY);
        (bool ok, bytes memory ret) = _openRaw(pm, alice, BTC, true, COL, LEV, payload);
        assertFalse(ok, "future price should revert");
        assertEq(bytes4(ret), PositionManager.PriceFromFuture.selector, "future selector");
    }

    function test_RevertWhen_SignerNotAuthorised() public {
        // A NON-harness manager authorises only the real demo signer, so the
        // mock-signed payload must be rejected.
        (, PositionManager plain) = _newPlainSystem(LP_LIQUIDITY);
        _fund(plain, alice, COL);
        bytes memory payload = _payload(block.timestamp * 1000, BTC, ENTRY);
        (bool ok,) = _openRaw(plain, alice, BTC, true, COL, LEV, payload);
        assertFalse(ok, "unauthorised signer must be rejected");
    }

    function _newPlainSystem(uint256 liq) internal returns (LiquidityPool p, PositionManager m) {
        p = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP");
        m = new PositionManager(p);
        p.setPositionManager(address(m));
        asset.mint(address(this), liq);
        asset.approve(address(p), liq);
        p.deposit(liq, lp);
    }

    // =====================================================================
    // Access control on the pool's trusted settlement surface
    // =====================================================================

    function test_RevertWhen_PayProfitCallerNotManager() public {
        vm.prank(alice);
        vm.expectRevert(LiquidityPool.NotPositionManager.selector);
        pool.payProfit(alice, 1e18);
    }

    function test_RevertWhen_ReceiveLossCallerNotManager() public {
        vm.prank(alice);
        vm.expectRevert(LiquidityPool.NotPositionManager.selector);
        pool.receiveLoss(1e18);
    }

    function test_RevertWhen_SetPositionManagerCalledTwice() public {
        vm.expectRevert(LiquidityPool.PositionManagerAlreadySet.selector);
        pool.setPositionManager(address(0xBEEF));
    }

    function test_RevertWhen_SetPositionManagerByNonDeployer() public {
        LiquidityPool fresh = new LiquidityPool(IERC20(address(asset)), "x", "x");
        vm.prank(alice);
        vm.expectRevert(LiquidityPool.NotDeployer.selector);
        fresh.setPositionManager(address(0xBEEF));
    }

    function test_RevertWhen_SetPositionManagerZero() public {
        LiquidityPool fresh = new LiquidityPool(IERC20(address(asset)), "x", "x");
        vm.expectRevert(LiquidityPool.ZeroAddress.selector);
        fresh.setPositionManager(address(0));
    }

    // =====================================================================
    // Reentrancy on the profit-payout path
    // =====================================================================

    function test_ReentrancyBlockedOnClosePayout() public {
        EvilToken evil = new EvilToken();
        LiquidityPool evilPool = new LiquidityPool(IERC20(address(evil)), "Evil LP", "eLP");
        PositionManagerHarness evilPm = new PositionManagerHarness(evilPool);
        evilPool.setPositionManager(address(evilPm));

        // Seed the pool with LP liquidity.
        evil.mint(address(this), LP_LIQUIDITY);
        evil.approve(address(evilPool), LP_LIQUIDITY);
        evilPool.deposit(LP_LIQUIDITY, lp);

        // Alice opens a long that will close in profit.
        evil.mint(alice, COL);
        vm.prank(alice);
        evil.approve(address(evilPm), COL);
        {
            bytes memory payload = _payload(block.timestamp * 1000, BTC, ENTRY);
            bytes memory data = abi.encodePacked(
                abi.encodeWithSelector(PositionManager.openPosition.selector, BTC, true, COL, LEV), payload
            );
            vm.prank(alice);
            (bool ok,) = address(evilPm).call(data);
            require(ok, "evil open failed");
        }

        // Arm the token to re-enter closePosition during the profit payout.
        evil.arm(evilPm, BTC, true);

        bytes memory closePayload = _payload(block.timestamp * 1000, BTC, 66_000);
        bytes memory closeData =
            abi.encodePacked(abi.encodeWithSelector(PositionManager.closePosition.selector, BTC, true), closePayload);
        vm.prank(alice);
        (bool okClose, bytes memory ret) = address(evilPm).call(closeData);
        assertFalse(okClose, "reentrant close must revert");
        assertEq(bytes4(ret), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "reentrancy selector");
    }

    // =====================================================================
    // PR-4a — Borrow fee
    // =====================================================================

    uint256 internal constant SIZE = COL * LEV; // 5000e18 notional
    uint256 internal constant FEE_PRECISION = 1e18;
    uint256 internal constant ONE_YEAR = 31_536_000; // seconds

    /// @dev Mirrors the contract: ceil(size · rate·elapsed / FEE_PRECISION).
    function _expectedFee(uint256 size, uint256 elapsed) internal view returns (uint256) {
        uint256 num = size * (pm.BORROW_RATE_PER_SECOND() * elapsed);
        return (num + FEE_PRECISION - 1) / FEE_PRECISION;
    }

    // --- accrual over simulated time -------------------------------------

    function test_BorrowFeeAccruesOverTime() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        // No fee right at open.
        assertEq(pm.pendingBorrowFee(alice, BTC, true), 0, "no fee at open");

        vm.warp(block.timestamp + ONE_YEAR);
        uint256 fee = _expectedFee(SIZE, ONE_YEAR);
        assertGt(fee, 0, "fee accrued");
        assertEq(pm.pendingBorrowFee(alice, BTC, true), fee, "pending fee = size*rate*dt");

        // Close flat (exit == entry): no P&L, only the borrow fee is taken.
        _close(pm, alice, BTC, true, ENTRY);

        // Trader paid exactly the fee; pool (LPs) received exactly the fee.
        assertEq(asset.balanceOf(alice), aliceStart - fee, "trader pays borrow fee");
        assertEq(asset.balanceOf(address(pool)), poolBefore + fee, "pool collects borrow fee");
        assertEq(pm.totalUnrealizedProfit(), 0, "cachedU clean after close");
        assertEq(pm.totalReserved(), 0, "reserve released");
    }

    function test_NoElapsedTime_NoFee() public {
        _fund(pm, alice, COL);
        uint256 aliceStart = asset.balanceOf(alice);

        // Open and close in the same block: a +500 profit, zero fee.
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        _close(pm, alice, BTC, true, 66_000);

        // Exactly the PR-3 result — fee must not perturb same-block settlement.
        assertEq(asset.balanceOf(alice), aliceStart + 500e18, "no fee when no time elapses");
    }

    // --- deduction at close: profit & loss -------------------------------

    function test_BorrowFeeDeductedFromProfit() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        vm.warp(block.timestamp + ONE_YEAR);
        uint256 fee = _expectedFee(SIZE, ONE_YEAR);

        _close(pm, alice, BTC, true, 66_000); // +500 pnl, well under the fee-vs-available cap

        // payout = collateral + pnl - fee; pool nets pnl - fee out.
        assertEq(asset.balanceOf(alice), aliceStart + 500e18 - fee, "payout = collateral + profit - fee");
        assertEq(asset.balanceOf(address(pool)), poolBefore - 500e18 + fee, "pool pays profit net of fee");
    }

    function test_BorrowFeeDeductedFromLoss() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        vm.warp(block.timestamp + ONE_YEAR);
        uint256 fee = _expectedFee(SIZE, ONE_YEAR);

        _close(pm, alice, BTC, true, 54_000); // -500 pnl (loss capped well under collateral)

        // payout = collateral - lossCapped - fee; pool inflow = lossCapped + fee.
        assertEq(asset.balanceOf(alice), aliceStart - 500e18 - fee, "payout = collateral - loss - fee");
        assertEq(asset.balanceOf(address(pool)), poolBefore + 500e18 + fee, "pool inflow = loss + fee");
    }

    // --- fee exceeds collateral: payout floors at 0, remainder uncollected

    function test_BorrowFeeCappedSoPayoutNeverNegative() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        // Long enough that the uncapped fee exceeds the whole collateral.
        vm.warp(block.timestamp + 4 * ONE_YEAR);
        uint256 rawFee = pm.pendingBorrowFee(alice, BTC, true);
        assertGt(rawFee, COL, "uncapped fee exceeds collateral");

        // Close flat: available = collateral, fee charged is capped to it.
        _close(pm, alice, BTC, true, ENTRY);

        // Payout floors at 0 (no revert/underflow); only collateral is collected.
        assertEq(asset.balanceOf(alice), aliceStart - COL, "payout floored at 0");
        assertEq(
            asset.balanceOf(address(pool)),
            poolBefore + COL,
            "pool collects only collateral; remainder uncollected (PR-5)"
        );
    }

    // --- O(1) shared index: fees scale with size -------------------------

    function test_BorrowFeeProportionalToSizeViaSharedIndex() public {
        // Alice size 5000e18, Bob size 10000e18, same market, same interval.
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);
        _fund(pm, bob, COL * 2);
        _open(pm, bob, BTC, true, COL * 2, LEV, ENTRY); // size 10000e18

        vm.warp(block.timestamp + ONE_YEAR);

        uint256 aliceFee = pm.pendingBorrowFee(alice, BTC, true);
        uint256 bobFee = pm.pendingBorrowFee(bob, BTC, true);

        assertEq(aliceFee, _expectedFee(SIZE, ONE_YEAR), "alice fee from shared index");
        assertEq(bobFee, _expectedFee(SIZE * 2, ONE_YEAR), "bob fee from shared index");
        assertEq(bobFee, aliceFee * 2, "fee scales linearly with notional, one shared index");
    }

    // --- pure accrual must not move LP accounting; only close realizes ---

    function test_PureAccrualDoesNotChangeNavOrReserved() public {
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        uint256 reservedBefore = pm.totalReserved();
        uint256 cachedUBefore = pm.totalUnrealizedProfit();
        uint256 navBefore = pool.totalAssets();
        uint256 poolBalBefore = asset.balanceOf(address(pool));

        // Time passes with no open/close.
        vm.warp(block.timestamp + ONE_YEAR);

        // Accounting is untouched until a close realizes the fee.
        assertEq(pm.totalReserved(), reservedBefore, "reserved unchanged by pure accrual");
        assertEq(pm.totalUnrealizedProfit(), cachedUBefore, "cachedU unchanged by pure accrual");
        assertEq(pool.totalAssets(), navBefore, "NAV unchanged by pure accrual");
        assertEq(asset.balanceOf(address(pool)), poolBalBefore, "pool balance unchanged by pure accrual");

        // Realize on close (flat price): pool balance and NAV rise by the fee.
        uint256 fee = _expectedFee(SIZE, ONE_YEAR);
        _close(pm, alice, BTC, true, ENTRY);
        assertEq(asset.balanceOf(address(pool)), poolBalBefore + fee, "pool balance rises by fee at close");
        assertEq(pool.totalAssets(), navBefore + fee, "LP NAV rises by exactly the collected fee");
    }

    // =====================================================================
    // PR-5 — Liquidations
    // =====================================================================

    address internal liquidator = makeAddr("liquidator");

    // Mirrors of the manager's PR-5 risk params for assertions.
    uint256 internal constant MAINTENANCE_MARGIN_BPS = 1_000; // 10%
    uint256 internal constant LIQUIDATION_FEE_BPS = 500; // 5%
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MAINTENANCE = (COL * MAINTENANCE_MARGIN_BPS) / BPS_DENOMINATOR; // 100e18
    uint256 internal constant BONUS = (COL * LIQUIDATION_FEE_BPS) / BPS_DENOMINATOR; // 50e18

    // --- liquidation helpers ---------------------------------------------

    function _liquidate(PositionManager p, address caller, address owner, bytes32 market, bool isLong, uint256 price)
        internal
    {
        (bool ok,) = _liquidateRaw(p, caller, owner, market, isLong, price);
        require(ok, "liquidate failed");
    }

    function _liquidateRaw(PositionManager p, address caller, address owner, bytes32 market, bool isLong, uint256 price)
        internal
        returns (bool ok, bytes memory ret)
    {
        bytes memory payload = _payload(block.timestamp * 1000, market, price);
        bytes memory data = abi.encodePacked(
            abi.encodeWithSelector(PositionManager.liquidate.selector, owner, market, isLong), payload
        );
        vm.prank(caller);
        (ok, ret) = address(p).call(data);
    }

    // --- 1 & 2: healthy / profitable positions are NOT liquidatable -------

    function test_Liquidate_RevertWhen_HealthyPositionSmallLoss() public {
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // exit 58800: -2% on 5x = -100 pnl -> equity 900, well above maintenance 100.
        (bool ok, bytes memory ret) = _liquidateRaw(pm, liquidator, alice, BTC, true, 58_800);
        assertFalse(ok, "healthy position must not be liquidatable");
        assertEq(bytes4(ret), PositionManager.NotLiquidatable.selector, "not-liquidatable selector");
    }

    function test_Liquidate_RevertWhen_Profitable() public {
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // exit 66000: +500 profit -> equity 1500, far above maintenance.
        (bool ok, bytes memory ret) = _liquidateRaw(pm, liquidator, alice, BTC, true, 66_000);
        assertFalse(ok, "profitable position must not be liquidatable");
        assertEq(bytes4(ret), PositionManager.NotLiquidatable.selector, "not-liquidatable selector");
    }

    // --- 3: equity exactly at maintenance -> liquidatable -----------------

    function test_Liquidate_AtMaintenanceThreshold() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // exit 49200: -18% on 5x = -900 loss -> equity = 1000 - 900 = 100 == maintenance.
        // equity > maintenance is the revert condition, so == is liquidatable.
        _liquidate(pm, liquidator, alice, BTC, true, 49_200);

        uint256 loss = 900e18; // raw pnl
        uint256 toPool = loss; // net owed = pnl + fee(0)
        uint256 remaining = COL - toPool; // 100e18
        uint256 expectBonus = BONUS; // min(50, 100) = 50
        uint256 expectRefund = remaining - expectBonus; // 50e18

        assertEq(toPool, 900e18, "toPool = loss");
        assertEq(toPool + expectBonus + expectRefund, COL, "conservation: split sums to collateral");
        assertEq(asset.balanceOf(address(pool)), poolBefore + toPool, "pool balance += toPool");
        assertEq(asset.balanceOf(liquidator), expectBonus, "liquidator received bounty");
        assertEq(asset.balanceOf(alice), expectRefund, "owner received refund");
        // badDebt == 0 here; position fully cleared.
        assertEq(pm.totalReserved(), 0, "reserve released");
        assertEq(pm.totalUnrealizedProfit(), 0, "cachedU clean");
        bytes32 key = pm.getPositionKey(alice, BTC, true);
        (,,,, uint256 sizeUsd,,) = pm.positions(key);
        assertEq(sizeUsd, 0, "position deleted");
    }

    // --- 4: loss between maintenance and full collateral ------------------

    function test_Liquidate_LossBetweenMaintenanceAndCollateral() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // exit 48600: -19% on 5x = -950 loss -> equity = 50 (< maintenance 100, > 0).
        _liquidate(pm, liquidator, alice, BTC, true, 48_600);

        uint256 toPool = 950e18;
        uint256 remaining = COL - toPool; // 50e18
        uint256 expectBonus = remaining < BONUS ? remaining : BONUS; // min(50,50)=50
        uint256 expectRefund = remaining - expectBonus; // 0

        assertEq(toPool, 950e18, "toPool = loss");
        assertEq(expectBonus, 50e18, "bonus capped by remaining");
        assertEq(expectRefund, 0, "no refund left for owner");
        assertEq(toPool + expectBonus + expectRefund, COL, "conservation: split sums to collateral");
        assertEq(asset.balanceOf(address(pool)), poolBefore + toPool, "pool balance += toPool");
        assertEq(asset.balanceOf(liquidator), expectBonus, "liquidator received bounty");
        assertEq(asset.balanceOf(alice), expectRefund, "owner refund == 0");
    }

    // --- 5: deeply underwater -> bad debt, no underflow -------------------

    function test_Liquidate_DeeplyUnderwater_BadDebt() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // exit 40000: -33% on 5x = -1666.67 raw loss > collateral.
        _liquidate(pm, liquidator, alice, BTC, true, 40_000);

        // Raw uncapped loss = 5000 * 20000/60000 (Ceil).
        uint256 rawLoss = (SIZE * 20_000 + (60_000 - 1)) / 60_000; // ceil(5000e18 * 20000/60000)
        uint256 netOwed = rawLoss; // fee 0
        assertGt(netOwed, COL, "net owed exceeds collateral");

        uint256 expectBadDebt = netOwed - COL;
        assertEq(asset.balanceOf(address(pool)), poolBefore + COL, "pool collects only collateral");
        assertEq(asset.balanceOf(liquidator), 0, "no bounty when nothing remains");
        assertEq(asset.balanceOf(alice), 0, "no refund when underwater");
        assertGt(expectBadDebt, 0, "bad debt is positive");
        assertEq(pm.totalReserved(), 0, "reserve still released");
    }

    // --- 6: fee-dominated but price-profitable -> net path, no payProfit --

    function test_Liquidate_FeeDominatedProfitablePrice() public {
        // High leverage so the borrow fee on notional can swamp a small price gain.
        _fund(pm, alice, COL);
        _open(pm, alice, BTC, true, COL, 10, ENTRY); // size 10000e18
        uint256 size = COL * 10;
        uint256 poolBefore = asset.balanceOf(address(pool));

        // Age the position ~1.05y so the fee exceeds collateral + the small profit.
        uint256 elapsed = (ONE_YEAR * 105) / 100;
        vm.warp(block.timestamp + elapsed);
        uint256 fee = _expectedFee(size, elapsed);

        // exit 60600: +1% on 10x -> +100 raw profit (floored), swamped by the fee.
        uint256 pnl = (size * 600) / 60_000; // 100e18, floor
        // Liquidatable: equity = COL + pnl - fee <= maintenance, i.e. fee >= COL + pnl - MAINTENANCE.
        assertGe(fee, COL + pnl - MAINTENANCE, "fee dominates: equity at/under maintenance");
        assertGe(fee, pnl, "fee >= pnl so the net path cannot underflow");
        assertLt(fee - pnl, COL, "net owed under collateral: bonus/refund are exercised");

        _liquidate(pm, liquidator, alice, BTC, true, 60_600);

        // Net owed to pool = fee - pnl (profit branch). Settled purely as an inflow.
        uint256 netOwed = fee - pnl;
        uint256 toPool = netOwed > COL ? COL : netOwed;
        uint256 remaining = COL - toPool;
        uint256 expectBonus = remaining < BONUS ? remaining : BONUS;
        uint256 expectRefund = remaining - expectBonus;

        assertEq(toPool + expectBonus + expectRefund, COL, "conservation holds on the net path");
        // Pool only ever receives (no payProfit): balance rises by exactly toPool.
        assertEq(asset.balanceOf(address(pool)), poolBefore + toPool, "pool received toPool, never paid profit");
        assertEq(asset.balanceOf(liquidator), expectBonus, "liquidator bounty");
        assertEq(asset.balanceOf(alice), expectRefund, "owner refund");
    }

    // --- 7: aggregate release matches a normal close (no leak) ------------

    function test_Liquidate_AggregateReleaseMatchesClose() public {
        // System A: liquidate alice while bob stays open.
        (LiquidityPool poolA, PositionManagerHarness mA) = _newSystem(LP_LIQUIDITY);
        _fund(mA, alice, COL);
        _open(mA, alice, BTC, true, COL, LEV, ENTRY);
        _fund(mA, bob, COL);
        _open(mA, bob, BTC, true, COL, LEV, ENTRY); // healthy, stays open
        _liquidate(mA, liquidator, alice, BTC, true, 49_200);

        // System B: alice closes normally at the same price while bob stays open.
        (LiquidityPool poolB, PositionManagerHarness mB) = _newSystem(LP_LIQUIDITY);
        _fund(mB, alice, COL);
        _open(mB, alice, BTC, true, COL, LEV, ENTRY);
        _fund(mB, bob, COL);
        _open(mB, bob, BTC, true, COL, LEV, ENTRY);
        _close(mB, alice, BTC, true, 49_200);

        // The residual book must be identical between liquidation and close.
        assertEq(mA.totalReserved(), mB.totalReserved(), "totalReserved matches close");
        assertEq(mA.totalUnrealizedProfit(), mB.totalUnrealizedProfit(), "cachedU matches close");

        (uint256 lSizeA, uint256 lWeightA, uint256 sSizeA, uint256 sWeightA, uint256 markA,,) = mA.markets(BTC);
        (uint256 lSizeB, uint256 lWeightB, uint256 sSizeB, uint256 sWeightB, uint256 markB,,) = mB.markets(BTC);
        assertEq(lSizeA, lSizeB, "longSizeUsd matches");
        assertEq(lWeightA, lWeightB, "longWeight matches");
        assertEq(sSizeA, sSizeB, "shortSizeUsd matches");
        assertEq(sWeightA, sWeightB, "shortWeight matches");
        assertEq(markA, markB, "lastMarkPrice matches");
        // Bob's single long survives in both books.
        assertEq(lSizeA, SIZE, "only bob's notional remains");
        poolA; // silence unused warnings
        poolB;
    }

    // --- 8: REGRESSION — closePosition unchanged after the refactor -------

    function test_Regression_CloseProfitUnchanged() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // Same-block close at +10%: profit 500, fee 0, payout = collateral + 500.
        vm.expectEmit(true, true, false, true, address(pm));
        emit PositionManager.PositionClosed(alice, BTC, true, 66_000 * ONE8, true, 500e18, 0, COL + 500e18);
        _close(pm, alice, BTC, true, 66_000);

        assertEq(asset.balanceOf(alice), aliceStart + 500e18, "profit payout unchanged");
        assertEq(asset.balanceOf(address(pool)), poolBefore - 500e18, "pool pays profit unchanged");
    }

    function test_Regression_CloseLossUnchanged() public {
        _fund(pm, alice, COL);
        uint256 poolBefore = asset.balanceOf(address(pool));
        uint256 aliceStart = asset.balanceOf(alice);

        _open(pm, alice, BTC, true, COL, LEV, ENTRY);

        // Same-block close at -10%: loss 500, fee 0, payout = collateral - 500.
        vm.expectEmit(true, true, false, true, address(pm));
        emit PositionManager.PositionClosed(alice, BTC, true, 54_000 * ONE8, false, 500e18, 0, COL - 500e18);
        _close(pm, alice, BTC, true, 54_000);

        assertEq(asset.balanceOf(alice), aliceStart - 500e18, "loss payout unchanged");
        assertEq(asset.balanceOf(address(pool)), poolBefore + 500e18, "pool gains loss unchanged");
    }

    // --- 9: liquidate carries the reentrancy guard ------------------------

    function test_Liquidate_ReentrancyBlocked() public {
        ReenterLiquidateToken evil = new ReenterLiquidateToken();
        LiquidityPool evilPool = new LiquidityPool(IERC20(address(evil)), "Evil LP", "eLP");
        PositionManagerHarness evilPm = new PositionManagerHarness(evilPool);
        evilPool.setPositionManager(address(evilPm));

        evil.mint(address(this), LP_LIQUIDITY);
        evil.approve(address(evilPool), LP_LIQUIDITY);
        evilPool.deposit(LP_LIQUIDITY, lp);

        // Alice opens a long that will be liquidatable at the exit price below.
        evil.mint(alice, COL);
        vm.prank(alice);
        evil.approve(address(evilPm), COL);
        {
            bytes memory payload = _payload(block.timestamp * 1000, BTC, ENTRY);
            bytes memory data = abi.encodePacked(
                abi.encodeWithSelector(PositionManager.openPosition.selector, BTC, true, COL, LEV), payload
            );
            vm.prank(alice);
            (bool ok,) = address(evilPm).call(data);
            require(ok, "evil open failed");
        }

        // Arm the token to re-enter liquidate during the bounty/refund transfer.
        evil.arm(evilPm, alice, BTC, true);

        // exit 49200 -> liquidatable; the bounty transfer triggers the reentry.
        (bool okLiq, bytes memory ret) = _liquidateRaw(evilPm, liquidator, alice, BTC, true, 49_200);
        assertFalse(okLiq, "reentrant liquidate must revert");
        assertEq(bytes4(ret), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "reentrancy selector");
    }
}

/**
 * @dev Malicious ERC20 that, once armed, re-enters {PositionManager.closePosition}
 *      on its next `transfer` (the call the pool makes when paying out profit).
 *      The manager's `nonReentrant` guard must trip, reverting the whole close.
 */
contract EvilToken is ERC20 {
    PositionManager internal pm;
    bytes32 internal market;
    bool internal isLong;
    bool internal armed;

    constructor() ERC20("Evil", "EVL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(PositionManager pm_, bytes32 market_, bool isLong_) external {
        pm = pm_;
        market = market_;
        isLong = isLong_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            // Re-enter; the manager's guard is active and must revert.
            pm.closePosition(market, isLong);
        }
        return super.transfer(to, amount);
    }
}

/**
 * @dev Malicious ERC20 that re-enters {PositionManager.liquidate} on its next
 *      `transfer` (the manager's bounty/refund payout during a liquidation).
 *      The `nonReentrant` guard must trip and revert the whole liquidation.
 */
contract ReenterLiquidateToken is ERC20 {
    PositionManager internal pm;
    address internal owner;
    bytes32 internal market;
    bool internal isLong;
    bool internal armed;

    constructor() ERC20("EvilLiq", "ELQ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(PositionManager pm_, address owner_, bytes32 market_, bool isLong_) external {
        pm = pm_;
        owner = owner_;
        market = market_;
        isLong = isLong_;
        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (armed) {
            armed = false;
            // Re-enter; the guard runs before the oracle read and must revert.
            pm.liquidate(owner, market, isLong);
        }
        return super.transfer(to, amount);
    }
}
