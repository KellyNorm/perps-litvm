import { useEffect, useRef } from 'react'
import { readStats } from '../lib/stats'

export default function Stats() {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-count]'))
    // Order matches the reference markup: [0]=Pool TVL, [1]=Live Markets, [2]=Open Interest.
    const reduce = window.matchMedia('(prefers-reduced-motion:reduce)').matches
    let cancelled = false

    // Reveal-on-scroll, copied verbatim from the reference <script> (threshold .12).
    // Scoped to this section's own `.rv` so nothing outside the strip is touched.
    // Under reduced motion the reference CSS already forces `.rv` visible.
    const rio = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in')
            rio.unobserve(e.target)
          }
        }),
      { threshold: 0.12 },
    )
    root.querySelectorAll('.rv:not(.in)').forEach((el) => rio.observe(el))

    // Count-up copied verbatim from the reference <script>.
    function countUp(el: HTMLElement) {
      const target = +el.dataset.count!,
        money = el.dataset.money,
        pre = el.dataset.prefix || ''
      const dur = 1500,
        t0 = performance.now()
      function fmt(n: number) {
        return money ? Math.round(n).toLocaleString('en-US') : Math.round(n).toString()
      }
      function tick(t: number) {
        const p = Math.min((t - t0) / dur, 1),
          e = 1 - Math.pow(1 - p, 3)
        el.textContent = pre + fmt(target * e)
        if (p < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }

    // Set an element's final value straight away (reduced-motion path in the reference).
    function setFinal(el: HTMLElement) {
      el.textContent = (el.dataset.prefix || '') + (+el.dataset.count!).toLocaleString('en-US')
    }

    // Render the "—" fallback for a stat whose live read was slow or failed.
    function setDash(el: HTMLElement) {
      delete el.dataset.count
      el.textContent = '—'
    }

    // Once live values are in, animate each stat as it scrolls into view — same
    // IntersectionObserver + threshold as the reference.
    function activate() {
      if (cancelled) return
      const live = els.filter((el) => el.dataset.count != null)
      if (reduce) {
        live.forEach(setFinal)
        return
      }
      const sio = new IntersectionObserver(
        (es) =>
          es.forEach((e) => {
            if (e.isIntersecting) {
              countUp(e.target as HTMLElement)
              sio.unobserve(e.target)
            }
          }),
        { threshold: 0.5 },
      )
      live.forEach((el) => sio.observe(el))
    }

    // Fetch live values in the background — first paint already happened with the
    // reference's initial "$0"/"0" text, so nothing here blocks render.
    readStats().then((s) => {
      if (cancelled) return
      const values = [s.tvl, s.markets, s.openInterest]
      els.forEach((el, i) => {
        const v = values[i]
        if (v == null) setDash(el)
        else el.dataset.count = String(v)
      })
      activate()
    })

    return () => {
      cancelled = true
      rio.disconnect()
    }
  }, [])

  return (
    <div className="wrap stats" ref={rootRef}>
      <div className="stats-inner rv">
        <div className="stat">
          <div className="stat-label">Pool TVL</div>
          <div className="stat-val" data-count="0" data-prefix="$" data-money="1">
            $0
          </div>
          <div className="stat-sub">test mUSD · single vault</div>
        </div>
        <div className="stat">
          <div className="stat-label">Live Markets</div>
          <div className="stat-val" data-count="0">
            0
          </div>
          <div className="stat-sub">BTC · ETH — more soon</div>
        </div>
        <div className="stat">
          <div className="stat-label">Open Interest</div>
          <div className="stat-val" data-count="0" data-prefix="$" data-money="1">
            $0
          </div>
          <div className="stat-sub">long + short, all markets</div>
        </div>
      </div>
    </div>
  )
}
