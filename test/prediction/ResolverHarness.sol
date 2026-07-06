// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "../../src/prediction/IAggregatorV3.sol";
import {OracleResolvedMarket} from "../../src/prediction/OracleResolvedMarket.sol";

/**
 * @title ResolverHarness
 * @notice Test-only concrete subclass exposing {OracleResolvedMarket}'s internal
 *         `_createMarket`. `observe` / `settle` are already public on the base
 *         (permissionless by design), so the harness only opens the factory hook
 *         the same way the future `ParimutuelPredictions` will call it.
 */
contract ResolverHarness is OracleResolvedMarket {
    function createMarket(
        uint16 assetId,
        IAggregatorV3 feed,
        uint64 betWindow,
        uint64 settleWindow,
        uint256 offsetBps,
        bool offsetUp
    ) external returns (uint256) {
        return _createMarket(assetId, feed, betWindow, settleWindow, offsetBps, offsetUp);
    }

    // Expose constants so tests read against the contract's source of truth.
    function maxStaleness() external pure returns (uint256) {
        return MAX_STALENESS;
    }

    function minSamples() external pure returns (uint256) {
        return MIN_SAMPLES;
    }

    function minCoverageBps() external pure returns (uint256) {
        return MIN_COVERAGE_BPS;
    }

    function minObsSpacing() external pure returns (uint256) {
        return MIN_OBS_SPACING;
    }

    function settleGrace() external pure returns (uint256) {
        return SETTLE_GRACE;
    }
}
