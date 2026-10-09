import type { AdminReading, DaySpend } from '../types'
import type { AdminFetch } from './admin'
import { DAY, dayKey, periodBounds } from './model'

/** The endpoint Claude Code's own /usage panel reads. */
export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const BETA = 'oauth-2025-04-20'

/** What the endpoint calls extra usage: a monthly limit and the spend so far, in minor units (cents). */
type ExtraUsage = {
  is_enabled?: boolean
  monthly_limit?: number | null
  used_credits?: number | null
  utilization?: number | null
  currency?: string | null
  decimal_places?: number | null
  disabled_reason?: string | null
  user_disabled?: boolean
  spend_limit_reached?: boolean
}

/** The same figures in the newer block the endpoint also sends. */
type Money = { amount_minor?: number | null; currency?: string | null; exponent?: number | null }
type SpendBlock = { used?: Money | null; limit?: Money | null; enabled?: boolean; disabled_reason?: string | null }

export type OauthResult = {
  /** Absent when the account reports no extra-usage spend. */
  reading?: AdminReading
  /** What happened, for /usagebar status. */
  note: string
  /** The call itself failed, so figures from an earlier read still stand. */
  isFailure?: boolean
}

/** The access token in Claude Code's credentials file or keychain entry, unless it has expired. */
export function tokenFromCredentials(text: string, now: number): { token?: string; isExpired?: boolean } {
  try {
    const oauth = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth
    const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken.trim() : ''
    if (!token) return {}
    if (typeof oauth?.expiresAt === 'number' && oauth.expiresAt <= now) return { isExpired: true }

    return { token }
  } catch {
    return {}
  }
}

/** Minor units to major ones, `places` digits in; undefined for anything that is not a number. */
const major = (minor: unknown, places = 2) =>
  typeof minor === 'number' && Number.isFinite(minor) ? minor / 10 ** places : undefined

const placesOf = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 6 ? n : 2)

export function parseOauthUsage(body: unknown, now: number): OauthResult {
  const { extra_usage: extra, spend } = (body as { extra_usage?: ExtraUsage | null; spend?: SpendBlock | null } | null) ?? {}
  if ((!extra || typeof extra !== 'object') && (!spend || typeof spend !== 'object')) return { note: 'no extra_usage in the response' }

  const isEnabled = extra && typeof extra === 'object' ? extra.is_enabled : spend?.enabled
  if (!isEnabled) {
    const why = (extra?.disabled_reason ?? spend?.disabled_reason) || (extra?.user_disabled ? 'turned off by the user' : '')

    return { note: `extra usage is not enabled on this account${why ? ` (${why})` : ''}` }
  }

  // The older block first; the newer one carries the same figures when it is missing.
  const places = placesOf(extra?.decimal_places ?? spend?.used?.exponent)
  const limitUsd = major(extra?.monthly_limit, places) ?? major(spend?.limit?.amount_minor, places)
  const spentUsd =
    major(extra?.used_credits, places) ??
    major(spend?.used?.amount_minor, places) ??
    (limitUsd !== undefined && typeof extra?.utilization === 'number' ? (limitUsd * extra.utilization) / 100 : undefined)
  if (spentUsd === undefined) return { note: 'extra usage has no spend figure' }

  const currency = extra?.currency ?? spend?.used?.currency
  const unit = currency && currency !== 'USD' ? `, amounts in ${currency}` : ''

  return {
    reading: {
      at: now,
      source: 'oauth',
      scope: 'user',
      period: 'monthly',
      spentUsd,
      limitUsd: limitUsd && limitUsd > 0 ? limitUsd : undefined,
      resetsAt: periodBounds('monthly', now).end,
      days: [],
      ...(extra?.spend_limit_reached && { isLimitReached: true }),
    },
    note: `${limitUsd ? 'extra usage with a monthly limit' : 'extra usage with no monthly limit'}${extra?.spend_limit_reached ? ', limit reached' : ''}${unit}`,
  }
}

/**
 * What the login's month-to-date total has grown by, kept per day. The endpoint reports only the running total, so
 * the days are built here, on every device's spend, from the readings this machine takes.
 */
export type OauthDays = {
  lastDay: string
  lastUsd: number
  /** The first day the days are continuous from: earlier spend the readings never saw is not in them. */
  startDay: string
  days: Record<string, number>
}

const KEPT_DAYS = 62

/** `day` (YYYY-MM-DD) moved by `by` calendar days. */
function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split('-').map(Number)

  return dayKey(new Date(y!, m! - 1, d! + by, 12).getTime())
}

/** Folds a reading of the month's total into the days. Spend since the last reading belongs to the day that reading was on. */
export function advanceDays(prev: OauthDays | undefined, spentUsd: number, now: number): OauthDays {
  const today = dayKey(now)
  if (!prev) return { lastDay: today, lastUsd: spentUsd, startDay: today, days: {} }

  // A total below the last one means the month turned over and the count started again.
  const grew = spentUsd >= prev.lastUsd ? spentUsd - prev.lastUsd : spentUsd
  // After two or more days unread there is no telling which days the spend fell on.
  const isGap = prev.lastDay !== today && prev.lastDay !== shiftDay(today, -1)
  const days = { ...prev.days }
  if (!isGap && grew > 0) days[prev.lastDay] = (days[prev.lastDay] ?? 0) + grew
  const keep = dayKey(now - KEPT_DAYS * DAY)
  for (const day of Object.keys(days)) if (day < keep) delete days[day]

  return { lastDay: today, lastUsd: spentUsd, startDay: isGap ? today : prev.startDay, days }
}

/** The last month of days, oldest first, for the sparkline and today's figure. */
export function daysOf(state: OauthDays, now: number): DaySpend[] {
  const out: DaySpend[] = []
  for (let i = 30; i >= 0; i -= 1) {
    const day = dayKey(now - i * DAY)
    out.push({ day, usd: state.days[day] ?? 0 })
  }

  return out
}

export function isOauthDays(value: unknown): value is OauthDays {
  const v = value as OauthDays | null

  return typeof v === 'object' && v !== null && typeof v.lastDay === 'string' && typeof v.lastUsd === 'number' && typeof v.startDay === 'string' && typeof v.days === 'object' && v.days !== null
}

/** Reads the extra-usage spend /usage shows; never rejects. */
export async function readOauthUsage(fetch: AdminFetch, token: string, now: number): Promise<OauthResult> {
  try {
    const res = await fetch(OAUTH_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': BETA, 'Content-Type': 'application/json' },
    })
    if (!res.ok) return { note: `HTTP ${res.status}`, isFailure: true }

    return parseOauthUsage(JSON.parse(res.text), now)
  } catch (error) {
    return { note: error instanceof Error ? error.message : String(error), isFailure: true }
  }
}
