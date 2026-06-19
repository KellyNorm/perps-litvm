import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion.js";

// Ambient ember field rising from the firebase glow — ported from the design
// reference. Disabled entirely under prefers-reduced-motion, and paused while the
// tab is hidden.
export default function EmberCanvas() {
  const ref = useRef(null);
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const ec = ref.current;
    if (!ec) return;
    const ex = ec.getContext("2d");
    let ew = 0;
    let eh = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let P = [];
    let raf = 0;

    function esize() {
      ew = ec.clientWidth;
      eh = ec.clientHeight;
      ec.width = ew * dpr;
      ec.height = eh * dpr;
      ex.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function spawn(init) {
      return {
        x: Math.random() * ew,
        y: init ? Math.random() * eh : eh + 8,
        vx: (Math.random() - 0.5) * 0.18,
        vy: -(0.16 + Math.random() * 0.46),
        r: 0.5 + Math.random() * 1.7,
        a: 0,
        maxa: 0.1 + Math.random() * 0.34,
        t: 0,
        life: 260 + Math.random() * 380,
        hot: Math.random() < 0.22,
      };
    }
    function tick() {
      ex.clearRect(0, 0, ew, eh);
      ex.globalCompositeOperation = "lighter";
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        p.t++;
        p.x += p.vx;
        p.y += p.vy;
        p.vy -= 0.0006;
        p.vx += (Math.random() - 0.5) * 0.02;
        const lf = p.t / p.life;
        p.a = lf < 0.15 ? p.maxa * (lf / 0.15) : p.maxa * (1 - (lf - 0.15) / 0.85);
        if (p.t >= p.life || p.y < -10) {
          P[i] = spawn(false);
          continue;
        }
        ex.beginPath();
        ex.fillStyle = "rgba(" + (p.hot ? "255,231,207" : "255,138,76") + "," + p.a.toFixed(3) + ")";
        ex.arc(p.x, p.y, p.r, 0, 6.2832);
        ex.fill();
      }
      raf = requestAnimationFrame(tick);
    }

    esize();
    for (let ei = 0; ei < 54; ei++) P.push(spawn(true));
    tick();

    const onResize = () => esize();
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf) {
        tick();
      }
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      P = [];
    };
  }, [reduce]);

  if (reduce) return null;
  return <canvas id="embers" ref={ref} aria-hidden="true" />;
}
