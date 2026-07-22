import CoinIcon from "./CoinIcon.jsx";
import { PHASE, PHASE_LABEL, TIMEFRAME_LABEL, OUTCOME, SIDE } from "../../lib/prediction/predictionConfig.js";
import {
  fmtPool,
  fmtMusd,
  fmtFeedPrice,
  upShare,
  fmtHMS,
  fmtPriceAge,
  strikeDelta,
  sideMultiples,
  fmtMult,
} from "../../lib/prediction/predictionFormat.js";

function PhasePill({ phase }) {
  return <span className={`pm-pill pm-pill-${PHASE_LABEL[phase]?.toLowerCase()}`}>{PHASE_LABEL[phase]}</span>;
}

export default function MarketCard({ market, now, onBet, onClaim, pending }) {
  const { symbol, displayDp, timeframe, phase, outcome, strike, settlePrice, upPool, downPool, price, claimable } =
    market;

  const share = upShare(upPool, downPool);
  const upPct = Math.round(share * 100);

  // Price-vs-strike drift, surfaced so a stale strike is SEEN, not discovered after a bet.
  const delta = price ? strikeDelta(price.answer, strike) : null;
  const showDelta = delta && (phase === PHASE.OPEN || phase === PHASE.LOCKED);

  // Per-side payout multiples from the market's OWN feeBps — the real "what does this pay"
  // signal behind the crowd-share %. `empty` flags a 0/0 book with no priced line yet.
  const mult = sideMultiples(upPool, downPool, market.feeBps);
  const showOdds = phase === PHASE.OPEN || phase === PHASE.LOCKED;

  // H:M:S so both countdowns tick live every second and the lock↔settle gap (1800s on
  // 24h markets) is always visible — never collapsed into one coarse minute/hour bucket.
  const lockIn = fmtHMS(market.tLock, now);
  const settleIn = fmtHMS(market.tExpiry, now);

  // Chain-time lock gate: betting is disabled the moment chain time reaches tLock, even if
  // the keeper has not flipped the phase to LOCKED yet — the contract rejects at that same
  // boundary (block.timestamp >= tLock → BettingClosed), so we never offer a doomed bet.
  const bettable = phase === PHASE.OPEN && now != null && now < market.tLock;

  // The 2px top accent keys the card to its phase — a fast scan signal before you
  // read the pill.
  const accent =
    phase === PHASE.OPEN
      ? "linear-gradient(90deg,#00D98B,transparent)"
      : phase === PHASE.LOCKED
        ? "linear-gradient(90deg,#A24DFF,#D44CFF)"
        : "linear-gradient(90deg,rgba(255,255,255,.2),transparent)";

  const hasClaim = claimable && !claimable.isZero?.() && !claimable.eq?.(0);

  return (
    <div className="pm-card">
      <span className="pm-card-accent" style={{ background: accent }} />

      <span className="pm-card-head">
        <span className="pm-card-asset">
          <CoinIcon symbol={symbol} size={30} />
          <span className="pm-card-ticker">
            <span className="pm-card-sym">{symbol}</span>
            <span className="pm-card-tf mono">{TIMEFRAME_LABEL[timeframe] ?? "—"}</span>
          </span>
        </span>
        <PhasePill phase={phase} />
      </span>

      <span className="pm-card-q">
        Will {symbol} be above {fmtFeedPrice(strike, displayDp)}?
      </span>

      {/* Prominent drift cue: signed $ + % vs strike, coloured to the side it favours.
          Below strike → DOWN/red, above → UP/green. */}
      {showDelta && (
        <span className={`pm-delta pm-delta-${delta.dir}`}>
          <span className="pm-delta-move mono">
            {delta.diff >= 0 ? "+" : "−"}
            {fmtFeedPrice(Math.abs(delta.diff), displayDp)}
          </span>
          <span className="pm-delta-pct mono">
            {delta.pct >= 0 ? "+" : ""}
            {delta.pct.toFixed(2)}% {delta.dir === "up" ? "above" : delta.dir === "down" ? "below" : "at"} strike
          </span>
        </span>
      )}

      <span className="pm-odds">
        {showOdds && mult.empty ? (
          // Honest empty-book state — a 0/0 pool prices nothing; don't fake a 50/50.
          <span className="pm-odds-empty mono">
            {phase === PHASE.OPEN ? "No bets yet — be the first to set the line" : "No bets were placed"}
          </span>
        ) : (
          <span className="pm-odds-row mono">
            <span className="pm-up">
              ▲ UP {upPct}%{showOdds && <span className="pm-mult"> · {fmtMult(mult.up)}</span>}
            </span>
            <span className="pm-down">
              {showOdds && <span className="pm-mult">{fmtMult(mult.down)} · </span>}
              {100 - upPct}% DOWN ▼
            </span>
          </span>
        )}
        <span className={`pm-barwrap ${showOdds && mult.empty ? "is-empty" : ""}`}>
          {!(showOdds && mult.empty) && <span className="pm-barfill" style={{ width: `${upPct}%` }} />}
        </span>
      </span>

      <span className="pm-card-stats">
        <span className="pm-stat">
          {phase === PHASE.OPEN && (
            <>
              <span className="pm-stat-k">LOCKS IN</span>
              <span className="pm-stat-v mono pm-warm">{lockIn ?? "locking…"}</span>
              <span className="pm-stat-sub mono">{settleIn ? `settles in ${settleIn}` : "settling…"}</span>
            </>
          )}
          {phase === PHASE.LOCKED && (
            <>
              <span className="pm-stat-k">RESOLVES IN</span>
              <span className="pm-stat-v mono">{settleIn ?? "settling…"}</span>
            </>
          )}
          {(phase === PHASE.SETTLED || phase === PHASE.VOID) && (
            <>
              <span className="pm-stat-k">{phase === PHASE.VOID ? "VOIDED" : "CLOSED AT"}</span>
              <span className={`pm-stat-v mono ${outcome === OUTCOME.UP ? "pm-up" : ""}`}>
                {phase === PHASE.VOID ? "refunded" : fmtFeedPrice(settlePrice, displayDp)}
              </span>
            </>
          )}
        </span>

        <span className="pm-stat pm-stat-r">
          <span className="pm-stat-k">POOL</span>
          <span className="pm-stat-v mono">{fmtPool(upPool.add(downPool))} mUSD</span>
          {phase === PHASE.OPEN && price && (
            <span className="pm-stat-sub mono">
              now {fmtFeedPrice(price.answer, displayDp)}
              {/* Age from the feed's updatedAt vs the chain clock — makes it visible that a
                  static number is DIA's ~140s heartbeat, not a frozen fetch. */}
              {fmtPriceAge(price.updatedAt, now) && (
                <span className="pm-price-age"> · {fmtPriceAge(price.updatedAt, now)}</span>
              )}
            </span>
          )}
        </span>
      </span>

      {/* Phase actions — the real money path. */}
      {phase === PHASE.OPEN &&
        (bettable ? (
          <div className="pm-actions">
            <button type="button" className="pm-btn pm-btn-up" onClick={() => onBet(market, SIDE.UP)}>
              ▲ UP
            </button>
            <button type="button" className="pm-btn pm-btn-down" onClick={() => onBet(market, SIDE.DOWN)}>
              ▼ DOWN
            </button>
          </div>
        ) : (
          // Chain time has passed tLock but the keeper hasn't locked the phase yet —
          // betting is already closed on-chain, so we don't offer it.
          <div className="pm-locked">
            <span>🔒</span>
            <span className="pm-locked-t">Locking — betting closed</span>
          </div>
        ))}

      {phase === PHASE.LOCKED && (
        <div className="pm-locked">
          <span>🔒</span>
          <span className="pm-locked-t">In play — betting locked</span>
        </div>
      )}

      {phase === PHASE.SETTLED && (
        <div className={`pm-settled ${outcome === OUTCOME.DOWN ? "pm-settled-down" : ""}`}>
          <span className="pm-settled-t">
            {outcome === OUTCOME.UP ? "▲ UP won" : outcome === OUTCOME.DOWN ? "▼ DOWN won" : "no result"}
          </span>
          {hasClaim && (
            <button type="button" className="pm-claim" onClick={() => onClaim(market)} disabled={pending}>
              {pending ? "Claiming…" : `Claim ${fmtMusd(claimable)} mUSD`}
            </button>
          )}
        </div>
      )}

      {phase === PHASE.VOID && (
        <div className="pm-locked pm-void">
          <span>↩</span>
          <span className="pm-locked-t">
            Voided — <strong>refunded, not a loss</strong>. Your full stake is claimable.
          </span>
          {hasClaim && (
            <button type="button" className="pm-claim pm-claim-void" onClick={() => onClaim(market)} disabled={pending}>
              {pending ? "Refunding…" : `Refund ${fmtMusd(claimable)} mUSD`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
