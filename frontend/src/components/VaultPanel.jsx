import { fmtCompact, fmtPct, fmt2, fmtShare } from "../lib/format.js";

// LiquidityPool read surface: TVL (totalAssets), utilization (reserved / balance),
// share price (totalAssets / totalSupply), and the connected LP's deposit. LP APR is
// not directly readable on-chain (needs realized fee history), so it shows "—".
export default function VaultPanel({ vault, yourDeposit, account }) {
  const dim = (txt) => <span className="loading-dim">{txt}</span>;
  return (
    <div className="vault">
      <div className="cell">
        <div className="k">Total value locked</div>
        <div className="v">{vault ? <>{fmtCompact(vault.tvl)} <small>mUSD</small></> : dim("…")}</div>
      </div>
      <div className="cell">
        <div className="k">Utilization</div>
        <div className="v">{vault ? fmtPct(vault.utilization, 1) : dim("…")}</div>
        <div className="util-track">
          <div className="util-fill" style={{ width: (vault ? Math.min(100, vault.utilization * 100) : 0) + "%" }}></div>
        </div>
      </div>
      <div className="cell">
        <div className="k">Share price</div>
        <div className="v">{vault ? <>{fmtShare(vault.sharePrice)} <small>mUSD / share</small></> : dim("…")}</div>
      </div>
      <div className="cell">
        <div className="k">
          Your deposit <small>{account ? "" : "connect to view"}</small>
        </div>
        <div className="v">
          {!account ? (
            dim("$0")
          ) : yourDeposit ? (
            <>
              {fmtCompact(yourDeposit.assets)} <small>{fmt2(yourDeposit.shares)} sh</small>
            </>
          ) : (
            dim("…")
          )}
        </div>
      </div>
    </div>
  );
}
