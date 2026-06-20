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
// DISCOVERY  Maintain the active request-id set. Backfill by walking the id
//            counter and reconciling each id against requests(id).active (so a
//            restart is idempotent — it rebuilds the exact live set from chain
//            state). Stay live via the *Requested events (add) and
//            RequestExecuted / RequestCancelled (remove); every event handler
//            re-reads chain state through the same reconcile(), so listeners can
//            never desync the set. A per-loop counter catch-up backstops any
//            missed log.
//
// EXECUTION  by kind (a request is a TRIGGER iff triggers(id).triggerPrice != 0):
//   - MARKET   once now >= requestTimestamp + MIN_EXECUTION_DELAY and a payload
//              stamped past that floor exists, send executeRequest. The contract
//              fills OR auto-cancels on slippage — we record the receipt's
//              outcome, we don't second-guess it.
//   - TRIGGER  each loop, STATIC-probe fillability (provider.call via the
//              revert-decoder). Send the real executeRequest ONLY on a probe that
//              would succeed; otherwise it's still resting — try again next loop.
//
// Usage:  cd keeper && cp .env.example .env && edit .env && node keeper.mjs
//   (reads keeper/.env via --env-file or a manual source; see README.md)

import { ethers } from "ethers";
import { PM_ABI, ERC20_ABI } from "./lib/abi.mjs";
import { makeWrap, feedOf, fetchMark, payloadTimestampSec } from "./lib/redstone.mjs";
import { revertReason, staticExecuteCheck } from "./lib/revert.mjs";

// ---- config ---------------------------------------------------------------
const cfg = {
  rpc: process.env.LITVM_RPC_URL,
  pk: process.env.KEEPER_PRIVATE_KEY,
  pmAddr: process.env.POSITION_MANAGER_ADDRESS,
  musdAddr: process.env.MUSD_ADDRESS,
  dataService: process.env.REDSTONE_DATA_SERVICE || "redstone-primary-prod",
  startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : undefined,
  loopMs: process.env.KEEPER_LOOP_MS ? Number(process.env.KEEPER_LOOP_MS) : 2500,
};
for (const [k, v] of Object.entries({
  LITVM_RPC_URL: cfg.rpc,
  KEEPER_PRIVATE_KEY: cfg.pk,
  POSITION_MANAGER_ADDRESS: cfg.pmAddr,
  MUSD_ADDRESS: cfg.musdAddr,
})) {
  if (!v) throw new Error(`missing env ${k}`);
}

