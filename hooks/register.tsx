import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import type { AdminReading, Level, Period, Snapshot } from '../types'
import { readAdmin } from './admin'
import type { AdminFetch } from './admin'
import { applyCost, dayKey, isLedger, isStale, LEDGER_PREFIX, summarize } from './ledger'
import type { SessionLedger } from './ledger'
import {
  barCells,
  buildView,
  burnRate,
  CACHE_TTL,
  cacheRewriteUsd,
  cacheState,
  cacheWarnMs,
  crossedAlerts,
  formatClock,
  formatDate,
  formatDuration,
  formatReset,
  formatUsd,
  gaugeNote,
  hitsFullIn,
  levelGlyph,
  MINUTE,
  parseCacheTtl,
  parsePart,
  parseStyle,
  PARTS,
  percentLabel,
  smoothBar,
  sparkline,
  statusText,
  STYLES,
  visibleView,
} from './model'
import type { Gauge, Options, Part, Shown, Style, View } from './model'
import { barSvg, cacheClockSvg, liveDotSvg, ruleSvg, sparkSvg, SVG_COLOR, SVG_QUIET } from './svg'

const PANE = 'usage-statusbar'
const COMMAND = 'usagebar'

const snapshotAtom = atom({ plugin: 'usage-statusbar', key: 'snapshot' } as const, null)
const spendAtom = atom({ plugin: 'usage-statusbar', key: 'spend' } as const, null)
const adminAtom = atom({ plugin: 'usage-statusbar', key: 'admin' } as const, null)
const historyAtom = atom({ plugin: 'usage-statusbar', key: 'history' } as const, [])
const turnsAtom = atom({ plugin: 'usage-statusbar', key: 'turns' } as const, [])
const alertsAtom = atom({ plugin: 'usage-statusbar', key: 'alerts' } as const, [])

const COLOR: Record<Level | 'ctx' | 'quiet' | 'track' | 'tick', string> = {
  calm: '#7fb685',
  warm: '#e0a458',
  hot: '#e06c5a',
  quiet: '#6b6a66',
  ctx: '#8a9fc0',
  track: '#3a3a40',
  tick: '#e6e3da',
}

// Pill fills. The desktop paints an absolute Box over the text, so the fill is translucent and the
// text reads through it on either a light or a dark band.
const FILL: Record<Level, string> = {
  calm: 'rgba(138, 135, 127, 0.38)',
  warm: 'rgba(212, 146, 58, 0.5)',
  hot: 'rgba(217, 86, 63, 0.55)',
}

const PERIODS: readonly Period[] = ['daily', 'weekly', 'monthly']

type Settings = Options & {
  display: string
  style: Style
  adminKey: string
  adminUser: string
  adminWorkspaceId: string
  pollMinutes: number
  shown: Shown
  cacheTtlMs: number
  cacheWriteUsd: number
}

const DEFAULT_CACHE_WRITE_USD = 3.75

function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const period = String(options.budget_period ?? 'monthly') as Period
  const cacheWrite = Number(options.cache_write_usd_per_mtok ?? DEFAULT_CACHE_WRITE_USD)

  return {
    display: String(options.display ?? 'band'),
    style: parseStyle(String(options.style ?? 'pulse')) ?? 'pulse',
    budgetUsd: Number(options.budget_usd ?? 0) || 0,
    budgetPeriod: PERIODS.includes(period) ? period : 'monthly',
    orgLimitUsd: Number(options.org_limit_usd ?? 0) || 0,
    adminKey: String(options.admin_api_key ?? '').trim(),
    adminUser: String(options.admin_user ?? '').trim(),
    adminWorkspaceId: String(options.admin_workspace_id ?? '').trim(),
    pollMinutes: Math.max(1, Number(options.admin_poll_minutes ?? 5) || 5),
    shown: Object.fromEntries(PARTS.map(part => [part, options[`show_${part}`] !== false])) as Shown,
    cacheTtlMs: CACHE_TTL[parseCacheTtl(String(options.cache_ttl ?? '5m'))],
    cacheWriteUsd: Number.isFinite(cacheWrite) && cacheWrite >= 0 ? cacheWrite : DEFAULT_CACHE_WRITE_USD,
  }
}

export function toSnapshot(usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>, now: number): Snapshot {
  return {
    at: now,
    contextPercent: usage.context.percent,
    contextTokens: usage.context.tokens,
    contextWindow: usage.context.window,
    windows: usage.rateLimits.map(w => {
      const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN

      return {
        kind: w.kind,
        percentUsed: w.percentUsed,
        resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt,
      }
    }),
    sessionUsd: usage.cost?.usd,
  }
}

const hasAnything = (view: View) =>
  view.windows.length > 0 ||
  view.spend !== undefined ||
  view.sessionUsd !== undefined ||
  view.contextPercent !== undefined

// Module state: a reload re-runs register() and session.start fills it again.
let settings: Settings = readSettings({})
let isBand = true
let isStatus = false
// The other sessions' ledgers, re-read now and then; this one's, kept live.
let others: SessionLedger[] = []
let own: SessionLedger | undefined
let adminKey = ''
// The band's width at its last draw, for /usagebar status.
let bandColumns: number | undefined
// Pulse: the percent each bar last drew at, so the next one grows from there.
const drawnPercent = new Map<string, number>()
// Pulse on the terminal: a dot that beats while a turn runs.
const PULSE_FRAMES = ['·', '•', '●', '•']
let pulseFrame = 0
let pulseTimer: Timer | undefined

