import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtUsdPx, fmtCompact, fmtPct } from "../lib/format.js";
import { borrowDayFrac, fundingDayFrac } from "../lib/engine.js";

function Price({ mark }) {
  if (!mark) return <span className="loading-dim">loading…</span>;
  if (mark.error) return <span className="neg">unavailable</span>;
  return <>{fmtUsdPx(mark.price)}</>;
}

// Live price for a symbol: prefer the fast exchange ticker, fall back to the RedStone
// mark. Returns a {price}|{error}-shaped object so the <Price> renderer is reused.
function displayMark(symbol, marks, live) {
  const lv = live && live[symbol];
  if (lv && isFinite(lv.price)) return { price: lv.price };
  return marks[symbol];
}

export default function MarketStrip({ supported, selected, onSelect, marks, live, liveSource, states }) {
  const [open, setOpen] = useState(false);
  const [ddPos, setDdPos] = useState(null); // {top,left,width} for the fixed dropdown
  const selRef = useRef(null);
  const meta = supported.find((m) => m.symbol === selected) || supported[0];
  const mark = marks[selected]; // RedStone mark · execution
  const liveMark = displayMark(selected, marks, live); // fast display price
  const st = states[selected];

  useEffect(() => {
    function onDoc(e) {
      if (selRef.current && !selRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  // The dropdown is position:fixed (so it escapes the market strip's overflow clip).
  // Anchor it under the trigger and clamp it fully on-screen — works at 320px → desktop.
  // useLayoutEffect positions it before paint (no flash); kept synced on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const r = selRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(360, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setDdPos({ top: Math.round(r.bottom), left: Math.round(left), width });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true); // capture scroll in any ancestor
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  if (!meta) return null;

  const longOI = st?.longOI ?? null;
  const shortOI = st?.shortOI ?? null;
  const totalOI = longOI != null && shortOI != null ? longOI + shortOI : null;
  const longPct = totalOI && totalOI > 0 ? Math.round((longOI / totalOI) * 100) : 50;
  const fundFrac = totalOI != null ? fundingDayFrac(longOI, shortOI) : null;

  function fundLabel() {
    if (fundFrac == null) return "—";
    if (totalOI === 0) return "No open interest";
    if (fundFrac === 0) return "Balanced · 0% / day";
    return (fundFrac > 0 ? "Longs pay " : "Shorts pay ") + fmtPct(Math.abs(fundFrac), 3) + " / day";
  }

  return (
    <div className="marketstrip">
      <div
        className={"mkt-select" + (open ? " open" : "")}
        ref={selRef}
        role="button"
        tabIndex={0}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <span className="mkt-ico" style={{ background: meta.bg, color: meta.fg }}>
          {meta.ico}
        </span>
        <span>
          <div className="mkt-name">{meta.name}</div>
          <div className="mkt-tag">{meta.full} perpetual</div>
        </span>
        <span className="mkt-chevron">▾</span>
        {open && (
          <div
            className="dropdown"
            style={ddPos ? { top: ddPos.top, left: ddPos.left, width: ddPos.width } : { visibility: "hidden" }}
          >
            <div className="dd-search">Markets · RedStone feeds</div>
            {supported.map((m) => {
              const mk = displayMark(m.symbol, marks, live);
              return (
                <button
                  key={m.symbol}
                  className="dd-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(m.symbol);
                    setOpen(false);
                  }}
                >
                  <span className="mkt-ico" style={{ width: 26, height: 26, fontSize: 12, background: m.bg, color: m.fg }}>
                    {m.ico}
                  </span>
                  <span>
                    <div className="di-name">{m.symbol}-PERP</div>
                    <div className="di-full">{m.full}</div>
                  </span>
                  <span className="di-price">{mk && !mk.error ? fmtUsdPx(mk.price) : "…"}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="stat">
        <span className="k">Live price{liveSource ? ` · ${liveSource}` : ""}</span>
        <span className="v big mono" title="Indicative real-time price from a public exchange feed. Trades execute & realize at the RedStone mark.">
          <Price mark={liveMark} />
        </span>
      </div>
      <div className="stat">
        <span className="k">Borrow / day</span>
        <span className="v mono">{fmtPct(borrowDayFrac(), 3)}</span>
      </div>
      <div className="stat">
        <span className="k">Mark · execution (RedStone)</span>
        <span className="v mono" title="The on-chain RedStone mark — the price your trades actually execute and realize against.">
          <Price mark={mark} />
        </span>
      </div>

      <div className="oi">
        <div className="oi-head">
          <span className="l">Long OI</span>
          <span>Open interest skew</span>
          <span className="s">Short OI</span>
        </div>
        <div className="oi-bar">
          <span className="long" style={{ width: longPct + "%" }}></span>
        </div>
        <div className="oi-foot">
          <span>{longOI == null ? "…" : fmtCompact(longOI)}</span>
          <span className="oi-fund">{fundLabel()}</span>
          <span>{shortOI == null ? "…" : fmtCompact(shortOI)}</span>
        </div>
      </div>
    </div>
  );
}
