// FULL-SURFACE two-step smoke test for the perps stack on LitVM (chain 4441).
//
// Exercises the deployed contracts end-to-end with ONE wallet
// (DEPLOYER_PRIVATE_KEY) playing trader, LP, AND keeper:
//
//   SETUP   mint mUSD -> approve pool+PM -> pool.deposit (seed LP) -> read live BTC mark P
//   1 FAUCET    (PR-7)  faucet() mints 10k; a second call hits the cooldown revert
//   2 REGISTRY  (PR-8)  BTC and ETH are supported markets
//   3 OPEN      long via requestOpen -> executeRequest         (size == collateral*lev)
//   4 INCREASE  via requestIncrease -> executeRequest          (size/collateral/entry blend)
//   5 DECREASE  50% via requestDecrease -> executeRequest      (size/collateral halve)
//   6 TRIGGER-CLOSE (TP already met) closes the rest; keeper earns the execution fee
//   7 TRIGGER-OPEN  (resting, not met) — execute REVERTS, the order stays active
//   8 OPEN-SHORT    open a SHORT with the DOWN buffer (acceptable = P*0.93)
//   9 CLOSE-SHORT   close it with the UP buffer (acceptable = P*1.07)
//
// Steps 1-6 only ever exercised LONGs, so they never tested the long/short-aware
// half of the slippage gate. Steps 8/9 do, using the SAME acceptablePrice convention
// the frontend uses (up = isOpenSide === isLong):
//   - open short  -> DOWN buffer (below P): engine must require fill >= acceptable.
//   - close short -> UP buffer   (above P): engine must require fill <= acceptable.
// DISCRIMINATOR: if the short OPEN fills with the DOWN buffer, the engine is
// long/short-aware and the frontend matrix is correct. If it slippage-CANCELS, the
// engine groups by open/close only and the frontend's short buffer is on the wrong
// side — the step FAILS and says so rather than widening the buffer to hide it.
//
// Every two-step action is: request (plain call, NO payload) -> waitForFreshPayload ->
// executeRequest WITH a fresh signed RedStone payload (the keeper step).
//
// SKIPPED: on-chain liquidation (PR-5). There is no way to force an adverse price on
// the live redstone-main-demo feed, so liquidation is covered by the PR-5 forge tests.
//
// Prices on-chain are 1e8-scaled; mUSD is 18 decimals. All triggers and slippage bounds
// are parameterized off the live mark P so the smoke works at any price. The bounds are
// deliberately GENEROUS (buys ~ P*1.05, sells ~ P*0.95) so actions fill despite live-feed
// drift during the waits — slippage-bound correctness is already forge-tested; here the
// actions just need to execute.
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

// Contract constants (must match PositionManager / MockERC20).
const EXECUTION_FEE = ethers.utils.parseUnits("0.5", 18); // 0.5e18
const MIN_EXECUTION_DELAY = 3; // seconds; contract floor before a fill is allowed
const CANCEL_DELAY = 180; // seconds; owner-reclaim window for a resting request
const FAUCET_AMOUNT = ethers.utils.parseUnits("10000", 18); // 10_000e18

// Setup amounts.
const MINT_AMOUNT = ethers.utils.parseUnits("2000000", 18); // 2_000_000e18 to the wallet
const LP_SEED = ethers.utils.parseUnits("1000000", 18); // 1_000_000e18 LP liquidity

// Trade sizing (asset units, 18 dp).
const OPEN_COLLATERAL = ethers.utils.parseUnits("1000", 18); // 1000e18
const OPEN_LEVERAGE = 5;
const ADD_COLLATERAL = ethers.utils.parseUnits("500", 18); // 500e18
const ADD_LEVERAGE = 5;
const DECREASE_BPS = 5000; // 50%

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function faucet()",
  "function faucetAvailableAt(address who) view returns (uint256)",
  "function lastFaucetClaim(address) view returns (uint256)",
  "error FaucetCooldownActive(uint256 nextClaimTime)",
];

const POOL_ABI = [
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function balanceOf(address owner) view returns (uint256)",
];

