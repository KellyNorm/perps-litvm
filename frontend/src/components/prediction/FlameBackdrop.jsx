import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";

// Ambient "3D ember environment" behind the board — depth pools with parallax drift,
// rising ember particles on a canvas, glowing fire-crack fissures, and an edge vignette.
//
// HARD RULES (do not relax without re-checking against the cards):
//  - It sits at z-index 0 behind .pm-content (z-index 1), pointer-events:none, and every
//    layer stays low-contrast. Data is small mono text on dark cards — readability wins.
//    The vignette darkens the edges to push the cards forward.
//  - Cost is capped: no WebGL. The ember canvas clamps DPR to 1.5, caps particle count,
//    pauses its rAF when the tab is hidden, and does not run at all under reduced-motion.
//  - Branding: Dark Velocity base, blue (#5EC8FF/#29A9FF) + green (#00D98B) accents only.
//
// `intensity` (0..1) is the single knob. It scales overall opacity, ember count/brightness,
// fissure-spark strength and drift. Two review presets live in PredictionApp.

const clamp01 = (v) => Math.max(0, Math.min(1, v));

const CRACKS = [
  { d: "M-40 180 C 120 120, 210 300, 380 240 S 640 130, 820 210", w: 1.4, o: 0.16, dur: "11s" },
  { d: "M-60 520 C 140 470, 240 640, 430 570 S 700 470, 900 540", w: 1.1, o: 0.12, dur: "14s" },
  { d: "M120 -40 C 180 140, 90 260, 160 420 S 210 640, 150 840", w: 1.0, o: 0.1, dur: "17s" },
  { d: "M780 -30 C 720 160, 830 280, 760 450 S 700 660, 790 860", w: 1.0, o: 0.1, dur: "19s" },
  { d: "M-30 860 C 160 800, 300 900, 480 830 S 720 760, 920 820", w: 0.9, o: 0.08, dur: "16s" },
];

// Traveling-spark durations per crack (staggered so they don't pulse in unison).
const SPARK_DUR = ["6.5s", "8s", "9.5s", "7.2s", "10.5s"];

// Rising ember particles. Self-contained lifecycle: capped count, DPR-clamped, rAF paused
// on hidden tab, torn down on unmount. Never mounted under reduced-motion.
function EmberField({ intensity }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const COUNT = Math.round(10 + intensity * 40); // ~14 restrained → ~46 dramatic
    const COLORS = ["#5EC8FF", "#00D98B", "#8FFCE8"];
    let w = 0;
    let h = 0;
    let raf = 0;
    let paused = false;
    let parts = [];

    const rand = (a, b) => a + Math.random() * (b - a);
    const spawn = (fromBottom) => ({
      x: Math.random() * w,
      y: fromBottom ? h + rand(0, 60) : Math.random() * h,
      r: rand(0.6, 2.0),
      vy: rand(0.12, 0.55) * (0.6 + intensity), // rise speed scales with intensity
      vx: rand(-0.22, 0.22),
      a: rand(0.12, 0.42),
      color: COLORS[(Math.random() * COLORS.length) | 0],
      tw: Math.random() * Math.PI * 2,
    });

    const resize = () => {
      const rect = host.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      if (paused) return;
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.y -= p.vy;
        p.x += p.vx;
        p.tw += 0.03;
        if (p.y < -12) Object.assign(p, spawn(true));
        const flicker = 0.7 + 0.3 * Math.sin(p.tw);
        ctx.globalAlpha = p.a * flicker * (0.45 + intensity * 0.55);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      paused = document.hidden;
      if (!paused) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(draw);
      }
    };

    resize();
    parts = Array.from({ length: COUNT }, () => spawn(false));
    raf = requestAnimationFrame(draw);

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    ro?.observe(host);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intensity]);

  return <canvas ref={ref} className="pm-ember-canvas" aria-hidden="true" />;
}

export default function FlameBackdrop({ intensity = 0.6 }) {
  const reduced = usePrefersReducedMotion();
  const t = clamp01(intensity);

  // Single knob → layer strengths. Kept within readability-safe bounds even at t=1.
  const rootOpacity = 0.42 + t * 0.46; // 0.42 → 0.88
  const sparkOpacity = 0.12 + t * 0.5; // fissure travelling glow
  const poolOpacity = 0.55 + t * 0.45; // depth pool glow

  return (
    <div className="pm-flame" aria-hidden="true" style={{ opacity: rootOpacity }}>
      {/* Depth pools — two parallax planes drifting at different speeds/amplitudes give a
          sense of 3D depth without any mouse input (which would fight the mascot tracking). */}
      <div className="pm-flame-plane pm-flame-deep" style={{ opacity: poolOpacity }}>
        <span className="pm-flame-pool pm-flame-pool-a" />
        <span className="pm-flame-pool pm-flame-pool-b" />
      </div>
      <div className="pm-flame-plane pm-flame-mid" style={{ opacity: poolOpacity * 0.9 }}>
        <span className="pm-flame-pool pm-flame-pool-c" />
      </div>

      {/* Ember particles — only when motion is allowed. */}
      {!reduced && <EmberField intensity={t} />}

      {/* Fire-crack fissures: a soft base stroke plus a bright spark that travels along it. */}
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
              key={`base-${i}`}
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

        {!reduced && (
          <g style={{ opacity: sparkOpacity }}>
            {CRACKS.map((c, i) => (
              <path
                key={`spark-${i}`}
                d={c.d}
                className="pm-crack-spark"
                style={{ animationDuration: SPARK_DUR[i], animationDelay: `${i * -1.7}s` }}
              />
            ))}
          </g>
        )}
      </svg>

      {/* Edge vignette — darkens the frame so the cards sit forward and text stays crisp. */}
      <div className="pm-flame-vignette" />
    </div>
  );
}
