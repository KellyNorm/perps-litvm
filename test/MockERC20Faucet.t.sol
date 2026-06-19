// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

// MockERC20 cooldown faucet test (PR-7).
//
// Covers the bounded self-mint path used by the testnet UI. The unrestricted
// public `mint(address,uint256)` is intentionally left untouched and is not
// exercised here.
contract MockERC20FaucetTest is Test {
    MockERC20 internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event FaucetClaimed(address indexed claimer, uint256 amount);

    function setUp() public {
        token = new MockERC20("Mock USD", "mUSD");
        // Start at a non-zero timestamp so cooldown arithmetic is meaningful.
        vm.warp(1_000_000);
    }

    /// 1. faucet() mints exactly FAUCET_AMOUNT and records lastFaucetClaim.
    function test_FaucetMintsAmountAndRecordsClaim() public {
        vm.expectEmit(true, false, false, true, address(token));
        emit FaucetClaimed(alice, token.FAUCET_AMOUNT());

        vm.prank(alice);
        token.faucet();

        assertEq(token.balanceOf(alice), token.FAUCET_AMOUNT(), "minted amount");
        assertEq(token.lastFaucetClaim(alice), block.timestamp, "claim recorded");
    }

    /// 2. A second faucet() before the cooldown reverts FaucetCooldownActive(next).
    function test_FaucetRevertsDuringCooldown() public {
        vm.prank(alice);
        token.faucet();

        uint256 next = block.timestamp + token.FAUCET_COOLDOWN();

        // Advance partway, still inside the window.
        vm.warp(block.timestamp + token.FAUCET_COOLDOWN() - 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.FaucetCooldownActive.selector, next));
        token.faucet();
    }

    /// 3. After warping past the cooldown, faucet() succeeds and mints again.
    function test_FaucetSucceedsAfterCooldown() public {
        vm.prank(alice);
        token.faucet();

        vm.warp(block.timestamp + token.FAUCET_COOLDOWN());

        vm.prank(alice);
        token.faucet();

        assertEq(token.balanceOf(alice), 2 * token.FAUCET_AMOUNT(), "two claims minted");
        assertEq(token.lastFaucetClaim(alice), block.timestamp, "second claim recorded");
    }

    /// 4. faucetAvailableAt: 0 before any claim; the correct next time during
    ///    cooldown; 0 again after it lapses.
    function test_FaucetAvailableAtTracksCooldown() public {
        assertEq(token.faucetAvailableAt(alice), 0, "claimable before any claim");

        vm.prank(alice);
        token.faucet();

        uint256 next = block.timestamp + token.FAUCET_COOLDOWN();
        assertEq(token.faucetAvailableAt(alice), next, "next time during cooldown");

        // One second before the boundary: still in cooldown.
        vm.warp(next - 1);
        assertEq(token.faucetAvailableAt(alice), next, "still in cooldown");

        // Exactly at the boundary: claimable again.
        vm.warp(next);
        assertEq(token.faucetAvailableAt(alice), 0, "claimable after cooldown lapses");
    }

    /// 5. Two different addresses have independent cooldowns.
    function test_FaucetCooldownsAreIndependentPerAddress() public {
        vm.prank(alice);
        token.faucet();

        // Bob has never claimed, so he can claim immediately.
        assertEq(token.faucetAvailableAt(bob), 0, "bob claimable");

        vm.prank(bob);
        token.faucet();

        assertEq(token.balanceOf(alice), token.FAUCET_AMOUNT(), "alice balance");
        assertEq(token.balanceOf(bob), token.FAUCET_AMOUNT(), "bob balance");

        // Alice is still on cooldown while bob has just claimed.
        uint256 aliceNext = token.lastFaucetClaim(alice) + token.FAUCET_COOLDOWN();
        assertEq(token.faucetAvailableAt(alice), aliceNext, "alice still cooling down");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockERC20.FaucetCooldownActive.selector, aliceNext));
        token.faucet();
    }
}
