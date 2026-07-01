import { useEffect, useRef } from 'react'

export default function Nav() {
  const shellRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const onScroll = () => shell.classList.toggle('scrolled', window.scrollY > 20)
    onScroll()
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <>
      <div className="nav-shell" id="navShell" ref={shellRef}></div>
      <nav>
        <a className="brand" href="#top">
          <img src="/logo-mark.png" alt="TachyonFi" />
          <span>
            Tachyon<span className="grad-text">Fi</span>
          </span>
        </a>
        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#faq">FAQ</a>
        </div>
        <div className="nav-right">
          <a className="btn" href="https://app.tachyonfi.xyz" target="_blank" rel="noopener">
            Trade Now
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </a>
        </div>
      </nav>
    </>
  )
}
