// THE ZERO-CHUNK NEGATIVE — a proven `false` derived from the index instead of walked.
//
// ============================================================================
// WHAT THIS REPLACES
// ============================================================================
// Proving "this wallet never traded" by scanning costs ~1,060 chunks for THAT WALLET, paid
// again for the next wallet and the next; scan.js makes it converge over ~200 polls, which
// is hours of polling per wallet. The backfill (quest-indexer/lib/backfill.mjs) already paid
// that cost ONCE, unfiltered, for everybody: every wallet that ever appeared in a source has
// a quest_completion row, and quest_backfill records which blocks were read to find them.
//
// So once the backfill has reached a source's floor, the question "did this wallet do it"
// is a single indexed lookup, and the answer is available on the FIRST poll instead of the
// two-hundredth. That is all this file is: the union proof that says the lookup is allowed
// to be trusted, and nothing else.
//
// ============================================================================
// THE INVARIANT IS UNCHANGED. THE PROOF JUST COMES FROM A DIFFERENT PLACE.
// ============================================================================
// scan.js earns a confirmed false from coverage IT walked this poll plus coverage earlier
// polls walked. This earns one from coverage the BACKFILL walked plus coverage the FORWARD
// INDEXER walked. Both are facts about work done; neither is a stored verdict; both are
// re-derived on every single request and degrade to indeterminate the moment any part of
// the derivation stops holding. There is still no representation anywhere for "this wallet
// did not do it".
//
// The six conditions are 0005_quest_backfill.sql's, restated as code — with a seventh that
// the migration could not express because it is a chain read (see FLOOR VALIDATION below):
//
//   1. a quest_backfill row exists for EVERY source the quest requires   no_backfill
//   2. its floor_block equals the configured floor                       floor_changed
//   3. covered_to EQUALS floor_block — the pass reached the floor        not_at_floor
//   4. covered_from >= completion_from - 1 — the two halves touch        handoff_gap
//   5. completion_from is not null — the forward half has a start        handoff_unset
//   6. the six-way freshness gate passes (indexerState.js)               indexer_stale
//   7. the floor is really the contract's first block                    floor_unverified
//
// ANY of them failing returns `unproven`, and the caller falls back to the ordinary scan —
// which is exactly today's behaviour, so this path can only ever be faster, never wronger.
//
// ============================================================================
// WHY THE COMPLETION READ CANNOT REUSE THE CACHE
// ============================================================================
// The subtle one, and the reason supabaseIndexProof.js exists as its own driver.
//
// resolveQuest() already looked this wallet up in quest_completion through supabaseCache.js
// — and that driver SWALLOWS every failure and returns a miss, because there a failed read
// costs a re-verification and nothing else. Here it would cost a wrong answer: "the row is
// absent" and "we could not read whether the row is absent" are the same value coming out
// of that driver, and only the first of them may be turned into a confirmed false.
//
// So the proof re-reads the row through a driver that THROWS, and a throw becomes
// `unproven`. Same reasoning as supabaseIndexerState.js, which is the other place in the
// read path that refuses to swallow: absence is only an answer when the read succeeded.
//
// ============================================================================
// FLOOR VALIDATION IS NOT OPTIONAL HERE EITHER
// ============================================================================
// scan.js validates the floor on EVERY derivation, including the poll that walks no chunks
// at all, because a floor set too HIGH (a stale env var after a redeploy) ends the walk
// above the events and manufactures a confident false. The identical hazard applies to a
// backfill pass: it would sweep to the wrong floor, record covered_to === floor_block, and
// satisfy conditions 1-6 perfectly.
//
// This path therefore pays the SAME one eth_getCode per source, through the SAME exported
// helper, on the negative path only. That is one ~50ms call, not a chunk — the path stays
// zero-getLogs, which is the expensive thing it exists to avoid.

import { sourceKeyOf, verifySourceFloor } from "./scan.js";

/** What the proof concluded. `UNPROVEN` is the load-bearing one: it means "fall back". */
export const PROOF = {
  /** A quest_completion row exists. Proof, and it needs no freshness at all. */
  COMPLETED: "completed",
  /** All seven conditions held and there is no row: a proven negative. */
  ABSENT: "absent",
  /** Anything else. The caller must scan; it must NOT read this as a false. */
  UNPROVEN: "unproven",
};

const unproven = (detail) => ({ answer: PROOF.UNPROVEN, detail, checkedThroughBlock: null, index: null });

/** Tolerate either a Map (what the drivers return) or a plain object, like scan.js does. */
function lookup(store, key) {
  if (!store) return null;
  return (typeof store.get === "function" ? store.get(key) : store[key]) ?? null;
}

