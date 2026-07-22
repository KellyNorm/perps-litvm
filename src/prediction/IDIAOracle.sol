// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IDIAOracle
 * @notice The native surface of DIA's custom LitVM oracle (live on testnet at
 *         0x49c39225Dbc64700936bb641d1E81113DbadD2DF). It is NOT AggregatorV3-shaped:
 *         it keys prices by a `"SYMBOL/USD"` string and returns a plain
 *         `(uint128 value, uint128 timestamp)` tuple. {DIAAggregatorV3Adapter}
 *         wraps one of these keys per asset and re-exposes it as {IAggregatorV3},
 *         so the prediction stack keeps reading through a single oracle abstraction
 *         and the proven market contracts stay untouched.
 * @dev    Deliberately self-contained under `src/prediction/`: like the rest of the
 *         prediction stack it imports NOTHING from the perps money path.
 */
interface IDIAOracle {
    /**
     * @notice Latest price for a `"SYMBOL/USD"` key (e.g. `"BTC/USD"`).
     * @param key        The asset pair, formatted `"SYMBOL/USD"`.
     * @return value     USD price scaled by 18 decimals (confirmed empirically against the
     *                   live LitVM feed — a BTC read returned 62865495019032875630592, i.e.
     *                   ~$62,865 x 1e18). `0` signals no/void value. Packed as `uint128`
     *                   on-chain: 18-dec USD prices never approach `type(uint128).max`.
     * @return timestamp Unix seconds (UTC) of the last update — the staleness anchor.
     */
    function getValue(string memory key) external view returns (uint128 value, uint128 timestamp);
}
