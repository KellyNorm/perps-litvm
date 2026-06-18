// Funding smoke test for the PR-4b perps stack on LitVM (chain 4441).
//
// One key, two-sided book: opens an unequal BTC long + short (long-heavy) from
// the deployer, holds for real time so peer-to-peer funding accrues, then closes
// both — the long should PAY funding, the short should RECEIVE it, and the pool
// keeps the rounding dust (long paid >= short received). Because one wallet holds
// both sides, its funding nets to ~0 (it pays itself), minus the dust + borrow fees.
//
// Usage: node scripts/smoke-perps.mjs
//   (reads POSITION_MANAGER_ADDRESS, MUSD_ADDRESS, LITVM_RPC_URL, DEPLOYER_PRIVATE_KEY)

import { ethers } from "ethers";
import { WrapperBuilder } from "@redstone-finance/evm-connector";

const DEMO_SIGNER = "0x0C39486f770B26F5527BBBf942726537986Cd7eb";
const DATA_SERVICE_ID = process.env.REDSTONE_DATA_SERVICE || "redstone-main-demo";
const FEED = "BTC";

// long notional 4x the short -> 60% skew -> funding pinned at the ~3%/day cap.
const LONG_COLL = ethers.utils.parseUnits("200", 18);
const SHORT_COLL = ethers.utils.parseUnits("50", 18);
const LEVERAGE = 2;
const HOLD_SECONDS = 60;

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

const PM_ABI = [
  "function openPosition(bytes32 market, bool isLong, uint256 collateral, uint256 leverage)",
  "function closePosition(bytes32 market, bool isLong)",
  "event PositionOpened(address indexed owner, bytes32 indexed market, bool isLong, uint256 collateral, uint256 sizeUsd, uint256 entryPrice)",
  "event PositionClosed(address indexed owner, bytes32 indexed market, bool isLong, uint256 exitPrice, bool profit, uint256 pnl, uint256 borrowFee, int256 funding, uint256 payout)",
];

const wrap = (c) =>
  WrapperBuilder.wrap(c).usingDataService({
    dataServiceId: DATA_SERVICE_ID,
    dataPackagesIds: [FEED],
    uniqueSignersCount: 1,
    authorizedSigners: [DEMO_SIGNER],
  });

function findEvent(contract, receipt, name) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.address.toLowerCase()) continue;
    let parsed;
    try { parsed = contract.interface.parseLog(log); } catch { continue; }
    if (parsed.name === name) return parsed.args;
  }
  throw new Error(`event ${name} not found in tx ${receipt.transactionHash}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f18 = (v) => ethers.utils.formatUnits(v, 18);
const f8 = (v) => ethers.utils.formatUnits(v, 8);

async function main() {
  const pm = process.env.POSITION_MANAGER_ADDRESS;
  const musd = process.env.MUSD_ADDRESS;
  const rpc = process.env.LITVM_RPC_URL;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  for (const [k, v] of Object.entries({ POSITION_MANAGER_ADDRESS: pm, MUSD_ADDRESS: musd, LITVM_RPC_URL: rpc, DEPLOYER_PRIVATE_KEY: pk }))
    if (!v) throw new Error(`missing env ${k}`);

  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const trader = new ethers.Wallet(pk, provider);
  const market = ethers.utils.formatBytes32String(FEED);
  const token = new ethers.Contract(musd, ERC20_ABI, trader);
  const mgr = new ethers.Contract(pm, PM_ABI, trader);

  console.log(`trader:          ${trader.address}`);
  console.log(`PositionManager: ${pm}\n`);

  const need = LONG_COLL.add(SHORT_COLL);
  console.log("minting + approving collateral...");
  await (await token.mint(trader.address, need)).wait();
  await (await token.approve(pm, need)).wait();
  const balStart = await token.balanceOf(trader.address);

  console.log(`opening LONG  ${f18(LONG_COLL)} mUSD @ ${LEVERAGE}x ...`);
  const oL = findEvent(mgr, await (await wrap(mgr).openPosition(market, true, LONG_COLL, LEVERAGE)).wait(), "PositionOpened");
  console.log(`  long size:  ${f18(oL.sizeUsd)} USD  entry ${f8(oL.entryPrice)}`);
  console.log(`opening SHORT ${f18(SHORT_COLL)} mUSD @ ${LEVERAGE}x ...`);
  const oS = findEvent(mgr, await (await wrap(mgr).openPosition(market, false, SHORT_COLL, LEVERAGE)).wait(), "PositionOpened");
  console.log(`  short size: ${f18(oS.sizeUsd)} USD  entry ${f8(oS.entryPrice)}\n`);

  console.log(`book is long-heavy (long ${f18(oL.sizeUsd)} vs short ${f18(oS.sizeUsd)} USD) -> longs pay`);
  console.log(`holding ${HOLD_SECONDS}s for funding to accrue...\n`);
  await sleep(HOLD_SECONDS * 1000);

  console.log("closing LONG...");
  const cL = findEvent(mgr, await (await wrap(mgr).closePosition(market, true)).wait(), "PositionClosed");
  console.log("closing SHORT...");
  const cS = findEvent(mgr, await (await wrap(mgr).closePosition(market, false)).wait(), "PositionClosed");
  const balEnd = await token.balanceOf(trader.address);

  const paid = cL.funding;            // expect > 0
  const received = cS.funding.mul(-1); // cS.funding expect < 0 -> received > 0
  const dust = paid.sub(received);

  console.log("\n--- funding result ---------------------------------------");
  console.log(`  long  borrowFee ${f18(cL.borrowFee)}  funding ${f18(cL.funding)} mUSD  ${cL.funding.gt(0) ? "(paid)" : "(received)"}`);
  console.log(`  short borrowFee ${f18(cS.borrowFee)}  funding ${f18(cS.funding)} mUSD  ${cS.funding.lt(0) ? "(received)" : "(paid)"}`);
  console.log(`  long paid ${f18(paid)}  vs  short received ${f18(received)}`);
  console.log(`  pool dust (paid - received): ${f18(dust)} mUSD  ${dust.gte(0) ? "OK (>= 0, pool favored)" : "!! NEGATIVE"}`);
  console.log(`  net trader balance delta: ${f18(balEnd.sub(balStart))} mUSD`);
  console.log("");
  console.log(cL.funding.gt(0) && cS.funding.lt(0) && dust.gte(0) ? "funding smoke PASSED." : "funding smoke FAILED — check signs/dust.");
}

main().catch((e) => { console.error(e); process.exit(1); });