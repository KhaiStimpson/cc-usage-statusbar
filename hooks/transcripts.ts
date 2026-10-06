/**
 * Spend read back from Claude Code's transcripts (`<config>/projects/**.jsonl`), for the days before the live
 * ledgers counted. Transcripts keep token counts, not dollars, so each reply is priced here at list prices.
 */

/** Dollars per million tokens, and the cache-read share of the input price. */
type Price = { input: number; output: number; readShare: number; fastInput?: number; fastOutput?: number }

const OPUS_4_5: Price = { input: 5, output: 25, readShare: 0.1 }
const OPUS_FAST: Price = { ...OPUS_4_5, fastInput: 10, fastOutput: 50 }
const OPUS_4: Price = { input: 15, output: 75, readShare: 0.1 }
const SONNET_5: Price = { input: 2, output: 10, readShare: 0.1 }
const SONNET_4: Price = { input: 3, output: 15, readShare: 0.1 }
const FABLE_5: Price = { input: 10, output: 50, readShare: 0.1 }

/** Longest names first, so `claude-opus-4-8` is never read as `claude-opus-4`. */
const PRICES: [string, Price][] = [
  ['claude-fable-5-1', { input: 10, output: 50, readShare: 0.025 }],
  ['claude-mythos-5-1', { input: 10, output: 50, readShare: 0.025 }],
  ['claude-fable-5', FABLE_5],
  ['claude-mythos-5', FABLE_5],
  ['claude-opus-5-5', { input: 4, output: 20, readShare: 0.05, fastInput: 8, fastOutput: 40 }],
  ['claude-opus-5', OPUS_FAST],
  ['claude-opus-4-8', OPUS_FAST],
  ['claude-opus-4-7', OPUS_4_5],
  ['claude-opus-4-6', OPUS_4_5],
  ['claude-opus-4-5', OPUS_4_5],
  ['claude-opus-4-1', OPUS_4],
  ['claude-opus-4', OPUS_4],
  ['claude-sonnet-5-5', SONNET_5],
  ['claude-sonnet-5', SONNET_5],
  ['claude-sonnet-4-6', SONNET_4],
  ['claude-sonnet-4-5', SONNET_4],
  ['claude-sonnet-4', SONNET_4],
  ['claude-3-7-sonnet', SONNET_4],
  ['claude-3-5-sonnet', SONNET_4],
  ['claude-haiku-4-5', { input: 1, output: 5, readShare: 0.1 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4, readShare: 0.1 }],
]

const WEB_SEARCH_USD = 0.01

/** A model id as Bedrock, Vertex or a `[1m]` suffix spell it, down to the API's own name. */
function normalModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[.*?\]$/, '')
    .replace(/^(?:[a-z]+\.)*anthropic\./, '')
    .replace(/[@:].*$/, '')
    .replace(/-v\d+$/, '')
}

export function priceOf(model: string): Price | undefined {
  const name = normalModel(model)

  return PRICES.find(([key]) => name === key || name.startsWith(`${key}-`))?.[1]
}

/** The `usage` of one reply as transcripts record it. */
export type ReplyUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
  server_tool_use?: { web_search_requests?: number }
  speed?: string
  inference_geo?: string
}

/** What one reply cost at list prices, or undefined for a model with no known price. */
export function replyUsd(model: string, usage: ReplyUsage): number | undefined {
  const price = priceOf(model)
  if (!price) return undefined
  const isFast = usage.speed === 'fast' && price.fastInput !== undefined
  const input = isFast ? price.fastInput! : price.input
  const output = isFast ? price.fastOutput! : price.output
  const written = usage.cache_creation_input_tokens ?? 0
  // Older transcripts give writes as one figure, which was the 5-minute cache.
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const fiveMinutes = usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : written
  const perMillion =
    (usage.input_tokens ?? 0) * input +
    fiveMinutes * input * 1.25 +
    hour * input * 2 +
    (usage.cache_read_input_tokens ?? 0) * input * price.readShare +
    (usage.output_tokens ?? 0) * output
  const geo = usage.inference_geo === 'us' ? 1.1 : 1

  return (perMillion / 1_000_000) * geo + (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
}

/**
 * Adds transcript lines up by day. A reply is written once per content block, and a resumed or forked session
 * copies the replies before it, so each is counted once by its message and request id.
 */
export class TranscriptTally {
  readonly days: Record<string, number> = {}
  readonly unpriced = new Set<string>()
  replies = 0
  private readonly seen = new Set<string>()

  /** `dayOf` maps a reply's time to its day; replies at or after `before`, or before `from`, are left out. */
  constructor(
    private readonly dayOf: (ms: number) => string,
    private readonly from: number,
    private readonly before: number,
  ) {}

  add(line: string): void {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) return
    let entry: {
      type?: string
      timestamp?: string
      requestId?: string
      uuid?: string
      isApiErrorMessage?: boolean
      message?: { id?: string; model?: string; usage?: ReplyUsage }
    }
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    const message = entry.message
    if (entry.type !== 'assistant' || entry.isApiErrorMessage || !message?.usage || !message.model) return
    if (message.model === '<synthetic>') return
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN
    if (Number.isNaN(at) || at < this.from || at >= this.before) return
    const key = `${message.id ?? entry.uuid}:${entry.requestId ?? ''}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const usd = replyUsd(message.model, message.usage)
    if (usd === undefined) {
      this.unpriced.add(message.model)
      return
    }
    this.replies += 1
    const day = this.dayOf(at)
    this.days[day] = (this.days[day] ?? 0) + usd
  }

  /** Feeds text that may end mid-line; returns the unfinished tail to prepend to the next piece. */
  addText(text: string): string {
    const lines = text.split('\n')
    const tail = lines.pop() ?? ''
    for (const line of lines) this.add(line)

    return tail
  }
}

/** Spend before `at`, read from the transcripts, kept in the store under `import`. */
export type ImportedSpend = {
  at: number
  days: Record<string, number>
  replies: number
  files: number
  unpriced: string[]
}

export function isImported(value: unknown): value is ImportedSpend {
  const v = value as ImportedSpend | null
  return typeof v === 'object' && v !== null && typeof v.at === 'number' && typeof v.days === 'object'
}

/**
 * A fresh read laid over the last one: a day takes the larger figure, since Claude Code deletes old transcripts
 * and a later read can only have lost replies, never gained wrong ones. Days before `keepFrom` are dropped.
 */
export function mergeImported(
  previous: ImportedSpend | undefined,
  next: ImportedSpend,
  keepFrom: string,
): ImportedSpend {
  const days: Record<string, number> = {}
  for (const [day, usd] of [...Object.entries(previous?.days ?? {}), ...Object.entries(next.days)]) {
    if (day >= keepFrom) days[day] = Math.max(days[day] ?? 0, usd)
  }

  return { ...next, days }
}
