import { useMemo, useState } from "react";
import { fmtCompact, fmtPct, fmt2, fmtShare, fmtUsd2, fmtSigned } from "../lib/format.js";
import { useVaultActions } from "../hooks/useVaultActions.js";

// Liquidity-vault section. THREE clearly-separated things so users don't conflate them:
//   1. POOL STATS (top grid)      — read-only data (TVL, share price, utilization,
//                                    reserved-for-open-positions). Not an action.
//   2. YOUR LIQUIDITY (P&L block) — this wallet's pLP shares, current mUSD value, and P&L
//                                    vs deposited (can be negative — it's P&L, not yield).
//   3. PROVIDE LIQUIDITY (panel)  — the DEPOSIT / WITHDRAW actions, badged so it's
//                                    obviously "be the pool," distinct from the trade
//                                    ticket. Withdraw is instant (no cooldown on testnet).
export default function VaultPanel({ vault, yourDeposit, account, wrongChain, getSigner, musdBalance, onConnect, onSwitch, onFaucet, toast, onDone }) {
  const actions = useVaultActions({ account, getSigner, wrongChain, toast, onDone });
  const dim = (txt) => <span className="loading-dim">{txt}</span>;

  const reserved = vault ? vault.reserved : null;
  return (
    <div className="vault-wrap">
      {/* 1) POOL STATS — data, not an action */}
      <div className="vault">
        <div className="cell">
          <div className="k">Total value locked</div>
          <div className="v">{vault ? <>{fmtCompact(vault.tvl)} <small>mUSD</small></> : dim("…")}</div>
        </div>
        <div className="cell">
          <div className="k">Share price</div>
          <div className="v">{vault ? <>{fmtShare(vault.sharePrice)} <small>mUSD / pLP</small></> : dim("…")}</div>
        </div>
        <div className="cell">
          <div className="k">Utilization</div>
          <div className="v">{vault ? fmtPct(vault.utilization, 1) : dim("…")}</div>
          <div className="util-track">
            <div className="util-fill" style={{ width: (vault ? Math.min(100, vault.utilization * 100) : 0) + "%" }}></div>
          </div>
        </div>
        <div className="cell">
          <div className="k">Reserved for open positions</div>
          <div className="v">{reserved != null ? <>{fmtCompact(reserved)} <small>backing live trades</small></> : dim("…")}</div>
        </div>
      </div>

      {/* 2) YOUR LIQUIDITY + P&L */}
      <YourLiquidity account={account} yourDeposit={yourDeposit} onConnect={onConnect} />

      {/* 3) PROVIDE LIQUIDITY — deposit / withdraw */}
      <ProvidePanel
        vault={vault}
        yourDeposit={yourDeposit}
        account={account}
        wrongChain={wrongChain}
        musdBalance={musdBalance}
        actions={actions}
        onConnect={onConnect}
        onSwitch={onSwitch}
        onFaucet={onFaucet}
      />
    </div>
  );
}