const wrap = makeWrap(cfg.dataService);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f18 = (v) => ethers.utils.formatUnits(v, 18);
const f8 = (v) => ethers.utils.formatUnits(v, 8);
const now = () => Math.floor(Date.now() / 1000);

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

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(cfg.rpc);
  const wallet = new ethers.Wallet(cfg.pk, provider);
  const pm = new ethers.Contract(cfg.pmAddr, PM_ABI, wallet);
  const musd = new ethers.Contract(cfg.musdAddr, ERC20_ABI, provider);

  const net = await provider.getNetwork();
  const MIN_DELAY = (await pm.MIN_EXECUTION_DELAY()).toNumber();
  const EXEC_FEE = await pm.EXECUTION_FEE();
  const startZkltc = await provider.getBalance(wallet.address);
  const startMusd = await musd.balanceOf(wallet.address);

  logSys("=== keeper starting ============================================");
  logSys(`keeper account:    ${wallet.address}  (dedicated — earns the fill fee)`);
  logSys(`PositionManager:   ${cfg.pmAddr}`);
  logSys(`chainId:           ${net.chainId}   data service: ${cfg.dataService}`);
  logSys(`MIN_EXEC_DELAY:    ${MIN_DELAY}s     EXECUTION_FEE: ${f18(EXEC_FEE)} mUSD`);
  logSys(`keeper zkLTC:      ${ethers.utils.formatEther(startZkltc)}`);
  logSys(`keeper mUSD:       ${f18(startMusd)}`);
  logSys("================================================================");

  // ---- active request-id set ----------------------------------------------
  // id(string) -> { id, req, isTrigger, feed, phase } ; `phase` is the last
  // logged steady-state so we only re-log on change.
  const active = new Map();
  const inFlight = new Set(); // ids with a tx mid-flight — never double-submit
  let feesEarned = ethers.constants.Zero; // cumulative this session
  let fills = 0;
  let scanCursor = 0; // next id not yet walked by the counter catch-up

  // Read chain state for one id and (re)concile it into the active set. This is
  // the single source of truth: events and the counter catch-up both funnel
  // through here, so the set can never drift from requests(id).active.
  async function reconcile(id) {
    const key = id.toString();
    if (inFlight.has(key)) return; // a fill is settling; let it finish first
    let req;
    try {
      req = await pm.requests(id);
    } catch (err) {
      logId(key, "errored", `requests() read failed: ${err.message}`);
      return;
    }
    if (!req.active) {
      if (active.delete(key)) logId(key, "removed", "no longer active on-chain");
      return;
    }
    let isTrigger = false;
    try {
      isTrigger = !(await pm.triggers(id)).triggerPrice.isZero();
    } catch {}
    const feed = feedOf(req.market);
    if (!active.has(key)) {
      const kind = ["Open", "Close", "Decrease", "Increase"][req.kind] ?? `kind${req.kind}`;
      active.set(key, { id, req, isTrigger, feed, phase: null });
      logId(
        key,
        "discovered",
        `${isTrigger ? "TRIGGER" : "MARKET"} ${kind} ${req.isLong ? "long" : "short"} ${feed}` +
          ` (owner ${req.owner.slice(0, 10)}…, requestTs ${req.requestTimestamp})`,
      );
    } else {
      const e = active.get(key);
      e.req = req;
      e.isTrigger = isTrigger;
      e.feed = feed;
    }
  }

  // Catch the counter up: reconcile every id created since the last walk. This
  // is the backfill (from 0 on a cold start, or START_BLOCK-independent) AND the
  // per-loop backstop for any *Requested log the listener might have missed.
  async function catchUpCounter() {
    let next;
    try {
      next = (await pm.nextRequestId()).toNumber();
    } catch (err) {
      logSys(`nextRequestId() read failed (transient): ${err.message}`);
      return;
    }
    for (let id = scanCursor; id < next; id++) await reconcile(id);
    scanCursor = next;
  }

  // ---- live event wiring --------------------------------------------------
  // Every *Requested event adds; RequestExecuted / RequestCancelled remove. Each
  // handler just re-reads chain state via reconcile(), so listeners stay
  // authoritative even under reorgs or duplicate deliveries.
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
  for (const ev of REQUESTED) {
    pm.on(ev, (requestId) => {
      reconcile(requestId).catch((e) => logSys(`reconcile(${requestId}) failed: ${e.message}`));
    });
  }
  for (const ev of ["RequestExecuted", "RequestCancelled"]) {
    pm.on(ev, (requestId) => {
      reconcile(requestId).catch((e) => logSys(`reconcile(${requestId}) failed: ${e.message}`));
    });
  }

  // ---- sequential nonce manager -------------------------------------------
  // One keeper account, one tx in flight at a time (we await each send). An
  // explicit nonce makes the ordering deterministic; we resync from chain after
  // any send error so a dropped/replaced tx can't wedge the pipeline.
  let nonce = await provider.getTransactionCount(wallet.address, "latest");
  async function resyncNonce() {
    nonce = await provider.getTransactionCount(wallet.address, "latest");
  }

  // Send a real executeRequest for one id and classify the receipt. The contract
  // decides the outcome — we just report it. Returns nothing; updates fee/fill
  // counters and re-reconciles the id (which drops it once inactive).
  async function execute(entry) {
    const key = entry.id.toString();
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      // Build the payload-bearing tx once (same wrap path the static probe used),
      // then send it with an explicit nonce.
      const wrapped = wrap(pm, entry.feed);
      const txReq = await wrapped.populateTransaction.executeRequest(entry.id);
      txReq.nonce = nonce;
      logId(key, "executing", `nonce ${nonce}`);
      const sent = await wallet.sendTransaction(txReq);
      nonce++;
      const rcpt = await sent.wait();

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

  // Decide and act on one active request this tick.
  async function process(entry, blockTs) {
    const key = entry.id.toString();
    if (inFlight.has(key)) return;
    const earliest = entry.req.requestTimestamp.toNumber() + MIN_DELAY;

    if (entry.isTrigger) {
      // Resting order: never blind-send. Static-probe fillability first.
      if (blockTs < earliest) {
        if (entry.phase !== "waiting-delay") {
          logId(key, "waiting-delay", `trigger min-delay until ${earliest}`);
          entry.phase = "waiting-delay";
        }
        return;
      }
      let probe;
      try {
        const wrapped = wrap(pm, entry.feed);
        const txReq = await wrapped.populateTransaction.executeRequest(entry.id);
        probe = await staticExecuteCheck(provider, pm.interface, txReq, wallet.address);
      } catch (err) {
        logId(key, "errored", `static probe failed (transient): ${err.message}`);
        return;
      }
      if (probe.ok) {
        entry.phase = "fillable";
        await execute(entry);
      } else if (entry.phase !== "not-met") {
        logId(key, "not-met", probe.reason);
        entry.phase = "not-met";
      }
      return;
    }

    // MARKET order: wait out the delay, then require a payload past the floor.
    if (blockTs < earliest) {
      if (entry.phase !== "waiting-delay") {
        logId(key, "waiting-delay", `min-delay until ${earliest} (now ${blockTs})`);
        entry.phase = "waiting-delay";
      }
      return;
    }
    let pkgTs = 0;
    try {
      pkgTs = await payloadTimestampSec(cfg.dataService, entry.feed);
    } catch (err) {
      logId(key, "errored", `payload fetch failed (transient): ${err.message}`);
      return;
    }
    if (pkgTs < earliest) {
      if (entry.phase !== "waiting-payload") {
        logId(key, "waiting-payload", `need ${entry.feed} pkg ts >= ${earliest}, have ${pkgTs}`);
        entry.phase = "waiting-payload";
      }
      return;
    }
    await execute(entry);
  }

  // ---- startup backfill ---------------------------------------------------
  if (cfg.startBlock !== undefined) {
    logSys(`START_BLOCK=${cfg.startBlock} set — live listeners attach from current head;`);
    logSys(`backfill walks the id counter (chain state is authoritative & idempotent).`);
  }
  logSys("backfilling active requests from the id counter…");
  await catchUpCounter();
  logSys(`backfill complete — ${active.size} active request(s).`);

  // ---- main loop ----------------------------------------------------------
  let tick = 0;
  let backoff = 0;
  for (;;) {
    try {
      await catchUpCounter(); // discover new ids + backstop missed logs
      const blockTs = (await provider.getBlock("latest")).timestamp;
      // Snapshot to avoid mutating the map mid-iteration (execute() reconciles).
      for (const entry of [...active.values()]) {
        await process(entry, blockTs);
      }
      backoff = 0;
    } catch (err) {
      backoff = Math.min(backoff + 1, 5);
      logSys(`loop error (backoff x${backoff}): ${err.message}`);
    }

    // Heartbeat every ~10 ticks, or whenever idle so the operator sees liveness.
    if (tick % 10 === 0) {
      try {
        const bal = await provider.getBalance(wallet.address);
        const mb = await musd.balanceOf(wallet.address);
        const mark = await fetchMark(cfg.dataService, "BTC").catch(() => null);
        logSys(
          `heartbeat — active ${active.size}, in-flight ${inFlight.size}, fills ${fills}, ` +
            `fees earned ${f18(feesEarned)} mUSD | keeper zkLTC ${ethers.utils.formatEther(bal)}, ` +
            `mUSD ${f18(mb)}${mark ? `, BTC ${f8(mark.price1e8)}` : ""}`,
        );
      } catch {}
    }
    tick++;
    await sleep(cfg.loopMs * (1 + backoff)); // linear backoff on sustained errors
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