function pulseTicker($: EngineInterface, isOn: boolean) {
  if (isOn && !pulseTimer) {
    pulseTimer = $.clock.every(400, () => {
      pulseFrame += 1
      $.ui.invalidate('ui.render')
    })
  } else if (!isOn && pulseTimer) {
    pulseTimer.cancel()
    pulseTimer = undefined
  }
}

// The cache countdown: when the last main-thread response went out, which refreshes the cache entry.
let cacheAt: number | undefined
let cacheTimer: Timer | undefined

// What the band last drew of the cache, so the timer redraws only when something visible changes.
let cacheDrawn: { level: Level; minutes: number; isSvg: boolean } | undefined

/**
 * Redraws the band when the cache countdown changes what it shows. A redraw flashes the whole band, so on the
 * desktop the last minute runs itself inside one drawing and only a new stage or minute redraws; the terminal
 * has no such drawing and redraws every second near the end and every 10 s before.
 */
async function tickCache($: EngineInterface) {
  if (!isBand || !settings.shown.cache || cacheAt === undefined || cacheDrawn === undefined) return
  const now = await $.clock.now()
  // A lapsed cache has been drawn red already; it only changes with the next response.
  if (now - (cacheAt + settings.cacheTtlMs) > 2000) return
  const state = cacheState(cacheAt, settings.cacheTtlMs, now)
  const isChanged =
    state.level !== cacheDrawn.level ||
    (cacheDrawn.isSvg
      ? state.level === 'calm' && Math.ceil(state.remainingMs / MINUTE) !== cacheDrawn.minutes
      : state.level !== 'calm' || Math.floor(state.remainingMs / 1000) % 10 === 0)
  if (isChanged) $.ui.invalidate('ui.render')
}

function adminFetch($: EngineInterface): AdminFetch {
  return (url, init) => $.http.fetch(url, init)
}

async function publishSpend($: EngineInterface, now: number) {
  const spend = summarize(own ? [...others, own] : others, settings.budgetPeriod, now)
  await update($, spendAtom, () => spend)
}

async function loadLedgers($: EngineInterface, sessionId: string, now: number) {
  const keys = (await $.store.keys()).filter(k => k.startsWith(LEDGER_PREFIX))
  const loaded: SessionLedger[] = []
  for (const key of keys) {
    const value = await $.store.get(key)
    if (!isLedger(value)) continue
    if (key === LEDGER_PREFIX + sessionId) {
      own = value
    } else if (isStale(value, now)) {
      await $.store.delete(key)
    } else {
      loaded.push(value)
    }
  }
  others = loaded
}

async function pollAdmin($: EngineInterface) {
  if (!adminKey) return
  const now = await $.clock.now()
  const reading: AdminReading = await readAdmin(
    adminFetch($),
    { key: adminKey, user: settings.adminUser, workspaceId: settings.adminWorkspaceId },
    now,
  )
  // A failed read keeps the last good figures, carrying the error beside them.
  const kept = await read($, adminAtom)
  const next = reading.error && kept && !kept.error ? { ...kept, error: reading.error } : reading
  await update($, adminAtom, () => next)
  if (!next.error) await $.store.set('admin', next)
  await publish($)
}

async function currentView($: EngineInterface, now: number): Promise<View> {
  let snapshot = await read($, snapshotAtom)
  if (!snapshot) snapshot = toSnapshot(await $.session.usage(), now)

  return buildView(snapshot, await read($, adminAtom), await read($, spendAtom), settings, now)
}

/** Refreshes the status entry and raises any alert newly crossed. */
async function publish($: EngineInterface) {
  const now = await $.clock.now()
  const view = await currentView($, now)
  const rate = burnRate(await read($, historyAtom), now)
  if (isStatus) $.ui.status(statusText(visibleView(view, settings.shown), rate, now))

  const fired = new Set(await read($, alertsAtom))
  const fresh = crossedAlerts(view, now).filter(a => !fired.has(a.key))
  if (fresh.length === 0) return
  // One toast per gauge, the highest threshold it crossed.
  const byGauge = new Map(fresh.map(a => [a.key.split(':')[0], a]))
  for (const alert of byGauge.values()) $.ui.toast(alert.text, { timeoutMs: 8000 })
  const alerts = await update($, alertsAtom, list => [...list, ...fresh.map(a => a.key)].slice(-100))
  await $.store.set('alerts', alerts)
}

async function absorb($: EngineInterface, usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>) {
  const now = await $.clock.now()
  const snapshot = toSnapshot(usage, now)
  await update($, snapshotAtom, () => snapshot)

  const five = snapshot.windows.find(w => w.kind === 'five_hour')
  if (five) {
    const history = await update($, historyAtom, list => {
      const kept = list.filter(s => s.resetsAt === five.resetsAt)
      const last = kept[kept.length - 1]
      if (last && last.percent === five.percentUsed) return kept

      return [...kept, { at: now, percent: five.percentUsed, resetsAt: five.resetsAt }].slice(-300)
    })
    await $.store.set('history', history)
  }

  const usd = snapshot.sessionUsd
  if (usd !== undefined) {
    const sessionId = await $.session.id()
    const next = applyCost(own, usd, dayKey(now))
    if (next.last !== own?.last) {
      own = next
      await $.store.set(LEDGER_PREFIX + sessionId, next)
    }
    await publishSpend($, now)
    await update($, turnsAtom, turns => {
      const last = turns[turns.length - 1]
      if (!last) return turns

      return [...turns.slice(0, -1), { ...last, usd: Math.max(0, usd - last.startUsd) }]
    })
  }

  await publish($)
}

