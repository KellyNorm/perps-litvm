// Two-step deferred-execution smoke test for the perps stack on LitVM (chain 4441).
//
// PR-6c removed the direct openPosition/closePosition path. The ONLY trader
// entries now are requestOpen / requestClose — plain calls with NO oracle payload
// that queue a request and escrow funds — followed by executeRequest, the keeper
// step that appends a FRESH signed RedStone payload to fill the request at a
// post-request price (the front-running / MEV protection). A single wallet
// (DEPLOYER_PRIVATE_KEY) plays both trader and keeper here.
//
// Flow: open a BTC long via request -> wait past MIN_EXECUTION_DELAY -> keeper
// executes -> assert the position is live with sizeUsd == COLLATERAL*LEVERAGE ->
// close it via request -> wait -> keeper executes -> assert the position is gone.
//
// Usage:
//   set -a; source .env; set +a; node scripts/smoke-perps.mjs
//   (reads POSITION_MANAGER_ADDRESS, LIQUIDITY_POOL_ADDRESS, MUSD_ADDRESS,
//    LITVM_RPC_URL, DEPLOYER_PRIVATE_KEY)

import { ethers } from "ethers";
import { WrapperBuilder } from "@redstone-finance/evm-connector";
import { requestDataPackages, getDataPackagesTimestamp } from "@redstone-finance/sdk";

const DEMO_SIGNER = "0x0C39486f770B26F5527BBBf942726537986Cd7eb";
const DATA_SERVICE_ID = process.env.REDSTONE_DATA_SERVICE || "redstone-main-demo";
const FEED = "BTC";

// Trade parameters (match the PositionManager constants).
const COLLATERAL = ethers.utils.parseUnits("1000", 18); // 1000e18
const LEVERAGE = 5;
const EXECUTION_FEE = ethers.utils.parseUnits("0.5", 18); // 0.5e18
const MIN_EXECUTION_DELAY = 3; // seconds; contract floor before a fill is allowed

// Slippage bounds (1e8 price scale). Wide enough to never miss the demo mark.
//   Open long  fills when price <= acceptable -> use a huge ceiling.
//   Close long fills when price >= acceptable -> use a tiny floor.
const ACCEPTABLE_OPEN = ethers.utils.parseUnits("1000000", 8); // 1,000,000 USD ceiling
const ACCEPTABLE_CLOSE = ethers.utils.parseUnits("1", 8); // 1 USD floor

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];

const PM_ABI = [
  // two-step trader entries (plain calls, NO payload)
  "function requestOpen(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 acceptablePrice) returns (uint256)",
  "function requestClose(bytes32 market, bool isLong, uint256 acceptablePrice) returns (uint256)",
  // keeper step (call WITH a fresh RedStone payload)
  "function executeRequest(uint256 requestId)",
  // views
  "function nextRequestId() view returns (uint256)",
  "function getPositionKey(address owner, bytes32 market, bool isLong) view returns (bytes32)",
  "function positions(bytes32 key) view returns (address owner, bytes32 market, bool isLong, uint256 collateral, uint256 sizeUsd, uint256 entryPrice, uint256 entryCumBorrowRate, int256 entryCumFunding)",
  // events
  "event OpenRequested(uint256 indexed requestId, address indexed owner, bytes32 indexed market, bool isLong, uint256 collateral, uint256 leverage, uint256 acceptablePrice, uint256 executionFee)",
  "event CloseRequested(uint256 indexed requestId, address indexed owner, bytes32 indexed market, bool isLong, uint256 acceptablePrice, uint256 executionFee)",
  "event RequestExecuted(uint256 indexed requestId, address indexed keeper, uint256 executionPrice)",
  "event RequestCancelled(uint256 indexed requestId, address indexed owner, bool slippage)",
  "event PositionOpened(address indexed owner, bytes32 indexed market, bool isLong, uint256 collateral, uint256 sizeUsd, uint256 entryPrice)",
  "event PositionClosed(address indexed owner, bytes32 indexed market, bool isLong, uint256 exitPrice, bool profit, uint256 pnl, uint256 borrowFee, int256 funding, uint256 payout)",
];

