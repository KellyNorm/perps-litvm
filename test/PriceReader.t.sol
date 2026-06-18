// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// PriceReader oracle smoke test (PR-1).
//
// This test proves the RedStone Pull-Model read flow works end-to-end without
// any network access, using RedStone's deterministic mock signers.
//
// FFI SETUP (required):
//  * Run with FFI enabled. It is turned on in `foundry.toml` (`ffi = true`);
//    `forge test` picks it up automatically. To run a single test explicitly:
//      forge test --ffi --match-contract PriceReaderTest
//  * The test shells out to `test/ffi/redstone-mock-payload.js` (Node) to build
//    a mock signed RedStone payload. That script needs the npm deps installed
//    (`npm install`) — it imports `@redstone-finance/evm-connector`.
//  * `node` must be on PATH.
//
// How the read works: RedStone consumers read the signed price from the *tail*
// of the transaction calldata. So we build calldata = abi.encodeWithSelector(
// getPrice, feedId) ++ redstonePayload, then `staticcall` the contract with it.
//
// Signer/timestamp handling: the mock payload is signed by mock signer index 0
// (0xf39F...266), which `PriceReaderHarness` authorises with a single-signer
// threshold (matching MainDemoConsumerBase). We `vm.warp` the block time to the
// package timestamp so the inherited staleness check passes.

import {Test} from "forge-std/Test.sol";
import {PriceReader} from "../src/PriceReader.sol";
import {AuthorisedMockSignersBase} from "@redstone-finance/evm-connector/contracts/mocks/AuthorisedMockSignersBase.sol";

/**
 * @dev Test-only subclass that swaps `MainDemoConsumerBase`'s real demo signer
 *      for RedStone's mock signers, so offline mock payloads verify. The
 *      single-signer threshold and the rest of the verification logic
 *      (signature recovery, timestamp validation, aggregation) are exercised
 *      exactly as in production.
 */
contract PriceReaderHarness is PriceReader, AuthorisedMockSignersBase {
    function getAuthorisedSignerIndex(address signerAddress) public view virtual override returns (uint8) {
        return getAuthorisedMockSignerIndex(signerAddress);
    }
}

contract PriceReaderTest is Test {
    PriceReaderHarness internal reader;

    // Mock package timestamp (ms). Block time is warped to ts/1000 so the
    // package is "fresh" against the inherited staleness window.
    uint256 internal constant TIMESTAMP_MS = 1_700_000_000_000;

    // RedStone default numeric precision is 8 decimals.
    uint256 internal constant ONE = 1e8;

    uint256 internal constant BTC_PRICE = 67_000;
    uint256 internal constant ETH_PRICE = 3_500;

    function setUp() public {
        reader = new PriceReaderHarness();
        vm.warp(TIMESTAMP_MS / 1000);
    }

    /// @dev Builds the mock signed payload via the Node ffi helper.
    function _redstonePayload() internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "test/ffi/redstone-mock-payload.js";
        cmd[2] = vm.toString(TIMESTAMP_MS);
        cmd[3] = "BTC:67000";
        cmd[4] = "ETH:3500";
        return vm.ffi(cmd);
    }

    /// @dev Reads a feed by appending the RedStone payload to getPrice calldata.
    function _readPrice(bytes32 feedId, bytes memory payload) internal view returns (uint256) {
        bytes memory callData = abi.encodePacked(abi.encodeWithSelector(PriceReader.getPrice.selector, feedId), payload);
        (bool ok, bytes memory ret) = address(reader).staticcall(callData);
        require(ok, "getPrice call failed");
        return abi.decode(ret, (uint256));
    }

    function test_getPrice_BTC() public {
        bytes memory payload = _redstonePayload();
        uint256 price = _readPrice(bytes32("BTC"), payload);
        assertEq(price, BTC_PRICE * ONE, "unexpected BTC price");
    }

    function test_getPrice_ETH() public {
        bytes memory payload = _redstonePayload();
        uint256 price = _readPrice(bytes32("ETH"), payload);
        assertEq(price, ETH_PRICE * ONE, "unexpected ETH price");
    }

    /// @dev A plain call with no appended RedStone payload must revert.
    function test_getPrice_revertsWithoutPayload() public {
        vm.expectRevert();
        reader.getPrice(bytes32("BTC"));
    }
}
