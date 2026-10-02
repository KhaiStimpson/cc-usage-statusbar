import type {
  AdminReading,
  Level,
  LocalSpend,
  Period,
  Sample,
  Snapshot,
} from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

const WINDOW_SPAN: Record<string, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * DAY,
}
const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export type Gauge = {
  id: string
  label: string
  percent: number
  /** Where an even burn would be by now, 0 to 100. */
  pace?: number
  resetsAt?: number
  level: Level
  isAhead: boolean
  spentUsd?: number
  limitUsd?: number
  /** Tracked on this machine rather than read from a server. */
  isEstimate?: boolean
  forecastUsd?: number
  hitsLimitAt?: number
}

export type Options = {
  budgetUsd: number
  budgetPeriod: Period
  orgLimitUsd: number
}

export type View = {
  windows: Gauge[]
  spend?: Gauge
  /** Spend this month, shown when no limit is known. */
  monthUsd?: number
  isMonthEstimate?: boolean
  todayUsd?: number
  sessionUsd?: number
  contextPercent?: number
  /** No subscription windows: the account pays per token. */
  isApiMode: boolean
}

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n))
const round1 = (n: number) => Math.round(n * 10) / 10

export function levelOf(percent: number, pace: number | undefined, warmAt: number, hotAt: number): Level {
  if (percent >= hotAt) return 'hot'
  if (percent >= warmAt) return 'warm'
  if (isAheadOf(percent, pace)) return 'warm'
  return 'calm'
}

export function isAheadOf(percent: number, pace: number | undefined): boolean {
  return pace !== undefined && percent >= 25 && percent - pace >= 10
}

/** Start and end of the period holding `now`, in local time or UTC. */
export function periodBounds(period: Period, now: number, isUtc = false): { start: number; end: number } {
  const d = new Date(now)
  if (isUtc) {
    d.setUTCHours(0, 0, 0, 0)
    if (period === 'weekly') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
    if (period === 'monthly') d.setUTCDate(1)
  } else {
    d.setHours(0, 0, 0, 0)
    if (period === 'weekly') d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    if (period === 'monthly') d.setDate(1)
  }
  const start = d.getTime()
  const e = new Date(start)
  if (period === 'daily') isUtc ? e.setUTCDate(e.getUTCDate() + 1) : e.setDate(e.getDate() + 1)
  if (period === 'weekly') isUtc ? e.setUTCDate(e.getUTCDate() + 7) : e.setDate(e.getDate() + 7)
  if (period === 'monthly') isUtc ? e.setUTCMonth(e.getUTCMonth() + 1) : e.setMonth(e.getMonth() + 1)

  return { start, end: e.getTime() }
}

/** A gateway reports only when its limit resets; guess the period from that. */
function inferredStart(resetsAt: number, now: number): number {
  const remaining = resetsAt - now
  if (remaining <= DAY) return resetsAt - DAY
  if (remaining <= 7 * DAY) return resetsAt - 7 * DAY
  const d = new Date(resetsAt)
  d.setMonth(d.getMonth() - 1)

  return d.getTime()
}

function paceBetween(start: number, end: number, now: number): number {
  return end > start ? clamp(((now - start) / (end - start)) * 100) : 0
}

export function windowGauge(kind: string, percentUsed: number, resetsAt: number | undefined, now: number): Gauge {
  const span = WINDOW_SPAN[kind]
  const pace =
    span !== undefined && resetsAt !== undefined ? paceBetween(resetsAt - span, resetsAt, now) : undefined
  const percent = round1(percentUsed)

  return {
    id: kind,
    label: WINDOW_LABEL[kind] ?? kind,
    percent,
    pace,
    resetsAt,
    level: levelOf(percent, pace, 70, 90),
    isAhead: isAheadOf(percent, pace),
  }
}

function amountGauge(
  label: string,
  spentUsd: number,
  limitUsd: number,
  start: number,
  end: number,
  now: number,
  isEstimate: boolean,
): Gauge {
  const percent = round1((spentUsd / limitUsd) * 100)
  const pace = paceBetween(start, end, now)
  const elapsed = (now - start) / (end - start)
  const forecastUsd = elapsed > 0.03 ? spentUsd / elapsed : undefined
  const hitAt = spentUsd > 0 ? start + ((now - start) * limitUsd) / spentUsd : undefined
  const hitsLimitAt = hitAt !== undefined && spentUsd < limitUsd && hitAt < end ? hitAt : undefined

  return {
    id: 'spend',
    label,
    percent,
    pace,
    resetsAt: end,
    level: levelOf(percent, pace, 80, 95),
    isAhead: isAheadOf(percent, pace),
    spentUsd,
    limitUsd,
    isEstimate,
    forecastUsd,
    hitsLimitAt,
  }
}

