import EyesMascot from "../prediction/EyesMascot.jsx";
import "../../styles/prediction.css";
import "../../styles/tachy.css";

// Tachy's face. A wrapper around the existing mascot, not a copy of it and not a
// modification of it.
//
// WHY A WRAPPER RATHER THAN AN `expression` PROP ON EyesMascot: EyesMascot.jsx belongs
// to the prediction tree, which has to stay byte-identical — `git diff` on that tree is
// part of the isolation contract. So the expression axis lives out here, on a span that
// Tachy owns. EyesMascot keeps its own `mode` prop, which is about ANIMATION (idle bob
// vs cursor tracking) and is a different question from mood.
//
// V2 PATH — this is the whole point of the prop existing now while doing almost nothing:
// making Tachy mood-reactive means passing a different string (from sentiment, from a
// liquidation event, from `knowsAnswer: false`) and adding one CSS rule per mood. No
// component signature changes, no re-plumbing. In v1 `calm`, `alert` and `sorry` are
// declared-but-identical hooks; only `thinking` renders differently, because the loading
// state is a real requirement rather than a placeholder.
//
// It also imports prediction.css directly. EyesMascot's own styles (.pm-mascot, the idle
// bob, the reduced-motion rule) live in that file, and today it is loaded only as a side
// effect of PredictionApp being mounted. Depending on that would make Tachy's appearance
// hostage to an unrelated tree's mount order; Vite dedupes the second import, so this
// costs nothing and states the dependency out loud.

const EXPRESSIONS = new Set(["calm", "thinking", "alert", "sorry"]);

export default function TachyAvatar({ size = 44, expression = "calm", track = true, className = "" }) {
  // Unknown moods degrade to calm rather than producing a class that styles nothing —
  // so a v2 typo is a neutral face, not an invisible mascot.
  const mood = EXPRESSIONS.has(expression) ? expression : "calm";

  return (
    <span className={`tachy-avatar tachy-exp-${mood} ${className}`} data-expression={mood}>
      {/* "track" also suppresses the idle bob, which would fight the panel's own motion. */}
      <EyesMascot size={size} mode={track ? "track" : "idle"} />
    </span>
  );
}
