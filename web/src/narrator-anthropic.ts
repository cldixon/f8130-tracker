/**
 * A narrator backed by Claude Sonnet.
 *
 * The only file in the project that talks to a model. It lives in `web` rather
 * than in `core` so core stays pure and dependency-free — the same reason the
 * identity resolver and the repository client are ports there and
 * implementations here.
 *
 * The contract is narrow on purpose: `narrate` returns a validated `Narration`
 * or `null`, and never throws. Everything that can go wrong — no key, a
 * network failure, a rate limit, a refusal, a model that ignored the tool, a
 * model that wrote a real manufacturer's name — collapses to the same `null`,
 * and the caller falls back to the hand-written catalogue. There is one branch
 * to reason about instead of a dozen.
 */

import Anthropic from '@anthropic-ai/sdk'

import {
  NARRATION_SYSTEM,
  NARRATION_TOOL,
  narrationPrompt,
  validateNarration,
  type Narration,
  type NarrationBrief,
  type Narrator,
} from '@f8130/core'

/**
 * Sonnet, for the prose rather than for the reasoning.
 *
 * Three sentences of shop findings is not a hard task, and a smaller model
 * produces valid output — but the whole point of narrating rather than drawing
 * from a catalogue is range, and range is what the larger model has. The job
 * costs a fraction of a cent either way and the latency sits well inside the
 * gap between two feed events.
 *
 * No `thinking` and no `effort` here: this is a single constrained tool call,
 * and adaptive thinking would spend tokens deciding how to write two
 * sentences.
 */
const MODEL = 'claude-sonnet-5'

export type AnthropicNarratorOptions = {
  apiKey?: string
  /** Milliseconds before a call is abandoned and the catalogue takes over. */
  timeoutMs?: number
  onError?: (err: unknown) => void
}

export class AnthropicNarrator implements Narrator {
  private readonly client: Anthropic
  private readonly timeoutMs: number
  private readonly onError?: (err: unknown) => void

  /** Counts, for the health endpoint and for knowing whether this is working. */
  readonly stats = { asked: 0, narrated: 0, refused: 0, rejected: 0, failed: 0 }

  constructor(opts: AnthropicNarratorOptions = {}) {
    // A bare constructor resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or a
    // stored profile, in that order. Passing an explicit key is for callers
    // that hold one directly.
    // maxRetries: 0 is deliberate and was measured. The SDK retries timeouts
    // twice by default, which turns a bounded stall into three times the
    // bound — six calls with a four-second timeout took eighty seconds of
    // wall clock rather than the twenty-four the timeout implied. Retrying is
    // the wrong instinct on the publishing path of a feed when a perfectly
    // good fallback is one branch away.
    const config = { maxRetries: 0 }
    this.client = opts.apiKey
      ? new Anthropic({ ...config, apiKey: opts.apiKey })
      : new Anthropic(config)
    // Measured rather than guessed. Four seconds was too tight for Sonnet on
    // this prompt and nearly everything fell back; twelve leaves room without
    // holding a feed event open long enough to notice. With retries off this
    // is the true worst case, not a third of it.
    this.timeoutMs = opts.timeoutMs ?? 12_000
    this.onError = opts.onError
  }

  async narrate(brief: NarrationBrief): Promise<Narration | null> {
    this.stats.asked++
    try {
      const response = await this.client.messages.create(
        {
          model: MODEL,
          max_tokens: 1024,
          // The stable half first so it can be cached, the brief after it.
          system: NARRATION_SYSTEM,
          tools: [NARRATION_TOOL],
          // Forcing the tool removes the "model wrote a paragraph instead"
          // failure mode entirely, rather than parsing around it.
          tool_choice: { type: 'tool', name: NARRATION_TOOL.name },
          messages: [{ role: 'user', content: narrationPrompt(brief) }],
        },
        { timeout: this.timeoutMs },
      )

      // A safety decline is an ordinary outcome here, not an error: the
      // catalogue takes over and the feed carries on.
      if (response.stop_reason === 'refusal') {
        this.stats.refused++
        return null
      }

      const call = response.content.find((b) => b.type === 'tool_use')
      if (!call || call.type !== 'tool_use') {
        this.stats.rejected++
        return null
      }

      // `strict: true` already guaranteed the shape. This checks the content —
      // real names, stray identifiers, lengths the lexicon would refuse — and
      // is the gate that actually matters, because the API cannot know what a
      // real manufacturer is.
      const checked = validateNarration(call.input, brief)
      if (!checked.ok) {
        this.stats.rejected++
        this.onError?.(new Error(`narration rejected: ${checked.reason}`))
        return null
      }

      this.stats.narrated++
      return checked.narration
    } catch (err) {
      this.stats.failed++
      this.onError?.(describe(err))
      return null
    }
  }
}

/** Most specific first, so a 429 is distinguishable from a bad request. */
function describe(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('narrator: the API key was rejected')
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('narrator: rate limited')
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new Error('narrator: timed out')
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`narrator: API error ${err.status}: ${err.message}`)
  }
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Why there is no prefetch buffer here.
 *
 * The obvious way to keep a feed event from waiting on the network is to
 * generate forms ahead into a pool. It does not work, and the reason is worth
 * writing down so nobody adds one later.
 *
 * A narration is specific to its brief. Prose written for a manufacturer's
 * conformity certificate describes production acceptance; prose written for an
 * overhaul describes a defect found and corrected. A pool that hands a
 * NEW-manufacture narration to an OVERHAULED form produces precisely the
 * incoherence this module exists to prevent — a Block 12 that contradicts
 * Block 11 — and a pool keyed tightly enough to avoid that almost never hits,
 * because the brief space is org kind by status by component family.
 *
 * What actually bounds the wait is a short timeout plus the fallback: a slow
 * call is abandoned and the catalogue answers instead, so a tick is delayed by
 * at most `timeoutMs` and then publishes regardless. At a twelve-to-forty-five
 * second cadence that is invisible.
 *
 * Repeat briefs are still cheap — `memoize` in core caches by brief, and over
 * a long session the same combinations recur — which is the buffering that
 * does work.
 */
