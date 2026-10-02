import type { HttpInit, HttpResponse } from 'claude-code'

import type { AdminReading, DaySpend, Period } from '../types'
import { periodBounds } from './model'

const API = 'https://api.anthropic.com/v1/organizations'
const BETA = 'spend-limit-reads-2026-09-26'

/** `$.http.fetch`, handed in by the hooks module. */
export type AdminFetch = (url: string, init?: HttpInit) => Promise<HttpResponse>

export type AdminConfig = { key: string; user: string; workspaceId: string }

type EffectiveRow = {
  amount: string | null
  period: Period
  period_to_date_spend: string
  currency: string
}
type SpendLimit = {
  amount: string | null
  period: Period
  is_enabled: boolean
  scope: { type: string; workspace_id?: string }
}
type CostBucket = {
  starting_at: string
  results: { amount: string; workspace_id: string | null }[]
}

/** Admin API amounts are decimal strings in cents. */
const centsToUsd = (cents: string | null | undefined) => (cents ? Number(cents) / 100 : 0)

class AdminError extends Error {}

async function getJson(fetch: AdminFetch, config: AdminConfig, path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      'x-api-key': config.key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA,
    },
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = JSON.parse(res.text) as { error?: { message?: string } }
      if (body.error?.message) message += `: ${body.error.message}`
    } catch {
      // The status alone says enough.
    }
    throw new AdminError(message)
  }

  return JSON.parse(res.text)
}

async function resolveUserId(fetch: AdminFetch, config: AdminConfig): Promise<string> {
  if (!config.user.includes('@')) return config.user
  const body = (await getJson(
    fetch,
    config,
    `/users?limit=1&email=${encodeURIComponent(config.user)}`,
  )) as { data: { id: string }[] }
  const id = body.data[0]?.id
  if (!id) throw new AdminError(`no org member with email ${config.user}`)

  return id
}

/**
 * The row that binds first: among the periods with a limit, the one with the
 * highest share spent.
 */
export function pickEffective(rows: readonly EffectiveRow[]): EffectiveRow | undefined {
  const limited = rows.filter(r => r.amount !== null && Number(r.amount) > 0)
  const share = (r: EffectiveRow) => Number(r.period_to_date_spend) / Number(r.amount)

  return [...limited].sort((a, b) => share(b) - share(a))[0]
}

/** A workspace's own limit when one is named and set, else the organization's. */
export function pickConsoleLimit(limits: readonly SpendLimit[], workspaceId: string): SpendLimit | undefined {
  const usable = limits.filter(l => l.is_enabled && l.amount !== null)
  const own = workspaceId
    ? usable.find(l => l.scope.type === 'workspace' && l.scope.workspace_id === workspaceId)
    : undefined

  return own ?? usable.find(l => l.scope.type === 'organization')
}

export function sumCostBuckets(buckets: readonly CostBucket[], workspaceId: string): DaySpend[] {
  return buckets.map(bucket => ({
    day: bucket.starting_at.slice(0, 10),
    usd: bucket.results
      .filter(r => !workspaceId || r.workspace_id === workspaceId)
      .reduce((sum, r) => sum + centsToUsd(r.amount), 0),
  }))
}

async function readEnterprise(fetch: AdminFetch, config: AdminConfig, now: number): Promise<AdminReading> {
  const userId = await resolveUserId(fetch, config)
  const body = (await getJson(
    fetch,
    config,
    `/spend_limits/effective?user_ids[]=${encodeURIComponent(userId)}`,
  )) as { data: EffectiveRow[] }
  const row = pickEffective(body.data) ?? body.data.find(r => r.period === 'monthly') ?? body.data[0]
  const period = row?.period ?? 'monthly'

  return {
    at: now,
    scope: 'user',
    period,
    spentUsd: centsToUsd(row?.period_to_date_spend),
    limitUsd: row?.amount ? centsToUsd(row.amount) : undefined,
    resetsAt: periodBounds(period, now, true).end,
    days: [],
  }
}

async function readConsole(fetch: AdminFetch, config: AdminConfig, now: number): Promise<AdminReading> {
  const { start, end } = periodBounds('monthly', now, true)
  let limit: SpendLimit | undefined
  try {
    const body = (await getJson(
      fetch,
      config,
      '/spend_limits?limit=1000&scope_type[]=organization&scope_type[]=workspace',
    )) as { data: SpendLimit[] }
    limit = pickConsoleLimit(body.data, config.workspaceId)
  } catch {
    // Reading limits is a beta the org may lack; spend alone still helps.
  }
  const isWorkspace = limit?.scope.type === 'workspace' || (!limit && config.workspaceId !== '')
  const group = config.workspaceId ? '&group_by[]=workspace_id' : ''
  const buckets: CostBucket[] = []
  let page = ''
  for (let i = 0; i < 4; i += 1) {
    const body = (await getJson(
      fetch,
      config,
      `/cost_report?starting_at=${new Date(start).toISOString()}&limit=31${group}${page}`,
    )) as { data: CostBucket[]; has_more: boolean; next_page: string | null }
    buckets.push(...body.data)
    if (!body.has_more || !body.next_page) break
    page = `&page=${encodeURIComponent(body.next_page)}`
  }
  const days = sumCostBuckets(buckets, isWorkspace ? config.workspaceId : '')

  return {
    at: now,
    scope: isWorkspace ? 'workspace' : 'organization',
    period: 'monthly',
    spentUsd: days.reduce((sum, d) => sum + d.usd, 0),
    limitUsd: limit?.amount ? centsToUsd(limit.amount) : undefined,
    resetsAt: end,
    days,
  }
}

/** Reads spend and the limit that applies; never rejects, an error rides the reading. */
export async function readAdmin(fetch: AdminFetch, config: AdminConfig, now: number): Promise<AdminReading> {
  try {
    return config.user ? await readEnterprise(fetch, config, now) : await readConsole(fetch, config, now)
  } catch (error) {
    return {
      at: now,
      scope: config.user ? 'user' : 'organization',
      period: 'monthly',
      spentUsd: 0,
      resetsAt: periodBounds('monthly', now, true).end,
      days: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