// Wrap a contract so the signed RedStone payload is injected into the call's
// calldata. Used ONLY for executeRequest (the keeper step) — never for the plain
// requestOpen / requestClose calls.
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
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed.name === name) return parsed.args;
  }
  throw new Error(`event ${name} not found in tx ${receipt.transactionHash}`);
}

// Best-effort fetch of the demo payload's package timestamp (seconds), for the
// freshness diagnostic on a revert.
async function payloadTimestampSec() {
  const pkgs = await requestDataPackages({
    dataServiceId: DATA_SERVICE_ID,
    dataPackagesIds: [FEED],
    uniqueSignersCount: 1,
    authorizedSigners: [DEMO_SIGNER],
  });
  return Math.floor(getDataPackagesTimestamp(pkgs) / 1000);
}

// Pull a usable revert string out of an ethers v5 error, decoding the contract's
// custom errors (TooEarlyToExecute, PriceBeforeRequest, ...) when the data is present.
function extractErrorData(err) {
  const direct = [err?.data, err?.error?.data, err?.error?.error?.data];
  for (const c of direct) if (typeof c === "string" && c.startsWith("0x")) return c;
  const body = err?.error?.body ?? err?.body;
  if (typeof body === "string") {
    try {
      const d = JSON.parse(body)?.error?.data;
      if (typeof d === "string" && d.startsWith("0x")) return d;
    } catch {}
  }
  return null;
}

