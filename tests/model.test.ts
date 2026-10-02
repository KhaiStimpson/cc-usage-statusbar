import { describe, expect, test } from 'claude-code/testing'

import { pickConsoleLimit, pickEffective, sumCostBuckets } from '../hooks/admin'
import { applyCost, dayKey, summarize } from '../hooks/ledger'
import {
  barCells,
  buildView,
  burnRate,
  cacheRewriteUsd,
  cacheState,
  crossedAlerts,
  DAY,
  formatClock,
  formatDuration,
  formatUsd,
  gaugeNote,
  HOUR,
  levelGlyph,
  MINUTE,
  parseCacheTtl,
  parseCacheTtlSetting,
  parseStyle,
  percentLabel,
  resolveCacheTtl,
  periodBounds,
  smoothBar,
  sparkline,
  statusText,
  windowGauge,
} from '../hooks/model'
import { barSvg, cacheClockSvg, dailySvg, figureSvg, hairlineSvg, historySvg, liveDotSvg, ruleSvg, thinBarSvg } from '../hooks/svg'
import type { Snapshot } from '../types'

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime() // Wed Oct 14, 3pm local
const OPTIONS = { budgetUsd: 0, budgetPeriod: 'monthly' as const, orgLimitUsd: 0 }

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  at: NOW,
  contextPercent: 48,
  contextTokens: 96_000,
  contextWindow: 200_000,
  windows: [],
  sessionUsd: 1.82,
  ...over,
})

describe('windows', () => {
  test('pace is how far through the window an even burn would be', () => {
    // Resets in 1h48m: 3h12m of 5h gone, 64%.
    const g = windowGauge('five_hour', 62, NOW + 108 * MINUTE, NOW)
    expect(g.pace).toBe(64)
    expect(g.level).toBe('calm')
    expect(g.isAhead).toBe(false)
  })

  test('levels: warm from 70, hot from 90, warm when well ahead of pace', () => {
    expect(windowGauge('five_hour', 72, NOW + 3 * HOUR, NOW).level).toBe('warm')
    expect(windowGauge('five_hour', 91, NOW + 3 * HOUR, NOW).level).toBe('hot')
    const ahead = windowGauge('five_hour', 50, NOW + 4 * HOUR, NOW) // pace 20
    expect(ahead.isAhead).toBe(true)
    expect(ahead.level).toBe('warm')
  })

  test('a hot window with a burn rate says when it runs out', () => {
    const g = windowGauge('five_hour', 94, NOW + 22 * MINUTE, NOW)
    expect(gaugeNote(g, 24, NOW)).toBe('limit in ~15m')
    expect(gaugeNote(g, undefined, NOW)).toBe('slow down')
  })

  test('burn rate reads the current window only', () => {
    const resetsAt = NOW + HOUR
    const rate = burnRate(
      [
        { at: NOW - 3 * HOUR, percent: 90, resetsAt: NOW - HOUR },
        { at: NOW - 60 * MINUTE, percent: 40, resetsAt },
        { at: NOW - 30 * MINUTE, percent: 50, resetsAt },
        { at: NOW, percent: 60, resetsAt },
      ],
      NOW,
    )
    expect(rate).toBe(20)
  })
})

