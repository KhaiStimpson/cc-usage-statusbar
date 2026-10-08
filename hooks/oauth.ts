import type { AdminReading } from '../types'
import type { AdminFetch } from './admin'
import { periodBounds } from './model'

/** The endpoint Claude Code's own /usage panel reads. */
export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const BETA = 'oauth-2025-04-20'

/** What the endpoint calls extra usage: a monthly dollar limit, in cents. */
type ExtraUsage = {
  is_enabled?: boolean
  monthly_limit?: number | null
  used_credits?: number | null
  utilization?: number | null
}

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

/** Cents to dollars, or undefined for anything that is not a number. */
const dollars = (cents: unknown) => (typeof cents === 'number' && Number.isFinite(cents) ? cents / 100 : undefined)

export function parseOauthUsage(body: unknown, now: number): OauthResult {
  const extra = (body as { extra_usage?: ExtraUsage | null } | null)?.extra_usage
  if (!extra || typeof extra !== 'object') return { note: 'no extra_usage in the response' }
  if (!extra.is_enabled) return { note: 'extra usage is not enabled on this account' }

  const limitUsd = dollars(extra.monthly_limit)
  const spentUsd = dollars(extra.used_credits) ?? (limitUsd !== undefined && typeof extra.utilization === 'number' ? (limitUsd * extra.utilization) / 100 : undefined)
  if (spentUsd === undefined) return { note: 'extra usage has no spend figure' }

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
    },
    note: limitUsd ? 'extra usage with a monthly limit' : 'extra usage with no monthly limit',
  }
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
