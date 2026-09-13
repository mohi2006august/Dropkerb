/**
 * Token counting for the cost model.
 *
 * Tokens are measured with the Messages API's count_tokens endpoint when credentials are
 * available. That endpoint is free and exact for the model in question, and it is the
 * only way to get a real number - a local tokenizer such as tiktoken is a different
 * tokenizer and would silently disagree.
 *
 * With no credentials the spike does NOT pretend to have measured tokens. It records
 * `source: 'estimated'`, and every figure derived from it is labelled an estimate in the
 * report. Bytes stay an exact measurement either way, which is why the two findings that
 * matter - the clustering saving and the cache saving - are ratios over bytes and need
 * no tokenizer at all.
 */

export type TokenSource = 'count_tokens' | 'estimated';

/**
 * Chars per token for dense JSON, used only when count_tokens is unavailable.
 *
 * This is a placeholder, not a measurement: JSON with many short keys and punctuation
 * tokenizes worse than prose. It is deliberately on the optimistic side of the usual
 * 3-4 range so the resulting cost is a floor rather than a flattering midpoint - a cost
 * spike that under-reports is worse than one that over-reports.
 */
const CHARS_PER_TOKEN = 3.5;

export interface Counter {
  source: TokenSource;
  model: string;
  count: (text: string) => Promise<number>;
}

/**
 * Builds a counter. Tries the SDK; falls back to estimation. The SDK is imported
 * dynamically so the spike still runs in a checkout where it was never installed.
 */
export async function makeCounter(model: string): Promise<Counter> {
  const hasCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (hasCredentials) {
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic();
      return {
        source: 'count_tokens',
        model,
        count: async (text: string) => {
          const res = await client.messages.countTokens({
            model,
            messages: [{ role: 'user', content: text }],
          });
          return res.input_tokens;
        },
      };
    } catch {
      // An SDK that is absent or a client that will not construct is not a reason to
      // fail the spike; it is a reason to say the numbers are estimates.
    }
  }
  return {
    source: 'estimated',
    model,
    count: async (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN),
  };
}

export interface Model {
  id: string;
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
  contextTokens: number;
}

/** Input-side dollars. Output is modelled separately: it does not scale with page size. */
export function inputCost(tokens: number, model: Model): number {
  return (tokens / 1_000_000) * model.inputPerMTok;
}

/**
 * Cost of one run over `pages` pages where `cachedTokens` of every request is a shared
 * prefix. The first request writes the cache at a premium, the rest read it at a tenth.
 */
export function cachedRunCost(
  pages: number,
  cachedTokens: number,
  perPageTokens: number,
  model: Model,
  cacheWriteMultiplier: number,
  cacheReadMultiplier: number,
): number {
  if (pages <= 0) return 0;
  const rate = model.inputPerMTok / 1_000_000;
  const write = cachedTokens * rate * cacheWriteMultiplier;
  const reads = cachedTokens * rate * cacheReadMultiplier * (pages - 1);
  const variable = perPageTokens * rate * pages;
  return write + reads + variable;
}

export function uncachedRunCost(pages: number, cachedTokens: number, perPageTokens: number, model: Model): number {
  return inputCost((cachedTokens + perPageTokens) * pages, model);
}