describe('spend', () => {
  test('a gateway limit with a configured amount reads in dollars', () => {
    const view = buildView(
      snapshot({ windows: [{ kind: 'spend_limit', percentUsed: 62.4, resetsAt: new Date(2026, 10, 1).getTime() }] }),
      null,
      null,
      { ...OPTIONS, orgLimitUsd: 500 },
      NOW,
    )
    expect(view.isApiMode).toBe(true)
    expect(view.spend?.label).toBe('org')
    expect(view.spend?.percent).toBe(62.4)
    expect(view.spend?.spentUsd).toBe(312)
    expect(view.spend?.limitUsd).toBe(500)
  })

  test('a gateway limit without an amount is a percentage', () => {
    const view = buildView(
      snapshot({ windows: [{ kind: 'spend_limit', percentUsed: 62, resetsAt: NOW + 10 * DAY }] }),
      null,
      null,
      OPTIONS,
      NOW,
    )
    expect(view.spend?.spentUsd).toBeUndefined()
    expect(view.spend?.percent).toBe(62)
  })

  test('the Admin API wins over the gateway', () => {
    const { end } = periodBounds('monthly', NOW, true)
    const view = buildView(
      snapshot({ windows: [{ kind: 'spend_limit', percentUsed: 10, resetsAt: end }] }),
      { at: NOW, scope: 'user', period: 'monthly', spentUsd: 420, limitUsd: 500, resetsAt: end, days: [] },
      null,
      { ...OPTIONS, orgLimitUsd: 999 },
      NOW,
    )
    expect(view.spend?.spentUsd).toBe(420)
    expect(view.spend?.isEstimate).toBe(false)
    expect(view.spend?.level).toBe('warm')
  })

  test('a personal budget is an estimate from the local ledger', () => {
    const view = buildView(
      snapshot(),
      null,
      { todayUsd: 18.4, periodUsd: 82, monthUsd: 82, days: [] },
      { ...OPTIONS, budgetUsd: 200 },
      NOW,
    )
    expect(view.spend?.label).toBe('budget')
    expect(view.spend?.isEstimate).toBe(true)
    expect(view.spend?.percent).toBe(41)
    expect(view.todayUsd).toBe(18.4)
  })

  test('an org cap with no server reporting it counts this machine monthly', () => {
    const view = buildView(snapshot(), null, { todayUsd: 3, periodUsd: 3, monthUsd: 312, days: [] }, { ...OPTIONS, orgLimitUsd: 500 }, NOW)
    expect(view.spend?.label).toBe('org')
    expect(view.spend?.spentUsd).toBe(312)
    expect(view.spend?.limitUsd).toBe(500)
    expect(view.spend?.isEstimate).toBe(true)
  })

  test('subscription users see an org cap too', () => {
    const view = buildView(
      snapshot({ windows: [{ kind: 'five_hour', percentUsed: 62 }] }),
      null,
      { todayUsd: 3, periodUsd: 3, monthUsd: 40, days: [] },
      { ...OPTIONS, orgLimitUsd: 500 },
      NOW,
    )
    expect(view.windows).toHaveLength(1)
    expect(view.spend?.limitUsd).toBe(500)
  })

  test('no limit known shows month spend and no gauge', () => {
    const view = buildView(snapshot(), null, { todayUsd: 3, periodUsd: 82, monthUsd: 82, days: [] }, OPTIONS, NOW)
    expect(view.spend).toBeUndefined()
    expect(view.monthUsd).toBe(82)
    expect(view.isMonthEstimate).toBe(true)
  })

  test('over the limit says by how much', () => {
    const { end } = periodBounds('monthly', NOW, true)
    const view = buildView(
      snapshot(),
      { at: NOW, scope: 'workspace', period: 'monthly', spentUsd: 512, limitUsd: 500, resetsAt: end, days: [] },
      null,
      OPTIONS,
      NOW,
    )
    expect(view.spend?.level).toBe('hot')
    expect(gaugeNote(view.spend!, undefined, NOW)).toBe('over by $12.00')
  })

  test('subscription users keep their windows and no spend gauge', () => {
    const view = buildView(
      snapshot({ windows: [{ kind: 'seven_day', percentUsed: 31 }, { kind: 'five_hour', percentUsed: 62 }] }),
      null,
      { todayUsd: 3, periodUsd: 3, monthUsd: 3, days: [] },
      OPTIONS,
      NOW,
    )
    expect(view.isApiMode).toBe(false)
    expect(view.windows.map(w => w.label)).toEqual(['5h', '7d'])
    expect(view.monthUsd).toBeUndefined()
    expect(view.todayUsd).toBeUndefined()
  })
})

describe('ledger', () => {
  test('adds what the session total grew by to the day', () => {
    const a = applyCost(undefined, 1.5, '2026-10-14')
    const b = applyCost(a, 2.25, '2026-10-14')
    const c = applyCost(b, 3, '2026-10-15')
    expect(c.days).toEqual({ '2026-10-14': 2.25, '2026-10-15': 0.75 })
  })

  test('a total that drops starts the count over', () => {
    const a = applyCost(undefined, 5, '2026-10-14')
    expect(applyCost(a, 1, '2026-10-14').days['2026-10-14']).toBe(6)
  })

  test('sums sessions into today, the period and the month', () => {
    const today = dayKey(NOW)
    const lastMonth = dayKey(NOW - 20 * DAY)
    const spend = summarize(
      [
        { last: 0, days: { [today]: 2, [lastMonth]: 10 }, touched: today },
        { last: 0, days: { [today]: 1 }, touched: today },
      ],
      'weekly',
      NOW,
    )
    expect(spend.todayUsd).toBe(3)
    expect(spend.periodUsd).toBe(3)
    expect(spend.monthUsd).toBe(3)
    expect(spend.days).toHaveLength(31)
  })
})

