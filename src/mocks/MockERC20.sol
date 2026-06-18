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
}