function YourLiquidity({ account, yourDeposit, onConnect }) {
  if (!account) {
    return (
      <div className="lp-position empty">
        <span>Connect your wallet to see your liquidity position and P&L.</span>
        <button className="btn connect" onClick={onConnect}>Connect</button>
      </div>
    );
  }
  if (!yourDeposit) return <div className="lp-position empty"><span className="loading-dim">Loading your position…</span></div>;
  if (yourDeposit.shares <= 0) {
    return (
      <div className="lp-position empty">
        <span>You're not providing liquidity yet. Deposit mUSD below to mint pLP and start earning fees &amp; net trader losses (at risk when traders win).</span>
      </div>
    );
  }

  const { shares, value, deposited, earnings, earningsPct, tracked } = yourDeposit;
  const gain = earnings != null && earnings >= 0;
  return (
    <div className="lp-position">
      <div className="lp-position-head">
        <span className="lp-badge">Your liquidity</span>
        <span className="lp-shares">{fmt2(shares)} <small>pLP</small></span>
      </div>
      <div className="lp-pnl-grid">
        <div className="lp-stat">
          <div className="k">Deposited (cost basis)</div>
          <div className="v">{deposited != null ? fmtUsd2(deposited) : <span className="loading-dim">not tracked here</span>}</div>
        </div>
        <div className="lp-stat">
          <div className="k">Current value</div>
          <div className="v">{fmtUsd2(value)}</div>
        </div>
        <div className="lp-stat">
          <div className="k">P&amp;L <span className="hint" title="Current value minus your deposited amount. This is profit/loss — it can be negative if traders win in aggregate. Not guaranteed yield.">?</span></div>
          <div className={"v " + (earnings == null ? "" : gain ? "pos" : "neg")}>
            {earnings == null ? (
              <span className="loading-dim">—</span>
            ) : (
              <>
                {fmtSigned(earnings)} {earningsPct != null && <small>{gain ? "+" : "−"}{Math.abs(earningsPct * 100).toFixed(2)}%</small>}
              </>
            )}
          </div>
        </div>
      </div>
      {tracked === "partial" && (
        <div className="lp-note">P&amp;L covers your locally-recorded deposits; you hold additional pLP deposited on another device or received by transfer.</div>
      )}
      {tracked === "none" && (
        <div className="lp-note">Your deposit isn't recorded in this browser (made elsewhere or received by transfer), so only current value is shown — no cost basis to compute P&amp;L.</div>
      )}
    </div>
  );
}