describe('admin', () => {
  test('the binding effective limit is the most spent share', () => {
    const row = pickEffective([
      { amount: '50000', period: 'monthly', period_to_date_spend: '10000', currency: 'USD' },
      { amount: '5000', period: 'daily', period_to_date_spend: '4000', currency: 'USD' },
      { amount: null, period: 'weekly', period_to_date_spend: '9999', currency: 'USD' },
    ])
    expect(row?.period).toBe('daily')
  })

  test('a named workspace limit wins over the organization', () => {
    const limits = [
      { amount: '100000', period: 'monthly' as const, is_enabled: true, scope: { type: 'organization' } },
      { amount: '20000', period: 'monthly' as const, is_enabled: true, scope: { type: 'workspace', workspace_id: 'wrkspc_a' } },
    ]
    expect(pickConsoleLimit(limits, 'wrkspc_a')?.amount).toBe('20000')
    expect(pickConsoleLimit(limits, 'wrkspc_b')?.amount).toBe('100000')
    expect(pickConsoleLimit(limits, '')?.amount).toBe('100000')
  })

  test('cost buckets are cents, filtered by workspace', () => {
    const days = sumCostBuckets(
      [
        {
          starting_at: '2026-10-01T00:00:00Z',
          results: [
            { amount: '12345.6', workspace_id: 'wrkspc_a' },
            { amount: '500', workspace_id: null },
          ],
        },
      ],
      'wrkspc_a',
    )
    expect(days).toEqual([{ day: '2026-10-01', usd: 123.456 }])
  })
})

describe('formatting', () => {
  test('money and durations', () => {
    expect(formatUsd(1.823)).toBe('$1.82')
    expect(formatUsd(312.4)).toBe('$312')
    expect(formatUsd(1250)).toBe('$1.3k')
    expect(formatDuration(108 * MINUTE)).toBe('1h48m')
    expect(formatDuration(22 * MINUTE)).toBe('22m')
  })

  test('bars put the pace tick on its cell', () => {
    expect(barCells(62, 10, 64)).toEqual([
      'fill', 'fill', 'fill', 'fill', 'fill', 'fill', 'tick', 'empty', 'empty', 'empty',
    ])
    expect(sparkline([0, 50, 100], 100)).toBe('▁▄█')
  })

  test('the plain-text line names every figure', () => {
    const view = buildView(
      snapshot({ windows: [{ kind: 'five_hour', percentUsed: 62, resetsAt: NOW + 108 * MINUTE }] }),
      null,
      null,
      OPTIONS,
      NOW,
    )
    expect(statusText(view, undefined, NOW)).toBe('5h ██████┊░░░ 62% ↻1h48m · $1.82 · ctx 48%')
  })

  test('alerts fire once per threshold and window', () => {
    const view = buildView(
      snapshot({ windows: [{ kind: 'five_hour', percentUsed: 96, resetsAt: NOW + 20 * MINUTE }] }),
      null,
      null,
      OPTIONS,
      NOW,
    )
    const alerts = crossedAlerts(view, NOW)
    expect(alerts.map(a => a.key.split(':')[2])).toEqual(['80', '95'])
    expect(alerts[1]?.text).toBe('5-hour window at 95%, resets in 20m')
  })
})

