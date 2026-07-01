import { useEffect, useRef } from 'react'

export default function How() {
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
    <section className="block wrap" id="how" ref={rootRef}>
      <div className="sec-head rv">
        <div className="sec-eyebrow">From zero to open position</div>
        <h2 className="sec-title">Three steps, no real funds</h2>
      </div>
      <div className="steps">
        <div className="step rv d1">
          <div className="step-num">01</div>
          <div className="step-line"></div>
          <h4>Connect your wallet</h4>
          <p>Open the app and connect. It prompts you to switch to the LitVM network automatically.</p>
        </div>
        <div className="step rv d2">
          <div className="step-num">02</div>
          <div className="step-line"></div>
          <h4>Claim test mUSD</h4>
          <p>Grab free test mUSD from the built-in faucet. It's testnet collateral — nothing has real value.</p>
        </div>
        <div className="step rv d3">
          <div className="step-num">03</div>
          <div className="step-line"></div>
          <h4>Open a position</h4>
          <p>Go long or short on BTC or ETH with leverage. The keeper fills your order at the fresh oracle price.</p>
        </div>
      </div>
    </section>
  )
}
