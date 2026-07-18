// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAggregatorV3} from "./IAggregatorV3.sol";

/**
 * @title SafeAggregatorReader
 * @notice The single safe price-read the whole prediction stack uses (design §3).
 *         Every fund-affecting price MUST come through {readFreshPrice}. It NEVER
 *         reverts and NEVER propagates a bad price: a healthy, fresh, complete read
 *         is the ONLY path that yields `ok == true`; every failure mode returns
 *         `(false, 0)` so the caller decides — block (at market creation) or void +
 *         refund (at settlement). A bad price can never be silently coerced to a
 *         usable value.
 * @dev    Uses a low-level `staticcall` + returndata-length check so a reverting OR
 *         malformed (short/garbage returndata) feed is caught before any ABI decode
 *         — a decode of attacker-controlled bytes never runs on the price path. This
 *         mirrors the perps circuit breaker's abstain pattern, but is an INDEPENDENT
 *         copy: this file imports nothing from the perps money path.
 */
library SafeAggregatorReader {
    /// @dev `latestRoundData` returns five 32-byte words. Anything shorter is garbage.
    uint256 internal constant RETURN_DATA_LEN = 160;

    /**
     * @notice Read + fully validate the feed's latest price.
     * @param feed          The AggregatorV3-shaped feed (a DIA adapter in prod).
     * @param maxStaleness  Max age, in seconds, of `updatedAt` vs `block.timestamp`.
     *                      The market passes its governance-set `maxStaleness`
     *                      (300s default, above the DIA heartbeat floor — see
     *                      docs/dia-cadence-diagnostic.md).
     * @return ok     True IFF the read succeeded AND every guard held. When false,
     *                `price` is meaningless (always 0) and MUST NOT be used.
     * @return price  The raw `answer` at the feed's native decimals when `ok`; else 0.
     *                No normalization happens here — the caller interprets it against
     *                the per-asset `feedDecimals`, so precision is preserved exactly.
     */
    function readFreshPrice(IAggregatorV3 feed, uint256 maxStaleness) internal view returns (bool ok, int256 price) {
        // Wrapped read: a revert (success == false) or short/garbage returndata
        // (< 160 bytes) fails safe here, BEFORE any decode of feed-controlled bytes.
        (bool success, bytes memory data) =
            address(feed).staticcall(abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector));
        if (!success || data.length < RETURN_DATA_LEN) return (false, 0);

        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            abi.decode(data, (uint80, int256, uint256, uint256, uint80));

        // Value guards — ANY failure yields (false, 0); never a usable price.
        if (answer <= 0) return (false, 0); // zero or negative price
        if (updatedAt == 0) return (false, 0); // never-updated feed
        if (updatedAt > block.timestamp) return (false, 0); // future-stamped
        if (block.timestamp - updatedAt > maxStaleness) return (false, 0); // stale
        if (answeredInRound < roundId) return (false, 0); // incomplete / carried-over round

        return (true, answer);
    }
}
