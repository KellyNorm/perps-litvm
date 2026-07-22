import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import CoinIcon from "./CoinIcon.jsx";
import { musdRead } from "../../lib/contracts.js";
import { SIDE, PHASE } from "../../lib/prediction/predictionConfig.js";
import { estPayout, fmtFeedPrice, fmtHMS, fmtMusd, fmtPriceAge } from "../../lib/prediction/predictionFormat.js";

// Bet ticket for an OPEN market. Amount in mUSD, live parimutuel payout preview (using the
// market's OWN on-chain feeBps snapshot), and a chain-time lock gate so the ticket closes
// itself the instant the market locks — the same clock the contract enforces.
//
// The flow (approve → bet) is owned by usePredictionActions; this component only collects
// the amount/side and renders the returned `flow` status line.
export default function BetModal({ market, initialSide, account, chainNow, flow, busy, onSubmit, onClose }) {
  const [side, setSide] = useState(initialSide ?? SIDE.UP);
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState(null); // BigNumber | null

  const { symbol, displayDp, upPool, downPool, feeBps, strike, price } = market;

  // Balance for the MAX button + insufficient-funds hint. Read-only; refreshed on open.
  useEffect(() => {
    let alive = true;
    if (!account) return;
    musdRead()
      .balanceOf(account)
      .then((b) => alive && setBalance(b))
      .catch(() => alive && setBalance(null));
    return () => {
      alive = false;
    };
  }, [account, flow]);

  // Live lock gate. Once chain time reaches tLock the market is no longer bettable.
  const locked = market.phase !== PHASE.OPEN || (chainNow != null && chainNow >= market.tLock);
  const lockIn = fmtHMS(market.tLock, chainNow);

  const preview = useMemo(() => {
    const n = Number(amount);
    if (!n || n <= 0) return null;
    return estPayout({
      stake: n,
      side: side === SIDE.UP ? "UP" : "DOWN",
      upPool,
      downPool,
      feeBps,
    });
  }, [amount, side, upPool, downPool, feeBps]);

  const amountNum = Number(amount) || 0;
  const balNum = balance ? Number(ethers.utils.formatUnits(balance, 18)) : null;
  const insufficient = balNum != null && amountNum > balNum;
  const belowMin = amountNum > 0 && amountNum < 1;
  const canSubmit = !busy && !locked && amountNum >= 1 && !insufficient;

  const setMax = () => {
    if (balance) setAmount(ethers.utils.formatUnits(balance, 18));
  };

  return (
    <div className="pm-modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="pm-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="pm-modal-head">
          <span className="pm-modal-asset">
            <CoinIcon symbol={symbol} size={26} />
            <span className="pm-modal-q">
              Will {symbol} be above {fmtFeedPrice(strike, displayDp)}?
            </span>
          </span>
          <button type="button" className="pm-modal-x" onClick={onClose} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Side picker — UP=0 / DOWN=1 (Side enum), NOT the Outcome enum. */}
        <div className="pm-side-pick">
          <button
            type="button"
            className={`pm-side-btn pm-side-up ${side === SIDE.UP ? "is-on" : ""}`}
            onClick={() => setSide(SIDE.UP)}
            disabled={busy}
          >
            ▲ UP
          </button>
          <button
            type="button"
            className={`pm-side-btn pm-side-down ${side === SIDE.DOWN ? "is-on" : ""}`}
            onClick={() => setSide(SIDE.DOWN)}
            disabled={busy}
          >
            ▼ DOWN
          </button>
        </div>

        <label className="pm-amt-label">
          <span className="pm-amt-k mono">STAKE (mUSD)</span>
          <span className="pm-amt-bal mono">
            {balNum != null ? `balance ${balNum.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}
          </span>
        </label>
        <div className={`pm-amt-row ${insufficient || belowMin ? "is-bad" : ""}`}>
          <input
            className="pm-amt-input mono"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            disabled={busy || locked}
          />
          <button type="button" className="pm-amt-max mono" onClick={setMax} disabled={busy || !balance}>
            MAX
          </button>
        </div>

        <div className="pm-preview">
          <div className="pm-preview-row">
            <span className="pm-muted">Now{price && fmtPriceAge(price.updatedAt, chainNow) ? ` · ${fmtPriceAge(price.updatedAt, chainNow)}` : ""}</span>
            <span className="mono">{price ? fmtFeedPrice(price.answer, displayDp) : "—"}</span>
          </div>
          <div className="pm-preview-row">
            <span className="pm-muted">Est. payout if {side === SIDE.UP ? "UP" : "DOWN"} wins</span>
            <span className="mono pm-preview-payout">
              {preview ? `${preview.payout.toLocaleString(undefined, { maximumFractionDigits: 2 })} mUSD` : "—"}
            </span>
          </div>
          <div className="pm-preview-row">
            <span className="pm-muted">Multiple</span>
            <span className="mono">{preview && preview.multiple > 0 ? `${preview.multiple.toFixed(2)}×` : "—"}</span>
          </div>
          <p className="pm-preview-note">
            Parimutuel: winners split the pool pro-rata. This estimate moves as others bet until the market locks
            {lockIn ? ` in ${lockIn}` : ""}.
          </p>
        </div>

        {flow && flow.marketId === market.id && (
          <div className={`pm-flow ${flow.phase === "error" ? "is-err" : flow.ok ? "is-ok" : ""}`}>{flow.message}</div>
        )}

        {locked ? (
          <div className="pm-flow is-err">Betting has locked for this market.</div>
        ) : (
          <button
            type="button"
            className={`pm-submit ${side === SIDE.UP ? "pm-submit-up" : "pm-submit-down"}`}
            disabled={!canSubmit}
            onClick={() => onSubmit(market, side, amount)}
          >
            {busy
              ? "Confirm in wallet…"
              : belowMin
                ? "Min 1 mUSD"
                : insufficient
                  ? "Insufficient balance"
                  : `Bet ${side === SIDE.UP ? "▲ UP" : "▼ DOWN"}`}
          </button>
        )}

        <p className="pm-modal-foot mono">
          Pool now {fmtMusd(upPool.add(downPool))} mUSD · test tokens only
        </p>
      </div>
    </div>
  );
}