const PM_ABI = [
  // two-step trader entries (plain calls, NO payload)
  "function requestOpen(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 acceptablePrice) returns (uint256)",
  "function requestClose(bytes32 market, bool isLong, uint256 acceptablePrice) returns (uint256)",
  "function requestIncrease(bytes32 market, bool isLong, uint256 addCollateral, uint256 addLeverage, uint256 acceptablePrice) returns (uint256)",
  "function requestDecrease(bytes32 market, bool isLong, uint256 closeBps, uint256 acceptablePrice) returns (uint256)",
  "function requestTriggerClose(bytes32 market, bool isLong, uint256 acceptablePrice, uint256 triggerPrice, bool triggerAbove) returns (uint256)",
  "function requestTriggerDecrease(bytes32 market, bool isLong, uint256 closeBps, uint256 acceptablePrice, uint256 triggerPrice, bool triggerAbove) returns (uint256)",
  "function requestTriggerOpen(bytes32 market, bool isLong, uint256 collateral, uint256 leverage, uint256 acceptablePrice, uint256 triggerPrice, bool triggerAbove) returns (uint256)",
  "function requestTriggerIncrease(bytes32 market, bool isLong, uint256 addCollateral, uint256 addLeverage, uint256 acceptablePrice, uint256 triggerPrice, bool triggerAbove) returns (uint256)",
  // keeper step (call WITH a fresh RedStone payload) + owner reclaim
  "function executeRequest(uint256 requestId)",
  "function cancelRequest(uint256 requestId)",
  // views
  "function nextRequestId() view returns (uint256)",
  "function supportedMarkets(bytes32 market) view returns (bool)",
  "function getPositionKey(address owner, bytes32 market, bool isLong) view returns (bytes32)",
  "function positions(bytes32 key) view returns (address owner, bytes32 market, bool isLong, uint256 collateral, uint256 sizeUsd, uint256 entryPrice, uint256 entryCumBorrowRate, int256 entryCumFunding)",
  "function requests(uint256 id) view returns (address owner, bytes32 market, bool isLong, uint8 kind, uint256 collateral, uint256 leverage, uint256 acceptablePrice, uint256 executionFee, uint256 requestTimestamp, bool active)",
  "function triggers(uint256 id) view returns (uint256 triggerPrice, bool triggerAbove)",
  // events
  "event OpenRequested(uint256 indexed requestId, address indexed owner, bytes32 indexed market, bool isLong, uint256 collateral, uint256 leverage, uint256 acceptablePrice, uint256 executionFee)",
  "event IncreaseRequested(uint256 indexed requestId, address indexed owner, bytes32 indexed market, bool isLong, uint256 addCollateral, uint256 addLeverage, uint256 acceptablePrice, uint256 executionFee)",
  "event DecreaseRequested(uint256 indexed requestId, address indexed owner, bytes32 indexed market, bool isLong, uint256 closeBps, uint256 acceptablePrice, uint256 executionFee)",
  "event TriggerCloseRequested(uint256 indexed requestId, address indexed owner, bytes32 indexed market, bool isLong, uint256 acceptablePrice, uint256 triggerPrice, bool triggerAbove, uint256 executionFee)",
  "event TriggerOpenRequested(uint256 indexed requestId, address indexed owner, bytes32 indexed market, bool isLong, uint256 collateral, uint256 leverage, uint256 acceptablePrice, uint256 triggerPrice, bool triggerAbove, uint256 executionFee)",
  "event RequestExecuted(uint256 indexed requestId, address indexed keeper, uint256 executionPrice)",
  "event RequestCancelled(uint256 indexed requestId, address indexed owner, bool slippage)",
  "event PositionOpened(address indexed owner, bytes32 indexed market, bool isLong, uint256 collateral, uint256 sizeUsd, uint256 entryPrice)",
  "event PositionIncreased(address indexed owner, bytes32 indexed market, bool isLong, uint256 fillPrice, uint256 addCollateral, uint256 addSize, uint256 newSizeUsd, uint256 newCollateral, uint256 newEntryPrice)",
  "event PositionDecreased(address indexed owner, bytes32 indexed market, bool isLong, uint256 closeBps, uint256 exitPrice, bool profit, uint256 pnl, uint256 borrowFee, int256 funding, uint256 payout, uint256 remainingSizeUsd, uint256 remainingCollateral)",
  "event PositionClosed(address indexed owner, bytes32 indexed market, bool isLong, uint256 exitPrice, bool profit, uint256 pnl, uint256 borrowFee, int256 funding, uint256 payout)",
  // custom errors (for readable revert decoding)
  "error MarketNotSupported(bytes32 market)",
  "error RequestNotActive()",
  "error TooEarlyToExecute(uint256 nowTs, uint256 earliest)",
  "error TooEarlyToCancel(uint256 nowTs, uint256 earliest)",
  "error PriceBeforeRequest(uint256 priceTs, uint256 minTs)",
  "error PriceTooStale(uint256 priceTimestampSeconds, uint256 blockTimestamp)",
  "error PriceFromFuture(uint256 priceTimestampSeconds, uint256 blockTimestamp)",
  "error TriggerNotMet(uint256 price, uint256 triggerPrice, bool triggerAbove)",
  "error SlippageNotMet(uint256 price, uint256 acceptablePrice)",
  "error InvalidAcceptablePrice()",
  "error InvalidTriggerPrice()",
  "error InvalidCloseBps(uint256 bps)",
  "error CloseAlreadyPending()",
  "error PositionAlreadyOpen()",
  "error NoOpenPosition()",
];

