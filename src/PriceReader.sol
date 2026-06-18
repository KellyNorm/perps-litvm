// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {MainDemoConsumerBase} from "@redstone-finance/evm-connector/contracts/data-services/MainDemoConsumerBase.sol";

/**
 * @title PriceReader
 * @notice Minimal RedStone Pull-Model oracle consumer used to prove the
 *         on-demand signed-price flow works on LitVM (chain 4441) before any
 *         perps logic exists. It extends RedStone's `MainDemoConsumerBase`,
 *         which targets the free `redstone-main-demo` data service.
 * @dev    The signed RedStone payload is appended to the transaction calldata
 *         by the caller (off-chain, via `DataServiceWrapper`). The inherited
 *         `getOracleNumericValueFromTxMsg` verifies the signer(s) and the
 *         package timestamp, then returns the aggregated numeric value.
 *
 *         This contract is intentionally read-only: it holds no funds, has no
 *         admin functions, and no mutable state. It is a smoke test, not a
 *         money-path contract.
 *
 *         Returned values use RedStone's default numeric precision of 8
 *         decimals (e.g. a BTC price of 67000.0 is returned as 67000 * 1e8).
 */
contract PriceReader is MainDemoConsumerBase {
    /**
     * @notice Reads and verifies a single oracle price from the RedStone
     *         payload appended to the current transaction's calldata.
     * @dev    Reverts if signatures are invalid, the signer is not authorised,
     *         or the package timestamp is outside the allowed staleness window.
     *         Callers MUST append a fresh signed RedStone payload to the
     *         calldata; a plain call with no payload will revert.
     * @param  feedId The bytes32 data-feed identifier (e.g. bytes32("BTC")).
     * @return The verified price for `feedId`, scaled by 1e8.
     */
    function getPrice(bytes32 feedId) public view returns (uint256) {
        return getOracleNumericValueFromTxMsg(feedId);
    }
}
