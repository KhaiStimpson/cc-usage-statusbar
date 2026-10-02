import type { Level } from '../types'
import { formatClock } from './model'

/** Fills that read on both the desktop's light and dark themes. */
export const SVG_COLOR: Record<Level | 'ctx', string> = {
  calm: '#4f9e6a',
  warm: '#d4923a',
  hot: '#d9563f',
  ctx: '#6f8fbf',
}
/** The grey of a calm ledger segment: present, but asking for nothing. */
export const SVG_QUIET = '#8a877f'
const TRACK = 'fill="#808080" fill-opacity="0.28"'
const TICK = '#8a877f'

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n))
const r1 = (n: number) => Math.round(n * 10) / 10

function esc(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

/** How wide the fill is: a sliver for any spend at all, so $0.33 of $500 still shows. */
function fillWidth(percent: number, width: number): number {
  if (percent <= 0) return 0

  return r1(Math.max(2, (clamp(percent) / 100) * width))
}

const REDUCED = '@media (prefers-reduced-motion:reduce){*{animation:none!important}.sh{display:none}}'

export type BarSvg = {
  percent: number
  pace?: number
  width: number
  color: string
  title: string
  /** The bar's thickness; 6 px, or 8 px with motion, when absent. */
  height?: number
  /** Pulse: grow in from this percent, sweep a sheen, breathe the pace tick, glow when hot. */
  motion?: { from: number; isHot: boolean }
}

/** A rounded bar with its pace tick, `width` px wide and 14 px tall. */
export function barSvg({ percent, pace, width, color, title, height, motion }: BarSvg): string {
  const h = 14
  const bh = height ?? (motion ? 8 : 6)
  const y = (h - bh) / 2
  const fw = fillWidth(percent, width)
  const tx = pace === undefined ? undefined : r1(Math.min(width - 2, (clamp(pace) / 100) * width))
  const parts: string[] = [`<title>${esc(title)}</title>`]

  if (motion) {
    const ratio = fw > 0 ? r1(clamp(fillWidth(motion.from, width) / fw, 0, 1) * 100) / 100 : 1
    parts.push(
      '<style>',
      `.f{transform-box:fill-box;transform-origin:left center;animation:g .9s cubic-bezier(.2,.8,.2,1) both}`,
      `@keyframes g{from{transform:scaleX(${ratio})}to{transform:scaleX(1)}}`,
      `.sh{animation:s 3.2s ease-in-out 1s infinite}`,
      `@keyframes s{0%{transform:translateX(-${Math.round(width * 0.3)}px)}55%,100%{transform:translateX(${width}px)}}`,
      `.p{animation:b 2.4s ease-in-out infinite}`,
      `@keyframes b{0%,100%{opacity:.35}50%{opacity:1}}`,
      `.o{animation:o 2.2s ease-in-out infinite}`,
      `@keyframes o{0%,100%{opacity:0}50%{opacity:.7}}`,
      REDUCED,
      '</style>',
      `<clipPath id="c"><rect x="0" y="${y}" width="${fw}" height="${bh}" rx="${bh / 2}"/></clipPath>`,
    )
  }
  if (motion?.isHot) {
    parts.push(
      `<rect class="o" x="0.5" y="${y - 1.5}" width="${width - 1}" height="${bh + 3}" rx="${bh / 2 + 1.5}" fill="none" stroke="${color}" stroke-width="1"/>`,
    )
  }
  parts.push(`<rect x="0" y="${y}" width="${width}" height="${bh}" rx="${bh / 2}" ${TRACK}/>`)
  if (fw > 0) {
    parts.push(`<rect${motion ? ' class="f"' : ''} x="0" y="${y}" width="${fw}" height="${bh}" rx="${bh / 2}" fill="${color}"/>`)
    if (motion) {
      parts.push(
        `<g clip-path="url(#c)"><rect class="sh" x="0" y="${y}" width="${Math.round(width * 0.3)}" height="${bh}" fill="#fff" fill-opacity="0.45"/></g>`,
      )
    }
  }
  if (tx !== undefined) {
    parts.push(`<rect${motion ? ' class="p"' : ''} x="${tx}" y="0" width="2" height="${h}" rx="1" fill="${TICK}"/>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${parts.join('')}</svg>`
}

export type RuleSegment = { percent: number; pace?: number; color: string; title: string }

/** The ledger's hairline: one 3 px segment per gauge across `width` px, ticks rising above. */
export function ruleSvg(segments: readonly RuleSegment[], width: number): string {
  const h = 7
  const gap = 8
  const n = Math.max(1, segments.length)
  const sw = (width - gap * (n - 1)) / n
  const parts = segments.map((s, i) => {
    const x = r1(i * (sw + gap))
    const fw = fillWidth(s.percent, sw)
    const tick =
      s.pace === undefined ? '' : `<rect x="${r1(x + Math.min(sw - 2, (clamp(s.pace) / 100) * sw))}" y="0" width="2" height="${h}" fill="${TICK}"/>`

    return (
      `<g><title>${esc(s.title)}</title>` +
      `<rect x="${x}" y="4" width="${r1(sw)}" height="3" ${TRACK}/>` +
      (fw > 0 ? `<rect x="${x}" y="4" width="${fw}" height="3" fill="${s.color}"/>` : '') +
      `${tick}</g>`
    )
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" preserveAspectRatio="none">${parts.join('')}</svg>`
}

/** A dot that pings while a turn runs. */
export function liveDotSvg(color: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">' +
    '<title>A turn is running</title>' +
    '<style>.r{transform-box:fill-box;transform-origin:center;animation:p 1.6s ease-out infinite}' +
    '@keyframes p{0%{transform:scale(1);opacity:.55}100%{transform:scale(2.6);opacity:0}}' +
    `${REDUCED}</style>` +
    `<circle class="r" cx="6" cy="6" r="2.2" fill="${color}"/>` +
    `<circle cx="6" cy="6" r="2.6" fill="${color}"/>` +
    '</svg>'
  )
}

/** A small line of recent daily spend that draws itself in. */
export function sparkSvg(values: readonly number[], color: string, title: string): string {
  const w = 44
  const h = 16
  const top = Math.max(0, ...values)
  const step = values.length > 1 ? (w - 2) / (values.length - 1) : 0
  const points = values
    .map((v, i) => `${r1(1 + i * step)},${r1(h - 2 - (top > 0 ? (v / top) * (h - 4) : 0))}`)
    .join(' ')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<title>${esc(title)}</title>` +
    '<style>.l{stroke-dasharray:120;animation:d 1.4s ease-out .3s both}@keyframes d{from{stroke-dashoffset:120}to{stroke-dashoffset:0}}' +
    `${REDUCED}</style>` +
    `<polyline class="l" points="${points}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    '</svg>'
  )
}

export type CacheClockSvg = {
  /** Time left on the cache, inside its warning stretch. */
  remainingMs: number
  /** How long the warning stretch is; the bar drains across it. */
  warnMs: number
  color: string
  title: string
  hasBar: boolean
  /** White digits with a dark outline, for sitting on a tinted fill of either theme. */
  hasHalo?: boolean
}

/**
 * The cache's last stretch as one drawing that runs itself: the bar drains and the digits step down with
 * CSS alone, so the band need not redraw every second. Each second is its own `<text>` shown for that
 * second; with reduced motion the animation is off and it holds the value it was drawn at.
 */
export function cacheClockSvg({ remainingMs, warnMs, color, title, hasBar, hasHalo }: CacheClockSvg): string {
  const h = 16
  const barW = hasBar ? 72 : 0
  const textX = hasBar ? barW + 8 : 0
  const w = textX + 34
  const warnS = warnMs / 1000
  const left = Math.min(Math.max(0, remainingMs) / 1000, warnS)
  const elapsed = r1(warnS - left)
  const first = Math.ceil(left)
  const texts: string[] = []
  for (let v = first; v >= 0; v--) {
    const delay = r1(warnS - v - elapsed)
    texts.push(
      `<text class="t" x="${textX}" y="12.5" style="animation-delay:${delay}s${v === first ? ';opacity:1' : ''}">${formatClock(v * 1000)}</text>`,
    )
  }
  const bar = hasBar
    ? `<rect x="0" y="4" width="${barW}" height="8" rx="4" ${TRACK}/><rect class="b" x="0" y="4" width="${barW}" height="8" rx="4" fill="${color}"/>`
    : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<title>${esc(title)}</title>` +
    '<style>' +
    `.t{font:600 13px system-ui,-apple-system,'Segoe UI',sans-serif;font-variant-numeric:tabular-nums;${hasHalo ? 'fill:#fff;stroke:#14110f;stroke-width:2.5px;paint-order:stroke;stroke-linejoin:round' : `fill:${color}`};opacity:0;animation:v 1s steps(1,end) forwards}` +
    '@keyframes v{0%{opacity:1}100%{opacity:0}}' +
    `.b{transform-box:fill-box;transform-origin:left center;animation:d ${r1(left)}s linear forwards}` +
    `@keyframes d{from{transform:scaleX(${r1(left / warnS * 100) / 100})}to{transform:scaleX(0)}}` +
    `${REDUCED}</style>` +
    `${bar}${texts.join('')}</svg>`
  )
}

const NARROW_CHARS = "il.,:;'|!/ ()[]·"
const WIDE_CHARS = 'mwMW%⚠≈'

/** A rough width in px for 13 px system text; the pill draws its own text, so a miss only changes the padding. */
function textWidth(text: string, isBold: boolean): number {
  let w = 0
  for (const ch of text.split('')) {
    if (NARROW_CHARS.includes(ch)) w += 3.6
    else if (WIDE_CHARS.includes(ch)) w += 11
    else if (ch >= '0' && ch <= '9') w += 7.4
    else if (ch >= 'A' && ch <= 'Z') w += 8.6
    else w += 6.9
  }

  return Math.ceil(w * (isBold ? 1.05 : 1))
}

export type PillPart = { text: string; style: 'label' | 'value' | 'dim' } | { clock: true }

export type PillSvg = {
  parts: readonly PillPart[]
  /** How far the pill is filled, 0 to 100. */
  percent: number
  level: Level
  title: string
  /** The warm cache's countdown, drawn by the `clock` part. */
  clock?: { remainingMs: number; warnMs: number }
}

const PILL_FILL: Record<Level, string> = {
  calm: 'rgba(128,128,128,0.45)',
  warm: 'rgba(212,146,58,0.62)',
  hot: 'rgba(217,86,63,0.66)',
}
const CLOCK_WIDTH = 30

/**
 * One gauge as a rounded pill: a faint track, a fill to its percentage, and its text on top, all in one
 * drawing so the fill and the words always line up. The text follows the viewer's light or dark preference.
 */
export function pillSvg({ parts, percent, level, title, clock }: PillSvg): { source: string; width: number } {
  const h = 20
  const pad = 11
  const gap = 7
  let x = pad
  const texts: string[] = []
  let css = ''
  parts.forEach((part, i) => {
    if (i > 0) x += gap
    if ('clock' in part) {
      if (!clock) return
      const warnS = clock.warnMs / 1000
      const left = Math.min(Math.max(0, clock.remainingMs) / 1000, warnS)
      const elapsed = r1(warnS - left)
      const first = Math.ceil(left)
      for (let v = first; v >= 0; v--) {
        const delay = r1(warnS - v - elapsed)
        texts.push(
          `<text class="t v" x="${x}" y="14.5" style="animation-delay:${delay}s${v === first ? ';opacity:1' : ''}">${formatClock(v * 1000)}</text>`,
        )
      }
      css = '.t{font-variant-numeric:tabular-nums;opacity:0;animation:k 1s steps(1,end) forwards}@keyframes k{0%{opacity:1}100%{opacity:0}}'
      x += CLOCK_WIDTH

      return
    }
    const isBold = part.style === 'value'
    texts.push(
      `<text class="${isBold ? 'v' : 'd'}" x="${x}" y="14.5"${isBold ? ' font-weight="600"' : ''}>${esc(part.text)}</text>`,
    )
    x += textWidth(part.text, isBold)
  })
  const width = Math.round(x + pad)
  const fw = percent <= 0 ? 0 : r1(Math.max(h / 2, (clamp(percent) / 100) * width))

  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">` +
    `<title>${esc(title)}</title>` +
    '<style>' +
    "text{font:13px system-ui,-apple-system,'Segoe UI',sans-serif}" +
    '.v{fill:#1d1d1b}.d{fill:#6b6a65}' +
    '@media (prefers-color-scheme:dark){.v{fill:#ecebe6}.d{fill:#9a988f}}' +
    `${css}${REDUCED}</style>` +
    `<clipPath id="p"><rect x="0" y="0" width="${width}" height="${h}" rx="${h / 2}"/></clipPath>` +
    `<rect x="0" y="0" width="${width}" height="${h}" rx="${h / 2}" ${TRACK}/>` +
    (fw > 0 ? `<g clip-path="url(#p)"><rect x="0" y="0" width="${fw}" height="${h}" fill="${PILL_FILL[level]}"/></g>` : '') +
    `${texts.join('')}</svg>`

  return { source, width }
}
