import { useEffect, useRef } from 'react'

export default function Hero() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion:reduce)').matches
    if (reduce) return
    const cv = canvasRef.current
    if (!cv) return
    const canvas = cv
    const context = canvas.getContext('2d')
    if (!context) return
    const ctx = context

    let W = 0,
      H = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parts: any[] = []
    let raf = 0
    const cols = ['41,169,255', '106,123,255', '162,77,255', '212,76,255']
    function size() {
      W = canvas.width = innerWidth * devicePixelRatio
      H = canvas.height = canvas.offsetHeight * devicePixelRatio
      ctx.scale(1, 1)
    }
    function mk() {
      const hyper = Math.random() < 0.18
      const s = Math.random() * 2.6 + 0.7
      return {
        x: Math.random() * W,
        y: Math.random() * H,
        v: s * devicePixelRatio * (hyper ? 3.6 : 2),
        len: (hyper ? Math.random() * 150 + 100 : Math.random() * 60 + 20) * devicePixelRatio,
        c: cols[Math.floor(Math.random() * cols.length)],
        a: hyper ? Math.random() * 0.35 + 0.4 : Math.random() * 0.45 + 0.14,
        r: hyper ? Math.random() * 1.6 + 0.9 : Math.random() * 1.2 + 0.3,
        hyper,
      }
    }
    function seed() {
      parts = []
      const n = Math.min(150, Math.floor(innerWidth / 10))
      for (let i = 0; i < n; i++) parts.push(mk())
    }
    function frame() {
      ctx.clearRect(0, 0, W, H)
      for (const p of parts) {
        ctx.strokeStyle = `rgba(${p.c},${p.a})`
        ctx.lineWidth = p.r
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(p.x - p.len, p.y)
        ctx.stroke()
        ctx.fillStyle = `rgba(255,255,255,${p.a * 0.9})`
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r * 0.9, 0, 7)
        ctx.fill()
        p.x += p.v
        if (p.x - p.len > W) {
          p.x = -p.len
          p.y = Math.random() * H
          p.a = Math.random() * 0.5 + 0.15
        }
      }
      raf = requestAnimationFrame(frame)
    }
    const onResize = () => {
      size()
      seed()
    }
    size()
    seed()
    frame()
    addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <header className="hero" id="top">
      <canvas id="field" ref={canvasRef}></canvas>
      <div className="hero-glow"></div>
      <div className="burst"></div>
      <div className="wrap hero-inner">
        <img className="hero-mark" src="/logo-mark.png" alt="TachyonFi" />
        <div className="eyebrow hl-1">
          <span className="badge">
            <span className="dot"></span>Live on LitVM Testnet
          </span>
        </div>
        <h1 className="hero-title hl-2">
          High-Speed <span className="grad-text">Perpetuals</span>
        </h1>
        <p className="hero-sub hl-3">
          A decentralized perps exchange on LitVM. Trade leveraged BTC and ETH — with LTC and more
          cryptocurrencies on the way — against one shared mUSD pool. Deep, unified liquidity,
          filled around the clock by an automated keeper at fresh oracle prices.
        </p>
        <div className="hero-cta hl-4">
          <a className="btn" href="https://app.tachyonfi.xyz" target="_blank" rel="noopener">
            Trade Now
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </a>
          <a className="btn btn-ghost" href="https://x.com/_tachyonfi" target="_blank" rel="noopener">
            Follow on X
          </a>
        </div>
        <p className="hero-note hl-5">
          <span className="warn-dot"></span>Testnet · Unaudited · test mUSD only — nothing here has
          real value.
        </p>
      </div>
    </header>
  )
}
