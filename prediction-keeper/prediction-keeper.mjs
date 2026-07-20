// Standalone, ISOLATED keeper for the parimutuel prediction market on LitVM
// (chain 4441). Separate process, separate key, separate Railway service from the
// perp keeper (keeper/keeper.mjs) — it imports NOTHING from there. A crash, gas
// exhaustion, or nonce stall here can never affect the perp keeper.
//
// The prediction stack reads DIA prices ON-CHAIN through per-asset adapters, so —
// unlike the perp keeper — this keeper injects NO oracle payload. It just drives
// the factory's three PERMISSIONLESS entrypoints:
//
//   replenish()   keep the rolling board at TARGET_ACTIVE. GATED: sent only when
//                 active < TARGET_ACTIVE || open == 0, so we never burn gas/nonces
//                 on a no-op (this keeper earns nothing and the RPC rate-limits us).
//   observe(id)   sample the feed into a market's settlement window [tLock,tExpiry)
//                 to build its TWAP, respecting MIN_OBS_SPACING.
//   settle(id)    resolve a market once past tExpiry (real outcome or VOID).
//
// DISCIPLINE (see README + docs/prediction-deploy.md):
//   - EVERY send uses an EXPLICIT gasLimit AND gasPrice. We NEVER call estimateGas
//     or getFeeData — both return 502/504 on this degraded RPC, and replenish()
//     cost is variable; an under-estimate OOGs and silently fails to maintain the
//     board. replenish() ships with a 20,000,000 limit.
//   - We STATIC-PROBE each action first and only send when it would land, so the
//     many benign reverts (feed briefly stale, spacing, await-grace) cost a read,
//     not a failed tx + nonce.
//   - Sends are SERIALIZED behind one nonce; receipt.status is always checked.
//
// Usage:  cd prediction-keeper && cp .env.example .env && edit .env && npm start
//   node prediction-keeper.mjs --once   # read-only smoke (probe, never sends)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ethers } from "ethers";
import { staticProbe, revertReason } from "./lib/revert.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FACTORY_ABI = JSON.parse(readFileSync(join(__dirname, "abi", "PredictionFactory.json"), "utf8"));

const ONCE = process.argv.includes("--once");

// ---- config ---------------------------------------------------------------
const cfg = {
  rpc: process.env.LITVM_RPC_URL,
  pk: process.env.PREDICTION_KEEPER_PRIVATE_KEY,
  factory: process.env.PREDICTION_FACTORY_ADDRESS,
  loopMs: num(process.env.PREDICTION_LOOP_MS, 10_000),
  reconcileMs: num(process.env.PREDICTION_RECONCILE_MS, 120_000),
  // Keeper-side observe cadence, in seconds. This is POLICY, distinct from the
  // contract's MIN_OBS_SPACING floor (10s) — see OBSERVE_SPACING note below.
  observeSpacing: num(process.env.PREDICTION_OBSERVE_SPACING, 60),
  gas: {
    replenish: num(process.env.PREDICTION_GAS_REPLENISH, 20_000_000),
    observe: num(process.env.PREDICTION_GAS_OBSERVE, 500_000),
    settle: num(process.env.PREDICTION_GAS_SETTLE, 3_000_000),
  },
  gasPriceGwei: process.env.PREDICTION_GAS_PRICE_GWEI || "0.02",
  minBalance: process.env.PREDICTION_MIN_BALANCE || "0.002",
};