// Wrap a contract so the signed RedStone payload is injected into the call's calldata.
// Used ONLY for executeRequest (the keeper step) — never for the plain request* calls.
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

// Non-throwing variant: returns the event args or null. Used by the SHORT walk to
// tell a FILL (RequestExecuted) from a slippage CANCEL (RequestCancelled) without
// blowing up — the whole point there is to observe which branch the engine took.
function tryFindEvent(contract, receipt, name) {
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
  return null;
}

// Fetch the live BTC data package: returns { ts (sec), price1e8 (BigNumber) }. The mark
// P is the package value scaled to the on-chain 1e8 convention.
async function fetchMark() {
  const pkgs = await requestDataPackages({
    dataServiceId: DATA_SERVICE_ID,
    dataPackagesIds: [FEED],
    uniqueSignersCount: 1,
    authorizedSigners: [DEMO_SIGNER],
  });
  const ts = Math.floor(getDataPackagesTimestamp(pkgs) / 1000);
  const value = pkgs[FEED][0].dataPackage.dataPoints[0].toObj().value; // human price (float)
  const price1e8 = ethers.BigNumber.from(Math.round(value * 1e8).toString());
  return { ts, price1e8 };
}

async function payloadTimestampSec() {
  return (await fetchMark()).ts;
}

// Pull a usable revert string out of an ethers v5 error, decoding custom errors when present.
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
const pct = (P, n) => P.mul(n).div(100); // P * (n/100) on the 1e8 scale

// --- per-step PASS/FAIL bookkeeping ----------------------------------------
const steps = [];
let initialBalance = ethers.constants.Zero;
let tokenRef = null;
let walletRef = null;
let poolAddrRef = null;

async function printSummary() {
  console.log("\n=== STEP SUMMARY =========================================");
  for (const s of steps) {
    console.log(`  [${s.status === "PASS" ? "PASS" : "FAIL"}] ${s.name}${s.detail ? ` — ${s.detail}` : ""}`);
  }
  console.log("  [SKIP] liquidation (PR-5) — no way to force an adverse live mark; covered by forge tests");
  try {
    const finalBalance = await tokenRef.balanceOf(walletRef.address);
    const lpShares = poolAddrRef ? await new ethers.Contract(poolAddrRef, POOL_ABI, walletRef).balanceOf(walletRef.address) : ethers.constants.Zero;
    console.log("----------------------------------------------------------");
    console.log(`  wallet mUSD start:  ${f18(initialBalance)}`);
    console.log(`  wallet mUSD end:    ${f18(finalBalance)}`);
    console.log(`  net mUSD delta:     ${f18(finalBalance.sub(initialBalance))}  (includes +mint, -LP deposit)`);
    console.log(`  wallet LP shares:   ${f18(lpShares)}  (mUSD parked in the pool as LP)`);
  } catch {}
  console.log("==========================================================");
}

function record(name, status, detail = "") {
  steps.push({ name, status, detail });
}

async function fail(name, msg) {
  console.error(`\nFAIL [${name}]: ${msg}`);
  record(name, "FAIL", msg);
  await printSummary();
  process.exit(1);
}

async function expect(cond, name, msg) {
  if (!cond) await fail(name, msg);
}

