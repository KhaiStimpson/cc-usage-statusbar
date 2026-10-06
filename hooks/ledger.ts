import type { DaySpend, LocalSpend, Period } from '../types'
import { DAY, periodBounds } from './model'
import type { ImportedSpend } from './transcripts'

/**
 * One session's spend, kept in the store under its own key so concurrent
 * sessions never write over each other: the last cost total seen and what it
 * grew by on each local day. `since` is the transcript import it counts on
 * from: spend before that time is the import's.
 */
export type SessionLedger = { last: number; days: Record<string, number>; touched: string; since?: number }

export const LEDGER_PREFIX = 'ledger:'

export function dayKey(ms: number): string {
  const d = new Date(ms)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A ledger that counts only what the session's total grows by from `usd`. */
export function startLedger(usd: number, day: string, since?: number): SessionLedger {
  return { last: usd, days: {}, touched: day, ...(since !== undefined && { since }) }
}

/** The ledger counting on from an import at `at`: what it held before is the import's now. */
export function afterImport(ledger: SessionLedger, at: number): SessionLedger {
  return (ledger.since ?? 0) >= at ? ledger : { ...ledger, days: {}, since: at }
}

/** Adds what the session's cost total grew by since the last reading to `day`. */
export function applyCost(prev: SessionLedger | undefined, usd: number, day: string): SessionLedger {
  const last = prev?.last ?? 0
  // A total lower than the last one means the session's ledger started over.
  const delta = usd >= last ? usd - last : usd
  const days = { ...prev?.days }
  if (delta > 0) days[day] = (days[day] ?? 0) + delta

  return { ...prev, last: usd, days, touched: day }
}

export function isLedger(value: unknown): value is SessionLedger {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SessionLedger).last === 'number' &&
    typeof (value as SessionLedger).days === 'object'
  )
}

/**
 * Adds the sessions up by day, over what the transcripts held when last imported. A ledger that has not caught up
 * with that import is left out: its spend until then is in the import, and it counts again once its session moves on.
 */
export function summarize(
  ledgers: readonly SessionLedger[],
  period: Period,
  now: number,
  imported?: Pick<ImportedSpend, 'at' | 'days'>,
): LocalSpend {
  const totals: Record<string, number> = { ...imported?.days }
  for (const ledger of ledgers) {
    if (imported && (ledger.since ?? 0) < imported.at) continue
    for (const [day, usd] of Object.entries(ledger.days)) totals[day] = (totals[day] ?? 0) + usd
  }
  const sumFrom = (from: string) =>
    Object.entries(totals).reduce((sum, [day, usd]) => (day >= from ? sum + usd : sum), 0)
  const days: DaySpend[] = []
  for (let i = 30; i >= 0; i -= 1) {
    const day = dayKey(now - i * DAY)
    days.push({ day, usd: totals[day] ?? 0 })
  }

  return {
    todayUsd: totals[dayKey(now)] ?? 0,
    periodUsd: sumFrom(dayKey(periodBounds(period, now).start)),
    monthUsd: sumFrom(dayKey(periodBounds('monthly', now).start)),
    days,
  }
}

/** Ledgers untouched for two months are past every period worth showing. */
export function isStale(ledger: SessionLedger, now: number): boolean {
  return ledger.touched < dayKey(now - 62 * DAY)
}
