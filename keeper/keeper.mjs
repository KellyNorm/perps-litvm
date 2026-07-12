// Standalone keeper service for the perps stack on LitVM (chain 4441).
//
// Traders sign only the REQUEST (a plain request* call, no payload). This keeper
// watches PositionManager for the requests they leave behind and fills each one
// with executeRequest carrying a fresh signed RedStone price — earning the 0.5
// mUSD execution fee per fill. It reuses the proven Node helpers from
// scripts/smoke-perps.mjs (payload wrap, freshness, Nitro revert-decoder),
// factored into keeper/lib.
//
// No Solidity changes. The keeper calls EXACTLY ONE state-changing function,
// executeRequest — never cancelRequest, never anything that moves funds.
//
// DISCOVERY  Maintain the active request-id set. Stay live on a real WebSocket:
//            a *Requested log -> reconcile(id) immediately (sub-second, vs up to
//            a full loop tick on the old .on()-over-HTTP polling). RequestExecuted
//            / RequestCancelled likewise remove. Every handler re-reads chain
//            state through the same idempotent reconcile(), so listeners can never
//            desync the set. catchUpCounter() walks the id counter and reconciles
//            each id against requests(id).active — it backfills on startup, runs on
//            a low-frequency 30s timer, and runs on every WS reconnect, so a
//            dropped/reconnected socket can never lose a request.
//
// EXECUTION  by kind (a request is a TRIGGER iff triggers(id).triggerPrice != 0):
//   - MARKET   on discovery we SCHEDULE the fill to the window-open instant:
//              fireAt = requestTimestamp + MIN_EXECUTION_DELAY. A per-id setTimeout
//              (sized off the chain-vs-wall clock skew tracked from newHeads) AND
//              the newHeads stream both release the fill — newHeads fires it on the
//              FIRST block whose timestamp crosses the floor (so the on-chain
//              block.timestamp >= earliest check passes, no TooEarlyToExecute), and
//              the timer is the backup if heads stall. At fire we fetch ONE fresh
//              payload and sign+broadcast. The contract fills OR auto-cancels on
//              slippage — we record the receipt's outcome, we don't second-guess it.
//   - TRIGGER  each loop, STATIC-probe fillability (provider.call via the
//              revert-decoder). Send the real executeRequest ONLY on a probe that
//              would succeed; otherwise it's still resting — try again next loop.
//              (Triggers stay on the loop this step; the scheduler is market-only.)
//
// Usage:  cd keeper && cp .env.example .env && edit .env && node keeper.mjs
//   (reads keeper/.env via --env-file or a manual source; see README.md)

import { pathToFileURL } from "url";
import { ethers } from "ethers";
import { PM_ABI, ERC20_ABI } from "./lib/abi.mjs";
import { fetchPackages, wrapWithPackages, feedOf, fetchMark } from "./lib/redstone.mjs";
import { revertReason, staticExecuteCheck, extractErrorData } from "./lib/revert.mjs";

// ---- config ---------------------------------------------------------------
const cfg = {
  rpc: process.env.LITVM_RPC_URL,
  // WebSocket endpoint(s) for the live subscriptions (logs + newHeads). The
  // infra-partner socket is primary; the public /ws is the fallback. Reconnects
  // alternate between them so a dead primary falls through to the public one.
  wsUrls: [
    process.env.KEEPER_WS_URL || "wss://liteforge.rpc.caldera.xyz/infra-partner-ws",
    process.env.KEEPER_WS_FALLBACK || "wss://liteforge.rpc.caldera.xyz/ws",
  ],
  pk: process.env.KEEPER_PRIVATE_KEY,
  pmAddr: process.env.POSITION_MANAGER_ADDRESS,
  musdAddr: process.env.MUSD_ADDRESS,
  dataService: process.env.REDSTONE_DATA_SERVICE || "redstone-primary-prod",
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : undefined,
  loopMs: process.env.KEEPER_LOOP_MS ? Number(process.env.KEEPER_LOOP_MS) : 2500,
  catchUpMs: process.env.KEEPER_CATCHUP_MS ? Number(process.env.KEEPER_CATCHUP_MS) : 30_000,
};

