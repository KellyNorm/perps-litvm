// FOOTER, ported verbatim from the reference. The reference's inline SVG #mark
// stand-in is replaced with the real logo PNG (same pattern as Nav/Hero); its
// footer sizing lives in logo.css. Keeps both status columns (Product /
// Resources) and the "Testnet · Unaudited" disclaimer. "Trade Now" and the X
// link are plain external links; Predictions and Docs stay "Soon" (no links).
export default function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="foot-top">
          <div>
            <div className="foot-brand">
              <img src="/logo-mark.png" alt="TachyonFi" />
              <span>
                Tachyon<span className="grad-text">Fi</span>
              </span>
            </div>
            <p style={{ color: 'var(--muted)', fontSize: '14px', marginTop: '14px', maxWidth: '34ch' }}>
              High-speed perpetual futures on LitVM. Deep, unified liquidity — filled around the
              clock.
            </p>
          </div>
          <div className="foot-links">
            <div className="foot-col">
              <h5>Product</h5>
              <a className="frow" href="https://app.tachyonfi.xyz" target="_blank" rel="noopener">
                <span>Trade Now</span>
                <span className="tag tag-go">Open ↗</span>
              </a>
              <div className="frow">
                <span>Perps</span>
                <span className="tag tag-live">
                  <i></i>Live
                </span>
              </div>
              <div className="frow">
                <span>Predictions</span>
                <span className="tag tag-soon">Soon</span>
              </div>
            </div>
            <div className="foot-col">
              <h5>Resources</h5>
              <a className="frow" href="https://x.com/_tachyonfi" target="_blank" rel="noopener">
                <span>X · @_tachyonfi</span>
                <span className="tag tag-go">Follow ↗</span>
              </a>
              <div className="frow">
                <span>Docs</span>
                <span className="tag tag-soon">Soon</span>
              </div>
            </div>
          </div>
        </div>
        <div className="foot-bottom">
          <span className="disclaimer">
            <span className="warn-dot"></span>Testnet · Unaudited — for testing and feedback only.
            Not financial advice.
          </span>
          <span className="copy">© 2026 TachyonFi</span>
        </div>
      </div>
    </footer>
  )
}
