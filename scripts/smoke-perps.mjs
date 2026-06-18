// End-to-end smoke test for the PR-3 perps stack on LitVM (chain 4441).
//
// Runs one full trade against the deployed contracts:
//   1. mint + approve mUSD collateral to the PositionManager,
//   2. open a BTC long (100 mUSD collateral, 2x leverage) with a fresh signed
//      RedStone price injected into the calldata, and print the entry price,
//   3. close it with a fresh payload, and print the exit price, realized P&L,
//      and the trader's payout.
//
// Uses RedStone's pull model exactly like scripts/read-price.mjs:
// `WrapperBuilder.usingDataService` (DataServiceWrapper, from
// @redstone-finance/evm-connector) fetches a freshly signed price package from
// the `redstone-main-demo` data service and appends it to the open/close call's
// calldata, where the on-chain MainDemoConsumerBase verifies signer + timestamp.
//
// Usage:
//   node scripts/smoke-perps.mjs <POSITION_MANAGER_ADDRESS> <MUSD_ADDRESS> [RPC_URL]
//
// or via env (CLI args take precedence):
//   POSITION_MANAGER_ADDRESS=0x... MUSD_ADDRESS=0x... LITVM_RPC_URL=https://... \
//   DEPLOYER_PRIVATE_KEY=0x... node scripts/smoke-perps.mjs
//
// The trader key is read from DEPLOYER_PRIVATE_KEY (testnet key only).
// Requires `npm install` (ethers v5 + @redstone-finance/* are in package.json).

import { ethers } from "ethers";
import { WrapperBuilder } from "@redstone-finance/evm-connector";

// redstone-main-demo single authorised signer (matches MainDemoConsumerBase).
const DEMO_SIGNER = "0x0C39486f770B26F5527BBBf942726537986Cd7eb";
const DATA_SERVICE_ID = process.env.REDSTONE_DATA_SERVICE || "redstone-main-demo";
const FEED = "BTC";

// Trade parameters.
const COLLATERAL = ethers.utils.parseUnits("100", 18); // 100 mUSD (18 dp)
const LEVERAGE = 2;
const IS_LONG = true;

// Minimal ABIs — only the methods / events we touch.
const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

const POSITION_MANAGER_ABI = [
  "function openPosition(bytes32 market, bool isLong, uint256 collateral, uint256 leverage)",
  "function closePosition(bytes32 market, bool isLong)",
  "event PositionOpened(address indexed owner, bytes32 indexed market, bool isLong, uint256 collateral, uint256 sizeUsd, uint256 entryPrice)",
  "event PositionClosed(address indexed owner, bytes32 indexed market, bool isLong, uint256 exitPrice, bool profit, uint256 pnl, uint256 payout)",
];

// Wrap a signer-connected contract so each call carries a fresh RedStone payload.
function wrapWithPayload(contract) {
  return WrapperBuilder.wrap(contract).usingDataService({
    dataServiceId: DATA_SERVICE_ID,
    dataPackagesIds: [FEED],
    uniqueSignersCount: 1,
    authorizedSigners: [DEMO_SIGNER],
  });
}

// Find the first decoded log of `name` emitted by `contract` in a receipt.
function findEvent(contract, receipt, name) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.address.toLowerCase()) continue;
    let parsed;
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed.name === name) return parsed.args;
  }
  throw new Error(`event ${name} not found in tx ${receipt.transactionHash}`);
}

async function main() {
  const pmAddress = process.argv[2] || process.env.POSITION_MANAGER_ADDRESS;
  const musdAddress = process.argv[3] || process.env.MUSD_ADDRESS;
  const rpcUrl = process.argv[4] || process.env.LITVM_RPC_URL;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

  if (!pmAddress) {
    throw new Error(
      "missing PositionManager address: pass as arg 1 or set POSITION_MANAGER_ADDRESS"
    );
  }
  if (!musdAddress) {
    throw new Error("missing mUSD address: pass as arg 2 or set MUSD_ADDRESS");
  }
  if (!rpcUrl) {
    throw new Error("missing RPC url: pass as arg 3 or set LITVM_RPC_URL");
  }
  if (!privateKey) {
    throw new Error("missing trader key: set DEPLOYER_PRIVATE_KEY");
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const trader = new ethers.Wallet(privateKey, provider);
  const market = ethers.utils.formatBytes32String(FEED);

  const musd = new ethers.Contract(musdAddress, ERC20_ABI, trader);
  const pm = new ethers.Contract(pmAddress, POSITION_MANAGER_ABI, trader);

  console.log(`trader:          ${trader.address}`);
  console.log(`PositionManager: ${pmAddress}`);
  console.log(`mUSD:            ${musdAddress}`);
  console.log(`market:          ${FEED}  collateral: 100 mUSD  leverage: ${LEVERAGE}x  ${IS_LONG ? "LONG" : "SHORT"}`);
  console.log("");

  // 1. Mint + approve collateral to the PositionManager (no payload needed).
  console.log("minting + approving collateral...");
  await (await musd.mint(trader.address, COLLATERAL)).wait();
  await (await musd.approve(pmAddress, COLLATERAL)).wait();

  const balBefore = await musd.balanceOf(trader.address);

  // 2. Open the position with a fresh signed price injected into calldata.
  console.log("opening position...");
  const pmWithPayload = wrapWithPayload(pm);
  const openReceipt = await (
    await pmWithPayload.openPosition(market, IS_LONG, COLLATERAL, LEVERAGE)
  ).wait();
  const opened = findEvent(pm, openReceipt, "PositionOpened");
  console.log(`  entry price: ${ethers.utils.formatUnits(opened.entryPrice, 8)} USD`);
  console.log(`  size:        ${ethers.utils.formatUnits(opened.sizeUsd, 18)} USD`);

  // 3. Close it with a fresh payload (new wrapper -> new package fetch).
  console.log("closing position...");
  const closeReceipt = await (
    await wrapWithPayload(pm).closePosition(market, IS_LONG)
  ).wait();
  const closed = findEvent(pm, closeReceipt, "PositionClosed");

  const balAfter = await musd.balanceOf(trader.address);
  const pnl = ethers.utils.formatUnits(closed.pnl, 18);
  const sign = closed.profit ? "+" : "-";

  console.log(`  exit price:  ${ethers.utils.formatUnits(closed.exitPrice, 8)} USD`);
  console.log(`  realized P&L: ${sign}${pnl} mUSD (${closed.profit ? "profit" : "loss"})`);
  console.log(`  payout:      ${ethers.utils.formatUnits(closed.payout, 18)} mUSD`);
  console.log(`  trader balance delta (close - open window): ${ethers.utils.formatUnits(balAfter.sub(balBefore), 18)} mUSD`);
  console.log("");
  console.log("smoke test complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