function passStep(name, detail = "") {
  console.log(`  PASS [${name}]${detail ? ` — ${detail}` : ""}`);
  record(name, "PASS", detail);
}

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
  const wallet = new ethers.Wallet(pk, provider); // plays trader + LP + keeper

  const market = ethers.utils.formatBytes32String(FEED);
  const marketEth = ethers.utils.formatBytes32String("ETH");
  const token = new ethers.Contract(musd, ERC20_ABI, wallet);
  const pool = new ethers.Contract(poolAddr, POOL_ABI, wallet);
  const mgr = new ethers.Contract(pm, PM_ABI, wallet);

  tokenRef = token;
  walletRef = wallet;
  poolAddrRef = poolAddr;
  initialBalance = await token.balanceOf(wallet.address);

  console.log(`wallet (trader+LP+keeper): ${wallet.address}`);
  console.log(`PositionManager:           ${pm}`);
  console.log(`LiquidityPool:             ${poolAddr}`);
  console.log(`mUSD:                      ${musd}`);
  console.log(`wallet mUSD start:         ${f18(initialBalance)}\n`);

  // Poll the demo feed until a payload exists that the contract's freshness guard will
  // accept for a request queued at `requestTs`: a package stamped >= requestTs +
  // MIN_EXECUTION_DELAY (else PriceBeforeRequest) AND the chain clock past the same floor
  // (else TooEarlyToExecute). The redstone-main-demo feed updates slowly, hence the poll.
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
      console.log(`    waiting for fresh payload: pkg ts ${pkgTs}, block ts ${blockTs}, need >= ${floor}`);
      if (pkgTs >= floor && blockTs >= floor) return;
      if (Date.now() - start > TIMEOUT_MS) {
        throw new Error(
          `timed out waiting for a demo payload stamped >= ${floor} (last pkg ts ${pkgTs}); the redstone-main-demo feed updates slowly — rerun or raise TIMEOUT_MS`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  // Run an executeRequest and, on revert, print the reason plus the request floor, the
  // current block.timestamp, and the live payload timestamp — making a freshness or
  // slippage miss obvious instead of a bare stack trace.
  async function guardedExecute(reqId, requestTs) {
    try {
      return await (await wrap(mgr).executeRequest(reqId)).wait();
    } catch (err) {
      const reason = revertReason(mgr.interface, err);
      let nowTs = "?";
      let payloadTs = "?";
      try {
        nowTs = (await provider.getBlock("latest")).timestamp;
      } catch {}
      try {
        payloadTs = await payloadTimestampSec();
      } catch {}
      console.error("\n!! executeRequest reverted:");
      console.error(`   reason:           ${reason}`);
      console.error(`   requestTs:        ${requestTs}  (floor = ${requestTs + MIN_EXECUTION_DELAY})`);
      console.error(`   block.timestamp:  ${nowTs}`);
      console.error(`   payload.timestamp:${payloadTs}`);
      throw err;
    }
  }

  // Send a request* tx; return its assigned id (== nextRequestId before the call) and the
  // block timestamp it was queued at. One sequential wallet, so the pre-read id is exact.
  async function sendRequest(label, txThunk) {
    const id = await mgr.nextRequestId();
    console.log(label);
    const rcpt = await (await txThunk()).wait();
    const ts = (await provider.getBlock(rcpt.blockNumber)).timestamp;
    console.log(`    queued requestId ${id.toString()} at requestTs ${ts}`);
    return { id, ts, rcpt };
  }

  // request -> wait past the floor -> executeRequest with a fresh payload. Returns the
  // execute receipt (so callers can read RequestExecuted / PositionClosed).
  async function walk(label, txThunk) {
    const { id, ts } = await sendRequest(label, txThunk);
    await waitForFreshPayload(ts);
    console.log(`    executeRequest(${id.toString()}) as keeper (fresh BTC payload)...`);
    const rcpt = await guardedExecute(id, ts);
    const fill = findEvent(mgr, rcpt, "RequestExecuted").executionPrice;
    console.log(`    filled at ${f8(fill)}`);
    return { id, ts, rcpt, fill };
  }

  // ===== SETUP ==============================================================
  console.log("--- SETUP ------------------------------------------------");
  console.log(`minting ${f18(MINT_AMOUNT)} mUSD to wallet...`);
  await (await token.mint(wallet.address, MINT_AMOUNT)).wait();

  const MAX = ethers.constants.MaxUint256;
  if ((await token.allowance(wallet.address, poolAddr)).lt(LP_SEED)) {
    console.log("approving pool for max mUSD...");
    await (await token.approve(poolAddr, MAX)).wait();
  }
  if ((await token.allowance(wallet.address, pm)).lt(MINT_AMOUNT)) {
    console.log("approving PositionManager for max mUSD...");
    await (await token.approve(pm, MAX)).wait();
  }

  console.log(`seeding LP: pool.deposit(${f18(LP_SEED)}, wallet)...`);
  await (await pool.deposit(LP_SEED, wallet.address)).wait();
  console.log(`  pool mUSD balance: ${f18(await token.balanceOf(poolAddr))}`);

  const mark = await fetchMark();
  const P = mark.price1e8;
  console.log(`live BTC mark P = ${f8(P)} (1e8 = ${P.toString()})  pkg ts ${mark.ts}\n`);

  // Bounds parameterized off P. Generous so actions fill despite drift during the waits.
  const BUY = pct(P, 105); // open/increase ceiling (long buys at <= this)
  const SELL = pct(P, 95); // decrease/close floor (long sells at >= this)
  const TP_TRIGGER = pct(P, 90); // already-met TP trigger (below P, can't un-meet)
  const REST_PRICE = pct(P, 150); // resting trigger-open: trigger + slippage both well above P

  const key = await mgr.getPositionKey(wallet.address, market, true);

  // ===== STEP 1: FAUCET (PR-7) =============================================
  console.log("--- 1 FAUCET (PR-7) --------------------------------------");
  {
    const name = "1 FAUCET";
    const availAt = await token.faucetAvailableAt(wallet.address);
    if (availAt.eq(0)) {
      const before = await token.balanceOf(wallet.address);
      console.log("faucet() claim...");
      await (await token.faucet()).wait();
      const after = await token.balanceOf(wallet.address);
      const got = after.sub(before);
      await expect(got.eq(FAUCET_AMOUNT), name, `faucet minted ${f18(got)} mUSD, expected ${f18(FAUCET_AMOUNT)}`);
      console.log(`  faucet minted ${f18(got)} mUSD`);
    } else {
      console.log(`  wallet already claimed this cooldown window (next at ${availAt.toString()}); the +10k success`);
      console.log(`  leg was exercised on a prior run — asserting the cooldown revert only.`);
    }
    // Second call (or the only call when already on cooldown) MUST revert with the cooldown.
    console.log("faucet() again (expect cooldown revert)...");
    let reverted = false;
    let reason = "";
    try {
      await (await token.faucet()).wait();
    } catch (err) {
      reverted = true;
      reason = revertReason(token.interface, err);
    }
    await expect(reverted, name, "second faucet() did NOT revert (cooldown not enforced)");
    console.log(`  reverted as expected: ${reason}`);
    passStep(name, "faucet mint + cooldown revert");
  }

  // ===== STEP 2: REGISTRY (PR-8) ===========================================
  console.log("\n--- 2 REGISTRY (PR-8) ------------------------------------");
  {
    const name = "2 REGISTRY";
    const btcOk = await mgr.supportedMarkets(market);
    const ethOk = await mgr.supportedMarkets(marketEth);
    console.log(`  supportedMarkets(BTC) = ${btcOk}, supportedMarkets(ETH) = ${ethOk}`);
    await expect(btcOk && ethOk, name, `expected BTC && ETH supported, got BTC=${btcOk} ETH=${ethOk}`);
    passStep(name, "BTC and ETH supported");
  }

  // ===== STEP 3: OPEN long =================================================
  console.log("\n--- 3 OPEN long ------------------------------------------");
  let entryAfterOpen;
  {
    const name = "3 OPEN";
    await walk(
      `requestOpen BTC long ${f18(OPEN_COLLATERAL)} mUSD @ ${OPEN_LEVERAGE}x (ceiling ${f8(BUY)})...`,
      () => mgr.requestOpen(market, true, OPEN_COLLATERAL, OPEN_LEVERAGE, BUY),
    );
    const pos = await mgr.positions(key);
    entryAfterOpen = pos.entryPrice;
    const expectedSize = OPEN_COLLATERAL.mul(OPEN_LEVERAGE); // 5000e18
    console.log(`  position: size ${f18(pos.sizeUsd)} USD  collateral ${f18(pos.collateral)} mUSD  entry ${f8(pos.entryPrice)}`);
    await expect(pos.sizeUsd.eq(expectedSize), name, `sizeUsd ${f18(pos.sizeUsd)} != ${f18(expectedSize)}`);
    // entryPrice ~ P: the fill mark postdates P, so allow generous drift (10%).
    const driftBps = pos.entryPrice.sub(P).abs().mul(10000).div(P);
    await expect(driftBps.lt(1000), name, `entry ${f8(pos.entryPrice)} drifted ${driftBps}bps from P ${f8(P)} (>10%)`);
    passStep(name, `size == ${f18(expectedSize)}, entry ${f8(pos.entryPrice)} (${driftBps}bps from P)`);
  }

  // ===== STEP 4: INCREASE ==================================================
  console.log("\n--- 4 INCREASE -------------------------------------------");
  {
    const name = "4 INCREASE";
    const { fill } = await walk(
      `requestIncrease BTC long +${f18(ADD_COLLATERAL)} mUSD @ ${ADD_LEVERAGE}x (ceiling ${f8(BUY)})...`,
      () => mgr.requestIncrease(market, true, ADD_COLLATERAL, ADD_LEVERAGE, BUY),
    );
    const pos = await mgr.positions(key);
    const expectedSize = OPEN_COLLATERAL.mul(OPEN_LEVERAGE).add(ADD_COLLATERAL.mul(ADD_LEVERAGE)); // 7500e18
    const expectedCollat = OPEN_COLLATERAL.add(ADD_COLLATERAL); // 1500e18
    console.log(`  position: size ${f18(pos.sizeUsd)} USD  collateral ${f18(pos.collateral)} mUSD  entry ${f8(pos.entryPrice)}`);
    console.log(`  blend inputs: original entry ${f8(entryAfterOpen)}, increase fill ${f8(fill)}`);
    await expect(pos.sizeUsd.eq(expectedSize), name, `sizeUsd ${f18(pos.sizeUsd)} != ${f18(expectedSize)}`);
    await expect(pos.collateral.eq(expectedCollat), name, `collateral ${f18(pos.collateral)} != ${f18(expectedCollat)}`);
    // Blended entry must sit strictly between the original entry and the increase fill
    // (the spec's "> original, < fill" when the price rose; robust to either drift order).
    const lo = entryAfterOpen.lt(fill) ? entryAfterOpen : fill;
    const hi = entryAfterOpen.lt(fill) ? fill : entryAfterOpen;
    const blended = pos.entryPrice.gte(lo) && pos.entryPrice.lte(hi);
    await expect(blended, name, `entry ${f8(pos.entryPrice)} not between original ${f8(entryAfterOpen)} and fill ${f8(fill)}`);
    passStep(name, `size 7500, collateral 1500, entry ${f8(pos.entryPrice)} blended in [${f8(lo)}, ${f8(hi)}]`);
  }

  // ===== STEP 5: DECREASE 50% ==============================================
  console.log("\n--- 5 DECREASE 50% ---------------------------------------");
  {
    const name = "5 DECREASE";
    await walk(
      `requestDecrease BTC long ${DECREASE_BPS}bps (floor ${f8(SELL)})...`,
      () => mgr.requestDecrease(market, true, DECREASE_BPS, SELL),
    );
    const pos = await mgr.positions(key);
    const expectedSize = ethers.utils.parseUnits("3750", 18);
    const expectedCollat = ethers.utils.parseUnits("750", 18);
    console.log(`  position: size ${f18(pos.sizeUsd)} USD  collateral ${f18(pos.collateral)} mUSD`);
    await expect(pos.sizeUsd.eq(expectedSize), name, `sizeUsd ${f18(pos.sizeUsd)} != ${f18(expectedSize)}`);
    await expect(pos.collateral.eq(expectedCollat), name, `collateral ${f18(pos.collateral)} != ${f18(expectedCollat)}`);
    passStep(name, "size 3750, collateral 750");
  }

  // ===== STEP 6: TRIGGER-CLOSE (TP already met) closes the rest =============
  console.log("\n--- 6 TRIGGER-CLOSE (TP, already met) --------------------");
  {
    const name = "6 TRIGGER-CLOSE";
    // request -> wait -> execute, capturing the keeper's balance across the EXECUTE only.
    const { id, ts } = await sendRequest(
      `requestTriggerClose BTC long (acceptable ${f8(SELL)}, trigger ${f8(TP_TRIGGER)}, above=true)...`,
      () => mgr.requestTriggerClose(market, true, SELL, TP_TRIGGER, true),
    );
    await waitForFreshPayload(ts);
    console.log(`    executeRequest(${id.toString()}) as keeper (fresh BTC payload)...`);
    const before = await token.balanceOf(wallet.address);
    const rcpt = await guardedExecute(id, ts);
    const after = await token.balanceOf(wallet.address);
    const closed = findEvent(mgr, rcpt, "PositionClosed");
    const fill = findEvent(mgr, rcpt, "RequestExecuted").executionPrice;
    // Wallet is owner + keeper: inflow = trader payout + keeper fee. Back out the fee.
    const inflow = after.sub(before);
    const keeperFee = inflow.sub(closed.payout);
    console.log(`    filled at ${f8(fill)}  payout ${f18(closed.payout)} mUSD  keeper fee ${f18(keeperFee)} mUSD`);
    const pos = await mgr.positions(key);
    console.log(`  position: size ${f18(pos.sizeUsd)} USD`);
    await expect(pos.sizeUsd.eq(0), name, `position not fully closed: sizeUsd ${f18(pos.sizeUsd)}`);
    await expect(keeperFee.eq(EXECUTION_FEE), name, `keeper fee ${f18(keeperFee)} != EXECUTION_FEE ${f18(EXECUTION_FEE)}`);
    passStep(name, `size 0, keeper earned ${f18(keeperFee)} mUSD fee`);
  }

  // ===== STEP 7: RESTING TRIGGER-OPEN (not met) ============================
  console.log("\n--- 7 RESTING TRIGGER-OPEN (not met) ---------------------");
  {
    const name = "7 RESTING TRIGGER-OPEN";
    const { id, ts } = await sendRequest(
      `requestTriggerOpen BTC long ${f18(OPEN_COLLATERAL)} mUSD @ ${OPEN_LEVERAGE}x ` +
        `(acceptable ${f8(REST_PRICE)}, trigger ${f8(REST_PRICE)}, above=true)...`,
      () => mgr.requestTriggerOpen(market, true, OPEN_COLLATERAL, OPEN_LEVERAGE, REST_PRICE, REST_PRICE, true),
    );
    // Wait past the floor so the ONLY remaining reason to revert is the unmet trigger
    // (not TooEarlyToExecute / PriceBeforeRequest).
    await waitForFreshPayload(ts);
    console.log(`    static executeRequest(${id.toString()}) — expect TriggerNotMet revert...`);
    // The RedStone wrapper injects the signed payload only on populateTransaction / send,
    // NOT on .callStatic — so build the payload-bearing tx and replay it through a raw
    // provider.call. That reaches the on-chain trigger gate and surfaces its revert data
    // (a bare callStatic would revert earlier with CalldataMustHaveValidPayload).
    const staticTx = await wrap(mgr).populateTransaction.executeRequest(id);
    let reverted = false;
    let reason = "";
    try {
      // This Nitro node returns revert bytes as a SUCCESSFUL eth_call result rather than
      // erroring. executeRequest returns nothing on a fill, so any non-empty return data
      // IS the revert payload. Handle both node behaviors (returned bytes or a throw).
      const raw = await provider.call({ ...staticTx, from: wallet.address });
      if (raw && raw !== "0x") {
        reverted = true;
        try {
          const p = mgr.interface.parseError(raw);
          reason = `${p.name}(${p.args.map((a) => a.toString()).join(", ")})`;
        } catch {
          reason = `raw ${raw}`;
        }
      }
    } catch (err) {
      reverted = true;
      reason = revertReason(mgr.interface, err);
    }
    await expect(reverted, name, "executeRequest did NOT revert on an unmet trigger");
    await expect(reason.startsWith("TriggerNotMet"), name, `expected TriggerNotMet, got ${reason}`);
    console.log(`    reverted as expected: ${reason}`);
    const req = await mgr.requests(id);
    await expect(req.active, name, `request ${id.toString()} no longer active after the failed execute`);
    console.log(`  request ${id.toString()} left RESTING (active=true); recoverable via cancelRequest after CANCEL_DELAY (${CANCEL_DELAY}s).`);
    console.log(`  NOT waiting out CANCEL_DELAY — the smoke leaves it resting by design.`);
    passStep(name, "execute reverts TriggerNotMet, request stays active");
  }

  // Classify an executeRequest receipt without throwing: a FILL emits
  // RequestExecuted; a market slippage miss emits RequestCancelled(slippage=true)
  // and refunds (the execute itself does NOT revert). The SHORT walk needs to see
  // which branch happened, so it inspects the receipt instead of assuming a fill.
  function classifyOutcome(rcpt) {
    const executed = tryFindEvent(mgr, rcpt, "RequestExecuted");
    if (executed) return { kind: "filled", price: executed.executionPrice };
    const cancelled = tryFindEvent(mgr, rcpt, "RequestCancelled");
    if (cancelled) return { kind: cancelled.slippage ? "slippage" : "cancelled" };
    return { kind: "unknown" };
  }

  const shortKey = await mgr.getPositionKey(wallet.address, market, false);

  // ===== STEP 8: OPEN SHORT (slippage-side discriminator) ==================
  console.log("\n--- 8 OPEN short (slippage-side discriminator) ------------");
  {
    const name = "8 OPEN short";
    const SHORT_DOWN = pct(P, 93); // open short -> DOWN buffer; engine must require fill >= acceptable
    const { id, ts } = await sendRequest(
      `requestOpen BTC SHORT ${f18(OPEN_COLLATERAL)} mUSD @ ${OPEN_LEVERAGE}x (acceptable ${f8(SHORT_DOWN)} = P*0.93)...`,
      () => mgr.requestOpen(market, false, OPEN_COLLATERAL, OPEN_LEVERAGE, SHORT_DOWN),
    );
    await waitForFreshPayload(ts);
    console.log(`    executeRequest(${id.toString()}) as keeper (fresh BTC payload)...`);
    const rcpt = await guardedExecute(id, ts);
    const out = classifyOutcome(rcpt);
    if (out.kind === "slippage") {
      // Discriminator tripped: a DOWN buffer on a short open should only fail if the
      // engine applied the LONG convention (fill <= acceptable). That means slippage
      // is grouped by open/close only, not by side — and the frontend's short buffer
      // (up = isOpenSide === isLong) is computed on the WRONG side.
      await fail(
        name,
        `short OPEN slippage-CANCELLED with the DOWN buffer (acceptable ${f8(SHORT_DOWN)} = P*0.93). ` +
          `The engine is NOT long/short-aware — it groups slippage by open/close only — so the frontend's ` +
          `short acceptablePrice is on the WRONG side. FIX THE FRONTEND MATRIX (up = isOpenSide === isLong); ` +
          `do NOT widen the buffer to mask this.`,
      );
    }
    await expect(out.kind === "filled", name, `expected a fill or a slippage-cancel, got ${out.kind}`);
    const pos = await mgr.positions(shortKey);
    const expectedSize = OPEN_COLLATERAL.mul(OPEN_LEVERAGE); // 5000e18
    console.log(`    filled at ${f8(out.price)}  position: size ${f18(pos.sizeUsd)} USD  isLong ${pos.isLong}  entry ${f8(pos.entryPrice)}`);
    await expect(pos.isLong === false, name, `position isLong ${pos.isLong}, expected false (short)`);
    await expect(pos.sizeUsd.eq(expectedSize), name, `sizeUsd ${f18(pos.sizeUsd)} != ${f18(expectedSize)}`);
    passStep(
      name,
      `short opened: size ${f18(expectedSize)}, isLong=false, filled at ${f8(out.price)} with the DOWN buffer — engine slippage IS long/short-aware`,
    );
  }

  // ===== STEP 9: CLOSE SHORT ===============================================
  console.log("\n--- 9 CLOSE short ----------------------------------------");
  {
    const name = "9 CLOSE short";
    const SHORT_UP = pct(P, 107); // close short -> UP buffer; engine must require fill <= acceptable
    const { id, ts } = await sendRequest(
      `requestClose BTC SHORT (acceptable ${f8(SHORT_UP)} = P*1.07)...`,
      () => mgr.requestClose(market, false, SHORT_UP),
    );
    await waitForFreshPayload(ts);
    console.log(`    executeRequest(${id.toString()}) as keeper (fresh BTC payload)...`);
    const rcpt = await guardedExecute(id, ts);
    const out = classifyOutcome(rcpt);
    if (out.kind === "slippage") {
      await fail(
        name,
        `short CLOSE slippage-CANCELLED with the UP buffer (acceptable ${f8(SHORT_UP)} = P*1.07). ` +
          `The engine grouped slippage by open/close only — the frontend's close-short buffer is on the WRONG side. ` +
          `FIX THE FRONTEND MATRIX; do NOT widen the buffer.`,
      );
    }
    await expect(out.kind === "filled", name, `expected a fill or a slippage-cancel, got ${out.kind}`);
    const pos = await mgr.positions(shortKey);
    console.log(`    filled at ${f8(out.price)}  position: size ${f18(pos.sizeUsd)} USD`);
    await expect(pos.sizeUsd.eq(0), name, `short not fully closed: sizeUsd ${f18(pos.sizeUsd)}`);
    passStep(name, `short closed to size 0, filled at ${f8(out.price)} with the UP buffer`);
  }

  console.log("\nNote: on-chain liquidation (PR-5) is intentionally SKIPPED — the live demo feed");
  console.log("cannot be forced to an adverse mark. Liquidation is covered by the PR-5 forge tests.\n");

  await printSummary();
  console.log("\nfull-surface smoke PASSED.");
}

main().catch(async (e) => {
  console.error(e);
  try {
    await printSummary();
  } catch {}
  process.exit(1);
});
