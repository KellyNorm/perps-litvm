# TachyonFi Landing — Build Rules (READ FIRST, EVERY SESSION)

This folder (`landing/`) is a **standalone static marketing site** for the root domain
`tachyonfi.xyz`. The design is **final and approved**. Your job is to **port it faithfully**
into a real project and wire the live data — **not to design, restyle, or improve it.**

## Source of truth
- `reference/index.reference.html` is the **locked, approved design**. It is the contract.
- Every section's markup, CSS values, copy, fonts, animations, spacing, and order must
  **match the reference exactly**.
- The correct way to preserve fidelity: **copy the reference's entire `<style>` block into a
  single global stylesheet, unchanged**, and build components whose rendered DOM matches the
  reference markup. Do not regenerate CSS from scratch. Do not "tidy" values.

## Hard boundaries — never cross these
1. **Do NOT touch, import from, read at runtime, or restructure `frontend/`** or any contract
   code. No wallet libraries, no web3 signing, no contract writes anywhere in `landing/`.
2. **Do NOT change the design.** No new colors, fonts, spacing, border-radius, shadows,
   layout, or animations. No section reordering. No "cleanup" passes that alter output.
3. **Do NOT rewrite or paraphrase copy.** All text is final. Match it character-for-character.
4. **Do NOT add features** not present in the reference (no new sections, CTAs, links, modals).
5. If you believe something *must* change (a genuine bug, a broken link, an a11y failure),
   **stop and ask first** with a one-line diff proposal. Default is: leave it as-is.

## Locked brand tokens (already in the reference `<style>` — do not alter)
```
--bg:#080B14  --bg2:#0E1324  --card:#131A2E  --line:rgba(148,170,255,.10)
--text:#F4F8FF  --muted:#93A0C0  --dim:#5C6A8C
--blue:#29A9FF  --indigo:#6A7BFF  --violet:#A24DFF  --magenta:#D44CFF
--green:#00D98B  --red:#FF4D6D
--grad: linear-gradient(135deg,#29A9FF,#6A7BFF 45%,#A24DFF 70%,#D44CFF 100%)
Fonts: Space Grotesk (display) · Inter (body) · JetBrains Mono (all numbers/labels)
```

## Locked behavior
- **"Trade Now"** is always a plain `<a href="https://app.tachyonfi.xyz" target="_blank"
  rel="noopener">`. It is a **link on click — never an auto-redirect / no JS navigation.**
- The **only** external social link is X at `https://x.com/_tachyonfi` (appears exactly twice:
  hero "Follow on X" and footer). No other social links.
- **Predictions** and **Docs** stay "Coming Soon" / "Soon". They are **not live** — never link
  them anywhere, never add a button to Predictions (no dead ends).
- "Predictions" must **not** appear in the top nav.

## Honesty (non-negotiable)
This is an **unaudited testnet product in active development**. Never imply audited, safe,
mainnet, or production-ready. Keep every existing "Testnet · Unaudited" disclaimer (hero,
footer bar, footer disclaimer). Keep the "test mUSD — nothing has real value" line.

## Assets
- Logo: copy the real logo from `frontend/public/` into `landing/public/` at build time
  (do not reference `frontend/` at runtime). The reference uses an inline SVG stand-in for the
  mark — replace it with the real logo file.
- Mascot: the reference draws the mascot once as an SVG `<symbol id="mascot">` reused in the
  endless-runner band and the Predictions section. Swap that single symbol for the real mascot
  art and both update. (If a run-cycle sprite exists, ask before changing the hop animation.)

## Live data (stats strip only)
- Read-only, no wallet. RPC: `https://liteforge.rpc.caldera.xyz/infra-partner-http` (chain 4441).
- Contracts: PositionManager `0x9396d36f713302ff39e0ba5b38012656f8e4eacf`,
  LiquidityPool `0x4716a0c9c504f83918002a3086590f1ed192560b`,
  mUSD `0x4aedab95d41a31f891ee12d13cd77102705e2def`.
- **Inspect the contracts' actual view functions** (or reuse the ABIs from the repo) to source
  TVL, market count, and open interest. Do not guess method names.
- If any read is slow or fails, render `—` for that stat. **Never crash, never block render.**

## Workflow
- **One section/feature per PR.** Build **hero first**, deploy a preview, and **wait for my
  approval** before starting the next section.
- After each PR: `npm run build` must pass, then **visually diff the built page against
  `reference/index.reference.html`** and report any difference before I review.

## Quality floor (already met in the reference — keep it)
Mobile-first, responsive at 1024 / 900 / 640 / 400px with no horizontal scroll; visible
keyboard focus; `prefers-reduced-motion` fully respected (freeze canvas, runner, reveals).