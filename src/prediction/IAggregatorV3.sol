// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IAggregatorV3
 * @notice Minimal Chainlink-AggregatorV3 surface — the oracle abstraction the
 *         prediction market reads through. DIA's LitVM adapters implement this
 *         exact shape, so the prediction stack is oracle-agnostic: swap DIA for
 *         anything AggregatorV3-shaped without touching market logic.
 * @dev    Deliberately self-contained and namespaced under `src/prediction/`. The
 *         prediction stack imports NOTHING from the perps money path
 *         (PositionManager / RedStone / MainDemoConsumerBase). The perps contracts
 *         carry their own private copy of this interface for the circuit breaker;
 *         the two are code-disjoint on purpose (design §1, §3).
 */
interface IAggregatorV3 {
    /// @notice Fixed-point decimals the feed scales `answer` by (e.g. 8).
    function decimals() external view returns (uint8);

    /**
     * @notice Latest round for this feed.
     * @return roundId        Monotonic round identifier.
     * @return answer         Price, scaled by {decimals}. Can be <= 0 on a bad feed.
     * @return startedAt      Round start timestamp.
     * @return updatedAt      Round update timestamp — the STALENESS anchor.
     * @return answeredInRound Round in which `answer` was computed; `< roundId`
     *         means the answer is carried over / incomplete.
     */
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
