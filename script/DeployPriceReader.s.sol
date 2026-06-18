// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import {Script, console} from "forge-std/Script.sol";
import {PriceReader} from "../src/PriceReader.sol";

/**
 * @title DeployPriceReader
 * @notice Deploys the PriceReader oracle smoke-test contract to LitVM LiteForge
 *         (chain 4441). The RPC URL is supplied on the command line via
 *         `--rpc-url`; the deployer key is read from the environment.
 * @dev    Set `DEPLOYER_PRIVATE_KEY` in the environment (testnet key only — see
 *         the gitignored .env). Run with:
 *
 *           forge script script/DeployPriceReader.s.sol:DeployPriceReader \
 *             --rpc-url "$LITVM_RPC_URL" --broadcast
 */
contract DeployPriceReader is Script {
    function run() external returns (PriceReader priceReader) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        priceReader = new PriceReader();
        vm.stopBroadcast();

        console.log("PriceReader deployed at:", address(priceReader));
        console.log("chain id:", block.chainid);
    }
}
