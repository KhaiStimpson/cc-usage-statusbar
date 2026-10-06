import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
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

/** The 5-hour window past its warning line: loud. */
const BUSY: SessionUsage = {
  ...SUBSCRIPTION,
  rateLimits: [
    { kind: 'five_hour', percentUsed: 83, resetsAt: new Date(NOW + MINUTES(108)).toISOString() },
    { kind: 'seven_day', percentUsed: 31, resetsAt: new Date(NOW + HOURS(30)).toISOString() },
  ],
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
function world(on: On, usage: SessionUsage, stored?: Readonly<Record<string, unknown>>) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  on('session.usage', () => ({ value: usage }))
  // The session's id, which a test changes to stand for a /clear or /resume.
  const session = { id: 'session-1' }
  on('session.id', () => ({ value: session.id }))
  // The model the session runs, which a test changes to stand for a /model switch.
  const model = { id: 'claude-sonnet-5-5' }
  on('session.model', () => ({ value: model.id }))
  const environment: Record<string, string> = {}
  on('env.get', (_$, e) => ({ value: environment[e.name] }))
  const claudeSettings: Record<string, unknown> = {}
  on('settings.read', () => ({ value: claudeSettings }))
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

  return { status, toasts, clock, model, claudeSettings, environment, session }
}