const PERIOD_WORDS: Record<string, Period> = {
  monthly: 'monthly',
  month: 'monthly',
  weekly: 'weekly',
  week: 'weekly',
  daily: 'daily',
  day: 'daily',
}

export function parsePeriod(word: string): Period | undefined {
  return PERIOD_WORDS[word.toLowerCase()]
}

/** Writes one of this plugin's /config rows; resolves the refusal, if any. */
async function setOption($: EngineInterface, field: string, value: string | number | boolean): Promise<string | undefined> {
  const row = (await $.config.list()).find(r => r.key.startsWith('usage-statusbar') && r.key.endsWith(`.${field}`))
  if (!row) return `no /config row for ${field}; set it with /plugin configure`
  const { deny } = await $.config.set({ key: row.key, value })

  return deny
}

/** What the mod received and where each figure comes from, for /usagebar status. */
async function statusReport($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const view = await currentView($, now)
  const snapshot = await read($, snapshotAtom)
  const admin = await read($, adminAtom)
  const spend = await read($, spendAtom)
  const usd = (n: number) => (n > 0 ? formatUsd(n) : 'off')
  const lines = [
    `Settings: display ${settings.display} · style ${settings.style} · budget_usd ${usd(settings.budgetUsd)} (${settings.budgetPeriod}) · org_limit_usd ${usd(settings.orgLimitUsd)} · Admin API key ${adminKey ? 'set' : 'not set'}${settings.adminUser ? ` · admin_user ${settings.adminUser}` : ''}${settings.adminWorkspaceId ? ` · workspace ${settings.adminWorkspaceId}` : ''}`,
  ]
  const kinds = (snapshot?.windows ?? []).map(w => `${w.kind} ${w.percentUsed}%`)
  lines.push(
    kinds.length > 0
      ? `Reported by Claude Code: ${kinds.join(', ')}`
      : 'Reported by Claude Code: no rate-limit or spend-limit windows (API pricing without a gateway limit, or no reply yet)',
  )
  if (adminKey) {
    lines.push(
      admin === null
        ? 'Admin API: not read yet'
        : admin.error
          ? `Admin API: ${admin.error}`
          : `Admin API: ${formatUsd(admin.spentUsd)}${admin.limitUsd ? ` of ${formatUsd(admin.limitUsd)}` : ', no limit set'} (${admin.scope}, ${admin.period}), read ${formatDuration(now - admin.at)} ago`,
    )
  }
  if (spend) {
    lines.push(
      `This machine: ${formatUsd(spend.monthUsd)} this month, ${formatUsd(spend.todayUsd)} today, across ${others.length + (own ? 1 : 0)} sessions`,
    )
  }
  const s = view.spend
  lines.push(
    s
      ? `Cap shown: ${s.label} ${s.spentUsd !== undefined && s.limitUsd !== undefined ? `${s.isEstimate ? '≈' : ''}${formatUsd(s.spentUsd)} / ${formatUsd(s.limitUsd)}` : `${s.percent}%`}${s.isEstimate ? ', counted from this machine' : ''}`
      : 'Cap shown: none. Set budget_usd or org_limit_usd, or an Admin API key.',
  )
  const hidden = PARTS.filter(part => !settings.shown[part])
  lines.push(hidden.length > 0 ? `Hidden on the bar: ${hidden.join(', ')}` : 'Hidden on the bar: nothing')
  lines.push(
    cacheAt === undefined
      ? `Prompt cache: no reply yet, so no countdown (${settings.cacheTtlMs === CACHE_TTL['1h'] ? '1h' : '5m'} TTL)`
      : `Prompt cache: ${formatClock(cacheState(cacheAt, settings.cacheTtlMs, now).remainingMs)} left of ${settings.cacheTtlMs === CACHE_TTL['1h'] ? '1h' : '5m'}, last response ${formatDuration(now - cacheAt)} ago`,
  )
  if (bandColumns !== undefined) lines.push(`Band width: ${bandColumns} columns`)

  return lines.join('\n')
}

