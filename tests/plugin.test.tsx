import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime()
const PLUGIN = 'usage-statusbar'

const SUBSCRIPTION: SessionUsage = {
  startedAt: NOW - HOURS(1),
  context: { tokens: 96_000, window: 200_000, percent: 48 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(NOW + MINUTES(108)).toISOString() },
    { kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + HOURS(30)).toISOString() },
  ],
  cost: { usd: 1.82 },
}

const GATEWAY: SessionUsage = {
  startedAt: NOW - HOURS(1),
  context: { tokens: 96_000, window: 200_000, percent: 48 },
  rateLimits: [{ kind: 'spend_limit', percentUsed: 62.4, resetsAt: new Date(2026, 10, 1).toISOString() }],
  cost: { usd: 4.05 },
}

function MINUTES(n: number) {
  return n * 60_000
}
function HOURS(n: number) {
  return n * 3_600_000
}

/** The engine beneath the plugin: the clock, the store and the session's figures. */
function world(on: On, usage: SessionUsage) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.usage', () => ({ value: usage }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  // What the engine draws when the plugin leaves a site to it.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return { status, toasts }
}

const refresh = {
  command: 'usagebar',
  args: 'refresh',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
}

const band = (bodyColumns: number) => ({
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
})

describe('band', () => {
  test('subscription windows draw with their percentages on every surface', async ($, on) => {
    world(on, SUBSCRIPTION)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ surface, ...band(160) })
      expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '31%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '↻1h48m' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '$1.82' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '┃' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a gateway spend limit reads in dollars once its amount is set', { options: { org_limit_usd: 500 } }, async ($, on) => {
    world(on, GATEWAY)
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    expect(await ui.find({ type: 'Text', text: 'org' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$312' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/ $500' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$4.05' })).toBeDefined()
    await ui.unmount()
  })

  test('a narrow terminal drops the bars', async ($, on) => {
    world(on, SUBSCRIPTION)
    const ui = await $.ui.mount({ surface: 'terminal', ...band(80) })
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /━/ })).toBeUndefined()
    await ui.unmount()
  })

  test('display "status" leaves the band to the engine', { options: { display: 'status' } }, async ($, on) => {
    world(on, SUBSCRIPTION)
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await ui.unmount()
  })
})

describe('measure', () => {
  test('records spend, writes the status line and toasts once past 80%', { options: { display: 'both' } }, async ($, on) => {
    const { status, toasts } = world(on, SUBSCRIPTION)
    const hot = {
      context: SUBSCRIPTION.context,
      rateLimits: [{ kind: 'five_hour', percentUsed: 83, resetsAt: new Date(NOW + MINUTES(54)).toISOString() }],
      cost: { usd: 2.5 },
      changed: ['rateLimits', 'cost'] as ('rateLimits' | 'cost')[],
    }
    await $.session.measure(hot)
    await $.session.measure(hot)

    expect(status[status.length - 1]).toContain('5h ')
    expect(status[status.length - 1]).toContain('83%')
    expect(toasts).toEqual(['5-hour window at 80%, resets in 54m'])
  })

  test('pay-per-token spend adds up into today', async ($, on) => {
    world(on, { ...GATEWAY, rateLimits: [] })
    for (const usd of [1, 2.5]) {
      await $.session.measure({ context: GATEWAY.context, rateLimits: [], cost: { usd }, changed: ['cost'] })
    }
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    expect(await ui.find({ type: 'Text', text: 'today' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$2.50' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'session' })).toBeDefined()
    await ui.unmount()
  })
})

describe('admin api', () => {
  test(
    'an Enterprise member reads their effective limit and spend',
    { options: { admin_api_key: 'sk-ant-admin-test', admin_user: 'user_01abc' } },
    async ($, on) => {
      world(on, { ...GATEWAY, rateLimits: [] })
      const asked: { url: string; headers?: Record<string, string> }[] = []
      on('http.fetch', ($, e) => {
        asked.push({ url: e.url, headers: e.init?.headers })
        const body = {
          data: [
            { amount: '50000', period: 'monthly', period_to_date_spend: '42012.5', currency: 'USD' },
            { amount: null, period: 'daily', period_to_date_spend: '900', currency: 'USD' },
          ],
          next_page: null,
        }

        return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
      })
      on('command.run', () => ({ text: '' }))

      const ran = await $.command.run(refresh)
      expect(ran.text).toBe('Spend refreshed from the Admin API.')
      expect(asked[0]?.url).toContain('/v1/organizations/spend_limits/effective?user_ids[]=user_01abc')
      expect(asked[0]?.headers?.['x-api-key']).toBe('sk-ant-admin-test')
      expect(asked[0]?.headers?.['anthropic-beta']).toBe('spend-limit-reads-2026-09-26')

      const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
      expect(await ui.find({ type: 'Text', text: '$420' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '/ $500' })).toBeDefined()
      await ui.unmount()
    },
  )

  test('an Admin API failure shows in the pane and keeps the band', { options: { admin_api_key: 'bad' } }, async ($, on) => {
    world(on, { ...GATEWAY, rateLimits: [] })
    on('http.fetch', () => ({
      value: { status: 401, ok: false, headers: {}, text: '{"error":{"message":"invalid x-api-key"}}' },
    }))
    on('command.run', () => ({ text: '' }))

    const ran = await $.command.run(refresh)
    expect(ran.text).toBe('Admin API: HTTP 401: invalid x-api-key')
    const pane = await $.ui.mount({
      surface: 'terminal',
      plugin: PLUGIN,
      component: 'Pane',
      requestId: 'usage-statusbar',
      props: {
        title: 'Usage',
        isFocused: false,
        bodyColumns: 48,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await pane.find({ type: 'Text', text: /HTTP 401/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'close' })).toBeDefined()
    await pane.unmount()
  })
})