// ---- transient-RPC retry tuning -------------------------------------------
// The LitVM RPC (Nitro gateway) intermittently returns 504 / gateway-timeouts and
// other infra 5xx while upstream is degraded. Those are TRANSIENT: the keeper
// retries them with capped exponential backoff (2s, 4s, 8s, 16s, cap 30s) instead
// of dying. All three are env-tunable for ops.
const RETRY = {
  attempts: process.env.KEEPER_RPC_RETRIES ? Number(process.env.KEEPER_RPC_RETRIES) : 6,
  baseMs: process.env.KEEPER_RPC_RETRY_BASE_MS ? Number(process.env.KEEPER_RPC_RETRY_BASE_MS) : 2000,
  capMs: process.env.KEEPER_RPC_RETRY_CAP_MS ? Number(process.env.KEEPER_RPC_RETRY_CAP_MS) : 30_000,
};
for (const [k, v] of Object.entries({
  LITVM_RPC_URL: cfg.rpc,
  KEEPER_PRIVATE_KEY: cfg.pk,
  POSITION_MANAGER_ADDRESS: cfg.pmAddr,
  MUSD_ADDRESS: cfg.musdAddr,
})) {
  if (!v) throw new Error(`missing env ${k}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f18 = (v) => ethers.utils.formatUnits(v, 18);
const f8 = (v) => ethers.utils.formatUnits(v, 8);
const now = () => Math.floor(Date.now() / 1000);

// Firing-window tuning. FIRE_BUFFER_MS nudges the wall-clock timer a hair past the
// floor so it doesn't beat the crossing block; REFIRE_MS throttles repeat fire
// attempts on one id so a post-floor revert can't busy-loop the submit path.
const FIRE_BUFFER_MS = 150;
const REFIRE_MS = 1000;

// ---- structured per-id logging --------------------------------------------
// One tagged line per id, with de-duplication on the steady-state phases
// (waiting-delay / not-met) so a resting order doesn't spam the log every tick.
function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
function logId(id, phase, msg = "") {
  console.log(`[${ts()}] req#${id} ${phase}${msg ? " — " + msg : ""}`);
}
function logSys(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ---- transient-RPC classification + retry (RPC-call layer only) ------------
// Distinguish INFRA errors (retryable) from GENUINE contract reverts (fatal to the
// call, handled exactly as before). This is the whole safety story: a real revert
// (TriggerNotMet, SlippageNotMet, RequestNotActive, …) carries decodable revert
// data, so we detect it FIRST and never retry/mask it. Only infra hiccups
// (HTTP 5xx — esp. 504 — SERVER_ERROR, TIMEOUT, NETWORK_ERROR, and a CALL_EXCEPTION
// that is really a server error with no revert data) are treated as transient.
const TRANSIENT_MSG =
  /\b50[0-9]\b|gateway ?time-?out|bad gateway|service unavailable|temporarily unavailable|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|socket hang up|timeout|network ?error/i;

export function isTransient(err) {
  if (!err) return false;
  // 1. Real contract revert? A decodable revert payload => NOT transient. This guard
  //    is what stops an infra retry from ever masking a genuine failure.
  try {
    const data = extractErrorData(err);
    if (typeof data === "string" && data.length >= 10) return false;
  } catch {}
  // 2. ethers v5 transient error codes.
  const code = err.code;
  if (code === "SERVER_ERROR" || code === "TIMEOUT" || code === "NETWORK_ERROR") return true;
  // 3. HTTP 5xx surfaced on the error (esp. 504 from the gateway). ethers hangs the
  //    status off a few shapes; a CALL_EXCEPTION that is really a server error (5xx,
  //    no revert data — step 1 already let it through) is transient per spec.
  const status =
    err.status ?? err.statusCode ?? err.error?.status ?? err.serverError?.status ?? err.response?.status;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  // 4. Message / body text fallback (proxies that only put "504 Gateway Time-out" in
  //    the body). Reached only when there is NO revert data, so matching "timeout"
  //    here can't swallow a real revert.
  const hay = `${err.message || ""} ${err.reason || ""} ${err.body || ""} ${
    err.error?.message || ""
  } ${err.error?.body || ""}`;
  if (TRANSIENT_MSG.test(hay)) return true;
  return false;
}

// Run `fn` (a single RPC call), retrying ONLY transient errors with capped
// exponential backoff. A non-transient error (a real revert, a bad-config error)
// throws IMMEDIATELY — the retry layer shields infra hiccups and nothing else. On
// exhaustion it rethrows the last error so the caller's existing try/catch can
// log-and-continue; the process is never brought down by a transient RPC error.
export async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? RETRY.attempts;
  const baseMs = opts.baseMs ?? RETRY.baseMs;
  const capMs = opts.capMs ?? RETRY.capMs;
  const label = opts.label || "rpc";
  let delay = baseMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt >= attempts) throw err;
      logSys(
        `${label}: transient RPC error (attempt ${attempt}/${attempts}) — ` +
          `${err.code || ""} ${err.message || err}`.trim() +
          ` — retrying in ${(delay / 1000).toFixed(0)}s`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, capMs);
    }
  }
}

