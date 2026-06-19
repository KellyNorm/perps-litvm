// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice A minimal, freely-mintable ERC20 used ONLY for tests and on the
 *         LitVM testnet (chain 4441) as a stand-in collateral asset.
 * @dev    TEST-ONLY. This token has an unrestricted public `mint`, which makes
 *         it worthless and unsafe for any real deployment. It MUST NEVER be
 *         deployed to mainnet or used as collateral with real value. It exists
 *         solely so the {LiquidityPool} vault can be exercised end-to-end.
 *
 *         Deployed as "Mock USD" (mUSD) with 18 decimals.
 */
contract MockERC20 is ERC20 {
    /// @notice Tokens minted per {faucet} claim (18 decimals).
    uint256 public constant FAUCET_AMOUNT = 10_000e18;
    /// @notice Minimum delay between {faucet} claims for a single address.
    uint256 public constant FAUCET_COOLDOWN = 8 hours;
    /// @notice Last {faucet} claim timestamp per address (0 = never claimed).
    mapping(address => uint256) public lastFaucetClaim;

    /// @notice Reverts a {faucet} call made before the per-address cooldown lapses.
    /// @param  nextClaimTime Unix time at which the caller may next claim.
    error FaucetCooldownActive(uint256 nextClaimTime);

    /// @notice Emitted on a successful {faucet} claim.
    /// @param  claimer Address that claimed.
    /// @param  amount  Amount minted (always {FAUCET_AMOUNT}).
    event FaucetClaimed(address indexed claimer, uint256 amount);

    /// @param name_   Human-readable token name (e.g. "Mock USD").
    /// @param symbol_ Token symbol (e.g. "mUSD").
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /**
     * @notice Mint `amount` tokens to `to`. Unrestricted by design — test-only.
     * @param  to     Recipient of the freshly minted tokens.
     * @param  amount Amount to mint, in token base units (18 decimals).
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Burn `amount` tokens from the caller's balance.
     * @param  amount Amount to burn, in token base units (18 decimals).
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /**
     * @notice Self-mint {FAUCET_AMOUNT} to the caller, bounded by a per-address
     *         cooldown. The bounded path the testnet UI calls; the unrestricted
     *         {mint} remains available for tests, scripts, and the deployer.
     * @dev    First claim (lastFaucetClaim == 0) is allowed immediately.
     */
    function faucet() external {
        uint256 last = lastFaucetClaim[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldownActive(last + FAUCET_COOLDOWN);
        }
        lastFaucetClaim[msg.sender] = block.timestamp; // effect before mint
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }

    /**
     * @notice Unix time at which `who` may next call {faucet} (0 = claimable now).
     * @dev    For the UI countdown.
     * @param  who Address to query.
     */
    function faucetAvailableAt(address who) external view returns (uint256) {
        uint256 last = lastFaucetClaim[who];
        if (last == 0) return 0;
        uint256 next = last + FAUCET_COOLDOWN;
        return block.timestamp >= next ? 0 : next;
    }
}
