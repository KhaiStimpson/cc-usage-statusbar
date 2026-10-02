import { describe, expect, test } from 'claude-code/testing'

import { pickConsoleLimit, pickEffective, sumCostBuckets } from '../hooks/admin'
import { applyCost, dayKey, summarize } from '../hooks/ledger'
import {
  barCells,
  buildView,
  burnRate,
  crossedAlerts,
  DAY,
  formatDuration,
  formatUsd,
  gaugeNote,
  HOUR,
  MINUTE,
  periodBounds,
  sparkline,
  statusText,
  windowGauge,
} from '../hooks/model'
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
