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
        (,,, uint256 collateral, uint256 sizeUsd, uint256 entryPrice) = pm.positions(key);
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
        (,,,, uint256 sizeUsd,) = pm.positions(key);
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