/**
 * The spend limit to show, best source first: the Admin API's real figures,
 * the gateway's enforced limit, the person's own budget, then the org cap
 * counted against this machine's spend.
 */
export function spendGauge(
  snapshot: Snapshot | null,
  admin: AdminReading | null,
  local: LocalSpend | null,
  options: Options,
  now: number,
): Gauge | undefined {
  if (admin && !admin.error && admin.limitUsd) {
    const { start } = periodBounds(admin.period, now, true)

    return amountGauge('org', admin.spentUsd, admin.limitUsd, start, admin.resetsAt, now, false)
  }

  const gateway = snapshot?.windows.find(w => w.kind === 'spend_limit')
  if (gateway) {
    const limitUsd = options.orgLimitUsd > 0 ? options.orgLimitUsd : undefined
    if (gateway.resetsAt !== undefined && limitUsd !== undefined) {
      const start = inferredStart(gateway.resetsAt, now)
      const gauge = amountGauge(
        'org',
        (gateway.percentUsed / 100) * limitUsd,
        limitUsd,
        start,
        gateway.resetsAt,
        now,
        false,
      )

      return { ...gauge, percent: round1(gateway.percentUsed) }
    }
    const pace =
      gateway.resetsAt !== undefined
        ? paceBetween(inferredStart(gateway.resetsAt, now), gateway.resetsAt, now)
        : undefined
    const percent = round1(gateway.percentUsed)

    return {
      id: 'spend',
      label: 'org',
      percent,
      pace,
      resetsAt: gateway.resetsAt,
      level: levelOf(percent, pace, 80, 95),
      isAhead: isAheadOf(percent, pace),
    }
  }

  if (options.budgetUsd > 0 && local) {
    const { start, end } = periodBounds(options.budgetPeriod, now)

    return amountGauge('budget', local.periodUsd, options.budgetUsd, start, end, now, true)
  }

  // No server reports the cap: count it monthly against this machine's spend.
  if (options.orgLimitUsd > 0 && local) {
    const { start, end } = periodBounds('monthly', now)

    return amountGauge('org', local.monthUsd, options.orgLimitUsd, start, end, now, true)
  }

  return undefined
}

export function buildView(
  snapshot: Snapshot | null,
  admin: AdminReading | null,
  local: LocalSpend | null,
  options: Options,
  now: number,
): View {
  const windows = (snapshot?.windows ?? [])
    .filter(w => w.kind in WINDOW_SPAN)
    .sort((a, b) => WINDOW_SPAN[a.kind]! - WINDOW_SPAN[b.kind]!)
    .map(w => windowGauge(w.kind, w.percentUsed, w.resetsAt, now))
  const isApiMode = windows.length === 0
  const spend = spendGauge(snapshot, admin, local, options, now)
  const hasAdminMonth = admin !== null && !admin.error && admin.period === 'monthly'
  const monthUsd = !spend && isApiMode ? (hasAdminMonth ? admin.spentUsd : local?.monthUsd) : undefined

  return {
    windows,
    spend,
    monthUsd,
    isMonthEstimate: !hasAdminMonth,
    todayUsd: isApiMode ? local?.todayUsd : undefined,
    sessionUsd: snapshot?.sessionUsd,
    contextPercent: snapshot?.contextPercent,
    isApiMode,
  }
}

/** Percentage points per hour over the current window, from its samples. */
export function burnRate(samples: readonly Sample[], now: number): number | undefined {
  const last = samples[samples.length - 1]
  if (!last) return undefined
  const current = samples.filter(s => s.resetsAt === last.resetsAt)
  const from = current.find(s => last.at - s.at <= 90 * MINUTE) ?? current[0]
  if (!from || last.at - from.at < 10 * MINUTE || now - last.at > 30 * MINUTE) return undefined

  return Math.max(0, (last.percent - from.percent) / ((last.at - from.at) / HOUR))
}

/** When a window reaches 100% at the burn rate, if before it resets. */
export function hitsFullIn(gauge: Gauge, rate: number | undefined, now: number): number | undefined {
  if (!rate || gauge.percent >= 100) return undefined
  const ms = ((100 - gauge.percent) / rate) * HOUR
  if (gauge.resetsAt !== undefined && now + ms >= gauge.resetsAt) return undefined

  return ms
}

