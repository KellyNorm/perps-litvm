// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "./IAggregatorV3.sol";
import {IDIAOracle} from "./IDIAOracle.sol";

/**
 * @title DIAAggregatorV3Adapter
 * @notice Presents ONE DIA `"SYMBOL/USD"` key as a Chainlink-{IAggregatorV3} feed,
 *         so the proven prediction market (which reads exclusively through
 *         {IAggregatorV3} / {SafeAggregatorReader}) can consume DIA's native oracle
 *         WITHOUT any change to market logic. Deploy one adapter per asset; point the
 *         factory's per-asset feed (addAsset / setAssetFeed) at it.
 *
 * @dev    Mapping (design §2, "DIA-swap path"):
 *           - DIA `value` (uint128, 18-dec) -> `answer` (int256, decimals()==18)
 *           - DIA `timestamp`               -> `updatedAt` AND `startedAt` (staleness anchor)
 *           - `roundId` / `answeredInRound` -> fixed {ROUND} so the completeness guard
 *             (`answeredInRound < roundId`) always holds; DIA has no round concept,
 *             so freshness is carried entirely by `updatedAt`.
 *
 *         FAIL-SAFE, NOT FAIL-LOUD: the adapter never manufactures a usable price from
 *         a bad DIA reading. A zero value stays `answer == 0`; a stale / future ts stays
 *         `updatedAt` as reported; an unknown symbol comes back `(0, 0)`; a dead feed
 *         reverts. Each of those is exactly what {SafeAggregatorReader}'s guards reject
 *         downstream — so the guards, not the adapter, remain the single decision point.
 *
 *         Self-contained under `src/prediction/`: imports NOTHING from the perps money
 *         path, consistent with the rest of the prediction stack.
 */
contract DIAAggregatorV3Adapter is IAggregatorV3 {
    /// Constructed with a zero oracle address — the adapter could never read a price.
    error InvalidOracle();
    /// Constructed with an empty symbol — there is no DIA key to query.
    error InvalidSymbol();

    /// DIA publishes every USD price scaled by 18 decimals.
    uint8 public constant DECIMALS = 18;

    /// DIA exposes no round identifier; a fixed non-decreasing pair keeps the
    /// completeness guard (`answeredInRound < roundId`) satisfied on every read.
    uint80 internal constant ROUND = 1;

    /// The DIA oracle this adapter reads from.
    IDIAOracle public immutable oracle;

    /// The `"SYMBOL/USD"` key queried on every read (e.g. `"BTC/USD"`).
    string public symbol;

    /**
     * @param _oracle The DIA oracle (live LitVM address in prod).
     * @param _symbol The `"SYMBOL/USD"` key this adapter is dedicated to.
     */
    constructor(IDIAOracle _oracle, string memory _symbol) {
        if (address(_oracle) == address(0)) revert InvalidOracle();
        if (bytes(_symbol).length == 0) revert InvalidSymbol();
        oracle = _oracle;
        symbol = _symbol;
    }

    /// @inheritdoc IAggregatorV3
    function decimals() external pure returns (uint8) {
        return DECIMALS;
    }

    /**
     * @inheritdoc IAggregatorV3
     * @dev Reads DIA's `getValue(symbol)` and re-shapes it. Values pass through
     *      untouched so {SafeAggregatorReader} stays the sole judge of health:
     *        - `value == 0`            -> `answer == 0`   (reader rejects: answer <= 0)
     *        - stale / future `ts`     -> `updatedAt`     (reader rejects: staleness/future)
     *      A DIA `value` that would not fit a positive int256 is clamped to 0 (an
     *      unusable, reader-rejected reading) rather than wrapping to a negative. DIA
     *      packs `value` as uint128, whose max (~3.4e38) sits far below int256's, so the
     *      clamp can no longer fire in practice — it stays as pure defense-in-depth.
     *      A reverting DIA feed reverts here, which the reader's staticcall catches.
     */
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint256 value, uint256 ts) = oracle.getValue(symbol);

        answer = value > uint256(type(int256).max) ? int256(0) : int256(value);
        return (ROUND, answer, ts, ts, ROUND);
    }
}
