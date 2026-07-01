import { useEffect, useRef } from 'react'

export default function Features() {
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // Reveal-on-scroll, copied verbatim from the reference <script> (threshold .12).
    // Scoped to this section's own `.rv`. Under reduced motion the reference CSS
    // already forces `.rv` visible.
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
    <section className="block wrap" id="features" ref={rootRef}>
      <div className="sec-head rv">
        <div className="sec-eyebrow">Built for velocity</div>
        <h2 className="sec-title">Trading infrastructure that runs itself</h2>
        <p className="sec-lead">
          One pool, an autonomous keeper, and an on-chain safety layer — engineered so positions
          fill fast and the vault stays protected.
        </p>
      </div>
      <div className="feat-grid">
        <div className="feat rv d1">
          <div className="feat-ico">
            <svg viewBox="0 0 24 24">
              <path d="M3 7c0-1.7 4-3 9-3s9 1.3 9 3-4 3-9 3-9-1.3-9-3Z" />
              <path d="M3 7v10c0 1.7 4 3 9 3s9-1.3 9-3V7" />
              <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
            </svg>
          </div>
          <h3>One pool, every market</h3>
          <p>
            A single mUSD vault backs BTC and ETH alike, so liquidity stays deep and unified — and
            LPs earn from all trading activity, not one isolated market.
          </p>
        </div>
        <div className="feat rv d2">
          <div className="feat-ico">
            <svg viewBox="0 0 24 24">
              <path d="M12 3v4" />
              <path d="M12 17v4" />
              <path d="M5 12H3" />
              <path d="M21 12h-2" />
              <circle cx="12" cy="12" r="4" />
              <path d="M12 8a4 4 0 0 1 4 4" />
            </svg>
          </div>
          <h3>Self-running execution</h3>
          <p>
            A two-step request-and-execute flow with front-running protection. An automated keeper
            fills orders 24/7 at fresh oracle prices — no manual steps, around the clock.
          </p>
        </div>
        <div className="feat rv d3">
          <div className="feat-ico">
            <svg viewBox="0 0 24 24">
              <path d="M12 3 4 6v6c0 5 3.4 7.7 8 9 4.6-1.3 8-4 8-9V6l-8-3Z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <h3>On-chain circuit-breaker</h3>
          <p>
            Prices are cross-checked against a secondary feed. If they diverge abnormally, new risk
            halts automatically — guarding the pool against oracle manipulation and bad debt during
            fast moves.
          </p>
        </div>
        <div className="feat rv d4">
          <div className="feat-ico">
            <svg viewBox="0 0 24 24">
              <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
            </svg>
          </div>
          <h3>Fast &amp; low-cost on LitVM</h3>
          <p>
            Built native to the Litecoin-aligned EVM chain: sub-cent gas and quick execution, so
            trading feels immediate — true to the tachyon name.
          </p>
        </div>
      </div>
    </section>
  )
}