export function formatUsd(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`
  if (usd >= 100) return `$${Math.round(usd)}`

  return `$${usd.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`

  return `${Math.round(hours / 24)}d`
}

export function formatDate(ms: number): string {
  const d = new Date(ms)

  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** A reset: a countdown under a day, the weekday within a week, else the date. */
export function formatReset(resetsAt: number, now: number): string {
  const ms = resetsAt - now
  if (ms < DAY) return formatDuration(ms)
  if (ms < 6 * DAY) return WEEKDAYS[new Date(resetsAt).getDay()]!

  return formatDate(resetsAt)
}

/** The short note a gauge carries when it needs attention. */
export function gaugeNote(gauge: Gauge, rate: number | undefined, now: number): string | undefined {
  if (gauge.spentUsd !== undefined && gauge.limitUsd !== undefined && gauge.spentUsd > gauge.limitUsd) {
    return `over by ${formatUsd(gauge.spentUsd - gauge.limitUsd)}`
  }
  if (gauge.percent >= 100) return 'limit reached'
  if (gauge.level === 'hot') {
    const ms = hitsFullIn(gauge, rate, now)

    return ms !== undefined ? `limit in ~${formatDuration(ms)}` : 'slow down'
  }
  if (gauge.isAhead && gauge.forecastUsd !== undefined && gauge.limitUsd !== undefined) {
    return gauge.forecastUsd > gauge.limitUsd ? `on track for ~${formatUsd(gauge.forecastUsd)}` : 'ahead of pace'
  }
  if (gauge.isAhead) return 'ahead of pace'

  return undefined
}

export type BarCell = 'fill' | 'empty' | 'tick'

/** A bar `width` cells wide, the pace tick replacing the cell it lands on. */
export function barCells(percent: number, width: number, pace?: number): BarCell[] {
  const filled = Math.round((clamp(percent) / 100) * width)
  const tick = pace === undefined ? -1 : Math.min(width - 1, Math.floor((clamp(pace) / 100) * width))

  return Array.from({ length: width }, (_, i) => (i === tick ? 'tick' : i < filled ? 'fill' : 'empty'))
}

export function textBar(percent: number, width: number, pace?: number): string {
  return barCells(percent, width, pace)
    .map(cell => (cell === 'fill' ? '█' : cell === 'tick' ? '┊' : '░'))
    .join('')
}

const SPARKS = '▁▂▃▄▅▆▇█'

/** One character per value, scaled to `max` (the largest value when absent). */
export function sparkline(values: readonly number[], max?: number): string {
  const top = max ?? Math.max(0, ...values)

  return values
    .map(v => (top <= 0 ? SPARKS[0] : SPARKS[Math.min(7, Math.floor((clamp(v / top, 0, 1) * 7.99)))]))
    .join('')
}

/** One cell that stands in for a calm bar: higher as the gauge fills. */
export function levelGlyph(percent: number): string {
  return SPARKS[Math.min(7, Math.floor((clamp(percent) / 100) * 7.99))]!
}

/** The plain-text line for the status entry: no color, so warnings are words. */
export function statusText(view: View, rate: number | undefined, now: number): string | undefined {
  const parts: string[] = []
  for (const g of view.windows) {
    const note = gaugeNote(g, rate, now)
    const reset = g.resetsAt !== undefined ? ` ↻${formatReset(g.resetsAt, now)}` : ''
    parts.push(
      `${g.level === 'hot' ? '⚠ ' : ''}${g.label} ${textBar(g.percent, 10, g.pace)} ${g.percent}%${reset}${note ? ` — ${note}` : ''}`,
    )
  }
  const s = view.spend
  if (s) {
    const amount =
      s.spentUsd !== undefined && s.limitUsd !== undefined
        ? `${s.isEstimate ? '≈' : ''}${formatUsd(s.spentUsd)}/${formatUsd(s.limitUsd)}`
        : `${s.percent}%`
    const reset = s.resetsAt !== undefined ? ` ↻${formatReset(s.resetsAt, now)}` : ''
    const note = gaugeNote(s, undefined, now)
    parts.push(
      `${s.level === 'hot' ? '⚠ ' : ''}${s.label} ${textBar(s.percent, 10, s.pace)} ${amount}${reset}${note ? ` — ${note}` : ''}`,
    )
  }
  if (view.monthUsd !== undefined) parts.push(`month ${view.isMonthEstimate ? '≈' : ''}${formatUsd(view.monthUsd)}`)
  if (view.todayUsd !== undefined) parts.push(`today ${formatUsd(view.todayUsd)}`)
  if (view.sessionUsd !== undefined) parts.push(view.isApiMode ? `session ${formatUsd(view.sessionUsd)}` : formatUsd(view.sessionUsd))
  if (view.contextPercent !== undefined) parts.push(`ctx ${Math.round(view.contextPercent)}%`)

  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** Alert keys crossed: one per gauge, threshold and window instance. */
export function crossedAlerts(view: View, now: number): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = []
  const gauges = view.spend ? [...view.windows, view.spend] : view.windows
  for (const g of gauges) {
    for (const at of [80, 95, 100]) {
      if (g.percent < at) continue
      const name =
        g.id === 'five_hour' ? '5-hour window' : g.id === 'seven_day' ? '7-day window' : g.label === 'org' ? 'Org spend limit' : 'Budget'
      const amount =
        g.spentUsd !== undefined && g.limitUsd !== undefined
          ? `: ${formatUsd(g.spentUsd)} of ${formatUsd(g.limitUsd)}`
          : ''
      const reset = g.resetsAt !== undefined ? `, resets ${g.resetsAt - now < DAY ? `in ${formatDuration(g.resetsAt - now)}` : formatDate(g.resetsAt)}` : ''
      out.push({
        key: `${g.id}:${g.resetsAt ?? ''}:${at}`,
        text: at === 100 ? `${name} reached${amount}${reset}` : `${name} at ${at}%${amount}${reset}`,
      })
    }
  }

  return out
}

/** The pieces of the bar a person can hide, each a `show_<part>` setting. */
export const PARTS = ['5h', '7d', 'spend', 'today', 'session', 'context', 'cache'] as const
export type Part = (typeof PARTS)[number]
export type Shown = Record<Part, boolean>

const PART_WORDS: Record<string, Part> = {
  '5h': '5h',
  'five_hour': '5h',
  '7d': '7d',
  'seven_day': '7d',
  spend: 'spend',
  budget: 'spend',
  cap: 'spend',
  limit: 'spend',
  today: 'today',
  month: 'today',
  session: 'session',
  cost: 'session',
  context: 'context',
  ctx: 'context',
  cache: 'cache',
}

export function parsePart(word: string): Part | undefined {
  return PART_WORDS[word.toLowerCase()]
}

/** The view with the hidden parts taken out; the pane and alerts keep the whole. */
export function visibleView(view: View, shown: Shown): View {
  return {
    ...view,
    windows: view.windows.filter(w => (w.id === 'five_hour' ? shown['5h'] : w.id === 'seven_day' ? shown['7d'] : true)),
    spend: shown.spend ? view.spend : undefined,
    monthUsd: shown.today ? view.monthUsd : undefined,
    todayUsd: shown.today ? view.todayUsd : undefined,
    sessionUsd: shown.session ? view.sessionUsd : undefined,
    contextPercent: shown.context ? view.contextPercent : undefined,
  }
}

/** How the band draws, chosen with `/usagebar style`. */
export const STYLES = ['chips', 'ledger', 'pulse'] as const
export type Style = (typeof STYLES)[number]

export function parseStyle(word: string): Style | undefined {
  const w = word.toLowerCase()

  return (STYLES as readonly string[]).includes(w) ? (w as Style) : undefined
}

/** How long the API keeps a prompt cache entry after its last use. */
export const CACHE_TTL = { '5m': 5 * MINUTE, '1h': HOUR } as const
export type CacheTtl = keyof typeof CACHE_TTL

export function parseCacheTtl(word: string): CacheTtl {
  return word === '1h' ? '1h' : '5m'
}

export type CacheState = {
  /** calm while there is time, warm in the last stretch, hot once it has lapsed. */
  level: Level
  remainingMs: number
  /** What is left of the TTL, 0 to 100. */
  percent: number
}

/** Where the prompt cache stands: it lapses `ttlMs` after the last response. */
export function cacheState(lastAt: number, ttlMs: number, now: number): CacheState {
  const left = lastAt + ttlMs - now
  const warnMs = ttlMs > 10 * MINUTE ? 5 * MINUTE : MINUTE

  return {
    level: left <= 0 ? 'hot' : left <= warnMs ? 'warm' : 'calm',
    remainingMs: Math.max(0, left),
    percent: clamp((left / ttlMs) * 100),
  }
}

/** A countdown as m:ss, rounding up so it reads 0:01 until it really is over. */
export function formatClock(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000)

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What re-writing `tokens` of context into the cache costs at `usdPerMillion`. */
export function cacheRewriteUsd(tokens: number, usdPerMillion: number): number {
  return (tokens / 1_000_000) * usdPerMillion
}

/** A percentage that never reads 0% once anything is spent. */
export function percentLabel(percent: number): string {
  if (percent <= 0) return '0%'
  if (percent < 0.1) return '<0.1%'
  if (percent < 10) return `${Math.round(percent * 10) / 10}%`

  return `${Math.round(percent)}%`
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar at an eighth of a cell, so small amounts still show: the filled part and the rest. */
export function smoothBar(percent: number, width: number): { fill: string; rest: string } {
  const eighths = percent > 0 ? Math.max(1, Math.round((clamp(percent) / 100) * width * 8)) : 0
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8]!
  const fill = '█'.repeat(full) + part

  return { fill, rest: '░'.repeat(Math.max(0, width - full - (part ? 1 : 0))) }
}
