/**
 * How many of the provider's tokens each token of the gateway's own estimate turns out to be.
 * Only OpenAI models have a real tokenizer here; every other provider is counted at one token
 * per UTF-8 byte. That put Claude's prompts at about 2.4 times what Anthropic reported, so a
 * conversation was compacted at well under half its threshold, mostly for nothing, and each try
 * read the whole prompt again uncached. Every size decision multiplies the estimate by this.
 */

/**
 * Below this a reading is not of the prompt that was sent. Byte counting gives no provider much
 * under a fifth, but a provider that leaves cached input out of `inputTokens` (a local server
 * reusing its cache) reports a sliver of it, and trusting that would let the prompt overflow.
 */
const FLOOR = 0.2;

/** Above this one odd reading would make the window look full; held, not trusted outright. */
const CEILING = 1.5;

/**
 * Before anything was measured. Claude's tokenizer reads more than two bytes into each token: the
 * run that showed the over-count measured 0.41 on step one. A half stays on the safe side of
 * that, so the first step of a conversation can only be counted too large, never too small.
 */
export function defaultScale(provider: string): number {
  return provider === 'anthropic' ? 0.5 : 1;
}

/**
 * The scale one step measured: the input the provider reported for it against what the gateway
 * estimated that same prompt at. Undefined when either is missing, zero or not a reading of
 * this prompt.
 */
export function measuredScale(
  reported: number | undefined,
  estimated: number | undefined,
): number | undefined {
  if (!reported || !estimated || reported < 0 || estimated < 0) return undefined;
  const scale = reported / estimated;
  if (!Number.isFinite(scale) || scale < FLOOR) return undefined;
  return Math.min(scale, CEILING);
}