function ProvidePanel({ vault, yourDeposit, account, wrongChain, musdBalance, actions, onConnect, onSwitch, onFaucet }) {
  const [mode, setMode] = useState("deposit"); // "deposit" | "withdraw"
  const [amount, setAmount] = useState("");
  const [isMax, setIsMax] = useState(false);

  const isDeposit = mode === "deposit";
  const sharePrice = vault ? vault.sharePrice : null;
  const amt = parseFloat(amount) || 0;

  const value = yourDeposit ? yourDeposit.value : 0;
  const withdrawable = yourDeposit ? yourDeposit.maxWithdrawable : 0;
  const capped = yourDeposit && yourDeposit.shares > 0 && withdrawable + 1e-6 < value;

  // Estimated shares minted (deposit) or burned (withdraw): amount / share price.
  const estShares = sharePrice && sharePrice > 0 && amt > 0 ? amt / sharePrice : null;

  function setField(v) {
    setAmount(v.replace(/[^0-9.]/g, ""));
    setIsMax(false);
  }
  function clickMax() {
    if (isDeposit) {
      if (musdBalance != null) setAmount(String(musdBalance));
    } else {
      setAmount(withdrawable > 0 ? String(withdrawable) : "0");
      setIsMax(true);
      return;
    }
    setIsMax(false);
  }
  function switchMode(m) {
    setMode(m);
    setAmount("");
    setIsMax(false);
  }

  // Validation & button state (mirrors OrderTicket's gating).
  const noMusd = account && !wrongChain && musdBalance != null && musdBalance <= 0;
  const overBalance = isDeposit && musdBalance != null && amt > musdBalance + 1e-9;
  const overWithdrawable = !isDeposit && amt > withdrawable + 1e-9 && !isMax;
  const busy = actions.busy;
  const validAmount = amt > 0;

  const flow = actions.flow;
  const myFlow = flow && flow.kind === mode ? flow : null;

  const canSubmit =
    account && !wrongChain && !busy && validAmount && !overBalance && !overWithdrawable && (isDeposit ? !noMusd : withdrawable > 0);

  function submit() {
    if (!account) return onConnect?.();
    if (wrongChain) return onSwitch?.();
    if (isDeposit && noMusd) return onFaucet?.();
    if (isDeposit) actions.deposit(amount);
    else actions.withdraw(amount, isMax);
  }

  let btnLabel;
  if (!account) btnLabel = "Connect wallet";
  else if (wrongChain) btnLabel = "Switch to LiteForge (4441)";
  else if (isDeposit && noMusd) btnLabel = "Get mUSD to deposit →";
  else if (busy && myFlow) btnLabel = myFlow.phase === "approving" ? "Approving…" : "Working…";
  else if (isDeposit) btnLabel = "Approve & deposit";
  else if (withdrawable <= 0) btnLabel = "Nothing to withdraw";
  else btnLabel = "Withdraw mUSD";

  return (
    <div className="lp-panel">
      <div className="lp-panel-head">
        <span className="lp-badge provide">Provide liquidity</span>
        <div className="lp-panel-title">Be the pool — deposit mUSD, mint pLP</div>
      </div>

      <div className="otabs lp-otabs" role="tablist" aria-label="Liquidity action">
        <button className={isDeposit ? "on" : ""} onClick={() => switchMode("deposit")}>Deposit</button>
        <button className={!isDeposit ? "on" : ""} onClick={() => switchMode("withdraw")}>Withdraw</button>
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="lpAmount">{isDeposit ? "Deposit" : "Withdraw"}</label>
          <button className="bal" type="button" onClick={clickMax}>
            {isDeposit ? (
              <>Balance <b>{musdBalance == null ? "— mUSD" : fmt2(musdBalance) + " mUSD"}</b></>
            ) : (
              <>Withdrawable <b>{yourDeposit ? fmt2(withdrawable) + " mUSD" : "— mUSD"}</b></>
            )}
          </button>
        </div>
        <div className="input-wrap">
          <input
            id="lpAmount"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            aria-label={isDeposit ? "mUSD to deposit" : "mUSD to withdraw"}
            onChange={(e) => setField(e.target.value)}
          />
          <span className="ccy">mUSD</span>
        </div>
      </div>

      <div className="readout">
        <div className="row">
          <span className="k">{isDeposit ? "You receive (est.)" : "You burn (est.)"}</span>
          <span className="v">{estShares != null ? <>{fmt2(estShares)} pLP</> : <span className="loading-dim">—</span>}</span>
        </div>
        <div className="row">
          <span className="k">Share price</span>
          <span className="v">{sharePrice != null ? <>{fmtShare(sharePrice)} mUSD</> : <span className="loading-dim">…</span>}</span>
        </div>
        {!isDeposit && (
          <div className="row">
            <span className="k">Your position value</span>
            <span className="v">{yourDeposit ? fmtUsd2(value) : <span className="loading-dim">…</span>}</span>
          </div>
        )}
      </div>

      {account && !wrongChain && overBalance && <div className="ticket-warn">Amount exceeds your mUSD balance.</div>}
      {account && !wrongChain && overWithdrawable && <div className="ticket-warn">Amount exceeds what's withdrawable right now — use Max, or wait for open positions to free liquidity.</div>}
      {!isDeposit && capped && (
        <div className="lp-note cap">
          Withdrawals are instant — no lock or cooldown. Right now {fmtUsd2(withdrawable)} of your {fmtUsd2(value)} is free; the rest is temporarily reserved against open trader positions and frees as they close.
        </div>
      )}

      <button className={"open-btn lp-btn" + (isDeposit ? " deposit" : " withdraw") + (noMusd && isDeposit ? " cta" : "")} disabled={account && !wrongChain && !canSubmit} onClick={submit}>
        {btnLabel}
      </button>

      {myFlow && (
        <div className={"ticket-status" + (myFlow.phase === "error" ? " err" : "")}>
          {myFlow.phase === "approving" || myFlow.phase === "working" ? <span className="spin" aria-hidden="true" /> : null}
          <span>{myFlow.message}</span>
        </div>
      )}

      <div className="panel-foot lp-explainer">
        <b>How LP works — and the risk.</b> Depositing mUSD mints pLP and makes you part of the pool that traders trade against. You earn a share of trading &amp; borrow fees and of net trader losses, so your pLP value (share price) tends to rise over time. But you are the counterparty: when traders win in aggregate, the pool pays them and your value falls — <b>P&amp;L can be negative</b>. There's nothing to claim; value accrues into the share price, and you realize it by withdrawing. This is <b>risk capital, not guaranteed yield.</b>
      </div>
    </div>
  );
}
