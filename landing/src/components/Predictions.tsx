import { useEffect, useRef } from 'react'

// PREDICTIONS section. Prediction markets went LIVE on 2026-07-25, so this is no
// longer a teaser: the badge is a live badge and the section carries the same
// external "Trade Now"-style CTA to app.tachyonfi.xyz as the hero and nav. The
// visual treatment (violet panel, mascot, floating pred-cards) is unchanged from
// the reference. The mascot is the shared <symbol id="mascot"> (see MascotSymbol),
// referenced via <use href="#mascot"/>.
//
// Copy facts verified against the live factory 0x7dd9e01f… on chain 4441:
// 11 enabled assets, timeframes 15-min / 30-min / 1-hour / 8-hour (there is no
// 5-min frame on-chain — see frontend predictionConfig.js TIMEFRAME_LABEL).
export default function Predictions() {
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // Reveal-on-scroll, copied verbatim from the reference <script> (threshold .12).
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            io.unobserve(e.target)
          }
        }),
      { threshold: 0.12 },
    )
    root.querySelectorAll('.rv:not(.in)').forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  return (
    <section className="block wrap" id="predictions" ref={rootRef}>
      <div className="pred rv">
        <div className="pred-copy">
          <span className="badge pred-badge">
            <span className="dot"></span>Now Live
          </span>
          <h2>
            Prediction markets,
            <br />
            the fast &amp; simple way in
          </h2>
          <p>
            No leverage, no liquidations — just pick a side. "Will BTC be up or down?" Stake mUSD
            and watch it play out over short, snappy windows. Live now across 11 assets,
            auto-generated around the clock, beginner-friendly, and housed in the same app as perps.
          </p>
          <div className="pred-chips">
            <span className="chip">15-min to 8-hour windows</span>
            <span className="chip">Up / down, that's it</span>
            <span className="chip">No leverage</span>
            <span className="chip">Same app as Perps</span>
          </div>
          <div className="pred-cta">
            <a className="btn" href="https://app.tachyonfi.xyz" target="_blank" rel="noopener">
              Open Predictions
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </a>
          </div>
        </div>
        <div className="pred-art">
          {/* mascot (swap in the real PNG on your build) */}
          <svg className="mascot" viewBox="0 0 220 240" aria-hidden="true">
            <use href="#mascot" />
          </svg>
          <div className="pred-card pc-top">
            <div className="pc-q">BTC · next 15 min</div>
            <div className="pc-row">
              <span className="pill-up">UP ▲</span>
              <span style={{ color: 'var(--dim)' }}>vs</span>
              <span className="pill-dn">DOWN ▼</span>
            </div>
          </div>
          <div className="pred-card pc-bot">
            <div className="pc-q">ETH · next 1 hour</div>
            <div className="pc-row">
              <span className="pill-up">62%</span>
              <span style={{ color: 'var(--dim)' }}>/</span>
              <span className="pill-dn">38%</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
