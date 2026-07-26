// Scan-coverage cursor store: driver interface + the validation policy + the resume glue.
//
// ============================================================================
// THIS IS NOT THE VERDICT CACHE, AND THE DISTINCTION IS THE WHOLE POINT.
// ============================================================================
// cache.js persists ANSWERS, and its policy is that only a proven completion may be
// written — a `false` never reaches storage. This file persists COVERAGE: intervals of
// blocks that were read and held no matching event. That is a fact about work done, not an
// answer, so it is safe to persist freely — and it has to be, because accumulating it
// across polls is the only way a deep-history negative can ever be proven at all.
//
// The two must never be conflated:
//
//   quest_completion (cache.js)  a row EXISTS  ⟺ this wallet proved this quest
//   quest_cursor     (this file) a row says    "blocks [scanned_to .. scanned_from] of this
//                                               contract were read and were empty"
//
// There is no column here that could hold a verdict, and no code path that writes one. The
// derivation from these intervals to `confirmed: false` lives in ONE place —
// coverageProvesAbsence() in scan.js — and runs fresh on every read. So the failure modes
// of this store are all in the safe direction: a lost row, a stale row, a rejected row and
// a driver outage all mean LESS coverage, and less coverage derives to indeterminate.
//
// DRIVER INTERFACE — { load(id), save(id, rows) }, both async, neither may throw:
//   load → array of {sourceKey, floorBlock, scannedFrom, scannedTo}; [] on a miss.
//   save → upsert those rows for `id`. Fire-and-forget.
// Same shape and same reasoning as cache.js's driver interface: a Supabase driver is a new
// file rather than a rewrite, and a broken store costs latency, never correctness.

import { scanForEvent } from "./scan.js";

const WALLET_RE = /^0x[0-9a-f]{40}$/;