/**
 * CONDITIONS 1-5. Do the backfill's coverage and the forward index's coverage, joined,
 * span every required source from its floor to its watermark with no hole between them?
 *
 * Exported because these five are the whole correctness surface of this file and each one
 * has to be assertable without a network. Pure: no reads, no clock.
 *
 * @param {object} args
 * @param {Array<{address?, floor}>} args.sources  the quest's required sources
 * @param {Map|object} args.coverage  quest_backfill rows by source key
 * @param {Map|object} args.state     indexer_state rows by source key (with completionFrom)
 * @returns {{proven: boolean, detail: string|null, joins: Array}} `joins` is the audit
 *   trail — the two intervals per source and where they meet — and is what the envelope
 *   reports so a confirmed false can be checked rather than taken on trust.
 */
export function unionCovers({ sources, coverage, state }) {
  // Vacuous truth is not truth. Same rule as coverageProvesAbsence() and readFreshness().
  if (!Array.isArray(sources) || sources.length === 0) {
    return { proven: false, detail: "no_required_sources", joins: [] };
  }

  const joins = [];

  for (const source of sources) {
    const key = sourceKeyOf(source);
    if (!key) return { proven: false, detail: "unkeyed_source", joins: [] };

    const floor = source.floor;
    if (!Number.isInteger(floor) || floor < 0) return { proven: false, detail: `bad_floor:${key}`, joins: [] };

    // --- 1. A REQUIRED SOURCE HAS NO BACKFILL ROW. Never swept, or the address changed —
    // which self-invalidates exactly as quest_cursor does, because the address IS the key.
    const cov = lookup(coverage, key);
    if (!cov) return { proven: false, detail: `no_backfill:${key}`, joins: [] };

    if (!Number.isInteger(cov.floorBlock) || !Number.isInteger(cov.coveredFrom) || !Number.isInteger(cov.coveredTo)) {
      // A row we cannot read is worse than a row that is absent: absence is honest.
      return { proven: false, detail: `unreadable_backfill:${key}`, joins: [] };
    }

    // --- 2. FLOOR COUPLING, as everywhere else. A floor moved DOWN means there is unswept
    // history below what was covered; a floor moved UP means the pass may have been reading
    // a different contract. Either way the coverage is void.
    if (cov.floorBlock !== floor) return { proven: false, detail: `floor_changed:${key}`, joins: [] };

    // --- 3. REACHED THE FLOOR. EQUALITY, not <=, for the same reason scan.js insists on it:
    // the table CHECK makes lower impossible, so equality is exactly "reached the floor" and
    // `<=` would let a corrupt row buy a proven negative it did not earn.
    if (cov.coveredTo !== floor) return { proven: false, detail: `not_at_floor:${key}`, joins: [] };

    const st = lookup(state, key);
    if (!st) return { proven: false, detail: `no_indexer_state:${key}`, joins: [] };

    // --- 5. THE HANDOFF WATERMARK IS NULL. Checked before the gap, because the gap check
    // subtracts from it. NULL means "the indexer has not told us from where completions have
    // been written" — not zero and not "since always". Failing closed here is the entire
    // reason the column exists; see 0005_quest_backfill.sql.
    if (!Number.isInteger(st.completionFrom) || st.completionFrom < 0) {
      return { proven: false, detail: `handoff_unset:${key}`, joins: [] };
    }

    // --- 4. THE TWO HALVES MUST TOUCH. The backfill covers [floor .. covered_from]; the
    // forward index has written completions from completion_from up to its watermark. If
    // covered_from sits below completion_from - 1, the blocks in between were indexed for
    // NOTHING, and a wallet whose only trade landed there would read as a non-trader.
    if (cov.coveredFrom < st.completionFrom - 1) {
      return { proven: false, detail: `handoff_gap:${key}`, joins: [] };
    }

    joins.push({
      source: key,
      floor,
      coveredFrom: cov.coveredFrom,
      completionFrom: st.completionFrom,
      indexedTo: Number.isInteger(st.lastBlock) ? st.lastBlock : null,
    });
  }

  return { proven: true, detail: null, joins };
}

/**
 * Bind the proof to its stores.
 *
 * @param {object} args
 * @param {{loadBackfill, readCompletion}} args.backfill  supabaseIndexProof.js. BOTH METHODS
 *   MUST THROW on failure — see the header. A driver that swallowed its own errors could not
 *   be made to fail closed by this layer.
 * @param {{readFreshness}} args.indexerState  createIndexerState(), which owns condition 6
 *   and is the single authority on freshness. Deliberately not re-implemented here.
 */
