// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAggregatorV3} from "../../src/prediction/IAggregatorV3.sol";
import {OracleResolvedMarket} from "../../src/prediction/OracleResolvedMarket.sol";
import {ParimutuelPredictions} from "../../src/prediction/ParimutuelPredictions.sol";
import {MockAggregatorV3} from "./MockAggregatorV3.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/**
 * @title ParimutuelPredictionsTest
 * @notice The critical money-path suite (design §5, §14). Every fund-moving path
 *         is exercised: parimutuel payouts with exact math, the full VOID/refund
 *         matrix, claim guards, and a conservation invariant (nothing created,
 *         lost, or stranded) including fuzzed settlements.
 */
contract ParimutuelPredictionsTest is Test {
    ParimutuelPredictions internal pm;
    MockAggregatorV3 internal feed;
    MockERC20 internal musd;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    uint16 internal constant ASSET = 0;
    uint256 internal constant NOW = 1_000_000;
    uint64 internal constant BET = 600;
    uint64 internal constant SETTLE = 300;
    int256 internal constant SPOT = 60_000e8;
    uint256 internal constant UNIT = 1e18; // mUSD is 18-decimal; MIN_BET = 1 mUSD

    function setUp() public {
        musd = new MockERC20("Mock USD", "mUSD");
        feed = new MockAggregatorV3(8);
        pm = new ParimutuelPredictions(IERC20(address(musd)), treasury, 0, address(this), 300);
        vm.warp(NOW);

        address[4] memory users = [alice, bob, carol, dave];
        for (uint256 i = 0; i < users.length; i++) {
            musd.mint(users[i], 1e30);
            vm.prank(users[i]);
            musd.approve(address(pm), type(uint256).max);
        }
    }

    // --- helpers -------------------------------------------------------------

    function _create() internal returns (uint256 id) {
        feed.setHealthy(SPOT, block.timestamp);
        id = pm.createMarket(ASSET, IAggregatorV3(address(feed)), BET, SETTLE, 0, false);
    }

    function _bet(address who, uint256 id, ParimutuelPredictions.Side side, uint256 amount) internal {
        vm.prank(who);
        pm.bet(id, side, amount);
    }

    function _obs(uint256 id, uint256 ts, int256 price) internal {
        vm.warp(ts);
        feed.setHealthy(price, ts);
        pm.observe(id);
    }

    /// Push a valid 3-sample constant-price window and settle → TWAP == price.
    function _resolveAt(uint256 id, int256 price) internal {
        uint256 tLock = NOW + BET;
        _obs(id, tLock + 10, price);
        _obs(id, tLock + 150, price);
        _obs(id, tLock + 290, price);
        vm.warp(NOW + BET + SETTLE);
        pm.settle(id);
    }

    function _resolveUp(uint256 id) internal {
        _resolveAt(id, SPOT + 1_000e8);
    }

    function _resolveDown(uint256 id) internal {
        _resolveAt(id, SPOT - 1_000e8);
    }

    function _claim(address who, uint256 id) internal returns (uint256 received) {
        uint256 before = musd.balanceOf(who);
        vm.prank(who);
        pm.claim(id);
        received = musd.balanceOf(who) - before;
    }

    function _phase(uint256 id) internal view returns (OracleResolvedMarket.Phase) {
        return pm.getMarket(id).phase;
    }

    // =========================================================================
    // Betting mechanics (design §5.1)
    // =========================================================================

    function test_Bet_CreditsPoolsAndStake_AndPullsFunds() public {
        uint256 id = _create();
        uint256 balBefore = musd.balanceOf(address(pm));

        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(bob, id, ParimutuelPredictions.Side.Down, 40 * UNIT);
        _bet(alice, id, ParimutuelPredictions.Side.Up, 60 * UNIT); // accumulates

        (uint256 up, uint256 down,) = pm.pools(id);
        assertEq(up, 160 * UNIT, "upPool");
        assertEq(down, 40 * UNIT, "downPool");

        (uint256 aUp, uint256 aDown) = pm.stakeOf(id, alice);
        assertEq(aUp, 160 * UNIT, "alice up stake accumulates");
        assertEq(aDown, 0, "alice no down stake");

        assertEq(musd.balanceOf(address(pm)) - balBefore, 200 * UNIT, "contract holds staked funds");
    }

    function test_Bet_RevertsBelowMinBet() public {
        uint256 id = _create();
        vm.prank(alice);
        vm.expectRevert(ParimutuelPredictions.BelowMinBet.selector);
        pm.bet(id, ParimutuelPredictions.Side.Up, UNIT - 1);
    }

    function test_Bet_RevertsAfterLock() public {
        uint256 id = _create();
        vm.warp(NOW + BET); // exactly at lock — betting closed
        vm.prank(alice);
        vm.expectRevert(ParimutuelPredictions.BettingClosed.selector);
        pm.bet(id, ParimutuelPredictions.Side.Up, 100 * UNIT);
    }

    function test_Bet_RevertsWhenPaused() public {
        uint256 id = _create();
        pm.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pm.bet(id, ParimutuelPredictions.Side.Up, 100 * UNIT);
    }

    function test_Bet_RevertsUnknownMarket() public {
        vm.prank(alice);
        vm.expectRevert(OracleResolvedMarket.NoSuchMarket.selector);
        pm.bet(999, ParimutuelPredictions.Side.Up, 100 * UNIT);
    }

    // =========================================================================
    // Normal two-sided settlement + pro-rata payout (design §5.3)
    // =========================================================================

    function test_TwoSided_UpWins_ProRataSplit_Exact() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(bob, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 200 * UNIT);
        _resolveUp(id);

        // W=200, L=200, P=400, fee=0, distributable=400.
        assertEq(_claim(alice, id), 200 * UNIT, "alice 100/200 * 400 = 200");
        assertEq(_claim(bob, id), 200 * UNIT, "bob 100/200 * 400 = 200");
        assertEq(_claim(carol, id), 0, "loser gets 0");

        // No fee, even division => no residual, nothing to sweep, contract empty.
        assertEq(musd.balanceOf(address(pm)), 0, "no funds stranded");
        vm.expectRevert(ParimutuelPredictions.NothingToSweep.selector);
        pm.sweepDust(id);
    }

    function test_TwoSided_DownWins_ProRataSplit() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 300 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _resolveDown(id);

        // Down wins: W=100, L=300, P=400, distributable=400. carol 100/100*400=400.
        assertEq(_claim(carol, id), 400 * UNIT, "carol takes the whole pot");
        assertEq(_claim(alice, id), 0, "loser gets 0");
        assertEq(musd.balanceOf(address(pm)), 0, "conserved");
    }

    function test_Fee_TakenFromLosingPoolOnly() public {
        pm.setFeeBps(300); // 3%, snapshotted at creation
        uint256 id = _create();
        (,, uint16 fee) = pm.pools(id);
        assertEq(fee, 300, "fee frozen at creation");

        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _resolveUp(id);

        // W=100, L=100, P=200, fee=100*300/1e4=3, distributable=197.
        assertEq(_claim(alice, id), 197 * UNIT, "winner gets stake + loser-funded profit - fee");
        assertGt(197 * UNIT, 100 * UNIT, "winner never receives less than stake");
        assertEq(_claim(carol, id), 0, "loser gets 0");

        // Residual == fee, swept to treasury after the winner is out.
        pm.sweepDust(id);
        assertEq(musd.balanceOf(treasury), 3 * UNIT, "fee to treasury");
        assertEq(musd.balanceOf(address(pm)), 0, "fully drained");
    }

    function test_Payout_RoundsDown_NoOverpay_DustIsSweepable() public {
        uint256 id = _create(); // fee 0
        _bet(alice, id, ParimutuelPredictions.Side.Up, UNIT);
        _bet(bob, id, ParimutuelPredictions.Side.Up, UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Up, UNIT); // W = 3e18
        _bet(dave, id, ParimutuelPredictions.Side.Down, UNIT); // L = 1e18
        _resolveUp(id);

        // distributable = 4e18; each winner: 1e18*4e18/3e18 = floor(1.333..e18).
        uint256 each = uint256(4e18) * UNIT / uint256(3e18);
        assertEq(each, 1_333_333_333_333_333_333, "floored payout");
        assertEq(_claim(alice, id), each, "alice floored");
        assertEq(_claim(bob, id), each, "bob floored");
        assertEq(_claim(carol, id), each, "carol floored");
        assertEq(_claim(dave, id), 0, "loser 0");

        // Σpayouts <= distributable (no overpay, §14.2); dust = 1 wei left.
        uint256 paid = 3 * each;
        assertLe(paid, 4 * UNIT, "never pays more than distributable");
        assertEq(musd.balanceOf(address(pm)), 4 * UNIT - paid, "dust retained");
        assertEq(4 * UNIT - paid, 1, "dust is exactly 1 wei");

        pm.sweepDust(id);
        assertEq(musd.balanceOf(treasury), 1, "dust swept to treasury");
        assertEq(musd.balanceOf(address(pm)), 0, "no wei stranded");
    }

    function test_Bettor_OnBothSides_WinningStakePays_LosingForfeited() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(alice, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _bet(bob, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _resolveUp(id);

        // upPool=100, downPool=200, W=100, distributable=300. alice up 100/100*300=300.
        assertEq(_claim(alice, id), 300 * UNIT, "alice paid on up stake, down stake forfeited");
        assertEq(_claim(bob, id), 0, "bob loses");
        assertEq(musd.balanceOf(address(pm)), 0, "conserved (300 in, 300 out)");
    }

    // =========================================================================
    // VOID / refund matrix (design §5.5–§5.8)
    // =========================================================================

    function test_Void_OneSidedPool_RefundsEveryone() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(bob, id, ParimutuelPredictions.Side.Up, 50 * UNIT); // no DOWN side

        vm.warp(NOW + BET + SETTLE);
        pm.settle(id); // voids WITHOUT any oracle read
        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Void), "one-sided => VOID");

        assertEq(_claim(alice, id), 100 * UNIT, "alice refunded in full");
        assertEq(_claim(bob, id), 50 * UNIT, "bob refunded in full");
        assertEq(musd.balanceOf(address(pm)), 0, "all refunded, none stranded");
    }

    function test_Void_ZeroParticipants_CleanClose() public {
        uint256 id = _create(); // nobody bets
        vm.warp(NOW + BET + SETTLE);
        pm.settle(id);
        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Void), "empty => VOID");
        assertEq(_claim(alice, id), 0, "nothing to claim");
        assertEq(musd.balanceOf(address(pm)), 0, "no transfers");
    }

    function test_Void_ExactTie_RefundsBoth_FeeWaived() public {
        pm.setFeeBps(300); // even with a fee configured...
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _resolveAt(id, SPOT); // TWAP == strike => exact tie

        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Void), "tie => VOID");
        assertEq(_claim(alice, id), 100 * UNIT, "alice full refund");
        assertEq(_claim(carol, id), 100 * UNIT, "carol full refund");
        assertEq(musd.balanceOf(treasury), 0, "...the fee is WAIVED on a void");
        assertEq(musd.balanceOf(address(pm)), 0, "conserved");
    }

    function test_Void_NoValidTwap_GraceRefund() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        // No observations at all -> no valid TWAP.

        vm.warp(NOW + BET + SETTLE);
        vm.expectRevert(OracleResolvedMarket.AwaitGrace.selector);
        pm.settle(id); // grace not yet elapsed

        vm.warp(NOW + BET + SETTLE + 1 hours); // SETTLE_GRACE
        pm.settle(id);
        assertEq(uint256(_phase(id)), uint256(OracleResolvedMarket.Phase.Void), "unsettleable => VOID");

        assertEq(_claim(alice, id), 100 * UNIT, "alice refunded");
        assertEq(_claim(carol, id), 100 * UNIT, "carol refunded");
        assertEq(musd.balanceOf(address(pm)), 0, "conserved");
    }

    // =========================================================================
    // Claim guards (design §5.4, §11)
    // =========================================================================

    function test_Claim_RevertsBeforeResolved() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        vm.prank(alice);
        vm.expectRevert(ParimutuelPredictions.NotResolved.selector);
        pm.claim(id);
    }

    function test_Claim_IsIdempotent() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _resolveUp(id);

        assertEq(_claim(alice, id), 200 * UNIT, "first claim pays");
        assertEq(_claim(alice, id), 0, "second claim pays 0");
    }

    function test_Claim_LoserGetsZero() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _resolveUp(id);
        assertEq(_claim(carol, id), 0, "loser claims nothing");
    }

    function test_Claim_WorksWhenPaused() public {
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _resolveUp(id);

        pm.pause(); // incident halt — exits must still work
        assertEq(_claim(alice, id), 200 * UNIT, "winner can still claim while paused");
    }

    // =========================================================================
    // Admin surface (design §11) — minimal, capped, no fund path to user stakes
    // =========================================================================

    function test_Constructor_RevertsFeeAboveCap() public {
        vm.expectRevert(ParimutuelPredictions.FeeAboveCap.selector);
        new ParimutuelPredictions(IERC20(address(musd)), treasury, 301, address(this), 300);
    }

    function test_Constructor_RevertsZeroAddress() public {
        vm.expectRevert(ParimutuelPredictions.ZeroAddress.selector);
        new ParimutuelPredictions(IERC20(address(0)), treasury, 0, address(this), 300);
    }

    function test_SetFeeBps_CapAndOwnerEnforced() public {
        vm.expectRevert(ParimutuelPredictions.FeeAboveCap.selector);
        pm.setFeeBps(301);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pm.setFeeBps(100);
    }

    // --- maxStaleness: constructor param + governance setter (design §3) --------

    function test_Constructor_WiresMaxStaleness() public view {
        assertEq(pm.maxStaleness(), 300, "constructor arg is the live staleness window");
    }

    function test_Constructor_RejectsBadMaxStaleness() public {
        vm.expectRevert(OracleResolvedMarket.BadMaxStaleness.selector);
        new ParimutuelPredictions(IERC20(address(musd)), treasury, 0, address(this), 0);

        vm.expectRevert(OracleResolvedMarket.BadMaxStaleness.selector);
        new ParimutuelPredictions(IERC20(address(musd)), treasury, 0, address(this), 1 hours + 1);
    }

    function test_SetMaxStaleness_OwnerOnly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pm.setMaxStaleness(200);
    }

    function test_SetMaxStaleness_UpdatesValueAndEmits() public {
        vm.expectEmit(true, true, true, true, address(pm));
        emit OracleResolvedMarket.MaxStalenessSet(200);
        pm.setMaxStaleness(200);
        assertEq(pm.maxStaleness(), 200, "owner can tune the staleness window");
    }

    function test_SetMaxStaleness_RejectsOutOfBounds() public {
        vm.expectRevert(OracleResolvedMarket.BadMaxStaleness.selector);
        pm.setMaxStaleness(0); // 0 would reject every price

        vm.expectRevert(OracleResolvedMarket.BadMaxStaleness.selector);
        pm.setMaxStaleness(1 hours + 1); // above the cap

        pm.setMaxStaleness(1 hours); // exactly the cap is allowed
        assertEq(pm.maxStaleness(), 1 hours, "cap boundary accepted");
    }

    function test_SetTreasury_NonZeroAndOwnerEnforced() public {
        vm.expectRevert(ParimutuelPredictions.ZeroAddress.selector);
        pm.setTreasury(address(0));

        pm.setTreasury(dave);
        assertEq(pm.treasury(), dave, "treasury updated");
    }

    function test_SweepDust_OwnerOnly_AndBlockedWhileClaimsPending() public {
        pm.setFeeBps(300);
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, 100 * UNIT);
        _bet(carol, id, ParimutuelPredictions.Side.Down, 100 * UNIT);
        _resolveUp(id);

        // No admin fund path: cannot sweep before the winner has claimed.
        vm.expectRevert(ParimutuelPredictions.ClaimsPending.selector);
        pm.sweepDust(id);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pm.sweepDust(id);

        _claim(alice, id); // winner out
        pm.sweepDust(id); // now only the fee (3) leaves
        assertEq(musd.balanceOf(treasury), 3 * UNIT, "only the fee, never user funds");

        vm.expectRevert(ParimutuelPredictions.AlreadySwept.selector);
        pm.sweepDust(id);
    }

    // =========================================================================
    // Conservation invariant (design §14.1–§14.3) — nothing created/lost/stranded
    // =========================================================================

    /// A settled two-sided market: after every claim + the dust sweep, the
    /// contract holds exactly zero — all staked mUSD flowed to winners + treasury.
    function testFuzz_Conservation_TwoSidedSettled(uint256 a, uint256 b, uint256 c, uint256 fee, bool upWins) public {
        a = bound(a, UNIT, 1e24);
        b = bound(b, UNIT, 1e24);
        c = bound(c, UNIT, 1e24);
        fee = bound(fee, 0, pm.FEE_CAP());

        pm.setFeeBps(fee);
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, a);
        _bet(bob, id, ParimutuelPredictions.Side.Up, b);
        _bet(carol, id, ParimutuelPredictions.Side.Down, c);

        uint256 staked = a + b + c;
        assertEq(musd.balanceOf(address(pm)), staked, "contract holds all stakes pre-settle");

        if (upWins) _resolveUp(id);
        else _resolveDown(id);

        // Winners must never be paid more than the distributable pot (§14.2).
        uint256 distributable;
        {
            (uint256 up, uint256 down,) = pm.pools(id);
            uint256 w = upWins ? up : down;
            uint256 l = upWins ? down : up;
            distributable = (w + l) - (l * fee / 10_000);
        }

        uint256 paid = _claim(alice, id) + _claim(bob, id) + _claim(carol, id);
        assertLe(paid, distributable, "no overpay: sum of payouts <= distributable");

        // Everything that isn't a winner payout is the treasury's (fee + dust).
        // With a 0 fee and an even split the residual can be exactly 0 — then
        // there is nothing to sweep and the contract is already drained.
        uint256 residual = musd.balanceOf(address(pm));
        if (residual > 0) pm.sweepDust(id);
        assertEq(musd.balanceOf(address(pm)), 0, "conservation: contract fully drained");
        assertEq(paid + musd.balanceOf(treasury), staked, "payouts + fee + dust == staked");
    }

    /// A voided market (exact tie): every stake is refunded, fee waived, and the
    /// contract ends empty regardless of amounts.
    function testFuzz_Conservation_VoidRefundsAll(uint256 a, uint256 c, uint256 fee) public {
        a = bound(a, UNIT, 1e24);
        c = bound(c, UNIT, 1e24);
        fee = bound(fee, 0, pm.FEE_CAP());

        pm.setFeeBps(fee);
        uint256 id = _create();
        _bet(alice, id, ParimutuelPredictions.Side.Up, a);
        _bet(carol, id, ParimutuelPredictions.Side.Down, c);
        _resolveAt(id, SPOT); // tie => VOID

        assertEq(_claim(alice, id), a, "alice fully refunded");
        assertEq(_claim(carol, id), c, "carol fully refunded");
        assertEq(musd.balanceOf(treasury), 0, "fee waived on void");
        assertEq(musd.balanceOf(address(pm)), 0, "conservation: nothing stranded");
    }
}
