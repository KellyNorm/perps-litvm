import CoinIcon from "./CoinIcon.jsx";
import { PHASE, PHASE_LABEL, TIMEFRAME_LABEL, OUTCOME } from "../../lib/prediction/predictionConfig.js";
import { fmtPool, fmtMusd, fmtFeedPrice, upShare, fmtCountdown } from "../../lib/prediction/predictionFormat.js";

function PhasePill({ phase }) {
  return <span className={`pm-pill pm-pill-${PHASE_LABEL[phase]?.toLowerCase()}`}>{PHASE_LABEL[phase]}</span>;
}

export default function MarketCard({ market, now, onOpen }) {
  const { symbol, displayDp, timeframe, phase, outcome, strike, settlePrice, upPool, downPool, price, claimable } =
    market;

  const share = upShare(upPool, downPool);
  const upPct = Math.round(share * 100);

  const lockIn = fmtCountdown(market.tLock, now);
  const settleIn = fmtCountdown(market.tExpiry, now);

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
    <button type="button" className="pm-card" onClick={() => onOpen(market)}>
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

      <span className="pm-odds">
        <span className="pm-odds-row mono">
          <span className="pm-up">▲ UP {upPct}%</span>
          <span className="pm-down">{100 - upPct}% DOWN ▼</span>
        </span>
        <span className="pm-barwrap">
          <span className="pm-barfill" style={{ width: `${upPct}%` }} />
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
            <span className="pm-stat-sub mono">now {fmtFeedPrice(price.answer, displayDp)}</span>
          )}
        </span>
      </span>

      {/* Phase actions. These are presentational in the board build — the bet/claim
          money-path wiring lands in the next step, not here. */}
      {phase === PHASE.OPEN && (
        <span className="pm-actions">
          <span className="pm-btn pm-btn-up">▲ UP</span>
          <span className="pm-btn pm-btn-down">▼ DOWN</span>
        </span>
      )}

      {phase === PHASE.LOCKED && (
        <span className="pm-locked">
          <span>🔒</span>
          <span className="pm-locked-t">In play — betting locked</span>
        </span>
      )}

      {phase === PHASE.SETTLED && (
        <span className={`pm-settled ${outcome === OUTCOME.DOWN ? "pm-settled-down" : ""}`}>
          <span className="pm-settled-t">
            {outcome === OUTCOME.UP ? "▲ UP won" : outcome === OUTCOME.DOWN ? "▼ DOWN won" : "no result"}
          </span>
          {hasClaim && <span className="pm-claim">Claim {fmtMusd(claimable)} mUSD</span>}
        </span>
      )}

      {phase === PHASE.VOID && (
        <span className="pm-locked pm-void">
          <span>↩</span>
          <span className="pm-locked-t">Voided — stakes refundable</span>
        </span>
      )}
    </button>
  );
}
