# Usage bar: quiet until it matters

Approved 2026-10-03 from the redesign mockups (direction A), for chips, ledger and pulse.
The mockup is reference material for proportion and behaviour, not markup to copy:
https://claude.ai/artifact/RycMp9j3v3srwKv9jUfjK2

## Decision

- `classic` is removed. `pulse` becomes the default. A saved `style: classic` falls back to `pulse`.
- A gauge is **calm** or **loud**. Loud means its level is `warm` or `hot` (which already
  covers "ahead of pace", see `levelOf` in `hooks/model.ts`).

## Hierarchy

1. Loud gauges: full bar with pace tick, coloured label and value, the note and the reset time.
2. Calm gauges: label, value and a minimal level mark. No reset time, no pace tick. A money
   gauge keeps its `/ $limit` even when calm: a dollar figure alone doesn't say how close it is.
3. Figures (month, today, session) and ctx: grouped at the right edge, so the left edge always
   means limits. ctx turns loud on the same rule (75% warm, 90% hot).

The `/usagebar for details` hint is dropped from the band.

## Per style

| Style  | Calm gauge | Loud gauge |
| ------ | ---------- | ---------- |
| pulse  | 28 px, 4 px thin bar on the desktop; one level glyph (`▁`…`█`) in the terminal | 96 px bar (52 narrow), pace tick, glow when hot; `smoothBar` in the terminal |
| chips  | plain text, no border | rounded chip in its level colour with bar, value, note, reset |
| ledger | plain text; its rule segment is grey | coloured text and rule segment, pace tick on the segment |

- pulse: the live dot moves to the start of the band.
- chips: session, other figures and a calm ctx share one dim chip on the right; a loud ctx gets
  its own chip.
- ledger: the rule gains a ctx segment and is kept on narrow bands too.
- Narrow (`isNarrow`): bars stay (calm ones are already tiny), reset times and the `session`
  word drop.

## Reused

- `barSvg`, `ruleSvg`, `liveDotSvg`, `sparkSvg`, `SVG_COLOR` in `hooks/svg.ts`. `barSvg` gains a
  `height` option for the thin calm bar.
- `smoothBar`, `barCells`, `gaugeNote`, `percentLabel` in `hooks/model.ts`.
- The pulse grow-in motion (`drawnPercent`) and terminal dot frames in `hooks/register.tsx`.

## New

- `levelGlyph` in `hooks/model.ts`: one cell that stands in for a calm bar in the terminal,
  where nothing else fits in a single column.
- `SVG_QUIET` in `hooks/svg.ts` and `COLOR.quiet` for calm ledger segments.

## Rejected

- **B, Instrument** (ghost pace fill, rings): clearer pace, but every gauge stays full-weight.
- **C, Headroom** (show what's left): fights `/usage` and Claude's own warnings, which speak in
  percent used.
- **Keeping classic**: it duplicated pulse in the terminal and was the noisiest style.
