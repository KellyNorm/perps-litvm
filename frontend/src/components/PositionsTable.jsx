import { fmtUsd, fmt2, fmtSigned } from "../lib/format.js";
import { signedPnl, liqPrice, health, healthColor } from "../lib/engine.js";

export default function PositionsTable({ account, positions, marks }) {
  const colSpan = 9;

  function emptyRow(content) {
    return (
      <tr>
        <td colSpan={colSpan} className="empty">
          {content}
        </td>
      </tr>
    );
  }

  let body;
  if (!account) {
    body = emptyRow(
      <>
        Connect a wallet to view your positions.
        <span className="sub">Reads run without one — positions need your address.</span>
      </>,
    );
  } else if (positions === null) {
    body = emptyRow(<span className="loading-dim">Reading positions…</span>);
  } else if (positions.length === 0) {
    body = emptyRow(
      <>
        No open positions.
        <span className="sub">Real empty — every live market × side returned size 0 for this address.</span>
      </>,
    );
  } else {
    body = positions.map((p) => {
      const mk = marks[p.symbol];
      const mark = mk && !mk.error ? mk.price : p.entryPrice;
      const lev = p.collateral > 0 ? p.sizeUsd / p.collateral : 0;
      const pnl = signedPnl(p, mark);
      const liq = liqPrice(p, p.borrowFee, p.fundingOwed);
      const h = health(p, mark, liq);
      const hc = healthColor(h);
      const hpc = Math.round(h * 100);
      const netFunding = -p.fundingOwed; // + ⇒ position is owed (receives), − ⇒ owes
      return (
        <tr key={p.key} className={h < 0.25 ? "danger" : undefined}>
          <td>
            <span className="pair">{p.name}</span>
            <span className={"sidetag " + (p.isLong ? "long" : "short")} style={{ marginLeft: 8 }}>
              {p.isLong ? "Long" : "Short"}
            </span>
            <span className="lev">{lev.toFixed(lev % 1 ? 1 : 0)}×</span>
          </td>
          <td className="mono">{fmtUsd(p.sizeUsd)}</td>
          <td className="mono">{fmtUsd(p.entryPrice)}</td>
          <td className="mono">{mk && !mk.error ? fmtUsd(mark) : <span className="loading-dim">…</span>}</td>
          <td className="mono neg">{fmtUsd(liq)}</td>
          <td>
            <span className="health">
              <span className="health-track">
                <span className="health-fill" style={{ width: hpc + "%", background: hc }}></span>
              </span>
              <span className="mono" style={{ fontSize: 11, color: hc }}>
                {hpc}%
              </span>
            </span>
          </td>
          <td className={"mono " + (netFunding >= 0 ? "pos" : "neg")}>{fmtSigned(netFunding)}</td>
          <td className={"mono " + (pnl >= 0 ? "pos" : "neg")}>{fmtSigned(pnl)}</td>
          <td style={{ textAlign: "right" }}>
            <span className="loading-dim" style={{ fontSize: 11 }}>
              read-only
            </span>
          </td>
        </tr>
      );
    });
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Market</th>
          <th>Size</th>
          <th>Entry</th>
          <th>Mark</th>
          <th>Liq. price</th>
          <th>Health</th>
          <th>Net funding</th>
          <th>uPnL</th>
          <th></th>
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  );
}