describe('styles', () => {
  test('style names parse in any case, others are refused', () => {
    expect(parseStyle('Pulse')).toBe('pulse')
    expect(parseStyle('ledger')).toBe('ledger')
    expect(parseStyle('fancy')).toBeUndefined()
    expect(parseStyle('classic')).toBeUndefined()
  })

  test('a calm gauge is one glyph that rises as it fills', () => {
    expect(levelGlyph(0)).toBe('▁')
    expect(levelGlyph(48)).toBe('▄')
    expect(levelGlyph(100)).toBe('█')
  })

  test('a calm pulse bar can be drawn thin', () => {
    const svg = barSvg({ percent: 40, width: 28, color: '#4f9e6a', title: 't', height: 4, motion: { from: 0, isHot: false } })
    expect(svg).toContain('y="5" width="28" height="4" rx="2"')
  })

  test('small percentages never read as 0%', () => {
    expect(percentLabel(0)).toBe('0%')
    expect(percentLabel(0.066)).toBe('<0.1%')
    expect(percentLabel(0.14)).toBe('0.1%')
    expect(percentLabel(62.4)).toBe('62%')
  })

  test('the smooth bar shows a sliver for any spend', () => {
    expect(smoothBar(0.07, 10)).toEqual({ fill: '▏', rest: '░'.repeat(9) })
    expect(smoothBar(50, 4)).toEqual({ fill: '██', rest: '░░' })
    expect(smoothBar(0, 4)).toEqual({ fill: '', rest: '░░░░' })
  })

  test('an SVG bar keeps a sliver of fill and escapes its title', () => {
    const svg = barSvg({ percent: 0.07, pace: 3, width: 84, color: '#4f9e6a', title: 'budget <0.1% & on pace' })
    expect(svg).toContain('width="2" height="6" rx="3" fill="#4f9e6a"')
    expect(svg).toContain('budget &#60;0.1% &#38; on pace')
    expect(svg).not.toContain('@keyframes')
  })

  test('the pulse bar grows from where it last drew and honors reduced motion', () => {
    const svg = barSvg({ percent: 50, width: 100, color: '#d9563f', title: 't', motion: { from: 25, isHot: true } })
    expect(svg).toContain('scaleX(0.5)')
    expect(svg).toContain('prefers-reduced-motion')
    expect(svg).toContain('class="o"')
    expect(liveDotSvg('#4f9e6a')).toContain('prefers-reduced-motion')
  })

  test('the ledger rule has one segment per gauge', () => {
    const svg = ruleSvg(
      [
        { percent: 62, pace: 64, color: '#4f9e6a', title: '5h' },
        { percent: 31, color: '#4f9e6a', title: '7d' },
      ],
      408,
    )
    expect(svg.match(/<g>/g)).toHaveLength(2)
    expect(svg).toContain('<rect x="208" y="4" width="200" height="3"')
  })
})

describe('pane drawings', () => {
  test('the history chart steps through the samples and projects to 100% when the burn would fill it', () => {
    const svg = historySvg({
      points: [
        { at: 0.1, percent: 10 },
        { at: 0.5, percent: 50 },
        { at: 0.76, percent: 83 },
      ],
      rate: 27,
      windowHours: 5,
      color: '#d4923a',
      width: 440,
      height: 118,
      title: 't',
    })
    expect(svg).toContain('H')
    expect(svg).toContain('stroke-dasharray="3 4"')
    expect(svg).toContain('prefers-reduced-motion')
    expect(svg.match(/<path class="l"/g)).toHaveLength(1)
  })

  test('without a burn rate the chart has no projection', () => {
    const svg = historySvg({ points: [{ at: 0.2, percent: 5 }], windowHours: 5, color: '#4f9e6a', width: 300, height: 100, title: 't' })
    expect(svg).not.toContain('stroke-dasharray="3 4"')
  })

  test('daily columns colour only the latest day', () => {
    const svg = dailySvg([1, 2, 4], '#6f8fbf', 90, 40, 't')
    expect(svg.match(/<rect class="c"/g)).toHaveLength(3)
    expect(svg.match(/fill="#6f8fbf"/g)).toHaveLength(1)
  })

  test('figures, hairlines and thin bars draw at the size asked', () => {
    const figure = figureSvg({ value: '44', unit: '%', size: 34 })
    expect(figure.height).toBe(41)
    expect(figure.source).toContain('>44</text>')
    expect(hairlineSvg(300)).toContain('width="300" height="1"')
    expect(thinBarSvg(50, 200, '#4f9e6a', 't', 4)).toContain('width="100" height="4"')
    expect(thinBarSvg(0, 200, '#4f9e6a', 't')).not.toContain('fill="#4f9e6a"')
  })
})