// ---- lifecycle stage timing (baseline telemetry, STEP 1 task B) ------------
// Pure observation — no behavior change. Each active entry carries an `t` object
// of wall-clock-ms stamps captured the FIRST time each stage is reached:
//   seen        — discovered into the active set (reconcile)
//   windowOpen  — the delay window opened (market: the fire instant; trigger: the
//                 first tick blockTs >= floor)
//   payload     — a usable RedStone payload (market: pkg ts past the floor;
//                 trigger: static-probe says fillable) is in hand
//   submitted   — executeRequest broadcast (tx hash returned)
//   confirmed   — receipt mined
// On confirm we print the per-stage deltas so we can see which segment dominates.
const dt = (a, b) => (a && b ? `${((b - a) / 1000).toFixed(2)}s` : "n/a");
function logTiming(entry) {
  const t = entry.t || {};
  logId(
    entry.id.toString(),
    "timing",
    `seen→open ${dt(t.seen, t.windowOpen)} | open→payload ${dt(t.windowOpen, t.payload)} | ` +
      `payload→submit ${dt(t.payload, t.submitted)} | submit→confirm ${dt(t.submitted, t.confirmed)} || ` +
      `TOTAL seen→confirm ${dt(t.seen, t.confirmed)}`,
  );
}

async function main() {
  // Reads and sends stay on the proven HTTP provider; only the live subscriptions
  // (logs + newHeads) move to a WebSocket. Keeping the wallet on HTTP means the
  // submit hot path is unchanged from STEP 2.
  const provider = new ethers.providers.JsonRpcProvider(cfg.rpc);
  const wallet = new ethers.Wallet(cfg.pk, provider);
  const pm = new ethers.Contract(cfg.pmAddr, PM_ABI, wallet);
  const musd = new ethers.Contract(cfg.musdAddr, ERC20_ABI, provider);

  const net = await withRetry(() => provider.getNetwork(), { label: "getNetwork" });
  const MIN_DELAY = (
    await withRetry(() => pm.MIN_EXECUTION_DELAY(), { label: "MIN_EXECUTION_DELAY" })
  ).toNumber();
  const EXEC_FEE = await withRetry(() => pm.EXECUTION_FEE(), { label: "EXECUTION_FEE" });
  const startZkltc = await withRetry(() => provider.getBalance(wallet.address), { label: "getBalance" });
  const startMusd = await withRetry(() => musd.balanceOf(wallet.address), { label: "balanceOf" });

  logSys("=== keeper starting ============================================");
  logSys(`keeper account:    ${wallet.address}  (dedicated — earns the fill fee)`);
  logSys(`PositionManager:   ${cfg.pmAddr}`);
  logSys(`chainId:           ${net.chainId}   data service: ${cfg.dataService}`);
  logSys(`MIN_EXEC_DELAY:    ${MIN_DELAY}s     EXECUTION_FEE: ${f18(EXEC_FEE)} mUSD`);
  logSys(`WS endpoints:      ${cfg.wsUrls.join("  |  ")}`);
  logSys(`keeper zkLTC:      ${ethers.utils.formatEther(startZkltc)}`);
  logSys(`keeper mUSD:       ${f18(startMusd)}`);
  logSys("================================================================");

  // ---- active request-id set ----------------------------------------------
  // id(string) -> { id, req, isTrigger, feed, phase, earliest, fireTimer, firing,
  // lastFireMs, t } ; `phase` is the last logged steady-state so we only re-log on
  // change. `fireTimer`/`firing`/`lastFireMs` drive the market scheduler.
  const active = new Map();
  const inFlight = new Set(); // ids with a tx mid-flight — never double-submit
  let feesEarned = ethers.constants.Zero; // cumulative this session
  let fills = 0;
  let scanCursor = 0; // next id not yet walked by the counter catch-up

  // ---- chain clock from newHeads ------------------------------------------
  // The contract gates fills on block.timestamp, so we track the chain clock from
  // the newHeads stream and estimate "chain now" between blocks off the wall clock.
  // Seeded from a getBlock at startup; refreshed on every head.
  let lastHead = null; // { num, tsSec, wallMs }
  function estChainNow() {
    if (!lastHead) return now();
    return lastHead.tsSec + (Date.now() - lastHead.wallMs) / 1000;
  }

  // Read chain state for one id and (re)concile it into the active set. This is
  // the single source of truth: WS events and the counter catch-up both funnel
  // through here, so the set can never drift from requests(id).active. On first
  // discovery of a MARKET request it arms the window-open schedule.
  async function reconcile(id) {
    const key = id.toString();
    if (inFlight.has(key)) return; // a fill is settling; let it finish first
    let req;
    try {
      req = await withRetry(() => pm.requests(id), { label: `requests(${key})` });
    } catch (err) {
      logId(key, "errored", `requests() read failed: ${err.message}`);
      return;
    }
    if (!req.active) {
      const e = active.get(key);
      if (e && e.fireTimer) clearTimeout(e.fireTimer);
      if (active.delete(key)) logId(key, "removed", "no longer active on-chain");
      return;
    }
    let isTrigger = false;
    try {
      isTrigger = !(await withRetry(() => pm.triggers(id), { label: `triggers(${key})` })).triggerPrice.isZero();
    } catch {}
    const feed = feedOf(req.market);
    if (!active.has(key)) {
      const kind = ["Open", "Close", "Decrease", "Increase"][req.kind] ?? `kind${req.kind}`;
      const entry = {
        id,
        req,
        isTrigger,
        feed,
        phase: null,
        earliest: req.requestTimestamp.toNumber() + MIN_DELAY,
        fireTimer: null,
        firing: false,
        lastFireMs: 0,
        t: { seen: Date.now() },
      };
      active.set(key, entry);
      logId(
        key,
        "discovered",
        `${isTrigger ? "TRIGGER" : "MARKET"} ${kind} ${req.isLong ? "long" : "short"} ${feed}` +
          ` (owner ${req.owner.slice(0, 10)}…, requestTs ${req.requestTimestamp})`,
      );
      if (!isTrigger) scheduleMarket(entry); // triggers stay on the loop this step
    } else {
      const e = active.get(key);
      e.req = req;
      e.isTrigger = isTrigger;
      e.feed = feed;
      e.earliest = req.requestTimestamp.toNumber() + MIN_DELAY;
      if (!isTrigger && !e.fireTimer && !e.firing && !inFlight.has(key)) scheduleMarket(e);
    }
  }

  // Catch the counter up: reconcile every id created since the last walk. This
  // is the backfill (from 0 on a cold start) AND the low-frequency backstop for
  // any *Requested log the WS listener might have missed or dropped on reconnect.
  async function catchUpCounter() {
    let next;
    try {
      next = (await withRetry(() => pm.nextRequestId(), { label: "nextRequestId" })).toNumber();
    } catch (err) {
      logSys(`nextRequestId() read failed (transient): ${err.message}`);
      return;
    }
    for (let id = scanCursor; id < next; id++) await reconcile(id);
    scanCursor = next;
  }

  // ---- market window-open scheduler ---------------------------------------
  // On discovery, arm a per-id timer for fireAt = requestTimestamp + MIN_DELAY,
  // sized off the chain-vs-wall skew. The timer is the BACKUP; the newHeads stream
  // (onNewHead) is the precise primary — it releases the fill on the first block
  // that crosses the floor, so the on-chain block.timestamp check passes. Both call
  // fireMarket(), which is idempotent (the `firing`/inFlight/throttle guards make a
  // double release harmless).
  function scheduleMarket(entry) {
    if (entry.isTrigger) return;
    const key = entry.id.toString();
    if (entry.fireTimer) {
      clearTimeout(entry.fireTimer);
      entry.fireTimer = null;
    }
    const waitMs = Math.max(0, (entry.earliest - estChainNow()) * 1000 + FIRE_BUFFER_MS);
    if (waitMs <= 0) {
      fireMarket(entry, "past-floor");
      return;
    }
    if (entry.phase !== "scheduled") {
      logId(key, "scheduled", `fire in ${(waitMs / 1000).toFixed(2)}s (floor ${entry.earliest})`);
      entry.phase = "scheduled";
    }
    entry.fireTimer = setTimeout(() => fireMarket(entry, "timer"), waitMs);
  }

  // Fire one MARKET request: fetch ONE fresh payload and run the STEP-2 hot path
  // (build -> sign -> broadcast). Guards make it safe to call from the timer, the
  // newHeads release, and the loop backstop at once. If released a hair early (wall
  // clock ahead of chain) or the payload isn't yet stamped past the floor, it
  // re-arms a short bounded retry instead of eating a TooEarlyToExecute revert.
  async function fireMarket(entry, via) {
    const key = entry.id.toString();
    if (!active.has(key) || entry.isTrigger) return;
    if (entry.firing || inFlight.has(key)) return;
    if (entry.lastFireMs && Date.now() - entry.lastFireMs < REFIRE_MS) return;
    if (entry.fireTimer) {
      clearTimeout(entry.fireTimer);
      entry.fireTimer = null;
    }
    // Floor guard: only proceed once the chain clock has reached the window. A
    // timer that beat the crossing block re-arms for the residual.
    if (estChainNow() < entry.earliest) {
      const waitMs = Math.max(50, (entry.earliest - estChainNow()) * 1000 + FIRE_BUFFER_MS);
      entry.fireTimer = setTimeout(() => fireMarket(entry, "rearm"), waitMs);
      return;
    }
    entry.firing = true;
    entry.lastFireMs = Date.now();
    entry.t.windowOpen ??= Date.now(); // window has opened — we are acting on it
    try {
      // ONE fetch: read the package timestamp for the freshness gate AND hold the
      // package to inject calldata — no second requestDataPackages on the submit path.
      const { pkgs, ts: pkgTs } = await fetchPackages(cfg.dataService, entry.feed);
      if (pkgTs < entry.earliest) {
        // Payload not yet stamped past the floor (clock skew) — brief bounded retry.
        if (entry.phase !== "waiting-payload") {
          logId(key, "waiting-payload", `need ${entry.feed} pkg ts >= ${entry.earliest}, have ${pkgTs}`);
          entry.phase = "waiting-payload";
        }
        entry.firing = false;
        entry.lastFireMs = 0; // self-scheduled retry — exempt from the refire throttle
        entry.fireTimer = setTimeout(() => fireMarket(entry, "pkg-retry"), 500);
        return;
      }
      entry.t.payload ??= Date.now(); // fresh-enough package obtained
      const txReq = await buildTx(entry, pkgs);
      await execute(entry, txReq); // owns inFlight + re-reconciles (drops if filled)
    } catch (err) {
      logId(key, "errored", `fire(${via}) failed (transient): ${err.message}`);
    } finally {
      entry.firing = false;
    }
  }

  // ---- newHeads handler ---------------------------------------------------
  // Update the chain clock and release any market past its floor on the FIRST
  // block that crosses it (precise, sub-block-time latency, no TooEarly revert).
  function onNewHead(num, tsSec) {
    if (lastHead && num <= lastHead.num) return; // ignore out-of-order/dup
    lastHead = { num, tsSec, wallMs: Date.now() };
    for (const entry of active.values()) {
      if (entry.isTrigger || entry.firing || inFlight.has(entry.id.toString())) continue;
      if (tsSec >= entry.earliest) fireMarket(entry, "newHead");
    }
  }

  // ---- sequential nonce manager -------------------------------------------
  // One keeper account, one tx in flight at a time (we await each send). An
  // explicit nonce makes the ordering deterministic; we resync from chain after
  // any send error so a dropped/replaced tx can't wedge the pipeline.
  let nonce = await withRetry(() => provider.getTransactionCount(wallet.address, "latest"), {
    label: "getTransactionCount",
  });
  async function resyncNonce() {
    nonce = await withRetry(() => provider.getTransactionCount(wallet.address, "latest"), {
      label: "resyncNonce",
    });
  }

  // ---- cached gas limit + fee data (keep the submit hot path RPC-free) -----
  // Left to ethers, every sendTransaction does eth_estimateGas + eth_getFeeData
  // before broadcasting — two RPCs on the critical path. We cache both so the hot
  // path is just eth_sendRawTransaction:
  //   gasLimit — estimated ONCE off the first real fill (guaranteed fillable, so
  //              the estimate can't revert), then held at estimate×2 (with a
  //              generous floor) for every later fill. On sub-cent gas an
  //              over-provided cap is free — you pay for gas used, not the cap — so
  //              the 2× headroom covers the worst-case path (liquidation / large
  //              position) without re-estimating. A low-gas send drops the cache so
  //              the next fill re-estimates.
  //   feeData  — primed at startup and refreshed on a 30s timer (and on any send
  //              error), bumped 2× so a base-fee move inside the window can't
  //              underprice us. Hot path reads the cached override, never the RPC.
  const GAS_FLOOR = ethers.BigNumber.from(2_000_000); // generous worst-case ceiling
  let cachedGasLimit = null;
  async function ensureGasLimit(txReq) {
    if (cachedGasLimit) return cachedGasLimit;
    // estimateGas of a guaranteed-fillable tx can't revert, so any throw here is
    // infra; a would-revert estimate carries revert data and isTransient=false, so
    // it still surfaces immediately (unchanged behavior).
    const est = await withRetry(() => wallet.estimateGas(txReq), { label: "estimateGas" });
    cachedGasLimit = est.mul(2);
    if (cachedGasLimit.lt(GAS_FLOOR)) cachedGasLimit = GAS_FLOOR;
    logSys(`gas limit cached @ ${cachedGasLimit} (estimate ${est} ×2, floor ${GAS_FLOOR})`);
    return cachedGasLimit;
  }
  let feeOverride = null;
  async function refreshFee() {
    try {
      const fd = await withRetry(() => provider.getFeeData(), { label: "getFeeData" });
      if (fd.maxFeePerGas && fd.maxPriorityFeePerGas) {
        feeOverride = {
          maxFeePerGas: fd.maxFeePerGas.mul(2),
          maxPriorityFeePerGas: fd.maxPriorityFeePerGas.mul(2),
        };
      } else if (fd.gasPrice) {
        feeOverride = { gasPrice: fd.gasPrice.mul(2) };
      }
    } catch (err) {
      logSys(`fee refresh failed (keeping cached): ${err.message}`);
    }
  }
  await refreshFee(); // prime before the first fill
  setInterval(refreshFee, 30_000).unref?.(); // background refresh; never blocks a fill

  // Stamp the cached nonce, gas limit, and fee override onto a built tx so
  // sendTransaction skips eth_estimateGas and eth_getFeeData.
  async function readyTx(txReq) {
    txReq.nonce = nonce;
    txReq.gasLimit = await ensureGasLimit(txReq);
    if (feeOverride) Object.assign(txReq, feeOverride);
    return txReq;
  }

  // Build the payload-bearing executeRequest tx from ALREADY-FETCHED packages.
  // The wrapper only appends the signed payload to calldata here (no gas estimate,
  // no network) — gas is estimated later at sendTransaction — so this is safe to
  // pre-build even for a resting trigger that wouldn't fill.
  async function buildTx(entry, pkgs) {
    const wrapped = wrapWithPackages(pm, pkgs);
    return wrapped.populateTransaction.executeRequest(entry.id);
  }

  // Send a real executeRequest for one id and classify the receipt. `txReq` is the
  // tx pre-built from the package fetched at the freshness gate / probe — so the
  // critical path here is just sign + broadcast, NOT a second RedStone round-trip.
  // The contract decides the outcome — we just report it. Updates fee/fill counters
  // and re-reconciles the id (which drops it once inactive).
  async function execute(entry, txReq) {
    const key = entry.id.toString();
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await readyTx(txReq);
      logId(key, "executing", `nonce ${nonce}`);
      let sent;
      try {
        sent = await wallet.sendTransaction(txReq);
      } catch (err) {
        // ONE retry covering the two benign send-time rejections of a cached path:
        //   stale  — the reused package is only ~1s old, so on-chain freshness
        //            should always pass; if it's ever rejected, refetch + rebuild.
        //   reprice/regas — a cached fee underpriced by a base-fee move, or a cached
        //            gas limit too low for this path: drop both caches, refresh, and
        //            re-ready so the retry re-estimates. (Neither hit in test fills.)
        const reason = revertReason(pm.interface, err);
        const stale = /Timestamp|Stale|TooOld|TooLongFuture/i.test(reason);
        const repriceRegas =
          /out of gas|intrinsic gas|gas required exceeds|underpriced|max fee per gas|fee too low/i.test(
            reason,
          );
        if (!stale && !repriceRegas) throw err;
        logId(key, "submit-retry", `${stale ? "stale pkg" : "reprice/regas"} (${reason})`);
        cachedGasLimit = null; // force a fresh estimate
        await refreshFee(); // force a fresh price
        await resyncNonce();
        if (stale) {
          const { pkgs } = await fetchPackages(cfg.dataService, entry.feed);
          txReq = await buildTx(entry, pkgs);
        }
        await readyTx(txReq);
        sent = await wallet.sendTransaction(txReq);
      }
      nonce++;
      entry.t.submitted = Date.now();
      const rcpt = await sent.wait();
      entry.t.confirmed = Date.now();
      logTiming(entry);

      // Outcome from the receipt only. A fill emits RequestExecuted; a MARKET
      // slippage miss emits RequestCancelled(slippage=true) (the tx still
      // succeeds). We do not re-derive either.
      const evs = rcpt.logs
        .filter((l) => l.address.toLowerCase() === pm.address.toLowerCase())
        .map((l) => {
          try {
            return pm.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const executed = evs.find((e) => e.name === "RequestExecuted");
      const cancelled = evs.find((e) => e.name === "RequestCancelled");
      if (executed) {
        fills++;
        const earnedFee = executed.args.keeper.toLowerCase() === wallet.address.toLowerCase();
        if (earnedFee) feesEarned = feesEarned.add(EXEC_FEE);
        logId(
          key,
          "filled",
          `@ ${f8(executed.args.executionPrice)}  tx ${rcpt.transactionHash.slice(0, 12)}…` +
            (earnedFee ? `  +${f18(EXEC_FEE)} mUSD fee` : ""),
        );
      } else if (cancelled) {
        logId(
          key,
          "cancelled",
          `${cancelled.args.slippage ? "slippage auto-cancel" : "owner reclaim"} — no fee` +
            `  tx ${rcpt.transactionHash.slice(0, 12)}…`,
        );
      } else {
        logId(key, "filled", `tx ${rcpt.transactionHash.slice(0, 12)}… (no event parsed)`);
      }
    } catch (err) {
      const reason = revertReason(pm.interface, err);
      // A real-tx revert is expected and benign in two cases:
      //   - RequestNotActive: we lost the race, someone else filled/cancelled it.
      //   - TriggerNotMet / SlippageNotMet: price moved back between the static
      //     probe and the send — the order is still resting, retry next loop.
      if (/RequestNotActive/.test(reason)) {
        logId(key, "removed", "lost race — already executed/cancelled");
      } else if (/TriggerNotMet|SlippageNotMet/.test(reason)) {
        logId(key, "not-met", `price moved back before send (${reason}) — still resting`);
      } else {
        logId(key, "errored", reason);
      }
      await resyncNonce(); // a failed send may not have consumed the nonce
    } finally {
      inFlight.delete(key);
      await reconcile(entry.id); // drop it if the chain says it's done
    }
  }

  // Decide and act on one resting TRIGGER this tick. (Markets are scheduler-driven
  // now; this is the unchanged STEP-2 trigger path, still on the loop this step.)
  async function processTrigger(entry, blockTs) {
    const key = entry.id.toString();
    if (inFlight.has(key)) return;
    if (blockTs >= entry.earliest) entry.t.windowOpen ??= Date.now(); // delay window opened

    // Resting order: never blind-send. Static-probe fillability first.
    if (blockTs < entry.earliest) {
      if (entry.phase !== "waiting-delay") {
        logId(key, "waiting-delay", `trigger min-delay until ${entry.earliest}`);
        entry.phase = "waiting-delay";
      }
      return;
    }
    // Fetch the package ONCE, build the payload-bearing tx, and probe with it.
    // On a fillable probe we reuse that exact tx for the real send — no second
    // RedStone fetch, no re-populate.
    let txReq, probe;
    try {
      const { pkgs } = await fetchPackages(cfg.dataService, entry.feed);
      txReq = await buildTx(entry, pkgs);
      probe = await staticExecuteCheck(provider, pm.interface, txReq, wallet.address);
    } catch (err) {
      logId(key, "errored", `static probe failed (transient): ${err.message}`);
      return;
    }
    if (probe.ok) {
      entry.phase = "fillable";
      entry.t.payload ??= Date.now(); // probe-fillable ⇒ a usable payload is in hand
      await execute(entry, txReq);
    } else if (entry.phase !== "not-met") {
      logId(key, "not-met", probe.reason);
      entry.phase = "not-met";
    }
  }

  // ---- live WS wiring (logs + newHeads), with reconnect -------------------
  // Subscriptions live on a WebSocket; reads/sends stay on HTTP. A *Requested log
  // -> reconcile immediately; RequestExecuted / RequestCancelled likewise remove.
  // On a socket close we tear down, alternate to the fallback URL, reconnect, and
  // run catchUpCounter() to backfill any gap. Market timers live in-process, so a
  // WS outage never loses a scheduled fill — the socket only sharpens the trigger.
  const REQUESTED = [
    "OpenRequested",
    "CloseRequested",
    "DecreaseRequested",
    "IncreaseRequested",
    "TriggerOpenRequested",
    "TriggerCloseRequested",
    "TriggerDecreaseRequested",
    "TriggerIncreaseRequested",
  ];
  let wsProvider = null;
  let pmWs = null;
  let wsTries = 0;
  let reconnecting = false;

  function teardownWs() {
    const w = wsProvider;
    wsProvider = null;
    try {
      if (pmWs) pmWs.removeAllListeners();
    } catch {}
    pmWs = null;
    // Strip the raw socket listeners BEFORE destroy() so its own close event can't
    // re-enter our close handler and double-schedule a reconnect.
    try {
      w?._websocket?.removeAllListeners();
    } catch {}
    try {
      w?.destroy();
    } catch {}
  }

  function scheduleReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    const delay = Math.min(1000 * (wsTries + 1), 15_000);
    setTimeout(async () => {
      reconnecting = false;
      wsTries++;
      logSys(`WS reconnect attempt ${wsTries}…`);
      setupWs();
      // Gap backfill: any *Requested logs missed while the socket was down are
      // recovered by walking the id counter (chain state is authoritative).
      await catchUpCounter().catch((e) => logSys(`reconnect catch-up failed: ${e.message}`));
    }, delay);
  }

  function setupWs() {
    const url = cfg.wsUrls[wsTries % cfg.wsUrls.length];
    try {
      wsProvider = new ethers.providers.WebSocketProvider(url);
    } catch (e) {
      logSys(`WS create failed (${url}): ${e.message}`);
      scheduleReconnect();
      return;
    }
    pmWs = new ethers.Contract(cfg.pmAddr, PM_ABI, wsProvider);
    for (const ev of REQUESTED) {
      pmWs.on(ev, (requestId) => {
        reconcile(requestId).catch((e) => logSys(`reconcile(${requestId}) failed: ${e.message}`));
      });
    }
    for (const ev of ["RequestExecuted", "RequestCancelled"]) {
      pmWs.on(ev, (requestId) => {
        reconcile(requestId).catch((e) => logSys(`reconcile(${requestId}) failed: ${e.message}`));
      });
    }
    // newHeads with the full header (timestamp) so we can release fills on the
    // crossing block without a per-block getBlock RPC.
    wsProvider._subscribe("keeperHeads", ["newHeads"], (header) => {
      try {
        onNewHead(
          ethers.BigNumber.from(header.number).toNumber(),
          ethers.BigNumber.from(header.timestamp).toNumber(),
        );
      } catch {}
    });
    const sock = wsProvider._websocket;
    sock.on("open", () => {
      wsTries = 0; // healthy — reset the URL rotation / backoff
      logSys(`WS connected: ${url}`);
    });
    sock.on("close", (code) => {
      logSys(`WS closed (code ${code}) — tearing down + reconnecting`);
      teardownWs();
      scheduleReconnect();
    });
    sock.on("error", (err) => {
      logSys(`WS error: ${err.message || err}`);
    });
  }

  // ---- startup ------------------------------------------------------------
  if (cfg.startBlock !== undefined) {
    logSys(`START_BLOCK=${cfg.startBlock} set — live listeners attach from current head;`);
    logSys(`backfill walks the id counter (chain state is authoritative & idempotent).`);
  }
  // Seed the chain clock before scheduling anything off it.
  try {
    const b = await withRetry(() => provider.getBlock("latest"), { label: "getBlock(latest)" });
    lastHead = { num: b.number, tsSec: b.timestamp, wallMs: Date.now() };
  } catch (err) {
    logSys(`initial getBlock failed (will seed from newHeads): ${err.message}`);
  }
  logSys("backfilling active requests from the id counter…");
  await catchUpCounter();
  logSys(`backfill complete — ${active.size} active request(s).`);

  setupWs(); // attach the live WS subscriptions
  setInterval(() => {
    catchUpCounter().catch((e) => logSys(`periodic catch-up failed: ${e.message}`));
  }, cfg.catchUpMs).unref?.(); // low-frequency backstop for any missed log

  // ---- main loop ----------------------------------------------------------
  // Triggers run their per-tick static probe here (unchanged). Markets are
  // scheduler-driven (timer + newHeads); the loop only acts as a post-floor
  // backstop for them, so a stalled timer AND a dead socket can't strand a fill.
  let tick = 0;
  for (;;) {
    try {
      const blockTs = Math.floor(estChainNow());
      // Snapshot to avoid mutating the map mid-iteration (execute() reconciles).
      for (const entry of [...active.values()]) {
        if (entry.isTrigger) {
          await processTrigger(entry, blockTs);
        } else if (
          blockTs >= entry.earliest &&
          !entry.firing &&
          !entry.fireTimer &&
          !inFlight.has(entry.id.toString())
        ) {
          await fireMarket(entry, "loop-backstop");
        }
      }
    } catch (err) {
      logSys(`loop error: ${err.message}`);
    }

    // Heartbeat every ~10 ticks so the operator sees liveness.
    if (tick % 10 === 0) {
      try {
        const bal = await withRetry(() => provider.getBalance(wallet.address), { label: "hb getBalance" });
        const mb = await withRetry(() => musd.balanceOf(wallet.address), { label: "hb balanceOf" });
        const mark = await fetchMark(cfg.dataService, "BTC").catch(() => null);
        logSys(
          `heartbeat — active ${active.size}, in-flight ${inFlight.size}, fills ${fills}, ` +
            `fees earned ${f18(feesEarned)} mUSD | keeper zkLTC ${ethers.utils.formatEther(bal)}, ` +
            `mUSD ${f18(mb)}${mark ? `, BTC ${f8(mark.price1e8)}` : ""}` +
            `${lastHead ? ` | head #${lastHead.num}` : ""}`,
        );
      } catch {}
    }
    tick++;
    await sleep(cfg.loopMs);
  }
}

// ---- entrypoint / supervisor ----------------------------------------------
// main() runs forever (the loop + timers self-heal via the in-call withRetry above).
// A TRANSIENT error can still escape main() only in the narrow startup window
// BEFORE the resilient loop is reached AND after the per-call retry budget is spent
// (a prolonged outage). We must NOT crash-loop the process there: log it, back off,
// and re-run main(). The reads that can throw through to here (getNetwork /
// MIN_EXECUTION_DELAY / EXECUTION_FEE / balances / nonce) all run before any WS or
// interval is created, so a restart is clean — no leaked sockets/timers. Only a
// genuine fatal (missing env, a real bug/revert) exits non-zero.
async function supervise() {
  let backoffMs = RETRY.baseMs;
  for (;;) {
    try {
      await main();
      return; // main() only returns on intentional shutdown
    } catch (err) {
      if (!isTransient(err)) {
        console.error(err);
        process.exit(1);
      }
      logSys(
        `startup hit a transient RPC error — ${err.code || ""} ${err.message || err}`.trim() +
          ` — RPC likely degraded; restarting in ${(backoffMs / 1000).toFixed(0)}s (will keep waiting)`,
      );
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, RETRY.capMs);
    }
  }
}

// Launch only when executed directly, so a test can import isTransient / withRetry
// without starting the keeper.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) supervise();
