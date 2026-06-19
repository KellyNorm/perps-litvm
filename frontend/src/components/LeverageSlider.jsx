import { MIN_LEVERAGE, MAX_LEVERAGE } from "../lib/engine.js";

// Leverage slider whose flame scales and heats with leverage — ported from the
// design reference. The flame flicker is CSS-animated and respects reduced-motion
// (global rule kills the animation); the scale/heat still track the value.
export default function LeverageSlider({ value, onChange }) {
  const span = MAX_LEVERAGE - MIN_LEVERAGE; // 9
  const pct = ((value - MIN_LEVERAGE) / span) * 100;
  const hI = (value - MIN_LEVERAGE) / span; // 0..1
  const valColor = hI < 0.34 ? "var(--molten-hot)" : hI < 0.7 ? "var(--molten)" : "var(--plasma)";

  return (
    <div className="field">
      <div className="lev-head">
        <label htmlFor="levInput">Leverage</label>
        <span className="lev-val" style={{ color: valColor }}>
          {value.toFixed(1)}×
        </span>
      </div>
      <div className="slider">
        <div className="track">
          <div className="heat" style={{ width: pct + "%" }}></div>
        </div>
        <div
          className="flame"
          style={{
            left: pct + "%",
            "--fscale": (0.42 + hI * 0.55).toFixed(3),
            "--fop": (0.5 + hI * 0.5).toFixed(3),
          }}
        >
          <i></i>
          <i className="core"></i>
        </div>
        <div
          className="glow"
          style={{
            left: pct + "%",
            boxShadow: `0 0 ${(6 + hI * 26).toFixed(0)}px ${(hI * 7).toFixed(1)}px rgba(255,107,61,${(0.1 + hI * 0.55).toFixed(2)})`,
          }}
        ></div>
        <input
          id="levInput"
          type="range"
          min={MIN_LEVERAGE}
          max={MAX_LEVERAGE}
          step="0.5"
          value={value}
          aria-label="Leverage multiplier"
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
      </div>
      <div className="lev-marks">
        <span>1×</span>
        <span>3×</span>
        <span>5×</span>
        <span>7×</span>
        <span>10×</span>
      </div>
    </div>
  );
}
