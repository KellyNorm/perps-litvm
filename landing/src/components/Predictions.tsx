import { useEffect, useRef } from 'react'

// PREDICTIONS "Coming Soon" section, ported verbatim from the reference.
// Intentionally has NO button and NO link (Predictions is not live). The mascot
// is the shared <symbol id="mascot"> (see MascotSymbol), referenced via
// <use href="#mascot"/>.
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
          <span className="badge pred-badge">Coming Soon</span>
          <h2>
            Prediction markets,
            <br />
            the fast &amp; simple way in
          </h2>
          <p>
            No leverage, no liquidations — just pick a side. "Will BTC be up or down?" Stake, and
            watch it play out over short, snappy windows. Auto-generated around the clock,
            beginner-friendly, and housed in the same app as perps.
          </p>
          <div className="pred-chips">
            <span className="chip">Minutes-to-an-hour windows</span>
            <span className="chip">Up / down, that's it</span>
            <span className="chip">No leverage</span>
            <span className="chip">Same app as Perps</span>
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
            <div className="pc-q">ETH · next 5 min</div>
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