/** Blocks are non-negative integers. Anything else is a corrupt row, not a small mistake. */
function toBlock(value) {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Normalize the (chain, wallet, quest) a cursor row belongs to, or null if it is not a
 * usable identity. Lower-casing the wallet HERE, at the boundary, is what stops checksum
 * casing from splitting one wallet's coverage across two rows and making a completed walk
 * look permanently partial — the same rule cacheKey() applies, and the table CHECKs.
 */
export function normalizeIdentity(id) {
  if (!id || typeof id !== "object") return null;

  const chainId = typeof id.chainId === "string" ? Number.parseInt(id.chainId, 10) : id.chainId;
  if (!Number.isInteger(chainId) || chainId <= 0) return null;

  const wallet = typeof id.wallet === "string" ? id.wallet.trim().toLowerCase() : "";
  if (!WALLET_RE.test(wallet)) return null;

  const quest = typeof id.quest === "string" ? id.quest.trim() : "";
  if (!quest) return null;

  return { chainId, wallet, quest };
}

/**
 * Validate one coverage interval, in both directions (rows read from storage and rows about
 * to be written to it). Returns the normalized row, or null to DROP it.
 *
 * These mirror the table's CHECK constraints deliberately rather than trusting them:
 *   - on WRITE, a row that would violate a CHECK fails the whole batch at PostgREST, so
 *     one bad interval would silently discard every other source's honest progress;
 *   - on READ, a row that somehow got past them must not be allowed to buy a proven
 *     negative. Dropping it costs a re-walk. Trusting it could cost a wrong answer.
 */
export function normalizeCoverageRow(row) {
  if (!row || typeof row !== "object") return null;

  const sourceKey = typeof row.sourceKey === "string" ? row.sourceKey.trim().toLowerCase() : "";
  if (!sourceKey) return null;

  const floorBlock = toBlock(row.floorBlock);
  const scannedFrom = toBlock(row.scannedFrom);
  const scannedTo = toBlock(row.scannedTo);
  if (floorBlock === null || scannedFrom === null || scannedTo === null) return null;

  // Coverage below the floor is meaningless — the contract did not exist there — and an
  // inverted interval is not an interval. Either one signals a floor/address mix-up.
  if (scannedTo < floorBlock) return null;
  if (scannedTo > scannedFrom) return null;

  return { sourceKey, floorBlock, scannedFrom, scannedTo };
}

/** No-op driver: coverage is never remembered, so every poll restarts from head. */
export function nullCursorDriver() {
  return {
    async load() {
      return [];
    },
    async save() {},
  };
}

/**
 * In-process cursor store. Convergence within the life of one warm instance only — a cold
 * start throws the coverage away and the walk restarts from head.
 *
 * That makes it near-useless for the deep-history case it exists to solve, and it is still
 * the right DEFAULT: it is the honest in-memory analogue of the durable store, it keeps the
 * resume code path exercised in dev and test, and losing coverage is the safe failure. Use
 * the Supabase driver for anything that actually needs to converge.
 */
export function memoryCursorDriver() {
  const rows = new Map();

  const prefix = (id) => `${id.chainId}:${id.wallet}:${id.quest}:`;

  return {
    async load(id) {
      const p = prefix(id);
      return [...rows.entries()].filter(([k]) => k.startsWith(p)).map(([, v]) => v);
    },

    async save(id, batch) {
      for (const row of batch) rows.set(prefix(id) + row.sourceKey, row);
    },

    _size: () => rows.size,
  };
}

/**
 * Wrap a driver with validation and failure isolation.
 *
 * A store that throws, times out or returns nonsense degrades to "no coverage" — the same
 * state as a first-ever poll. The verification still runs, still cannot lie, and merely
 * loses the accumulated progress it would have resumed from.
 */
export function createCursorStore(driver) {
  return {
    /**
     * @returns {Promise<Record<string, {floorBlock, scannedFrom, scannedTo}>>} keyed by
     *   sourceKey, ready to hand to scanForEvent as `priorCoverage`. Never throws.
     */
    async load(rawId) {
      const id = normalizeIdentity(rawId);
      if (!id) return {};

      let rows;
      try {
        rows = await driver.load(id);
      } catch (err) {
        console.error("[quest] cursor read failed, restarting the walk from head:", err?.message);
        return {};
      }

      if (!Array.isArray(rows)) return {};

      const out = {};
      for (const raw of rows) {
        const row = normalizeCoverageRow(raw);
        if (!row) {
          console.error("[quest] cursor row dropped as malformed; that source re-walks from head");
          continue;
        }
        out[row.sourceKey] = row;
      }
      return out;
    },

    /**
     * Persist coverage. Returns the number of rows actually written, for tests and logging.
     * Never throws: a failed write costs the next poll some re-walking, nothing more.
     */
    async save(rawId, rawRows) {
      const id = normalizeIdentity(rawId);
      if (!id || !Array.isArray(rawRows) || rawRows.length === 0) return 0;

      const rows = [];
      for (const raw of rawRows) {
        const row = normalizeCoverageRow(raw);
        if (row) rows.push(row);
        else console.error("[quest] cursor row not written: failed validation");
      }
      if (rows.length === 0) return 0;

      try {
        await driver.save(id, rows);
        return rows.length;
      } catch (err) {
        console.error("[quest] cursor write failed, continuing:", err?.message);
        return 0;
      }
    },
  };
}

/**
 * Load prior coverage, scan, persist what the scan covered.
 *
 * This is the whole convergence loop, and it is three lines because all the care is in the
 * two things it composes: scanForEvent() derives the verdict from coverage and never
 * carries one, and createCursorStore() refuses to move a malformed interval in either
 * direction.
 *
 * NOT PERSISTED: a scan that found the event. `coverage` comes back empty in that case —
 * the completion goes to quest_completion via the verdict cache and this wallet's cursor is
 * never read again.
 *
 * Degrades to a plain one-shot scan whenever the identity or store is missing, which is
 * what keeps every existing tier2 caller (and every test that passes only `{head}`)
 * working unchanged.
 */
export async function scanWithResume(sources, opts = {}) {
  const { cursors, chainId, wallet, quest, ...scanOpts } = opts;

  const id = cursors ? normalizeIdentity({ chainId, wallet, quest }) : null;
  const priorCoverage = id ? await cursors.load(id) : null;

  const scan = await scanForEvent(sources, { ...scanOpts, priorCoverage });

  if (id && !scan.found) {
    // Only intervals this poll actually moved. Re-upserting an unchanged row would be a
    // write per poll per source for no new information.
    const advanced = scan.coverage.filter((c) => c.dirty);
    if (advanced.length > 0) await cursors.save(id, advanced);
  }

  return scan;
}
