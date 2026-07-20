import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";

// Ambient "cracks of blue flame" behind the board.
//
// Deliberately restrained: the whole layer sits at ~0.5 opacity with individual
// strokes at .07-.16, blurred, behind everything at z-index 0 and pointer-events:none.
// It must read as atmosphere, never compete with the cards or cost contrast on text.
// If it is noticeable as "a graphic" it is too strong — turn OPACITY down first.
//
// The strokes are hand-placed rather than random so they frame the content column
// instead of cutting through it.

const OPACITY = 0.5;

const CRACKS = [
  { d: "M-40 180 C 120 120, 210 300, 380 240 S 640 130, 820 210", w: 1.4, o: 0.16, dur: "11s" },
  { d: "M-60 520 C 140 470, 240 640, 430 570 S 700 470, 900 540", w: 1.1, o: 0.12, dur: "14s" },
  { d: "M120 -40 C 180 140, 90 260, 160 420 S 210 640, 150 840", w: 1.0, o: 0.1, dur: "17s" },
  { d: "M780 -30 C 720 160, 830 280, 760 450 S 700 660, 790 860", w: 1.0, o: 0.1, dur: "19s" },
  { d: "M-30 860 C 160 800, 300 900, 480 830 S 720 760, 920 820", w: 0.9, o: 0.08, dur: "16s" },
];

export default function FlameBackdrop() {
  const reduced = usePrefersReducedMotion();

  return (
    <div className="pm-flame" aria-hidden="true" style={{ opacity: OPACITY }}>
      {/* Two broad radial pools give the "embers behind glass" base glow. */}
      <div className="pm-flame-pool pm-flame-pool-a" />
      <div className="pm-flame-pool pm-flame-pool-b" />

      <svg viewBox="0 0 880 880" preserveAspectRatio="xMidYMid slice" className="pm-flame-svg">
        <defs>
          <linearGradient id="pm-crack" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#29A9FF" stopOpacity="0" />
            <stop offset="0.45" stopColor="#5EC8FF" stopOpacity="1" />
            <stop offset="1" stopColor="#00D98B" stopOpacity="0" />
          </linearGradient>
          <filter id="pm-crack-blur" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
        </defs>

        <g filter="url(#pm-crack-blur)">
          {CRACKS.map((c, i) => (
            <path
              key={i}
              d={c.d}
              fill="none"
              stroke="url(#pm-crack)"
              strokeWidth={c.w}
              strokeLinecap="round"
              opacity={c.o}
              className={reduced ? undefined : "pm-crack-breathe"}
              style={reduced ? undefined : { animationDuration: c.dur, animationDelay: `${i * -2.5}s` }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
