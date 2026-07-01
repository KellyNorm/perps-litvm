import { useEffect, useRef } from 'react'

// FAQ accordion, ported verbatim from the reference. The reveal-on-scroll and
// the accordion click behavior are copied from the reference <script>, scoped to
// this section's own DOM. Copy is final — matched character-for-character.
export default function Faq() {
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    // Reveal-on-scroll (threshold .12), verbatim from the reference.
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

    // FAQ accordion, verbatim from the reference: single-open, animate max-height
    // to scrollHeight. Scoped to this section.
    const heads = Array.from(root.querySelectorAll<HTMLButtonElement>('.q-head'))
    const onClick = (b: HTMLButtonElement) => {
      const q = b.parentElement as HTMLElement
      const body = q.querySelector<HTMLElement>('.q-body')!
      const open = q.classList.contains('open')
      root.querySelectorAll<HTMLElement>('.q.open').forEach((o) => {
        o.classList.remove('open')
        o.querySelector<HTMLElement>('.q-body')!.style.maxHeight = ''
      })
      if (!open) {
        q.classList.add('open')
        body.style.maxHeight = body.scrollHeight + 'px'
      }
    }
    const handlers = heads.map((b) => {
      const h = () => onClick(b)
      b.addEventListener('click', h)
      return h
    })

    return () => {
      io.disconnect()
      heads.forEach((b, i) => b.removeEventListener('click', handlers[i]))
    }
  }, [])

  return (
    <section className="block wrap" id="faq" ref={rootRef}>
      <div className="sec-head rv" style={{ textAlign: 'center' }}>
        <div className="sec-eyebrow" style={{ textAlign: 'center' }}>
          Good to know
        </div>
        <h2 className="sec-title" style={{ marginInline: 'auto', textAlign: 'center' }}>
          Questions, answered straight
        </h2>
      </div>
      <div className="faq rv">
        <div className="q">
          <button className="q-head">
            What is TachyonFi?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>
              A decentralized perpetual futures exchange on LitVM — take leveraged long or short
              positions on BTC and ETH against a single shared liquidity pool.
            </p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            Is this real money?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>
              No. TachyonFi runs on LitVM testnet. You trade with test mUSD claimed from the faucet —
              nothing here has real value.
            </p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            How do I start?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>
              Connect your wallet, switch to LitVM (the app prompts you), claim test mUSD from the
              faucet, then open a position.
            </p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            What can I trade?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>
              BTC and ETH perpetuals — long or short, with leverage. More markets are coming, with
              LTC next.
            </p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            What's coming next?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>
              Prediction markets — fast, simple crypto up/down price markets, right inside the same
              app — plus more assets.
            </p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            How are trades executed?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>
              A two-step request/execute flow. An automated keeper fills your order at fresh oracle
              prices, with front-running protection, 24/7.
            </p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            How are prices set?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>
              A RedStone oracle feeds prices, backed by an on-chain circuit-breaker that halts new
              risk if prices diverge abnormally.
            </p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            Is it audited?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>
              Not yet. This is an early testnet release for testing and feedback — it is not
              production-ready.
            </p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            Where are the docs?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>Coming soon.</p>
          </div>
        </div>
        <div className="q">
          <button className="q-head">
            Feedback or bugs?<span className="q-ico"></span>
          </button>
          <div className="q-body">
            <p>Reach out on X at @_tachyonfi.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
