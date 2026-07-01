// Shared, hidden SVG that defines the mascot as a reusable <symbol id="mascot">
// (plus its blob/eye gradients), ported verbatim from the reference. Rendered
// once at the top of the page; BOTH the endless-runner band and the Predictions
// section reference it via <use href="#mascot"/>, so swapping this single symbol
// for real mascot art updates both. Do not change the markup or the hop animation.
export default function MascotSymbol() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient id="blob" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5EC8FF" />
          <stop offset="1" stopColor="#2B8FEB" />
        </linearGradient>
        <radialGradient id="eye" cx="50%" cy="50%" r="60%">
          <stop offset="0" stopColor="#8FFCE8" />
          <stop offset="1" stopColor="#00D98B" />
        </radialGradient>
      </defs>
      <symbol id="mascot" viewBox="0 0 220 240">
        <path
          d="M110 20 C70 20 60 46 66 66 C40 78 30 118 40 158 C50 200 78 224 110 224 C142 224 170 200 180 158 C190 118 180 78 154 66 C160 46 150 20 110 20 Z"
          fill="url(#blob)"
          stroke="#0A1428"
          strokeWidth="4"
        />
        <path
          d="M74 60 C82 42 100 34 110 34 C120 34 138 42 146 60"
          fill="none"
          stroke="#BFF0FF"
          strokeWidth="3"
          opacity=".6"
        />
        <ellipse cx="86" cy="128" rx="20" ry="26" fill="#0A1A2E" />
        <ellipse cx="140" cy="122" rx="20" ry="26" fill="#0A1A2E" />
        <g fill="url(#eye)" filter="drop-shadow(0 0 6px #00D98B)">
          <path d="M86 112 l6 12 -7 2 8 14 -4 2 -8-14 7-2 -6-12z" />
          <circle cx="86" cy="132" r="4" />
          <path d="M140 106 l6 12 -7 2 8 14 -4 2 -8-14 7-2 -6-12z" />
          <circle cx="140" cy="126" r="4" />
        </g>
        <path
          d="M104 156 q6 6 14 0"
          fill="none"
          stroke="#0A1428"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </symbol>
    </svg>
  )
}
