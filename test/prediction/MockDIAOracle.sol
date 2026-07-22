// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDIAOracle} from "../../src/prediction/IDIAOracle.sol";

/**
 * @title MockDIAOracle
 * @notice Test-only stand-in for DIA's native LitVM oracle so the
 *         {DIAAggregatorV3Adapter} can be exercised without touching the live feed.
 *         Prices are keyed by `"SYMBOL/USD"` string exactly like the real oracle,
 *         and can be forced into any (value, timestamp) state — including the
 *         zero / stale states the adapter must pass through for
 *         {SafeAggregatorReader} to reject downstream.
 * @dev    Lives under `test/` — never compiled into the deployable `src` tree. Can
 *         also simulate a hostile/dead feed via {setRevert}, so the adapter's revert
 *         path (which staticcall's up to SafeAggregatorReader as a safe (false,0)) is
 *         testable.
 */
contract MockDIAOracle is IDIAOracle {
    struct Point {
        uint256 value; // 18-decimal USD price
        uint256 timestamp; // Unix seconds (UTC)
        bool set; // whether this key has ever been written
    }

    mapping(bytes32 => Point) private _points;

    /// When true, {getValue} reverts like a dead / unreachable feed for ANY key.
    bool public reverting;

    /// @notice Force / update the stored point for a `"SYMBOL/USD"` key.
    function setValue(string memory key, uint256 value, uint256 timestamp) external {
        _points[keccak256(bytes(key))] = Point({value: value, timestamp: timestamp, set: true});
    }

    /// @notice Toggle a hard revert on every {getValue} call (dead-feed simulation).
    function setRevert(bool on) external {
        reverting = on;
    }

    // --- IDIAOracle ---

    function getValue(string memory key) external view returns (uint128 value, uint128 timestamp) {
        if (reverting) revert("MockDIAOracle: feed down");
        Point storage p = _points[keccak256(bytes(key))];
        // An unknown key returns (0, 0) — mirrors DIA's behavior for an asset that
        // has never been published (e.g. TRX/HYPE/ZCASH before finalization).
        // Values are stored as uint256 for test ergonomics but returned as uint128
        // to match the real feed's ABI; every price/timestamp a test injects fits.
        return (uint128(p.value), uint128(p.timestamp));
    }
}