export const register: Register = (on, options) => {
  settings = readSettings(options)
  isBand = settings.display !== 'status'
  isStatus = settings.display !== 'band'
  others = []
  own = undefined
  adminKey = settings.adminKey
  pulseTimer?.cancel()
  pulseTimer = undefined
  cacheTimer?.cancel()
  cacheTimer = undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    adminKey = adminKey || ((await $.env.get('ANTHROPIC_ADMIN_KEY')) ?? '').trim()

    await $.command.register({
      name: COMMAND,
      description: 'Usage details pane: windows, spend, forecast and cost per turn',
      argumentHint: '[status | style <name> | show|hide|only <parts> | budget <usd> [period] | period <p> | refresh | close]',
    })

    const sessionId = await $.session.id()
    await loadLedgers($, sessionId, now)
    await publishSpend($, now)

    const history = await read($, historyAtom)
    const stored = await $.store.get('history')
    if (history.length === 0 && Array.isArray(stored)) await update($, historyAtom, () => stored)
    const alerts = await $.store.get('alerts')
    if ((await read($, alertsAtom)).length === 0 && Array.isArray(alerts)) {
      await update($, alertsAtom, () => alerts.filter((a): a is string => typeof a === 'string'))
    }
    const admin = await $.store.get('admin')
    if (adminKey && (await read($, adminAtom)) === null && admin && typeof admin === 'object') {
      await update($, adminAtom, () => admin as AdminReading)
    }

    await absorb($, await $.session.usage())

    if (adminKey) {
      void pollAdmin($)
      $.clock.every(settings.pollMinutes * MINUTE, () => void pollAdmin($))
    }
    // Countdowns move with the clock, and other sessions spend too.
    $.clock.every(MINUTE, () => {
      $.ui.invalidate('ui.render')
      void publish($)
    })
    cacheTimer = $.clock.every(1000, () => void tickCache($))
    $.clock.every(10 * MINUTE, () => {
      void (async () => {
        const at = await $.clock.now()
        await loadLedgers($, sessionId, at)
        await publishSpend($, at)
      })()
    })

    return result
  })

  on('session.measure', async ($, e, next) => {
    await absorb($, e)

    return next(e)
  })

  // Each main-thread response that reached the API refreshes the cache entry.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.usage) {
      cacheAt = await $.clock.now()
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const snapshot = await read($, snapshotAtom)
    const startUsd = snapshot?.sessionUsd ?? 0
    const text = e.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (text && !text.startsWith('/')) {
      await update($, turnsAtom, turns => [...turns, { text, startUsd, usd: 0 }].slice(-20))
    }

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [verb = '', arg = '', rest = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })

      return { text: 'Usage pane closed.' }
    }
    if (verb === 'refresh') {
      if (!adminKey) return { text: 'No Admin API key set; local figures refresh on their own.' }
      await pollAdmin($)
      const admin = await read($, adminAtom)

      return { text: admin?.error ? `Admin API: ${admin.error}` : 'Spend refreshed from the Admin API.' }
    }
    if (verb === 'budget') {
      const usd = Number(arg.replace(/^\$/, ''))
      const period = rest ? parsePeriod(rest) : undefined
      if (!arg || !Number.isFinite(usd) || usd < 0 || (rest && !period)) {
        return { text: `Usage: /${COMMAND} budget <usd> [monthly | weekly | daily], 0 to turn it off.` }
      }
      const denied = (await setOption($, 'budget_usd', usd)) ?? (period ? await setOption($, 'budget_period', period) : undefined)
      if (denied) return { text: `Could not set the budget: ${denied}` }

      return { text: usd > 0 ? `Budget set to ${formatUsd(usd)} ${period ?? settings.budgetPeriod}.` : 'Budget turned off.' }
    }
    if (verb === 'show' || verb === 'hide' || verb === 'only') {
      const words = e.args.trim().toLowerCase().split(/[\s,]+/).slice(1)
      const parts = words.map(parsePart)
      const unknown = words.filter((_, i) => parts[i] === undefined)
      if (words.length === 0 || unknown.length > 0) {
        return {
          text: `${unknown.length > 0 ? `Unknown part: ${unknown.join(', ')}. ` : ''}Usage: /${COMMAND} ${verb} <part>..., where a part is ${PARTS.join(', ')}.`,
        }
      }
      const named = new Set(parts as Part[])
      const wanted: Shown = { ...settings.shown }
      for (const part of PARTS) {
        if (verb === 'only') wanted[part] = named.has(part)
        else if (named.has(part)) wanted[part] = verb === 'show'
      }
      for (const part of PARTS) {
        if (wanted[part] === settings.shown[part]) continue
        const denied = await setOption($, `show_${part}`, wanted[part])
        if (denied) return { text: `Could not change ${part}: ${denied}` }
      }
      const showing = PARTS.filter(part => wanted[part])

      return { text: showing.length > 0 ? `The bar shows: ${showing.join(', ')}.` : 'Every part is hidden, so the bar is off.' }
    }
    if (verb === 'period') {
      const period = parsePeriod(arg)
      if (!period) return { text: `Usage: /${COMMAND} period <monthly | weekly | daily>. It's ${settings.budgetPeriod} now.` }
      const denied = await setOption($, 'budget_period', period)
      if (denied) return { text: `Could not set the budget period: ${denied}` }

      return {
        text: `Budget period set to ${period}${period === 'weekly' ? ' (weeks start Monday)' : ''}.${settings.budgetUsd > 0 ? '' : ` Set an amount with /${COMMAND} budget <usd>.`}`,
      }
    }
    if (verb === 'style') {
      const style = parseStyle(arg)
      if (!style) return { text: `Usage: /${COMMAND} style <${STYLES.join(' | ')}>. It's ${settings.style} now.` }
      const denied = await setOption($, 'style', style)
      if (denied) return { text: `Could not set the style: ${denied}` }
      settings = { ...settings, style }
      drawnPercent.clear()
      $.ui.invalidate('ui.render')

      return {
        text: `The bar now draws in the ${style} style.${isBand ? '' : ` It shows once display is band or both.`}`,
      }
    }
    if (verb === 'status') return { text: await statusReport($) }
    const opened = await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: opened.isPlaced ? 'Usage pane opened.' : 'Usage pane opens once the terminal is wide enough.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!isBand || e.props.hasSurvey) return next(e)
    const now = await $.clock.now()
    const view = visibleView(await currentView($, now), settings.shown)
    if (!hasAnything(view)) return next(e)
    const rate = burnRate(await read($, historyAtom), now)
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    const isTerminal = e.surface === 'terminal'
    // The terminal's table names Svg too, drawing nothing; only the other surfaces paint it.
    const Svg = !isTerminal && 'Svg' in table ? table.Svg : undefined
    const columns = e.props.bodyColumns
    bandColumns = columns
    const style = settings.style
    // SVG bars are narrower than cells, so the desktop keeps them down to 70 columns.
    const isNarrow = columns < (Svg ? 70 : 100)
    pulseTicker($, style === 'pulse' && isTerminal && e.props.isWorking)

    const ctx = view.contextPercent
    const ctxLevel: Level = ctx === undefined ? 'calm' : ctx >= 90 ? 'hot' : ctx >= 75 ? 'warm' : 'calm'

    // Quiet until it matters: a calm gauge is a label and a number; a loud one gets its bar, note and reset.
    const isLoud = (level: Level) => level !== 'calm'
    const tone = (level: Level) => (isTerminal ? COLOR[level] : SVG_COLOR[level])
    const toneOf = (level: Level) => (level === 'calm' ? undefined : tone(level))
    const ctxColor = ctxLevel === 'calm' ? (isTerminal ? COLOR.ctx : SVG_COLOR.ctx) : tone(ctxLevel)
    const gauges = [...view.windows, ...(view.spend ? [view.spend] : [])]
    const isMoney = (g: Gauge) => g.spentUsd !== undefined && g.limitUsd !== undefined
    const amount = (g: Gauge) => (isMoney(g) ? `${g.isEstimate ? '≈' : ''}${formatUsd(g.spentUsd!)}` : percentLabel(g.percent))
    const titleOf = (g: Gauge) =>
      `${g.label}: ${percentLabel(g.percent)} used${g.pace !== undefined ? `, ${percentLabel(g.pace)} of the window gone` : ''}`
    const figures: { label: string; value: string; isSession?: boolean }[] = []
    if (view.monthUsd !== undefined) figures.push({ label: 'month', value: `${view.isMonthEstimate ? '≈' : ''}${formatUsd(view.monthUsd)}` })
    if (view.todayUsd !== undefined) figures.push({ label: 'today', value: formatUsd(view.todayUsd) })
    if (view.sessionUsd !== undefined) figures.push({ label: 'session', value: formatUsd(view.sessionUsd), isSession: true })

    const label = (g: Gauge) => (
      <Text color={toneOf(g.level)} dimColor={g.level === 'calm'}>
        {g.level === 'hot' ? `⚠ ${g.label}` : g.label}
      </Text>
    )
    // Dollars need their limit to mean anything, so a money gauge keeps it even when calm.
    const value = (g: Gauge) => [
      <Text bold color={toneOf(g.level)}>
        {amount(g)}
      </Text>,
      isMoney(g) ? <Text dimColor>/ {formatUsd(g.limitUsd!)}</Text> : undefined,
    ]
    // What a loud gauge adds after its value.
    const extras = (g: Gauge) => {
      const note = gaugeNote(g, g.id === 'five_hour' ? rate : undefined, now)

      return [
        note ? <Text color={tone(g.level)}>{note}</Text> : undefined,
        !isNarrow && g.resetsAt !== undefined ? <Text dimColor>resets {formatReset(g.resetsAt, now)}</Text> : undefined,
      ]
    }
    const figureLabel = (f: (typeof figures)[number]) => (isNarrow && f.isSession ? undefined : <Text dimColor>{f.label}</Text>)
    // The cache countdown: calm and dim with time left, amber near the end, red once it has lapsed.
    const cache = settings.shown.cache && cacheAt !== undefined ? cacheState(cacheAt, settings.cacheTtlMs, now) : undefined
    const cacheTokens =
      cache?.level === 'hot' ? ((await read($, snapshotAtom))?.contextTokens ?? (await $.session.usage()).context.tokens) : undefined
    const cacheCost =
      settings.cacheWriteUsd > 0 && cacheTokens ? `next turn ≈ ${formatUsd(cacheRewriteUsd(cacheTokens, settings.cacheWriteUsd))}` : 'next turn re-reads it all'
    const cacheMinutes = cache ? Math.ceil(cache.remainingMs / MINUTE) : 0
    cacheDrawn = cache ? { level: cache.level, minutes: cacheMinutes, isSvg: Svg !== undefined } : undefined
    // On the desktop a calm cache moves by the minute and a warm one runs itself inside one drawing, so the
    // band does not redraw (and flash) every second; the terminal shows the live clock.
    const cacheClock = cache ? (Svg && cache.level === 'calm' ? `${cacheMinutes}m` : formatClock(cache.remainingMs)) : ''
    const cacheTitle =
      cache?.level === 'hot'
        ? 'The prompt cache has lapsed; the next turn re-reads the whole context at full price'
        : `The prompt cache lapses in ${formatClock(cache?.remainingMs ?? 0)}`
    const cacheLabel = cache && (
      <Text color={toneOf(cache.level)} dimColor={cache.level === 'calm'}>
        {cache.level === 'hot' ? '⚠ cache cold' : 'cache'}
      </Text>
    )
    const cacheNote = cache?.level === 'warm' ? <Text color={tone('warm')}>expires soon</Text> : undefined
    // The calm bar and the ledger segment step by the minute for the same reason.
    const cachePercent = cache ? (Svg ? ((cacheMinutes * MINUTE) / settings.cacheTtlMs) * 100 : cache.percent) : 0
    const ctxTitle = `context ${Math.round(ctx ?? 0)}% full`
    const ctxValue = (
      <Text bold color={toneOf(ctxLevel)}>
        {Math.round(ctx ?? 0)}%
      </Text>
    )

    // A bar of cells for the terminal: fill, pace tick, track.
    const cellBar = (percent: number, width: number, pace: number | undefined, color: string, glyph = '━') => {
      const runs: { cell: string; n: number }[] = []
      for (const cell of barCells(percent, width, pace)) {
        const last = runs[runs.length - 1]
        if (last && last.cell === cell) last.n += 1
        else runs.push({ cell, n: 1 })
      }

      return (
        <Box>
          {runs.map(run =>
            run.cell === 'tick' ? (
              <Text color={COLOR.tick}>┃</Text>
            ) : (
              <Text color={run.cell === 'fill' ? color : COLOR.track}>{glyph.repeat(run.n)}</Text>
            ),
          )}
        </Box>
      )
    }
    // Interactive drawings sit in a frame that reloads whenever its markup changes, which flashes; the cache
    // countdown's bar changes often, so it is a plain image (no hover title) instead.
    const svg = (source: string, alt: string, width: number | undefined, height: number, isInteractive = true) =>
      Svg ? <Svg source={source} alt={alt} width={width} height={height} isInteractive={isInteractive} /> : undefined
    // The warm cache on the desktop: bar and digits in one self-running drawing (see cacheClockSvg).
    const cacheWarm = (hasBar: boolean, color = tone('warm'), hasHalo = false) =>
      cache && Svg
        ? svg(
            cacheClockSvg({ remainingMs: cache.remainingMs, warnMs: cacheWarnMs(settings.cacheTtlMs), color, title: cacheTitle, hasBar, hasHalo }),
            cacheTitle,
            hasBar ? 114 : 34,
            16,
            false,
          )
        : undefined
    const cacheValue =
      cache &&
      (cache.level === 'warm' && Svg ? (
        cacheWarm(false)
      ) : (
        <Text bold color={toneOf(cache.level)}>
          {cache.level === 'hot' ? cacheCost : cacheClock}
        </Text>
      ))

    // Chips and ledger both draw one entry per gauge, so a bar always sits with its own label.
    type Entry = {
      id: string
      label: string
      value: string
      limit?: string
      note?: string
      reset?: string
      level: Level
      percent: number
      pace?: number
      title: string
      /** The warm cache's digits are a self-running drawing rather than text. */
      isClock?: boolean
    }
    const entries: Entry[] = [
      ...gauges.map(g => ({
        id: g.id,
        label: g.level === 'hot' ? `⚠ ${g.label}` : g.label,
        value: amount(g),
        limit: isMoney(g) ? `/ ${formatUsd(g.limitUsd!)}` : undefined,
        note: isLoud(g.level) ? gaugeNote(g, g.id === 'five_hour' ? rate : undefined, now) : undefined,
        reset: isLoud(g.level) && !isNarrow && g.resetsAt !== undefined ? `resets ${formatReset(g.resetsAt, now)}` : undefined,
        level: g.level,
        percent: g.percent,
        pace: isLoud(g.level) ? g.pace : undefined,
        title: titleOf(g),
      })),
      ...(cache
        ? [
            {
              id: 'cache',
              label: cache.level === 'hot' ? '⚠ cache cold' : 'cache',
              value: cache.level === 'hot' ? cacheCost : cacheClock,
              note: cache.level === 'warm' && !isNarrow ? 'expires soon' : undefined,
              level: cache.level,
              percent: cache.level === 'hot' || (Svg && cache.level === 'warm') ? 100 : cachePercent,
              title: cacheTitle,
              isClock: cache.level === 'warm' && Svg !== undefined,
            },
          ]
        : []),
      ...(ctx !== undefined
        ? [{ id: 'ctx', label: 'ctx', value: `${Math.round(ctx)}%`, level: ctxLevel, percent: ctx, title: ctxTitle }]
        : []),
    ]
    const quiet = isTerminal ? COLOR.quiet : SVG_QUIET
    // On a fill the text keeps the theme's own colour; the fill carries the level.
    const entryParts = (e: Entry, isOnFill: boolean) => {
      const tint = isOnFill ? undefined : toneOf(e.level)

      return [
        <Text color={tint} dimColor={!isOnFill && e.level === 'calm'}>
          {e.label}
        </Text>,
        e.isClock ? (
          cacheWarm(false, tone('warm'), isOnFill)
        ) : (
          <Text bold color={tint}>
            {e.value}
          </Text>
        ),
        e.limit ? <Text dimColor>{e.limit}</Text> : undefined,
        e.note ? <Text color={tint}>{e.note}</Text> : undefined,
        e.reset ? <Text dimColor={!isOnFill}>{e.reset}</Text> : undefined,
      ]
    }
    const figureRow = figures.map(f => (
      <Box gap={1}>
        {figureLabel(f)}
        <Text bold>{f.value}</Text>
      </Box>
    ))

    if (style === 'chips') {
      // A pill on the desktop: the gauge's text with its percentage tinted in over it. The terminal has no
      // translucent fill, so there it is the text in the level's colour with a short bar.
      const pill = (e: Entry) => {
        const fill = Math.min(100, Math.max(0, Math.round(e.percent)))
        if (!Svg) {
          const color = isLoud(e.level) ? tone(e.level) : quiet
          return (
            <Box gap={1}>
              {entryParts(e, false).slice(0, 1)}
              {!isNarrow && cellBar(e.percent, 6, e.pace, color)}
              {entryParts(e, false).slice(1)}
            </Box>
          )
        }

        return (
          <Box paddingX={1} gap={1}>
            {entryParts(e, true)}
            {fill > 0 && (
              <Box position="absolute" left={0} top={0} bottom={0} width={`${Math.max(1, fill)}%`} backgroundColor={FILL[e.level]} />
            )}
          </Box>
        )
      }

      return (
        <Box paddingX={1} columnGap={1} flexWrap="wrap" alignItems="center">
          {entries.map(pill)}
          <Box flexGrow={1} />
          {figureRow}
        </Box>
      )
    }

    if (style === 'ledger') {
      // Each gauge is a column: its text, with its own bar directly beneath at the same width.
      const column = (e: Entry) => {
        const parts = [e.label, e.isClock ? '00:00' : e.value, e.limit, e.note, e.reset].filter((p): p is string => !!p)
        const width = Math.max(10, parts.reduce((n, p) => n + p.length, 0) + parts.length)
        const color = isLoud(e.level) ? tone(e.level) : quiet
        const bar = Svg
          ? svg(ruleSvg([{ percent: e.percent, pace: e.pace, color, title: e.title }], width * 8), e.title, width * 8, 7)
          : cellBar(e.percent, width, e.pace, color, '▔')

        return (
          <Box flexDirection="column" width={width}>
            <Box gap={1}>{entryParts(e, false)}</Box>
            {bar}
          </Box>
        )
      }

      return (
        <Box paddingX={1} columnGap={2} flexWrap="wrap" alignItems="flex-start">
          {entries.map(column)}
          <Box flexGrow={1} />
          {figureRow}
        </Box>
      )
    }

    // pulse
    const spend = await read($, spendAtom)
    const days = (spend?.days ?? []).slice(-8).map(d => d.usd)
    const motion = (id: string, percent: number, isHot: boolean) => {
      const key = `${e.surface}:${id}`
      const from = drawnPercent.get(key) ?? 0
      drawnPercent.set(key, percent)

      return { from, isHot }
    }
    // A calm meter is a thin 28 px bar, or one level glyph in the terminal.
    // A static bar skips the grow-in, sheen and pace motion: the cache countdown redraws every second,
    // and each redraw would restart them.
    const meter = (
      id: string,
      percent: number,
      pace: number | undefined,
      level: Level,
      title: string,
      color: string,
      width: number,
      isStatic = false,
    ) => {
      const isThin = !isLoud(level)
      if (Svg) {
        const source = barSvg({
          percent,
          pace: isThin ? undefined : pace,
          width,
          color,
          title,
          height: isThin ? 4 : isStatic ? 8 : undefined,
          motion: isStatic ? undefined : motion(id, percent, level === 'hot'),
        })

        return svg(source, title, width, 14, !isStatic)
      }
      if (isThin) return <Text color={percent > 0 ? color : COLOR.track}>{levelGlyph(percent)}</Text>
      const { fill, rest } = smoothBar(percent, Math.round(width / 12))

      return (
        <Text>
          <Text color={color}>{fill}</Text>
          <Text color={COLOR.track}>{rest}</Text>
        </Text>
      )
    }
    const widthOf = (g: Gauge) => (!isLoud(g.level) ? 28 : isNarrow ? 52 : g === view.spend ? 120 : 96)
    const dot = () => {
      if (!e.props.isWorking) return undefined
      if (Svg) return svg(liveDotSvg(tone('calm')), 'A turn is running', 12, 12)

      return <Text color={COLOR.calm}>{PULSE_FRAMES[pulseFrame % PULSE_FRAMES.length]}</Text>
    }

    return (
      <Box paddingX={1} columnGap={2} flexWrap="wrap" alignItems="center">
        {dot()}
        {gauges.map(g => (
          <Box gap={1} alignItems="center">
            {label(g)}
            {meter(g.id, g.percent, g.pace, g.level, titleOf(g), tone(g.level), widthOf(g))}
            {value(g)}
            {isLoud(g.level) && extras(g)}
          </Box>
        ))}
        {cache &&
          (cache.level === 'hot' ? (
            <Box borderStyle="round" borderColor={tone('hot')} paddingX={1} gap={1} alignItems="center">
              {cacheLabel}
              {cacheValue}
            </Box>
          ) : cache.level === 'warm' && Svg ? (
            <Box gap={1} alignItems="center">
              {cacheLabel}
              {cacheWarm(true)}
              {cacheNote}
            </Box>
          ) : (
            <Box gap={1} alignItems="center">
              {cacheLabel}
              {meter('cache', cachePercent, undefined, cache.level, cacheTitle, tone(cache.level), isLoud(cache.level) ? (isNarrow ? 52 : 72) : 28, true)}
              {cacheValue}
              {cacheNote}
            </Box>
          ))}
        <Box flexGrow={1} />
        {figures.map(f => (
          <Box gap={1} alignItems="center">
            {figureLabel(f)}
            {f.label === 'today' && Svg && !isNarrow && days.length > 1
              ? svg(sparkSvg(days, tone('calm'), 'Spend by day'), 'Spend by day', 44, 16)
              : undefined}
            <Text bold>{f.value}</Text>
          </Box>
        ))}
        {ctx !== undefined && (
          <Box gap={1} alignItems="center">
            <Text dimColor>ctx</Text>
            {meter('context', ctx, undefined, ctxLevel, ctxTitle, ctxColor, isLoud(ctxLevel) ? 48 : 28)}
            {ctxValue}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await $.clock.now()
    const view = await currentView($, now)
    const snapshot = await read($, snapshotAtom)
    const admin = await read($, adminAtom)
    const spend = await read($, spendAtom)
    const history = await read($, historyAtom)
    const turns = await read($, turnsAtom)
    const rate = burnRate(history, now)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns - 2)

    const row = (label: string, value: string, color?: string) => (
      <Box justifyContent="space-between">
        <Text dimColor>{label}</Text>
        <Text bold color={color}>
          {value}
        </Text>
      </Box>
    )
    const meter = (g: Gauge) => {
      const cells = barCells(g.percent, width, g.pace)

      return (
        <Text>
          {cells.map(c => (c === 'fill' ? '█' : c === 'tick' ? '┃' : '░')).join('')}
        </Text>
      )
    }

    const sections = []

    for (const g of view.windows) {
      const color = g.level === 'calm' ? undefined : COLOR[g.level]
      const name = g.id === 'five_hour' ? '5-hour window' : g.id === 'seven_day' ? '7-day window' : g.label
      const facts = [g.resetsAt !== undefined ? `resets ${g.resetsAt - now < 86_400_000 ? `in ${formatReset(g.resetsAt, now)}` : formatReset(g.resetsAt, now)}` : '']
      if (g.id === 'five_hour') {
        if (rate !== undefined) facts.push(`${Math.round(rate)}%/hr`)
        const full = hitsFullIn(g, rate, now)
        if (full !== undefined) facts.push(`full in ~${formatDuration(full)}`)
      }
      sections.push(
        <Box flexDirection="column">
          {row(name, `${g.percent}%`, color)}
          {g.id === 'five_hour' && history.length > 1 ? (
            <Text color={COLOR[g.level]}>{sparkline(history.slice(-width).map(s => s.percent), 100)}</Text>
          ) : (
            meter(g)
          )}
          <Text dimColor>{facts.filter(Boolean).join(' · ')}</Text>
        </Box>,
      )
    }

    const s = view.spend
    if (s) {
      const source =
        s.label === 'budget'
          ? `budget · ${settings.budgetPeriod}, this machine`
          : admin && !admin.error && admin.limitUsd
            ? `org limit · ${admin.scope}, Admin API`
            : 'org limit · gateway'
      const color = s.level === 'calm' ? undefined : COLOR[s.level]
      const isMoney = s.spentUsd !== undefined && s.limitUsd !== undefined
      const daily = s.label === 'org' && admin && admin.days.length > 0 ? admin.days : spend?.days ?? []
      const facts: string[] = []
      if (s.forecastUsd !== undefined) facts.push(`forecast ~${formatUsd(s.forecastUsd)}`)
      if (s.hitsLimitAt !== undefined) facts.push(`hits limit ~${formatDate(s.hitsLimitAt)}`)
      if (isMoney && s.resetsAt !== undefined && s.spentUsd! < s.limitUsd!) {
        const daysLeft = Math.max(1, Math.ceil((s.resetsAt - now) / 86_400_000))
        facts.push(`${formatUsd((s.limitUsd! - s.spentUsd!) / daysLeft)}/day left`)
      }
      sections.push(
        <Box flexDirection="column">
          <Text dimColor>{source}</Text>
          {row(
            isMoney ? `${s.isEstimate ? '≈' : ''}${formatUsd(s.spentUsd!)} of ${formatUsd(s.limitUsd!)}` : 'used',
            `${s.percent}%`,
            color,
          )}
          {meter(s)}
          {daily.length > 1 && <Text dimColor>{sparkline(daily.slice(-width).map(d => d.usd))}</Text>}
          {s.resetsAt !== undefined && <Text dimColor>resets {formatDate(s.resetsAt)}</Text>}
          {facts.length > 0 && <Text>{facts.join(' · ')}</Text>}
        </Box>,
      )
    }

    const money: string[] = []
    if (view.monthUsd !== undefined) money.push(`month ${view.isMonthEstimate ? '≈' : ''}${formatUsd(view.monthUsd)}`)
    if (spend && view.isApiMode) money.push(`today ${formatUsd(spend.todayUsd)}`)
    if (view.sessionUsd !== undefined) money.push(`session ${formatUsd(view.sessionUsd)}`)
    if (money.length > 0) sections.push(<Text>{money.join(' · ')}</Text>)

    if (snapshot?.contextPercent !== undefined) {
      const tokens = snapshot.contextTokens !== undefined ? ` · ${Math.round(snapshot.contextTokens / 1000)}k of ${Math.round(snapshot.contextWindow / 1000)}k` : ''
      sections.push(row('context', `${Math.round(snapshot.contextPercent)}%${tokens}`))
    }

    const priced = turns.filter(t => t.usd > 0).slice(-5).reverse()
    if (priced.length > 0) {
      sections.push(
        <Box flexDirection="column">
          <Text dimColor>cost by turn</Text>
          {priced.map(t => (
            <Box justifyContent="space-between" gap={1}>
              <Text wrap="truncate-end">{t.text}</Text>
              <Text>{formatUsd(t.usd)}</Text>
            </Box>
          ))}
        </Box>,
      )
    }

    if (admin?.error) sections.push(<Text color={COLOR.warm}>Admin API: {admin.error}</Text>)
    if (sections.length === 0) sections.push(<Text dimColor>No usage reported yet. It appears after the first reply.</Text>)

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {sections}
        <Box gap={1}>
          {adminKey && <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void pollAdmin($)} />}
          <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