export function createIndexProof({ backfill, indexerState }) {
  return {
    /**
     * Can the index answer this (wallet, quest) on its own?
     *
     * @param {object} args
     * @param {number} args.chainId
     * @param {string} args.wallet
     * @param {string} args.quest
     * @param {Array} args.sources        the quest's required sources (address + floor)
     * @param {number} args.head          current chain head, from Tier 1
     * @param {() => number} [args.now]   injectable clock, forwarded to the freshness gate
     * @param {(source) => Promise<boolean>} [args.verifyFloor]  condition 7; injectable so
     *   the policy is testable without a chain, exactly as scanForEvent's is.
     * @returns {Promise<{answer, detail, checkedThroughBlock, index}>} `checkedThroughBlock`
     *   on a proven absence is the index's MINIMUM watermark — never `head`, which the index
     *   has not reached and therefore cannot speak for.
     */
    async resolve({ chainId, wallet, quest, sources, head, now, verifyFloor = verifySourceFloor }) {
      if (!Array.isArray(sources) || sources.length === 0) return unproven("no_required_sources");

      const sourceKeys = sources.map(sourceKeyOf);
      if (sourceKeys.some((k) => !k)) return unproven("unkeyed_source");

      // ONE ROUND TRIP for all three reads. allSettled rather than all, so a completion that
      // came back positive is not held hostage by an unrelated table being unreadable — a
      // proven TRUE needs neither the coverage nor the freshness.
      const [completionRes, coverageRes, freshnessRes] = await Promise.allSettled([
        backfill.readCompletion({ chainId, wallet, quest }),
        backfill.loadBackfill(chainId, sourceKeys),
        // readFreshness catches its own driver's throw (fail-closed condition 3), so this
        // settles rejected only on a programming error.
        indexerState.readFreshness({ chainId, sourceKeys, head, ...(now ? { now } : {}) }),
      ]);

      // --- THE POSITIVE. A row is proof, and proof needs no freshness: quest_completion
      // rows are only ever written against a log that was actually seen.
      if (completionRes.status === "rejected") {
        console.error("[quest] index proof: completion read failed:", completionRes.reason?.message);
        return unproven("completion_read_failed");
      }
      if (completionRes.value?.found) {
        return {
          answer: PROOF.COMPLETED,
          detail: null,
          // Whatever block the row was proven at. Not head — we did not check head.
          checkedThroughBlock: completionRes.value.checkedThroughBlock ?? null,
          index: null,
        };
      }

      // From here on we are deciding whether ABSENCE is an answer, and every gate below is
      // one of the ways it is not.
      if (coverageRes.status === "rejected") {
        console.error("[quest] index proof: quest_backfill read failed:", coverageRes.reason?.message);
        return unproven("backfill_read_failed");
      }
      if (freshnessRes.status === "rejected") {
        console.error("[quest] index proof: freshness check threw:", freshnessRes.reason?.message);
        return unproven("freshness_read_failed");
      }

      // --- 6. THE FORWARD HALF MUST BE CURRENT. Runs before the coverage join for the same
      // reason indexerState.js is read before quest_daily: if the index is not provably
      // current, nothing derived from its absence may be used at all.
      const freshness = freshnessRes.value;
      if (!freshness?.fresh) return unproven(freshness?.detail ? `indexer_stale:${freshness.detail}` : "indexer_stale");

      // --- 1-5.
      const state = new Map((freshness.sources ?? []).map((row) => [row.sourceKey, row]));
      const union = unionCovers({ sources, coverage: coverageRes.value, state });
      if (!union.proven) return unproven(union.detail);

      // --- 7. FLOOR VALIDATION, on the negative path only. See the header: conditions 1-6
      // are all satisfiable by a pass that swept to a floor that was never the contract's
      // first block, and that is precisely how a confident false gets manufactured.
      for (const source of sources) {
        let floorOk;
        try {
          floorOk = await verifyFloor(source);
        } catch (err) {
          console.error(`[quest] index proof: floor check failed for ${sourceKeyOf(source)}:`, err?.message);
          floorOk = false; // cannot validate → cannot claim a proven negative
        }

        if (!floorOk) {
          console.error(
            `[quest] index proof: floor ${source.floor} for ${sourceKeyOf(source)} is not the contract's ` +
              "first block — refusing to report a proven negative. Check the *_DEPLOY_BLOCK env for this address.",
          );
          return unproven(`floor_unverified:${sourceKeyOf(source)}`);
        }
      }

      return {
        answer: PROOF.ABSENT,
        detail: null,
        // The MINIMUM watermark across the quest's sources. Reporting head here would claim
        // to have checked blocks the index has not reached.
        checkedThroughBlock: freshness.indexedThrough,
        index: { indexedThrough: freshness.indexedThrough, sources: union.joins },
      };
    },
  };
}
