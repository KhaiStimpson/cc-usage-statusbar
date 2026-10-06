import { describe, expect, test } from 'claude-code/testing'

import { afterImport, dayKey, startLedger, summarize } from '../hooks/ledger'
import { DAY } from '../hooks/model'
import { mergeImported, priceOf, replyUsd, TranscriptTally } from '../hooks/transcripts'

const NOW = new Date(2026, 9, 14, 15, 0, 0).getTime()
const close = (a: number | undefined, b: number) => expect(Math.abs((a ?? NaN) - b) < 1e-9).toBe(true)

/** One transcript line for a reply, as Claude Code writes it. */
function reply(id: string, at: number, usage: Record<string, unknown>, model = 'claude-sonnet-5-5') {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    requestId: `req_${id}`,
    message: { id: `msg_${id}`, model, usage },
  })
}

describe('pricing', () => {
  test('model ids from every provider find their price', () => {
    expect(priceOf('claude-opus-4-8')?.input).toBe(5)
    expect(priceOf('claude-opus-4-8[1m]')?.input).toBe(5)
    expect(priceOf('us.anthropic.claude-sonnet-4-5-20250929-v1:0')?.input).toBe(3)
    expect(priceOf('claude-opus-4-1@20250805')?.input).toBe(15)
    expect(priceOf('claude-opus-4-20250514')?.input).toBe(15)
    expect(priceOf('claude-opus-5-5')?.input).toBe(4)
    expect(priceOf('gpt-4')).toBeUndefined()
  })

  test('a reply costs its input, cache writes by lifetime, cache reads and output', () => {
    // Sonnet 5.5: $2 in, $10 out; 5m writes 1.25x, 1h writes 2x, reads 0.1x.
    close(
      replyUsd('claude-sonnet-5-5', {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 3_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 2_000_000 },
        cache_read_input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
      2 + 2.5 + 8 + 0.2 + 10,
    )
  })

  test('older transcripts count every cache write as five minutes', () => {
    close(replyUsd('claude-haiku-4-5', { cache_creation_input_tokens: 1_000_000 }), 1.25)
  })

  test('Opus 5.5 reads its cache at 0.05x and runs fast mode at double', () => {
    close(replyUsd('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 }), 0.2)
    close(replyUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000, speed: 'fast' }), 48)
  })

  test('US-only routing costs 1.1x and web searches a cent each', () => {
    close(replyUsd('claude-sonnet-5-5', { input_tokens: 1_000_000, inference_geo: 'us', server_tool_use: { web_search_requests: 3 } }), 2.2 + 0.03)
  })
})

describe('transcript tally', () => {
  test('a reply written once per content block counts once', () => {
    const tally = new TranscriptTally(dayKey, 0, NOW)
    const line = reply('a', NOW - 1000, { output_tokens: 100_000 })
    tally.addText(`${line}\n${line}\n${line}\n`)
    close(tally.days[dayKey(NOW)], 1)
    expect(tally.replies).toBe(1)
  })

  test('replies copied into a forked transcript count once', () => {
    const tally = new TranscriptTally(dayKey, 0, NOW)
    const line = reply('a', NOW - 1000, { output_tokens: 100_000 })
    tally.addText(`${line}\n`)
    tally.addText(`${line}\n${reply('b', NOW - 500, { output_tokens: 100_000 })}\n`)
    close(tally.days[dayKey(NOW)], 2)
  })

  test('replies are put on their own day, and none from the import time on', () => {
    const tally = new TranscriptTally(dayKey, 0, NOW)
    tally.addText(
      [
        reply('a', NOW - DAY, { output_tokens: 100_000 }),
        reply('b', NOW + 1000, { output_tokens: 100_000 }),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        'not json',
        '',
      ].join('\n'),
    )
    expect(tally.days).toEqual({ [dayKey(NOW - DAY)]: 1 })
  })

  test('a line split across pieces is joined before it is read', () => {
    const tally = new TranscriptTally(dayKey, 0, NOW)
    const line = reply('a', NOW - 1000, { output_tokens: 100_000 })
    let tail = tally.addText(line.slice(0, 40))
    tail = tally.addText(tail + line.slice(40))
    tally.add(tail)
    close(tally.days[dayKey(NOW)], 1)
  })

  test('a model with no known price is named, not guessed', () => {
    const tally = new TranscriptTally(dayKey, 0, NOW)
    tally.addText(`${reply('a', NOW - 1000, { output_tokens: 1 }, 'mystery-model')}\n`)
    expect([...tally.unpriced]).toEqual(['mystery-model'])
    expect(tally.days).toEqual({})
  })
})

describe('import and ledgers', () => {
  const today = dayKey(NOW)

  test('a later read keeps days whose transcripts were deleted since', () => {
    const merged = mergeImported(
      { at: 1, days: { '2026-09-01': 5, [today]: 1 }, replies: 2, files: 1, unpriced: [] },
      { at: 2, days: { [today]: 3 }, replies: 1, files: 1, unpriced: [] },
      '2026-08-01',
    )
    expect(merged.days).toEqual({ '2026-09-01': 5, [today]: 3 })
  })

  test('ledgers from before the import give way to it; ones after add to it', () => {
    const at = NOW - 1000
    const stale = { last: 30, days: { [today]: 20 }, touched: today }
    const fresh = startLedger(4, today, at)
    fresh.days[today] = 1.5
    const spend = summarize([stale, fresh], 'monthly', NOW, { at, days: { [today]: 4 } })
    expect(spend.todayUsd).toBe(5.5)
  })

  test('catching up with an import empties the days but keeps the running total', () => {
    const ledger = afterImport({ last: 30, days: { [today]: 20 }, touched: today }, NOW)
    expect(ledger).toEqual({ last: 30, days: {}, touched: today, since: NOW })
  })
})