function num(v, d) {
  const n = v === undefined || v === "" ? d : Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad numeric env: ${v}`);
  return n;
}

// Required always: RPC + factory. Key required only when we actually send.
for (const [k, v] of Object.entries({ LITVM_RPC_URL: cfg.rpc, PREDICTION_FACTORY_ADDRESS: cfg.factory })) {
  if (!v) throw new Error(`missing env ${k}`);
}
const KEY_PLACEHOLDER = !cfg.pk || /YOUR_DEDICATED/i.test(cfg.pk);
if (!ONCE && KEY_PLACEHOLDER) throw new Error("missing env PREDICTION_KEEPER_PRIVATE_KEY (required to send)");

// ---- constants mirrored from the contract (for local gating; authoritative
//      checks stay on-chain via static probes) --------------------------------
const TARGET_ACTIVE = 7;
const MIN_OBS_SPACING = 10; // seconds — mirrors the contract constant (the FLOOR
// below which observe() reverts ObservationTooSoon). Kept for reference; the
// keeper deliberately paces itself well above it — see cfg.observeSpacing.
//
// OBSERVE_SPACING (cfg.observeSpacing, default 60s) is the keeper's own cadence.
// Gating observes at the contract FLOOR made us sample every ~13-16s against a DIA
// feed whose real heartbeat is ~135-140s (docs/dia-cadence-diagnostic.md), so ~9 of
// every 10 samples re-recorded a price that had not changed. Coverage is a SPAN
// (last.ts - first.ts in block time, PredictionTwap._valid), not a count, so those
// extra samples bought no coverage — mkt#9 hit 97% on a 600s window with 39
// observes and 5 distinct prices. 60s reaches >=9 samples / 94.7% coverage on the
// same window at ~1/4 the gas.
//
// Why 60 and not higher: the 15m timeframe's settlement window is only 300s
// (PredictionMarketFactory._windows), and it is the binding case. Effective spacing
// is this value plus up to one loop period (~11s). At 80s a delayed first observe
// yields 3 samples spanning 182s = 60.7% against the 60.0% MIN_COVERAGE_BPS gate —
// one slow tick from voiding a market. 60s leaves margin on every timeframe
// (15m ~71%, 30m ~94.7%). Raise it only alongside the 15m window.
const PHASE = { 0: "Open", 1: "Locked", 2: "Settled", 3: "Void" };
const TF = { 0: "15m", 1: "30m", 2: "1h", 3: "24h" };
const isTerminal = (p) => p === 2 || p === 3;

// ---- logging --------------------------------------------------------------
const ts = () => new Date().toISOString().replace("T", " ").replace("Z", "");
const log = (msg) => console.log(`[${ts()}] ${msg}`);
const logId = (id, msg) => console.log(`[${ts()}] mkt#${id} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- degraded-RPC read retry ----------------------------------------------
// 502/504/timeout are routine here; back off and retry a handful of times.
async function withRetry(label, fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const wait = Math.min(500 * 2 ** i, 6000);
      if (i < tries - 1) await sleep(wait);
    }
  }
  throw new Error(`${label}: ${last?.message || last}`);
}

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(cfg.rpc);

  // In --once we tolerate a missing/placeholder key: use an ephemeral address just
  // to supply `from` for read-only static probes. It never signs or sends.
  let signer, from, readOnly;
  if (ONCE && KEY_PLACEHOLDER) {
    const eph = ethers.Wallet.createRandom();
    from = eph.address;
    readOnly = true;
    log(`--once: no operational key set — using ephemeral read-only from=${from} (no sends)`);
  } else {
    signer = new ethers.Wallet(cfg.pk, provider);
    from = signer.address;
    readOnly = ONCE; // --once with a real key still never sends
  }

  const factory = new ethers.Contract(cfg.factory, FACTORY_ABI, provider);
  const iface = factory.interface;

  const net = await withRetry("getNetwork", () => provider.getNetwork());
  log(`prediction-keeper up — chain ${net.chainId}, factory ${cfg.factory}`);
  log(`account ${from}  mode=${ONCE ? "ONCE(read-only)" : "LOOP"}  loop=${cfg.loopMs}ms  observeSpacing=${cfg.observeSpacing}s`);

  // Explicit gas price — ONE deliberate lookup with a hardcoded fallback so we
  // never depend on getFeeData per-tx (502/504-prone). Configurable via env.
  const fallbackGp = ethers.utils.parseUnits(cfg.gasPriceGwei, "gwei");
  let gasPrice = fallbackGp;
  try {
    const gp = await withRetry("getGasPrice", () => provider.getGasPrice(), 3);
    if (gp && gp.gt(0)) gasPrice = gp;
  } catch {
    log(`getGasPrice failed — using fallback ${cfg.gasPriceGwei} gwei`);
  }
  log(`gasPrice=${ethers.utils.formatUnits(gasPrice, "gwei")} gwei  limits: replenish=${cfg.gas.replenish} observe=${cfg.gas.observe} settle=${cfg.gas.settle}`);

  // ---- local live-set + caches --------------------------------------------
  // tracked: id -> { assetId, tf, tLock, tExpiry }  (immutables, cached once)
  const tracked = new Map();
  const assetSymbol = new Map(); // assetId -> display symbol (lazy)
  let highestScanned = 0; // next marketCount() tail we haven't ingested

  async function symbolOf(assetId) {
    if (assetSymbol.has(assetId)) return assetSymbol.get(assetId);
    let sym = `asset${assetId}`;
    try {
      const a = await withRetry("assets", () => factory.assets(assetId));
      sym = a.symbol || sym;
    } catch {}
    assetSymbol.set(assetId, sym);
    return sym;
  }

  async function trackMarket(id) {
    const m = await withRetry(`getMarket(${id})`, () => factory.getMarket(id));
    const phase = m.phase;
    if (isTerminal(phase)) return null; // already resolved — never track
    let tf = 255;
    try {
      tf = await withRetry("timeframeOf", () => factory.timeframeOf(id), 3);
      tf = Number(tf);
    } catch {}
    const entry = {
      id,
      assetId: Number(m.assetId),
      tf,
      tLock: m.tLock.toNumber(),
      tExpiry: m.tExpiry.toNumber(),
    };
    tracked.set(id, entry);
    const sym = await symbolOf(entry.assetId);
    logId(id, `tracked — ${sym} ${TF[tf] ?? tf}  lock=${entry.tLock} expiry=${entry.tExpiry}`);
    return entry;
  }

  // Ingest any markets created since our last scan (incremental tail), and on the
  // periodic reconcile do a full [0, marketCount) sweep to self-heal.
  async function ingestNew(full) {
    const mc = (await withRetry("marketCount", () => factory.marketCount())).toNumber();
    const start = full ? 0 : highestScanned;
    for (let id = start; id < mc; id++) {
      if (tracked.has(id)) continue;
      await trackMarket(id).catch((e) => log(`track#${id} failed: ${e.message}`));
    }
    highestScanned = Math.max(highestScanned, mc);
    return mc;
  }

  // ---- serialized send (one in-flight; local nonce) -----------------------
  let sending = Promise.resolve();
  async function send(label, action, gasLimit) {
    if (readOnly) return { skipped: true };
    const run = async () => {
      const data = iface.encodeFunctionData(action.fn, action.args);
      const nonce = await withRetry("nonce", () => provider.getTransactionCount(from, "latest"));
      const tx = await signer.sendTransaction({ to: cfg.factory, data, gasLimit, gasPrice, nonce });
      log(`${label}: sent ${tx.hash} (nonce ${nonce}, gas ${gasLimit})`);
      const rc = await tx.wait();
      if (rc.status === 1) log(`${label}: OK block ${rc.blockNumber} gasUsed ${rc.gasUsed.toString()}`);
      else log(`${label}: REVERTED on-chain (status 0) — will retry next tick`);
      return { status: rc.status, hash: tx.hash };
    };
    const p = sending.then(run, run);
    // keep the chain alive regardless of this send's outcome
    sending = p.then(() => {}, () => {});
    return p;
  }

  // ---- probe helper: only send if the action would land -------------------
  async function probeThenSend(label, fn, args, gasLimit) {
    const data = iface.encodeFunctionData(fn, args);
    const probe = await staticProbe(provider, iface, cfg.factory, data, from);
    if (!probe.ok) {
      logId(args[0] ?? "-", `${label} skip — ${probe.reason}`);
      return { landed: false, reason: probe.reason };
    }
    if (readOnly) {
      logId(args[0] ?? "-", `${label} WOULD SEND (probe ok) — suppressed (read-only)`);
      return { landed: false, wouldSend: true };
    }
    try {
      const r = await send(label, { fn, args }, gasLimit);
      return { landed: r.status === 1, status: r.status };
    } catch (err) {
      logId(args[0] ?? "-", `${label} send error — ${revertReason(iface, err)}`);
      return { landed: false, error: true };
    }
  }

  // ---- one cycle ----------------------------------------------------------
  let lastReconcile = 0;
  async function tick() {
    const nowMs = Date.now();
    const full = nowMs - lastReconcile >= cfg.reconcileMs || lastReconcile === 0;
    if (full) lastReconcile = nowMs;

    await ingestNew(full);

    const block = await withRetry("getBlock", () => provider.getBlock("latest"));
    const nowTs = block.timestamp;

    // --- replenish gate: board views (cheap) ---
    const [active, open] = await withRetry("boardCounts", () => factory.boardCounts());
    const need = active.toNumber() < TARGET_ACTIVE || open.toNumber() === 0;
    log(`board active=${active} open=${open} tracked=${tracked.size} chainTs=${nowTs}${need ? "  -> replenish" : ""}`);
    if (need) {
      await probeThenSend("replenish", "replenish", [], cfg.gas.replenish);
    }

    // --- per-market observe / settle ---
    for (const entry of [...tracked.values()]) {
      const { id, tLock, tExpiry } = entry;
      if (nowTs < tLock) continue; // still betting; nothing to do, no read

      // Actionable window — read fresh state (phase, lastObsTs).
      let m;
      try {
        m = await withRetry(`getMarket(${id})`, () => factory.getMarket(id));
      } catch (e) {
        logId(id, `state read failed: ${e.message}`);
        continue;
      }
      if (isTerminal(m.phase)) {
        logId(id, `resolved (${PHASE[m.phase]}) — untracking`);
        tracked.delete(id);
        continue;
      }

      if (nowTs >= tExpiry) {
        await probeThenSend("settle", "settle", [id], cfg.gas.settle);
      } else {
        // settlement window: pace off the last accepted sample at the keeper's own
        // cadence (cfg.observeSpacing), NOT the contract's MIN_OBS_SPACING floor —
        // sampling at the floor is ~9x redundant against the DIA heartbeat.
        const lastObs = m.lastObsTs.toNumber();
        if (lastObs !== 0 && nowTs < lastObs + cfg.observeSpacing) continue;
        await probeThenSend("observe", "observe", [id], cfg.gas.observe);
      }
    }
  }

  // ---- balance warning ----------------------------------------------------
  async function checkBalance() {
    try {
      const bal = await withRetry("getBalance", () => provider.getBalance(from), 3);
      const eth = ethers.utils.formatEther(bal);
      if (parseFloat(eth) < parseFloat(cfg.minBalance)) {
        log(`WARN low balance: ${eth} zkLTC (< ${cfg.minBalance}) — fund ${from} or the keeper stalls`);
      } else {
        log(`balance ${eth} zkLTC`);
      }
    } catch (e) {
      log(`balance check failed: ${e.message}`);
    }
  }

  // ---- run ----------------------------------------------------------------
  await checkBalance();
  if (ONCE) {
    log("=== --once: single read-only cycle (no sends) ===");
    await tick();
    log("=== --once complete ===");
    return;
  }

  // Main loop — never let one bad tick kill the process (Railway restarts anyway,
  // but a transient RPC blip shouldn't churn the service).
  let balCounter = 0;
  for (;;) {
    try {
      await tick();
    } catch (e) {
      log(`tick error: ${e.message}`);
    }
    if (++balCounter % 30 === 0) await checkBalance();
    await sleep(cfg.loopMs);
  }
}

main().catch((e) => {
  console.error(`fatal: ${e.stack || e.message || e}`);
  process.exit(1);
});
