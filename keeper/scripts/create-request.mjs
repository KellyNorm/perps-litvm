// Request-only helper — queues ONE request and STOPS, leaving it for the keeper
// to fill. This is the smoke's "request" step with the "execute" step removed, so
// the keeper is demonstrably the party that calls executeRequest.
//
// Plays the TRADER with DEPLOYER_PRIVATE_KEY (mints/approves mUSD as needed) and
// sends a plain request* call — NO RedStone payload, exactly what a trader signs.
// Prints the assigned requestId, then exits. Run the keeper separately to watch
// it discover and fill (or rest) this id.
//
// Usage (from project root, with .env loaded):
//   set -a; source .env; set +a
//   node keeper/scripts/create-request.mjs <action> [feed]
// actions:
//   open          market open  long  (feed default BTC)  -> keeper fills
//   close         market close long                       -> keeper fills, earns fee
//   trigger-open  resting trigger-open long (far above)   -> keeper leaves resting
//   trigger-close resting trigger-close long (not met)    -> keeper leaves resting
//
// Env: LITVM_RPC_URL, DEPLOYER_PRIVATE_KEY, POSITION_MANAGER_ADDRESS,
//      MUSD_ADDRESS, REDSTONE_DATA_SERVICE.

import { ethers } from "ethers";
import { PM_ABI, ERC20_ABI } from "../lib/abi.mjs";
import { fetchMark, feedOf } from "../lib/redstone.mjs";

const COLLATERAL = ethers.utils.parseUnits("1000", 18);
const LEVERAGE = 5;

const action = (process.argv[2] || "open").toLowerCase();
const FEED = (process.argv[3] || "BTC").toUpperCase();
const f8 = (v) => ethers.utils.formatUnits(v, 8);
const pct = (P, n) => P.mul(n).div(100);

async function main() {
  const rpc = process.env.LITVM_RPC_URL;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const pmAddr = process.env.POSITION_MANAGER_ADDRESS;
  const musdAddr = process.env.MUSD_ADDRESS;
  for (const [k, v] of Object.entries({
    LITVM_RPC_URL: rpc,
    DEPLOYER_PRIVATE_KEY: pk,
    POSITION_MANAGER_ADDRESS: pmAddr,
    MUSD_ADDRESS: musdAddr,
  })) {
    if (!v) throw new Error(`missing env ${k}`);
  }

  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const trader = new ethers.Wallet(pk, provider);
  const pm = new ethers.Contract(pmAddr, PM_ABI, trader);
  const musd = new ethers.Contract(musdAddr, ERC20_ABI, trader);
  const market = ethers.utils.formatBytes32String(FEED);

  console.log(`trader: ${trader.address}`);

  // Ensure the trader can post collateral + the execution fee (opens escrow both;
  // closes escrow only the fee — minting a buffer covers either).
  const need = COLLATERAL.mul(2);
  if ((await musd.balanceOf(trader.address)).lt(need)) {
    console.log(`minting ${ethers.utils.formatUnits(need, 18)} mUSD to trader…`);
    await (await musd.mint(trader.address, need)).wait();
  }
  if ((await musd.allowance(trader.address, pmAddr)).lt(need)) {
    console.log("approving PositionManager for mUSD…");
    await (await musd.approve(pmAddr, ethers.constants.MaxUint256)).wait();
  }

  const { price1e8: P } = await fetchMark(process.env.REDSTONE_DATA_SERVICE || "redstone-main-demo", FEED);
  console.log(`live ${FEED} mark P = ${f8(P)}`);

  const ceiling = pct(P, 105); // generous BUY cap so a market open fills
  const floor = pct(P, 95); // generous SELL floor so a market close fills
  const rest = pct(P, 150); // far above mark: a long trigger here stays not-met

  const id = await pm.nextRequestId();
  let tx, desc;
  if (action === "open") {
    desc = `requestOpen ${FEED} long ${ethers.utils.formatUnits(COLLATERAL, 18)} mUSD @ ${LEVERAGE}x (ceiling ${f8(ceiling)})`;
    tx = await pm.requestOpen(market, true, COLLATERAL, LEVERAGE, ceiling);
  } else if (action === "close") {
    desc = `requestClose ${FEED} long (floor ${f8(floor)})`;
    tx = await pm.requestClose(market, true, floor);
  } else if (action === "trigger-open" || action === "trigger") {
    desc = `requestTriggerOpen ${FEED} long (acceptable ${f8(rest)}, trigger ${f8(rest)}, above=true) — RESTS`;
    tx = await pm.requestTriggerOpen(market, true, COLLATERAL, LEVERAGE, rest, rest, true);
  } else if (action === "trigger-close") {
    desc = `requestTriggerClose ${FEED} long (acceptable ${f8(floor)}, trigger ${f8(rest)}, above=true) — RESTS (price < trigger)`;
    tx = await pm.requestTriggerClose(market, true, floor, rest, true);
  } else {
    throw new Error(`unknown action "${action}" — use open|close|trigger-open|trigger-close`);
  }

  console.log(`${desc}…`);
  const rcpt = await tx.wait();
  const blockTs = (await provider.getBlock(rcpt.blockNumber)).timestamp;

  console.log("\n=== request queued — NOT executed (left for the keeper) ===");
  console.log(`  requestId:    ${id.toString()}`);
  console.log(`  action:       ${action}   market: ${feedOf(market)}`);
  console.log(`  requestTs:    ${blockTs}`);
  console.log(`  tx:           ${rcpt.transactionHash}`);
  console.log("Now run the keeper (node keeper/keeper.mjs) and watch it discover this id.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
