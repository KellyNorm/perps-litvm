import { useEffect, useRef, useState } from "react";

// The mascot, extracted for reuse in the predictions header.
//
// PROVENANCE: the geometry is copied verbatim from
// `landing/src/components/MascotSymbol.tsx` (blob + eye gradients, eye sockets,
// lightning-bolt pupils, smile). It is COPIED, not imported: `landing/` and
// `frontend/` are separate Vite projects with separate package.json files and
// landing/CLAUDE.md forbids cross-wiring them, so a live import would break both the
// build and that boundary. Consequence to be aware of: the two copies must be kept
// in sync by hand if the mascot art is ever replaced.
//
// Gradient ids are namespaced (pm-blob / pm-eye) because SVG gradient ids are
// document-global and would otherwise collide with landing's `blob` / `eye`.
//
// NOTE ON ANIMATION: landing's `hop` keyframes (.62s, -32px, ±4deg) are a RUNNING
// cycle for the endless-runner band. Inline beside a heading that reads as frantic,
// so this uses a much gentler idle bob. landing's hop is untouched.

export default function EyesMascot({ size = 34, mode = "idle", className = "" }) {
  const ref = useRef(null);
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [blinking, setBlinking] = useState(false);

  // Periodic blink, slightly irregular so it does not read as a metronome.
  useEffect(() => {
    let timer;
    const schedule = () => {
      timer = setTimeout(() => {
        setBlinking(true);
        setTimeout(() => setBlinking(false), 130);
        schedule();
      }, 2600 + Math.random() * 3200);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  // Cursor tracking: pupils drift a few px toward the pointer. Only wired up in
  // "track" mode so the idle variant costs nothing.
  useEffect(() => {
    if (mode !== "track") return;
    const onMove = (e) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(d, 260) / 260;
      setLook({ x: (dx / d) * 9 * reach, y: (dy / d) * 7 * reach });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [mode]);

  return (
    <svg
      ref={ref}
      className={`pm-mascot pm-mascot-${mode} ${className}`}
      viewBox="0 0 220 240"
      width={size}
      height={size * (240 / 220)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="pm-blob" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5EC8FF" />
          <stop offset="1" stopColor="#2B8FEB" />
        </linearGradient>
        <radialGradient id="pm-eye" cx="50%" cy="50%" r="60%">
          <stop offset="0" stopColor="#8FFCE8" />
          <stop offset="1" stopColor="#00D98B" />
        </radialGradient>
      </defs>

      <g className="pm-mascot-body">
        <path
          d="M110 20 C70 20 60 46 66 66 C40 78 30 118 40 158 C50 200 78 224 110 224 C142 224 170 200 180 158 C190 118 180 78 154 66 C160 46 150 20 110 20 Z"
          fill="url(#pm-blob)"
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

        {/* Pupils. translate() carries the cursor offset; scaleY the blink. */}
        <g
          fill="url(#pm-eye)"
          filter="drop-shadow(0 0 6px #00D98B)"
          style={{
            transform: `translate(${look.x}px, ${look.y}px) scaleY(${blinking ? 0.12 : 1})`,
            transformOrigin: "113px 126px",
            transition: "transform .13s ease-out",
          }}
        >
          <path d="M86 112 l6 12 -7 2 8 14 -4 2 -8-14 7-2 -6-12z" />
          <circle cx="86" cy="132" r="4" />
          <path d="M140 106 l6 12 -7 2 8 14 -4 2 -8-14 7-2 -6-12z" />
          <circle cx="140" cy="126" r="4" />
        </g>

        <path d="M104 156 q6 6 14 0" fill="none" stroke="#0A1428" strokeWidth="3.5" strokeLinecap="round" />
      </g>
    </svg>
  );
}
