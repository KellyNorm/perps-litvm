// Live BTC price read from a deployed PriceReader on LitVM (chain 4441).
//
// Uses RedStone's pull model: `WrapperBuilder.usingDataService` (from
// @redstone-finance/evm-connector, which is built on @redstone-finance/sdk's
// DataServiceWrapper / requestDataPackages) fetches a freshly signed price
// package from the `redstone-main-demo` data service and appends it to the
// `getPrice` call's calldata, where the on-chain contract verifies it.
//
// Usage:
//   node scripts/read-price.mjs <PRICE_READER_ADDRESS> [RPC_URL]
//
// or via env (CLI args take precedence):
//   PRICE_READER_ADDRESS=0x... LITVM_RPC_URL=https://... node scripts/read-price.mjs
//
// Requires `npm install` (ethers v5 + @redstone-finance/* are in package.json).

import { ethers } from "ethers";
import { WrapperBuilder } from "@redstone-finance/evm-connector";

// redstone-main-demo single authorised signer (matches MainDemoConsumerBase).
const DEMO_SIGNER = "0x0C39486f770B26F5527BBBf942726537986Cd7eb";
const DATA_SERVICE_ID = process.env.REDSTONE_DATA_SERVICE || "redstone-main-demo";
const FEED = "BTC";

// Minimal ABI — only the read method we call.
const PRICE_READER_ABI = ["function getPrice(bytes32 feedId) view returns (uint256)"];

async function main() {
  const contractAddress = process.argv[2] || process.env.PRICE_READER_ADDRESS;
  const rpcUrl = process.argv[3] || process.env.LITVM_RPC_URL;

  if (!contractAddress) {
    throw new Error(
      "missing PriceReader address: pass as arg 1 or set PRICE_READER_ADDRESS"
    );
  }
  if (!rpcUrl) {
    throw new Error("missing RPC url: pass as arg 2 or set LITVM_RPC_URL");
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const reader = new ethers.Contract(contractAddress, PRICE_READER_ABI, provider);

  // Wrap so the signed RedStone payload is injected into the call's calldata.
  const wrapped = WrapperBuilder.wrap(reader).usingDataService({
    dataServiceId: DATA_SERVICE_ID,
    dataPackagesIds: [FEED],
    uniqueSignersCount: 1,
    authorizedSigners: [DEMO_SIGNER],
  });

  const feedId = ethers.utils.formatBytes32String(FEED);
  const raw = await wrapped.getPrice(feedId);

  // RedStone numeric values use 8 decimals.
  const price = ethers.utils.formatUnits(raw, 8);
  console.log(`${FEED} price (raw, 8dp): ${raw.toString()}`);
  console.log(`${FEED} price: ${price}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
