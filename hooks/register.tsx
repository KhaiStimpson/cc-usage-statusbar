import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { AdminReading, Level, Period, Snapshot } from '../types'
import { readAdmin } from './admin'
import type { AdminFetch } from './admin'
import { applyCost, dayKey, isLedger, isStale, LEDGER_PREFIX, summarize } from './ledger'
import type { SessionLedger } from './ledger'
import {
  barCells,
  buildView,
  burnRate,
  crossedAlerts,
  formatDate,
  formatDuration,
  formatReset,
  formatUsd,
  gaugeNote,
  hitsFullIn,
  MINUTE,
  parsePart,
  PARTS,
  sparkline,
  statusText,
  visibleView,
} from './model'
import type { Gauge, Options, Part, Shown, View } from './model'

const PANE = 'usage-statusbar'
const COMMAND = 'usagebar'

const snapshotAtom = atom({ plugin: 'usage-statusbar', key: 'snapshot' } as const, null)
const spendAtom = atom({ plugin: 'usage-statusbar', key: 'spend' } as const, null)
const adminAtom = atom({ plugin: 'usage-statusbar', key: 'admin' } as const, null)
const historyAtom = atom({ plugin: 'usage-statusbar', key: 'history' } as const, [])
const turnsAtom = atom({ plugin: 'usage-statusbar', key: 'turns' } as const, [])
const alertsAtom = atom({ plugin: 'usage-statusbar', key: 'alerts' } as const, [])

const COLOR: Record<Level | 'ctx' | 'track' | 'tick', string> = {
  calm: '#7fb685',
  warm: '#e0a458',
  hot: '#e06c5a',
  ctx: '#8a9fc0',
  track: '#3a3a40',
  tick: '#e6e3da',
}

const PERIODS: readonly Period[] = ['daily', 'weekly', 'monthly']

type Settings = Options & {
  display: string
  adminKey: string
  adminUser: string
  adminWorkspaceId: string
  pollMinutes: number
  shown: Shown
}

function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const period = String(options.budget_period ?? 'monthly') as Period

  return {
    display: String(options.display ?? 'band'),
    budgetUsd: Number(options.budget_usd ?? 0) || 0,
    budgetPeriod: PERIODS.includes(period) ? period : 'monthly',
    orgLimitUsd: Number(options.org_limit_usd ?? 0) || 0,
    adminKey: String(options.admin_api_key ?? '').trim(),
    adminUser: String(options.admin_user ?? '').trim(),
    adminWorkspaceId: String(options.admin_workspace_id ?? '').trim(),
    pollMinutes: Math.max(1, Number(options.admin_poll_minutes ?? 5) || 5),
    shown: Object.fromEntries(PARTS.map(part => [part, options[`show_${part}`] !== false])) as Shown,
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
    `Settings: display ${settings.display} · budget_usd ${usd(settings.budgetUsd)} (${settings.budgetPeriod}) · org_limit_usd ${usd(settings.orgLimitUsd)} · Admin API key ${adminKey ? 'set' : 'not set'}${settings.adminUser ? ` · admin_user ${settings.adminUser}` : ''}${settings.adminWorkspaceId ? ` · workspace ${settings.adminWorkspaceId}` : ''}`,
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

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    adminKey = adminKey || ((await $.env.get('ANTHROPIC_ADMIN_KEY')) ?? '').trim()

    await $.command.register({
      name: COMMAND,
      description: 'Usage details pane: windows, spend, forecast and cost per turn',
      argumentHint: '[status | show|hide|only <parts> | budget <usd> [period] | period <p> | refresh | close]',
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
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    bandColumns = columns
    const isNarrow = columns < 100
    const barWidth = columns >= 140 ? 10 : 8

    const bar = (percent: number, width: number, pace: number | undefined, color: string) => {
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
              <Text color={run.cell === 'fill' ? color : COLOR.track}>{'━'.repeat(run.n)}</Text>
            ),
          )}
        </Box>
      )
    }

    const gauge = (g: Gauge, width: number) => {
      const color = COLOR[g.level]
      const isMoney = g.spentUsd !== undefined && g.limitUsd !== undefined
      const value = isMoney ? `${g.isEstimate ? '≈' : ''}${formatUsd(g.spentUsd!)}` : `${g.percent}%`
      const note = isNarrow ? undefined : gaugeNote(g, g.id === 'five_hour' ? rate : undefined, now)

      return (
        <Box gap={1}>
          <Text dimColor={g.level !== 'hot'} color={g.level === 'hot' ? COLOR.hot : undefined}>
            {g.level === 'hot' ? `⚠ ${g.label}` : g.label}
          </Text>
          {!isNarrow && bar(g.percent, width, g.pace, color)}
          <Text bold color={g.level === 'calm' ? undefined : color}>
            {value}
          </Text>
          {isMoney && <Text dimColor>/ {formatUsd(g.limitUsd!)}</Text>}
          {!isNarrow && g.resetsAt !== undefined && <Text dimColor>↻{formatReset(g.resetsAt, now)}</Text>}
          {note && <Text color={color}>{note}</Text>}
        </Box>
      )
    }

    const figure = (label: string, value: string) => (
      <Box gap={1}>
        <Text dimColor>{label}</Text>
        <Text>{value}</Text>
      </Box>
    )

    const ctx = view.contextPercent
    const ctxLevel: Level = ctx === undefined ? 'calm' : ctx >= 90 ? 'hot' : ctx >= 75 ? 'warm' : 'calm'

    return (
      <Box paddingX={1} columnGap={isNarrow ? 1 : 2} flexWrap="wrap">
        {view.windows.map(g => gauge(g, barWidth))}
        {view.spend && gauge(view.spend, isNarrow ? barWidth : barWidth + 4)}
        {view.monthUsd !== undefined &&
          figure('month', `${view.isMonthEstimate ? '≈' : ''}${formatUsd(view.monthUsd)}`)}
        {view.todayUsd !== undefined && figure('today', formatUsd(view.todayUsd))}
        {view.sessionUsd !== undefined &&
          (view.isApiMode ? figure('session', formatUsd(view.sessionUsd)) : <Text>{formatUsd(view.sessionUsd)}</Text>)}
        {ctx !== undefined && (
          <Box gap={1}>
            <Text dimColor>ctx</Text>
            {!isNarrow && bar(ctx, 6, undefined, ctxLevel === 'calm' ? COLOR.ctx : COLOR[ctxLevel])}
            <Text bold color={ctxLevel === 'calm' ? undefined : COLOR[ctxLevel]}>
              {Math.round(ctx)}%
            </Text>
          </Box>
        )}
        {columns >= 150 && (
          <Box flexGrow={1} justifyContent="flex-end">
            <Text dimColor>/{COMMAND} for details</Text>
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
