// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LiquidityPool} from "../src/LiquidityPool.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/**
 * @title LiquidityPoolTest
 * @notice Unit tests for the GLP-style ERC-4626 LP vault (PR-2 scope):
 *         deposit/withdraw share math, the donation/inflation-attack
 *         mitigation, reentrancy protection, and zero/over-balance edges.
 *         No trader-P&L behavior is exercised — that arrives in a later PR.
 */
contract LiquidityPoolTest is Test {
    MockERC20 internal asset;
    LiquidityPool internal pool;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    // The vault adds this many decimals on top of the asset for its share math
    // (mirrors LiquidityPool._DECIMALS_OFFSET). With an 18-decimal asset the
    // first deposit therefore mints `assets * 10**OFFSET` shares.
    uint256 internal constant OFFSET = 6;

    function setUp() public {
        asset = new MockERC20("Mock USD", "mUSD");
        pool = new LiquidityPool(IERC20(address(asset)), "Perps LP", "pLP");
    }

    // --- helpers ---------------------------------------------------------

    /// @dev Mint `amount` collateral to `who`, approve, and deposit into the pool.
    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        asset.mint(who, amount);
        vm.startPrank(who);
        asset.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

    // --- share math ------------------------------------------------------

    function test_FirstDepositMintsExpectedShares() public {
        uint256 amount = 100e18;
        uint256 shares = _deposit(alice, amount);

        // Empty pool: shares == assets * 10**OFFSET (virtual-share initial rate).
        assertEq(shares, amount * 10 ** OFFSET, "unexpected first-deposit shares");
        assertEq(pool.balanceOf(alice), shares, "alice share balance");
        assertEq(pool.totalSupply(), shares, "total supply");
        assertEq(pool.totalAssets(), amount, "total assets");
        assertEq(asset.balanceOf(address(pool)), amount, "pool asset balance");
    }

    function test_LaterDepositAtNonUnitSharePriceMintsCorrectly() public {
        // Alice seeds the pool 1:1.
        uint256 aliceShares = _deposit(alice, 100e18);

        // Inflate the share price ~2x by donating assets without minting shares.
        asset.mint(address(this), 100e18);
        asset.transfer(address(pool), 100e18);
        assertEq(pool.totalAssets(), 200e18, "post-donation assets");

        // Bob deposits the same assets as Alice but at ~2x price -> ~half shares.
        uint256 bobShares = _deposit(bob, 100e18);

        assertApproxEqRel(bobShares, aliceShares / 2, 1e12, "bob shares not ~half");
        // And Bob can redeem ~his deposit back (no value created/destroyed for him).
        vm.prank(bob);
        uint256 bobOut = pool.redeem(bobShares, bob, bob);
        assertApproxEqRel(bobOut, 100e18, 1e12, "bob redeem mismatch");
    }

    // --- withdraw / redeem ----------------------------------------------

    function test_WithdrawAndRedeemReturnProportionalAssets() public {
        uint256 aliceShares = _deposit(alice, 100e18);
        uint256 bobShares = _deposit(bob, 50e18);

        // Alice redeems all her shares -> gets back her proportional assets (~100e18).
        vm.prank(alice);
        uint256 aliceOut = pool.redeem(aliceShares, alice, alice);
        assertApproxEqAbs(aliceOut, 100e18, 1, "alice proportional assets");
        assertEq(pool.balanceOf(alice), 0, "alice shares burned");

        // Bob withdraws an exact asset amount -> burns the right shares.
        uint256 bobBalBefore = asset.balanceOf(bob);
        vm.prank(bob);
        uint256 sharesBurned = pool.withdraw(25e18, bob, bob);
        assertEq(asset.balanceOf(bob) - bobBalBefore, 25e18, "bob received exact assets");
        assertEq(pool.balanceOf(bob), bobShares - sharesBurned, "bob remaining shares");
    }

    // --- donation / inflation attack ------------------------------------

    /// @dev Classic front-run: attacker mints 1 wei of shares then donates a
    ///      large amount to spike the share price, hoping a victim's deposit
    ///      rounds down to zero shares. OZ's virtual shares + decimals offset
    ///      must keep the victim's shares well above zero and redeemable.
    function test_DonationAttackDoesNotDiluteSmallDepositorToZero() public {
        // Attacker seeds the pool with the smallest possible deposit.
        _deposit(attacker, 1);

        // Attacker donates a huge amount directly to inflate the share price.
        uint256 donation = 1_000e18;
        asset.mint(attacker, donation);
        vm.prank(attacker);
        asset.transfer(address(pool), donation);

        // Victim makes a modest, realistic deposit.
        uint256 victimDeposit = 1e18;
        uint256 victimShares = _deposit(bob, victimDeposit);

        // Not diluted to zero: the victim holds real shares...
        assertGt(victimShares, 0, "victim diluted to zero shares");

        // ...and can redeem ~all of their deposit back (no meaningful theft).
        vm.prank(bob);
        uint256 victimOut = pool.redeem(victimShares, bob, bob);
        assertApproxEqRel(victimOut, victimDeposit, 1e16, "victim lost value to attacker"); // <=1%
    }

    // --- reentrancy ------------------------------------------------------

    function test_ReentrancyBlockedOnDeposit() public {
        ReentrantToken evil = new ReentrantToken();
        LiquidityPool evilPool = new LiquidityPool(IERC20(address(evil)), "Evil LP", "eLP");
        evil.configure(evilPool);

        evil.mint(attacker, 10e18);
        vm.startPrank(attacker);
        evil.approve(address(evilPool), type(uint256).max);
        evil.setMode(ReentrantToken.Mode.Deposit);
        // The reentrant call back into the pool must trip the guard.
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evilPool.deposit(1e18, attacker);
        vm.stopPrank();
    }

    function test_ReentrancyBlockedOnWithdraw() public {
        ReentrantToken evil = new ReentrantToken();
        LiquidityPool evilPool = new LiquidityPool(IERC20(address(evil)), "Evil LP", "eLP");
        evil.configure(evilPool);

        evil.mint(attacker, 10e18);
        vm.startPrank(attacker);
        evil.approve(address(evilPool), type(uint256).max);
        // First deposit cleanly (no reentry mode set yet).
        uint256 shares = evilPool.deposit(1e18, attacker);

        // Now arm the reentry on the outbound transfer during withdraw.
        evil.setMode(ReentrantToken.Mode.Withdraw);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evilPool.redeem(shares, attacker, attacker);
        vm.stopPrank();
    }

    // --- edge cases ------------------------------------------------------

    function test_RevertWhen_ZeroAmountWithdraw() public {
        _deposit(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(LiquidityPool.ZeroAmount.selector);
        pool.withdraw(0, alice, alice);
    }

    function test_RevertWhen_ZeroAmountDeposit() public {
        vm.prank(alice);
        vm.expectRevert(LiquidityPool.ZeroAmount.selector);
        pool.deposit(0, alice);
    }

    function test_RevertWhen_OverBalanceWithdraw() public {
        _deposit(alice, 100e18);
        // Alice owns 100e18 of assets; asking for more must revert via ERC4626 max check.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, 100e18 + 1, 100e18));
        pool.withdraw(100e18 + 1, alice, alice);
    }
}

/**
 * @dev Malicious ERC20 used only to prove the pool's reentrancy guard works.
 *      On the transfer that the vault performs during deposit (`transferFrom`)
 *      or withdraw (`transfer`), it attempts to re-enter the vault. The guarded
 *      vault must revert, and the reentrant token's transfer never completes.
 */
contract ReentrantToken is ERC20 {
    enum Mode {
        None,
        Deposit,
        Withdraw
    }

    LiquidityPool internal pool;
    Mode internal mode;

    constructor() ERC20("Reentrant", "RE") {}

    function configure(LiquidityPool pool_) external {
        pool = pool_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Re-enter the vault via `deposit`. The vault's `nonReentrant` guard
    ///      lives in `_deposit`, which is reached before any token transfer or
    ///      balance check, so this trips the guard without the token needing any
    ///      balance/approval — isolating the reentrancy behavior under test.
    function _reenter() internal {
        pool.deposit(1, address(this));
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.Deposit) _reenter();
        return super.transferFrom(from, to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == Mode.Withdraw) _reenter();
        return super.transfer(to, amount);
    }
}