/** A finished main-thread turn, which refreshes the prompt cache. */
const TURN = {
  answer: 'done',
  durationMs: 4000,
  isAborted: false,
  turnId: 't1',
  reason: 'end_turn' as const,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 6_000, model: 'm' },
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
  test('calm windows draw as a label and a percentage on every surface', async ($, on) => {
    world(on, SUBSCRIPTION)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ surface, ...band(160) })
      expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '31%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '$1.82' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /resets/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('a loud window grows its bar, note and reset time', async ($, on) => {
    world(on, BUSY)
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    expect(await ui.find({ type: 'Text', text: '83%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ahead of pace' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'resets 1h48m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /█/ })).toBeDefined()
    // The calm 7d window stays small.
    expect(await ui.find({ type: 'Text', text: 'resets Thu' })).toBeUndefined()
    await ui.unmount()
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

  test('a narrow terminal drops reset times', async ($, on) => {
    world(on, BUSY)
    const ui = await $.ui.mount({ surface: 'terminal', ...band(80) })
    expect(await ui.find({ type: 'Text', text: '83%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets/ })).toBeUndefined()
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
    world(on, { ...GATEWAY, rateLimits: [], cost: { usd: 0 } })
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

describe('local spend across sessions', () => {
  const API = { ...GATEWAY, rateLimits: [], cost: { usd: 0 } }
  const spent = async ($: Engine, usd: number) =>
    $.session.measure({ context: GATEWAY.context, rateLimits: [], cost: { usd }, changed: ['cost'] })
  /** The process starting the session, as the engine does before the first prompt. */
  const started = async ($: Engine, on: On) => {
    on('command.run', () => ({ text: '' }))
    on('command.register', () => ({ value: undefined }) as never)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  }
  const machine = async ($: Engine) =>
    (await $.command.run({ ...refresh, args: 'status' })).text?.match(/This machine: [^\n]*/)?.[0]

  test('a /clear that keeps the running total counts the earlier conversation once', async ($, on) => {
    const { session, clock } = world(on, API)
    await started($, on)
    await spent($, 2)
    session.id = 'session-2'
    await spent($, 3)
    // Past the re-read of every session's ledger from the store.
    await clock.advance(MINUTES(11))
    expect(await machine($)).toBe('This machine: $3.00 this month, $3.00 today, across 2 sessions')
  })

  test('a /clear that starts the total over counts both conversations', async ($, on) => {
    const { session, clock } = world(on, API)
    await started($, on)
    await spent($, 2)
    session.id = 'session-2'
    await spent($, 0.5)
    await spent($, 1)
    // Past the re-read of every session's ledger from the store.
    await clock.advance(MINUTES(11))
    expect(await machine($)).toBe('This machine: $3.00 this month, $3.00 today, across 2 sessions')
  })

  test('a resumed session counts only what it spends from here', async ($, on) => {
    world(on, { ...API, cost: { usd: 40 } })
    await started($, on)
    await spent($, 41.5)
    expect(await machine($)).toBe('This machine: $1.50 this month, $1.50 today, across 1 sessions')
  })

  test('past spend is read from the transcripts, and replaces what the ledgers held', async ($, on) => {
    const d = new Date(NOW)
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    // A ledger an older version inflated: $20 that was never spent.
    const { environment, clock } = world(on, API, { 'ledger:old': { last: 30, days: { [today]: 20 }, touched: today } })
    environment.HOME = '/home/me'
    const line = (id: string, outputTokens: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(NOW - MINUTES(30)).toISOString(),
        requestId: `req_${id}`,
        message: { id: `msg_${id}`, model: 'claude-sonnet-5-5', usage: { output_tokens: outputTokens } },
      })
    const root = '/home/me/.claude/projects'
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false })
    const file = (name: string) => ({ name, kind: 'file' as const, size: 100, mtimeMs: NOW, isLink: false })
    const listing: Record<string, ReturnType<typeof dir>[]> = {
      [root]: [dir('proj')],
      [`${root}/proj`]: [file('s1.jsonl'), dir('s1')],
      [`${root}/proj/s1`]: [dir('subagents'), dir('tool-results')],
      [`${root}/proj/s1/subagents`]: [file('agent-1.jsonl')],
    }
    const files: Record<string, string> = {
      // $1 each at Sonnet 5.5's $10 per million output tokens; a reply is written once per content block.
      [`${root}/proj/s1.jsonl`]: [line('a', 100_000), line('a', 100_000), line('b', 100_000)].join('\n'),
      [`${root}/proj/s1/subagents/agent-1.jsonl`]: line('c', 50_000),
    }
    on('fs.list', (_$, e) => ({ value: listing[e.path ?? ''] ?? [] }))
    on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }) as never)
    await started($, on)
    // The first start reads the transcripts in the background.
    await clock.settle()
    expect(await machine($)).toBe('This machine: $2.50 this month, $2.50 today, across 2 sessions')

    // Spend from here on is counted live, on top.
    await spent($, 1)
    expect(await machine($)).toBe('This machine: $3.50 this month, $3.50 today, across 2 sessions')
    const status = (await $.command.run({ ...refresh, args: 'status' })).text ?? ''
    expect(status).toContain('Transcripts: 3 replies in 2 files')
  })

  test('a resumed session picks its own ledger up again', async ($, on) => {
    const d = new Date(NOW)
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    world(on, { ...API, cost: { usd: 40 } }, { 'ledger:session-1': { last: 40, days: { [today]: 10 }, touched: today } })
    await started($, on)
    await spent($, 41)
    expect(await machine($)).toBe('This machine: $11.00 this month, $11.00 today, across 1 sessions')
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

describe('status command', () => {
  test('says what settings arrived and which cap is shown', { options: { org_limit_usd: 500 } }, async ($, on) => {
    world(on, { ...GATEWAY, rateLimits: [], cost: { usd: 0 } })
    on('command.run', () => ({ text: '' }))
    await $.session.measure({ context: GATEWAY.context, rateLimits: [], cost: { usd: 12 }, changed: ['cost'] })
    const ran = await $.command.run({ ...refresh, args: 'status' })
    expect(ran.text).toContain('org_limit_usd $500')
    expect(ran.text).toContain('no rate-limit or spend-limit windows')
    expect(ran.text).toContain('Cap shown: org ≈$12.00 / $500, counted from this machine')
  })

  test('the cap shows on the band for a subscription user on desktop', { options: { org_limit_usd: 500 } }, async ($, on) => {
    world(on, SUBSCRIPTION)
    await $.session.measure({ ...SUBSCRIPTION, changed: ['cost'] })
    const ui = await $.ui.mount({ surface: 'desktop', ...band(90) })
    expect(await ui.find({ type: 'Text', text: '/ $500' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    await ui.unmount()
  })
})

describe('budget commands', () => {
  /** The /config rows beneath the plugin, remembering what was written. */
  function config(on: On) {
    const written: Record<string, unknown> = {}
    const row = (field: string, kind: 'number' | 'choice') => ({
      key: `usage-statusbar@cc-usage-statusbar.${field}`,
      label: field,
      kind,
      value: 0,
      provider: { kind: 'engine' },
      isLocked: false,
    })
    on('config.list', () => ({ value: [row('budget_usd', 'number'), row('budget_period', 'choice')] as never }))
    on('config.set', ($, e) => {
      written[e.key.split('.').pop()!] = e.value

      return { value: e.value }
    })

    return written
  }

  test('period sets the budget period, taking short words too', async ($, on) => {
    world(on, SUBSCRIPTION)
    on('command.run', () => ({ text: '' }))
    const written = config(on)

    const ran = await $.command.run({ ...refresh, args: 'period Week' })
    expect(ran.text).toBe('Budget period set to weekly (weeks start Monday). Set an amount with /usagebar budget <usd>.')
    expect(written).toEqual({ budget_period: 'weekly' })
  })

  test('period refuses anything else and says the current one', async ($, on) => {
    world(on, SUBSCRIPTION)
    on('command.run', () => ({ text: '' }))
    const written = config(on)

    const ran = await $.command.run({ ...refresh, args: 'period yearly' })
    expect(ran.text).toBe("Usage: /usagebar period <monthly | weekly | daily>. It's monthly now.")
    expect(written).toEqual({})
  })

  test('budget takes an amount and a period together', async ($, on) => {
    world(on, SUBSCRIPTION)
    on('command.run', () => ({ text: '' }))
    const written = config(on)

    const ran = await $.command.run({ ...refresh, args: 'budget $50 daily' })
    expect(ran.text).toBe('Budget set to $50.00 daily.')
    expect(written).toEqual({ budget_usd: 50, budget_period: 'daily' })
  })
})

describe('parts of the bar', () => {
  test('hidden parts leave the bar, the rest stay', { options: { show_7d: false, show_context: false } }, async ($, on) => {
    world(on, SUBSCRIPTION)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ surface, ...band(160) })
      expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '7d' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'ctx' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: '$1.82' })).toBeDefined()
      await ui.unmount()
    }
  })

  test(
    'the budget alone',
    { options: { budget_usd: 200, show_5h: false, show_7d: false, show_session: false, show_context: false } },
    async ($, on) => {
      world(on, SUBSCRIPTION)
      await $.session.measure({ ...SUBSCRIPTION, changed: ['cost'] })
      const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
      expect(await ui.find({ type: 'Text', text: 'budget' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '/ $200' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5h' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^\$1\.82$/ })).toBeUndefined()
      await ui.unmount()
    },
  )

  test(
    'everything hidden leaves the band to the engine',
    { options: { show_5h: false, show_7d: false, show_spend: false, show_today: false, show_session: false, show_context: false } },
    async ($, on) => {
      world(on, SUBSCRIPTION)
      const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
      expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
      await ui.unmount()
    },
  )

  test('only writes every part that changes, with aliases', async ($, on) => {
    world(on, SUBSCRIPTION)
    on('command.run', () => ({ text: '' }))
    const written: Record<string, unknown> = {}
    const rows = ['5h', '7d', 'spend', 'today', 'session', 'context', 'cache'].map(part => ({
      key: `usage-statusbar@cc-usage-statusbar.show_${part}`,
      label: part,
      kind: 'boolean' as const,
      value: true,
      provider: { kind: 'engine' },
      isLocked: false,
    }))
    on('config.list', () => ({ value: rows as never }))
    on('config.set', ($, e) => {
      written[e.key.split('.').pop()!] = e.value

      return { value: e.value }
    })

    const ran = await $.command.run({ ...refresh, args: 'only budget' })
    expect(ran.text).toBe('The bar shows: spend.')
    expect(written).toEqual({
      show_5h: false,
      show_7d: false,
      show_today: false,
      show_session: false,
      show_context: false,
      show_cache: false,
    })

    const bad = await $.command.run({ ...refresh, args: 'hide weather' })
    expect(bad.text).toBe('Unknown part: weather. Usage: /usagebar hide <part>..., where a part is 5h, 7d, spend, today, session, context, cache.')
  })
})

describe('cache countdown', () => {
  /** The engine's own end of a turn, beneath the plugin. */
  const engine = (on: On) => on('turn.complete', () => ({ text: '' }))

  test('nothing shows before the first reply', async ($, on) => {
    world(on, SUBSCRIPTION)
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    expect(await ui.find({ type: 'Text', text: 'cache' })).toBeUndefined()
    await ui.unmount()
  })

  for (const style of ['pulse', 'chips', 'ledger'] as const) {
    test(`${style}: counts down, warns in the last minute, then goes red`, { options: { style } }, async ($, on) => {
      const { clock } = world(on, SUBSCRIPTION)
      engine(on)
      await $.turn.complete(TURN)

      const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
      expect(await ui.find({ type: 'Text', text: 'cache' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5:00' })).toBeDefined()
      await ui.unmount()

      await clock.advance(MINUTES(4) + 15_000)
      const warm = await $.ui.mount({ surface: 'terminal', ...band(160) })
      expect(await warm.find({ type: 'Text', text: '0:45' })).toBeDefined()
      expect(await warm.find({ type: 'Text', text: 'expires soon' })).toBeDefined()
      await warm.unmount()

      await clock.advance(MINUTES(1))
      const cold = await $.ui.mount({ surface: 'terminal', ...band(160) })
      expect(await cold.find({ type: 'Text', text: '⚠ cache cold' })).toBeDefined()
      // 96,000 tokens at $3.75 per million.
      expect(await cold.find({ type: 'Text', text: 'next turn ≈ $0.36' })).toBeDefined()
      await cold.unmount()
    })
  }

  test('on the desktop a calm cache reads in minutes and a warm one runs itself', async ($, on) => {
    const { clock } = world(on, SUBSCRIPTION)
    engine(on)
    await $.turn.complete(TURN)

    const calm = await $.ui.mount({ surface: 'desktop', ...band(160) })
    expect(await calm.find({ type: 'Text', text: '5m' })).toBeDefined()
    await calm.unmount()

    await clock.advance(MINUTES(4) + 15_000)
    const warm = await $.ui.mount({ surface: 'desktop', ...band(160) })
    expect(await warm.find({ type: 'Text', text: 'expires soon' })).toBeDefined()
    expect(await warm.find({ type: 'Svg', source: /class="t"[^>]*>0:45</ })).toBeDefined()
    await warm.unmount()
  })

  const pane = (surface: 'terminal' | 'desktop', bodyColumns: number) => ({
    surface,
    plugin: PLUGIN,
    component: 'Pane' as const,
    requestId: 'usage-statusbar',
    props: {
      title: 'Usage',
      isFocused: false,
      bodyColumns,
      placement: 'dock' as const,
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  })

  test('the desktop pane is a quiet list with figures, bars and the cache', async ($, on) => {
    world(on, BUSY)
    engine(on)
    await reply($, BUSY)

    const ui = await $.ui.mount(pane('desktop', 60))
    expect(await ui.find({ type: 'Text', text: '5-hour window' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ahead of pace' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Burn rate' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '7-day window' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Session cost' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Prompt cache' })).toBeDefined()
    expect(await ui.find({ type: 'Svg', source: />83</ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop pane draws at any width, from a narrow dock to a full-width pane', async ($, on) => {
    world(on, BUSY)
    engine(on)
    await reply($, BUSY)

    for (const columns of [30, 60, 155]) {
      const ui = await $.ui.mount(pane('desktop', columns))
      expect(await ui.find({ type: 'Text', text: '5-hour window' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the desktop pane says why a lapsed cache is cold and what the next turn costs', async ($, on) => {
    const { clock } = world(on, SUBSCRIPTION)
    engine(on)
    await $.turn.complete(TURN)
    await clock.advance(MINUTES(6))

    const ui = await $.ui.mount(pane('desktop', 60))
    expect(await ui.find({ type: 'Text', text: /The cache lapsed.*about \$0\.36/ })).toBeDefined()
    await ui.unmount()
  })

  test('the terminal pane stays plain text', async ($, on) => {
    world(on, BUSY)
    engine(on)

    const ui = await $.ui.mount(pane('terminal', 48))
    expect(await ui.find({ type: 'Text', text: '5-hour window' })).toBeDefined()
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    await ui.unmount()
  })

  /** A reply on the session's model, after the plan's windows have been reported. */
  const reply = async ($: Engine, usage: SessionUsage) => {
    await $.session.measure({ ...usage, changed: ['rateLimits'] })
    await $.turn.complete(TURN)
  }
  const shows = async ($: Engine, text: string | RegExp) => {
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()

    return found !== undefined
  }

  test('a subscription gets the one-hour lifetime and an API key five minutes', async ($, on) => {
    world(on, SUBSCRIPTION)
    engine(on)
    await reply($, SUBSCRIPTION)
    expect(await shows($, '60:00')).toBe(true)
  })

  test('a gateway limit is not a subscription, so five minutes', async ($, on) => {
    world(on, GATEWAY)
    engine(on)
    await reply($, GATEWAY)
    expect(await shows($, '5:00')).toBe(true)
  })

  test('a plan that is used up bills credits, so five minutes', async ($, on) => {
    world(on, SUBSCRIPTION)
    engine(on)
    const spent: SessionUsage = {
      ...SUBSCRIPTION,
      rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + MINUTES(10)).toISOString() }],
    }
    await reply($, spent)
    expect(await shows($, '5:00')).toBe(true)
  })

  test('FORCE_PROMPT_CACHING_5M and the promptCacheTtl setting outrank the plan', async ($, on) => {
    const { environment, claudeSettings } = world(on, SUBSCRIPTION)
    engine(on)
    claudeSettings.promptCacheTtl = '5m'
    await reply($, SUBSCRIPTION)
    expect(await shows($, '5:00')).toBe(true)
    claudeSettings.promptCacheTtl = undefined
    environment.FORCE_PROMPT_CACHING_5M = '1'
    await reply($, SUBSCRIPTION)
    expect(await shows($, '5:00')).toBe(true)
  })

  test('DISABLE_PROMPT_CACHING hides the countdown', async ($, on) => {
    const { environment } = world(on, SUBSCRIPTION)
    engine(on)
    environment.DISABLE_PROMPT_CACHING = '1'
    await reply($, SUBSCRIPTION)
    expect(await shows($, /cache/)).toBe(false)
  })

  test('each model has its own cache: a switch reads cold and switching back reads warm again', async ($, on) => {
    const { model, clock } = world(on, SUBSCRIPTION)
    engine(on)
    await reply($, SUBSCRIPTION)
    await clock.advance(MINUTES(10))
    expect(await shows($, '50:00')).toBe(true)

    model.id = 'claude-opus-5-5'
    expect(await shows($, '⚠ cache cold')).toBe(true)

    model.id = 'claude-sonnet-5-5'
    expect(await shows($, '50:00')).toBe(true)
  })

  test('a compaction leaves the cache cold, priced on the short summary', async ($, on) => {
    world(on, SUBSCRIPTION)
    engine(on)
    on('session.compact', () => ({ messages: [{ role: 'assistant', text: 'summary', toolUses: [] }], tokensAfter: 8000 }))
    await reply($, SUBSCRIPTION)
    const compacted = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] })
    expect(compacted).toBeDefined()
    expect(await shows($, '⚠ cache cold')).toBe(true)
    // 8,000 tokens at $3.75 per million.
    expect(await shows($, 'next turn ≈ $0.03')).toBe(true)
    // The next reply rebuilds it.
    await $.turn.complete(TURN)
    expect(await shows($, '⚠ cache cold')).toBe(false)
  })

  test('a /clear forgets the cache', async ($, on) => {
    world(on, SUBSCRIPTION)
    engine(on)
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    await reply($, SUBSCRIPTION)
    expect(await shows($, /cache/)).toBe(true)
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } as never })
    expect(await shows($, /cache/)).toBe(false)
  })

  test('a reload picks the countdown up again from the store, for the same session only', async ($, on) => {
    world(on, SUBSCRIPTION, { cache: { sessionId: 'session-1', entries: [['claude-sonnet-5-5', NOW - MINUTES(1)]] } })
    engine(on)
    on('command.register', () => ({ value: undefined }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })
    // A subscription's hour, less the minute since the last reply.
    expect(await shows($, '59:00')).toBe(true)
  })

  test('a one-hour cache lasts an hour', { options: { cache_ttl: '1h' } }, async ($, on) => {
    world(on, SUBSCRIPTION)
    engine(on)
    await $.turn.complete(TURN)
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    expect(await ui.find({ type: 'Text', text: '60:00' })).toBeDefined()
    await ui.unmount()
  })

  test('hiding the part removes the countdown', { options: { show_cache: false } }, async ($, on) => {
    world(on, SUBSCRIPTION)
    engine(on)
    await $.turn.complete(TURN)
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    expect(await ui.find({ type: 'Text', text: 'cache' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    await ui.unmount()
  })
})

describe('styles', () => {
  /** The style row beneath the plugin, remembering what was written. */
  function styleRow(on: On) {
    const written: Record<string, unknown> = {}
    on('config.list', () => ({
      value: [
        {
          key: 'usage-statusbar@cc-usage-statusbar.style',
          label: 'Style',
          kind: 'choice',
          value: 'pulse',
          provider: { kind: 'engine' },
          isLocked: false,
        },
      ] as never,
    }))
    on('config.set', ($, e) => {
      written[e.key.split('.').pop()!] = e.value

      return { value: e.value }
    })

    return written
  }

  test('style switches the band and refuses unknown names', async ($, on) => {
    world(on, SUBSCRIPTION)
    on('command.run', () => ({ text: '' }))
    const written = styleRow(on)

    const bad = await $.command.run({ ...refresh, args: 'style fancy' })
    expect(bad.text).toBe("Usage: /usagebar style <chips | ledger | pulse>. It's pulse now.")
    expect((await $.command.run({ ...refresh, args: 'style classic' })).text).toContain('Usage:')
    expect(written).toEqual({})

    const ran = await $.command.run({ ...refresh, args: 'style Ledger' })
    expect(ran.text).toBe('The bar now draws in the ledger style.')
    expect(written).toEqual({ style: 'ledger' })
    const ui = await $.ui.mount({ surface: 'terminal', ...band(160) })
    expect(await ui.find({ type: 'Text', text: /▔/ })).toBeDefined()
    await ui.unmount()
  })

  for (const style of ['chips', 'ledger', 'pulse'] as const) {
    test(`${style} draws every figure on both surfaces, with SVG bars on the desktop`, { options: { style, budget_usd: 500 } }, async ($, on) => {
      world(on, SUBSCRIPTION)
      await $.session.measure({ ...SUBSCRIPTION, changed: ['cost'] })
      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await $.ui.mount({ surface, ...band(160) })
        expect(await ui.find({ type: 'Text', text: '$1.82' })).toBeDefined()
        if (surface === 'desktop' && style === 'chips') {
          // Chips on the desktop draw each gauge's words inside its pill drawing.
          const drawn = (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.source)).join('')
          for (const word of ['>5h<', '>62%<', '>budget<']) expect(drawn).toContain(word)
        } else {
          expect(await ui.find({ type: 'Text', text: '5h' })).toBeDefined()
          expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
          expect(await ui.find({ type: 'Text', text: 'budget' })).toBeDefined()
          expect(await ui.find({ type: 'Svg' }))[surface === 'desktop' ? 'toBeDefined' : 'toBeUndefined']()
        }
        await ui.unmount()
      }
    })
  }

  test('pulse shows a live dot while a turn runs', { options: { style: 'pulse' } }, async ($, on) => {
    world(on, SUBSCRIPTION)
    const working = band(160)
    const ui = await $.ui.mount({ surface: 'desktop', ...working, props: { ...working.props, isWorking: true } })
    const dots = (svgs: { props: Record<string, unknown> }[]) => svgs.filter(s => s.props.alt === 'A turn is running')
    expect(dots(await ui.findAll({ type: 'Svg' }))).toHaveLength(1)
    await ui.unmount()
    const idle = await $.ui.mount({ surface: 'desktop', ...band(160) })
    expect(dots(await idle.findAll({ type: 'Svg' }))).toHaveLength(0)
    await idle.unmount()
  })

  /** The pill drawings on the desktop, as their markup. */
  const pills = async (ui: Awaited<ReturnType<typeof $.ui.mount>>) =>
    (await ui.findAll({ type: 'Svg' })).map(s => String(s.props.source))

  test('chips draw each gauge as a pill filled to its percentage, grey while calm', { options: { style: 'chips' } }, async ($, on) => {
    world(on, SUBSCRIPTION)
    const ui = await $.ui.mount({ surface: 'desktop', ...band(160) })
    const drawn = await pills(ui)
    // 5h, 7d and ctx.
    expect(drawn).toHaveLength(3)
    for (const source of drawn) expect(source).toContain('rgba(128,128,128,0.45)')
    expect(drawn[0]).toContain('>5h<')
    expect(drawn[0]).toContain('>62%<')
    await ui.unmount()
  })

  test('a loud gauge fills amber', { options: { style: 'chips' } }, async ($, on) => {
    world(on, BUSY)
    const ui = await $.ui.mount({ surface: 'desktop', ...band(160) })
    const drawn = await pills(ui)
    expect(drawn[0]).toContain('rgba(212,146,58,0.62)')
    expect(drawn[1]).toContain('rgba(128,128,128,0.45)')
    await ui.unmount()
  })

  test('a lapsed cache is a solid red pill', { options: { style: 'chips' } }, async ($, on) => {
    const { clock } = world(on, SUBSCRIPTION)
    on('turn.complete', () => ({ text: '' }))
    await $.turn.complete(TURN)
    await clock.advance(MINUTES(6))
    const ui = await $.ui.mount({ surface: 'desktop', ...band(160) })
    const red = (await pills(ui)).find(src => src.includes('rgba(217,86,63,0.66)'))
    expect(red).toContain('⚠ cache cold')
    await ui.unmount()
  })

  test('ledger puts each bar under its own gauge, at the gauge column width', { options: { style: 'ledger' } }, async ($, on) => {
    world(on, SUBSCRIPTION)
    const ui = await $.ui.mount({ surface: 'desktop', ...band(160) })
    const columns = (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexDirection === 'column' && b.props.width !== undefined)
    // 5h, 7d and ctx, each at least 10 cells wide.
    expect(columns).toHaveLength(3)
    for (const c of columns) expect(c.props.width).toBeGreaterThanOrEqual(10)
    const bars = await ui.findAll({ type: 'Svg' })
    expect(bars).toHaveLength(3)
    // No note sits under a bar.
    expect(await ui.find({ type: 'Text', text: 'expires soon' })).toBeUndefined()
    await ui.unmount()
  })
})