function revertReason(iface, err) {
  const data = extractErrorData(err);
  if (data && data.length >= 10) {
    try {
      const p = iface.parseError(data);
      return `${p.name}(${p.args.map((a) => a.toString()).join(", ")})`;
    } catch {}
  }
  return err?.reason || err?.error?.message || err?.shortMessage || err?.message || String(err);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f18 = (v) => ethers.utils.formatUnits(v, 18);
const f8 = (v) => ethers.utils.formatUnits(v, 8);

async function main() {
  const pm = process.env.POSITION_MANAGER_ADDRESS;
  const poolAddr = process.env.LIQUIDITY_POOL_ADDRESS;
  const musd = process.env.MUSD_ADDRESS;
  const rpc = process.env.LITVM_RPC_URL;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  for (const [k, v] of Object.entries({
    POSITION_MANAGER_ADDRESS: pm,
    LIQUIDITY_POOL_ADDRESS: poolAddr,
    MUSD_ADDRESS: musd,
    LITVM_RPC_URL: rpc,
    DEPLOYER_PRIVATE_KEY: pk,
  })) {
    if (!v) throw new Error(`missing env ${k}`);
  }

  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk, provider); // plays BOTH trader and keeper

  // Poll the demo feed until a payload exists that the contract's freshness guard
  // will accept for a request queued at `requestTs`. The redstone-main-demo feed
  // updates slowly, so the payload available right after MIN_EXECUTION_DELAY can
  // still be stamped BEFORE requestTs + MIN_EXECUTION_DELAY (-> PriceBeforeRequest).
  async function waitForFreshPayload(requestTs) {
    const floor = requestTs + MIN_EXECUTION_DELAY;
    const TIMEOUT_MS = 180_000;
    const POLL_MS = 4_000;
    const start = Date.now();
    for (;;) {
      let pkgTs = 0;
      try {
        pkgTs = await payloadTimestampSec();
      } catch {}
      const blockTs = (await provider.getBlock("latest")).timestamp;
      console.log(`  waiting for fresh payload: pkg ts ${pkgTs}, block ts ${blockTs}, need >= ${floor}`);
      // Need BOTH a package stamped >= floor (else PriceBeforeRequest) AND the
      // chain clock >= floor (else TooEarlyToExecute).
      if (pkgTs >= floor && blockTs >= floor) return;
      if (Date.now() - start > TIMEOUT_MS) {
        throw new Error(
          `timed out waiting for a demo payload stamped >= ${floor} (last pkg ts ${pkgTs}); the redstone-main-demo feed updates slowly — rerun or raise TIMEOUT_MS`,
        );
      }
      await sleep(POLL_MS);
    }
  }
  const market = ethers.utils.formatBytes32String(FEED);
  const token = new ethers.Contract(musd, ERC20_ABI, wallet);
  const mgr = new ethers.Contract(pm, PM_ABI, wallet);

  console.log(`wallet (trader+keeper): ${wallet.address}`);
  console.log(`PositionManager:        ${pm}`);
  console.log(`LiquidityPool:          ${poolAddr}`);
  console.log(`mUSD:                   ${musd}\n`);

  // --- 1. Setup: enough mUSD held + PositionManager approved -----------------
  // Open escrows COLLATERAL + EXECUTION_FEE; close escrows EXECUTION_FEE. The
  // keeper fee returns to this same wallet on each fill, but cover both legs up
  // front: COLLATERAL + 2 * EXECUTION_FEE.
  const need = COLLATERAL.add(EXECUTION_FEE.mul(2));
  const have = await token.balanceOf(wallet.address);
  if (have.lt(need)) {
    console.log(`minting ${f18(need.sub(have))} mUSD (have ${f18(have)}, need ${f18(need)})...`);
    await (await token.mint(wallet.address, need.sub(have))).wait();
  }
  const allowance = await token.allowance(wallet.address, pm);
  if (allowance.lt(need)) {
    console.log(`approving PositionManager for ${f18(need)} mUSD...`);
    await (await token.approve(pm, need)).wait();
  }

  const key = await mgr.getPositionKey(wallet.address, market, true);
  const poolBefore = await token.balanceOf(poolAddr);
  console.log(`pool balance before: ${f18(poolBefore)} mUSD\n`);

  // --- 2. OPEN request (plain call, NO payload) ------------------------------
  console.log(`requestOpen BTC long  ${f18(COLLATERAL)} mUSD @ ${LEVERAGE}x  (ceiling ${f8(ACCEPTABLE_OPEN)})...`);
  const openReqRcpt = await (await mgr.requestOpen(market, true, COLLATERAL, LEVERAGE, ACCEPTABLE_OPEN)).wait();
  const openReqId = findEvent(mgr, openReqRcpt, "OpenRequested").requestId;
  const openReqTs = (await provider.getBlock(openReqRcpt.blockNumber)).timestamp;
  console.log(`  queued requestId ${openReqId.toString()}  at requestTs ${openReqTs}\n`);

  // --- 3. Wait past MIN_EXECUTION_DELAY so block.timestamp AND a fresh payload
  //        both clear requestTs + MIN_EXECUTION_DELAY.
  console.log(`waiting for a fresh payload (floor = requestTs + ${MIN_EXECUTION_DELAY} = ${openReqTs + MIN_EXECUTION_DELAY})...`);
  await waitForFreshPayload(openReqTs);

  // --- 4. OPEN execute (keeper, WITH a fresh signed payload) -----------------
  console.log(`executeRequest(${openReqId.toString()}) as keeper (fresh BTC payload)...`);
  const keeperBeforeOpen = await token.balanceOf(wallet.address);
  await guarded(mgr, openReqTs, async () => (await wrap(mgr).executeRequest(openReqId)).wait());
  const keeperAfterOpen = await token.balanceOf(wallet.address);
  const keeperFeeOpen = keeperAfterOpen.sub(keeperBeforeOpen); // expect ~ +EXECUTION_FEE (no payout on open)

  const pos = await mgr.positions(key);
  console.log(`  position live: entry ${f8(pos.entryPrice)}  size ${f18(pos.sizeUsd)} USD  collateral ${f18(pos.collateral)} mUSD`);
  console.log(`  keeper fee from open fill: ${f18(keeperFeeOpen)} mUSD`);
  const expectedSize = COLLATERAL.mul(LEVERAGE);
  if (!pos.sizeUsd.eq(expectedSize)) {
    throw new Error(`sizeUsd ${f18(pos.sizeUsd)} != COLLATERAL*LEVERAGE ${f18(expectedSize)}`);
  }
  console.log(`  OK sizeUsd == COLLATERAL * LEVERAGE (${f18(expectedSize)} USD)\n`);

  // --- 5. CLOSE request (plain call, NO payload) -----------------------------
  console.log(`requestClose BTC long  (floor ${f8(ACCEPTABLE_CLOSE)})...`);
  const closeReqRcpt = await (await mgr.requestClose(market, true, ACCEPTABLE_CLOSE)).wait();
  const closeReqId = findEvent(mgr, closeReqRcpt, "CloseRequested").requestId;
  const closeReqTs = (await provider.getBlock(closeReqRcpt.blockNumber)).timestamp;
  console.log(`  queued requestId ${closeReqId.toString()}  at requestTs ${closeReqTs}\n`);

  // --- 6. Wait again ---------------------------------------------------------
  console.log(`waiting for a fresh payload (floor = requestTs + ${MIN_EXECUTION_DELAY} = ${closeReqTs + MIN_EXECUTION_DELAY})...`);
  await waitForFreshPayload(closeReqTs);

  // --- 7. CLOSE execute (keeper, WITH a fresh signed payload) ----------------
  console.log(`executeRequest(${closeReqId.toString()}) as keeper (fresh BTC payload)...`);
  const keeperBeforeClose = await token.balanceOf(wallet.address);
  const closeRcpt = await guarded(mgr, closeReqTs, async () => (await wrap(mgr).executeRequest(closeReqId)).wait());
  const keeperAfterClose = await token.balanceOf(wallet.address);
  // Close fill returns keeper fee + trader payout to this one wallet.
  const closeInflow = keeperAfterClose.sub(keeperBeforeClose);
  const closed = findEvent(mgr, closeRcpt, "PositionClosed");
  const traderPayout = closed.payout;
  console.log(`  exit ${f8(closed.exitPrice)}  pnl ${f18(closed.pnl)} ${closed.profit ? "(profit)" : "(loss)"}  borrowFee ${f18(closed.borrowFee)}  funding ${f18(closed.funding)}  payout ${f18(traderPayout)} mUSD`);

  const posAfter = await mgr.positions(key);
  if (!posAfter.sizeUsd.eq(0)) {
    throw new Error(`position not cleared: sizeUsd ${f18(posAfter.sizeUsd)}`);
  }
  console.log(`  OK position cleared (sizeUsd == 0)\n`);

  // --- 8. Summary ------------------------------------------------------------
  const poolAfter = await token.balanceOf(poolAddr);
  const keeperEarned = keeperFeeOpen.add(closeInflow.sub(traderPayout)); // fee leg of each fill
  console.log("--- summary ----------------------------------------------");
  console.log(`  keeper fee (open fill):       ${f18(keeperFeeOpen)} mUSD`);
  console.log(`  keeper fee (close fill):      ${f18(closeInflow.sub(traderPayout))} mUSD`);
  console.log(`  keeper mUSD earned (2 fills): ${f18(keeperEarned)} mUSD  (~ ${f18(EXECUTION_FEE.mul(2))} expected)`);
  console.log(`  trader payout (close):        ${f18(traderPayout)} mUSD`);
  console.log(`  pool balance before:          ${f18(poolBefore)} mUSD`);
  console.log(`  pool balance after:           ${f18(poolAfter)} mUSD`);
  console.log(`  pool delta:                   ${f18(poolAfter.sub(poolBefore))} mUSD`);
  console.log("");
  console.log("two-step smoke PASSED.");
}

// Run an executeRequest and, on revert, print the reason plus the request floor,
// the current block.timestamp, and the live payload timestamp — which makes a
// freshness (PriceBeforeRequest / TooEarlyToExecute) or slippage miss obvious.
async function guarded(mgr, requestTs, fn) {
  try {
    return await fn();
  } catch (err) {
    const reason = revertReason(mgr.interface, err);
    let nowTs = "?";
    let payloadTs = "?";
    try {
      nowTs = (await mgr.provider.getBlock("latest")).timestamp;
    } catch {}
    try {
      payloadTs = await payloadTimestampSec();
    } catch {}
    console.error("\n!! executeRequest reverted:");
    console.error(`   reason:           ${reason}`);
    console.error(`   requestTs:        ${requestTs}  (floor = requestTs + ${MIN_EXECUTION_DELAY} = ${requestTs + MIN_EXECUTION_DELAY})`);
    console.error(`   block.timestamp:  ${nowTs}`);
    console.error(`   payload.timestamp:${payloadTs}`);
    throw err;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
