export type Level = 'calm' | 'warm' | 'hot'

export type Period = 'daily' | 'weekly' | 'monthly'

/** One rate-limit window as the engine reported it. */
export type Window = {
  kind: string
  percentUsed: number
  /** Milliseconds since the epoch. */
  resetsAt?: number
}

/** The engine's figures at the last measurement. */
export type Snapshot = {
  at: number
  contextPercent?: number
  contextTokens?: number
  contextWindow: number
  windows: Window[]
  sessionUsd?: number
}

export type DaySpend = { day: string; usd: number }

/** Spend Claude Code recorded on this machine, across sessions. */
export type LocalSpend = {
  todayUsd: number
  periodUsd: number
  monthUsd: number
  days: DaySpend[]
}

/** What the Admin API (or Claude Code's own /usage endpoint) answered at its last read. */
export type AdminReading = {
  at: number
  /** Absent means the Admin API. */
  source?: 'admin' | 'oauth'
  scope: 'user' | 'workspace' | 'organization'
  period: Period
  spentUsd: number
  limitUsd?: number
  resetsAt: number
  days: DaySpend[]
  /** The day figure may miss spend from before the login was first read. */
  isTodayEstimate?: boolean
  /** The server says the limit has been reached. */
  isLimitReached?: boolean
  error?: string
}

/** A point on the 5-hour window's history. */
export type Sample = { at: number; percent: number; resetsAt?: number }

export type TurnCost = { text: string; startUsd: number; usd: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-statusbar': {
      snapshot: Snapshot | null
      spend: LocalSpend | null
      admin: AdminReading | null
      history: Sample[]
      turns: TurnCost[]
      alerts: string[]
    }
  }
}