describe('cache countdown', () => {
  const last = NOW
  const FIVE = 5 * MINUTE

  test('calm with time left, warm in the last minute, hot once lapsed', () => {
    expect(cacheState(last, FIVE, NOW + 3 * MINUTE).level).toBe('calm')
    expect(cacheState(last, FIVE, NOW + 4 * MINUTE).level).toBe('warm')
    expect(cacheState(last, FIVE, NOW + 5 * MINUTE).level).toBe('hot')
    expect(cacheState(last, FIVE, NOW + 9 * MINUTE)).toMatchObject({ level: 'hot', remainingMs: 0, percent: 0 })
  })

  test('the one-hour cache warns five minutes out', () => {
    expect(cacheState(last, HOUR, NOW + 54 * MINUTE).level).toBe('calm')
    expect(cacheState(last, HOUR, NOW + 56 * MINUTE).level).toBe('warm')
  })

  test('percent is what is left of the lifetime', () => {
    expect(cacheState(last, FIVE, NOW).percent).toBe(100)
    expect(cacheState(last, FIVE, NOW + 150_000).percent).toBe(50)
  })

  test('the clock rounds up and stays m:ss', () => {
    expect(formatClock(222_000)).toBe('3:42')
    expect(formatClock(48_001)).toBe('0:49')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(-5)).toBe('0:00')
  })

  test('a re-write costs the context at the cache-write price', () => {
    expect(Math.round(cacheRewriteUsd(140_000, 3.75) * 1000)).toBe(525)
    expect(cacheRewriteUsd(0, 3.75)).toBe(0)
  })

  test('the lifetime is 5m unless 1h is named', () => {
    expect(parseCacheTtl('1h')).toBe('1h')
    expect(parseCacheTtl('5m')).toBe('5m')
    expect(parseCacheTtl('nonsense')).toBe('5m')
  })
})

describe('cache clock drawing', () => {
  const draw = (remainingMs: number, hasBar = true) =>
    cacheClockSvg({ remainingMs, warnMs: MINUTE, color: '#d4923a', title: 't', hasBar })

  test('one text per second left, the current one showing at rest', () => {
    const svg = draw(45_000)
    expect(svg.match(/<text/g)).toHaveLength(46)
    expect(svg).toContain('animation-delay:0s;opacity:1">0:45')
    expect(svg).toContain('animation-delay:1s">0:44')
    expect(svg).toContain('>0:00</text>')
  })

  test('the bar drains over what is left and the animation honors reduced motion', () => {
    const svg = draw(45_000)
    expect(svg).toContain('animation:d 45s linear')
    expect(svg).toContain('scaleX(0.75)')
    expect(svg).toContain('prefers-reduced-motion')
  })

  test('without a bar there is only the digits', () => {
    const svg = draw(45_000, false)
    expect(svg).not.toContain('class="b"')
    expect(svg).toContain('width="34"')
  })
})

describe('cache lifetime', () => {
  const base = { setting: 'auto' as const, isForced5m: false, isEnabled1h: false, windows: [] }
  const plan = [
    { kind: 'five_hour', percentUsed: 40 },
    { kind: 'seven_day', percentUsed: 20 },
  ]

  test('a subscription within its plan gets an hour; no windows or a gateway limit get five minutes', () => {
    expect(resolveCacheTtl({ ...base, windows: plan })).toMatchObject({ ttl: '1h' })
    expect(resolveCacheTtl(base)).toMatchObject({ ttl: '5m' })
    expect(resolveCacheTtl({ ...base, windows: [{ kind: 'spend_limit', percentUsed: 10 }] })).toMatchObject({ ttl: '5m' })
  })

  test('a plan that is used up bills credits, which get five minutes', () => {
    const spent = [{ kind: 'five_hour', percentUsed: 100 }, plan[1]!]
    expect(resolveCacheTtl({ ...base, windows: spent })).toMatchObject({ ttl: '5m' })
  })

  test('the docs order: option, FORCE_5M, env var, promptCacheTtl, ENABLE_1H, then the plan', () => {
    const all = { ...base, windows: plan, isForced5m: true, envTtl: '1h', settingsTtl: '1h', isEnabled1h: true }
    expect(resolveCacheTtl({ ...all, setting: '1h' }).source).toBe('the cache_ttl option')
    expect(resolveCacheTtl(all)).toMatchObject({ ttl: '5m', source: 'FORCE_PROMPT_CACHING_5M' })
    expect(resolveCacheTtl({ ...all, isForced5m: false })).toMatchObject({ ttl: '1h', source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' })
    expect(resolveCacheTtl({ ...all, isForced5m: false, envTtl: undefined, settingsTtl: '5m' })).toMatchObject({ ttl: '5m' })
    expect(resolveCacheTtl({ ...base, isEnabled1h: true })).toMatchObject({ ttl: '1h', source: 'ENABLE_PROMPT_CACHING_1H' })
  })

  test('an unknown env or setting value is ignored', () => {
    expect(resolveCacheTtl({ ...base, windows: plan, envTtl: '30m', settingsTtl: 'forever' })).toMatchObject({ ttl: '1h' })
    expect(parseCacheTtlSetting('auto')).toBe('auto')
    expect(parseCacheTtlSetting('1h')).toBe('1h')
    expect(parseCacheTtlSetting('bogus')).toBe('auto')
  })
})
