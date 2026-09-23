import type { DecisionsStatus } from '@jian/contracts';
import { decisionsInputSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { gatewaySecrets } from '../storage/schema.js';

/** Where the installation's Jev key lives in the gateway vault. */
const SECRET = 'decisions:jev';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
/** Jev answers in 70–500 ms. Past this the fixed rule answers instead of the caller waiting. */
const DEFAULT_TIMEOUT_MS = 3000;
/** A question is about a message or an action, never a whole transcript. */
const MAX_STATE_CHARS = 12_000;

const answerSchema = z.object({
  answers: z.record(z.string(), z.object({ noul: z.number().min(0).max(1).optional() })),
});

/** A yes-or-no question: the probability, from 0 to 1, that the answer is yes. */
export type Ask = (
  question: { state: Record<string, unknown>; instructions: string; yes: string; no: string },
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<number | undefined>;

/**
 * The gateway's questions to Jev. Every answer is advice: `undefined` — no key, a refused key,
 * an outage, a slow answer — means the caller decides by its own rule, so a missing or broken
 * service changes nothing that worked without it. What is sent is the one message or action
 * being judged; the service keeps no conversation.
 */
export class Decisions {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly fetcher: typeof fetch,
    private readonly report: (line: string) => void = (line) => console.warn(line),
  ) {}

  async status(): Promise<DecisionsStatus> {
    const [row] = await this.store.db
      .select({ updatedAt: gatewaySecrets.updatedAt })
      .from(gatewaySecrets)
      .where(eq(gatewaySecrets.name, SECRET))
      .limit(1);

    return {
      provider: 'jev',
      configured: row !== undefined,
      ...(row ? { updatedAt: row.updatedAt.toISOString() } : {}),
    };
  }

  async configure(input: unknown): Promise<DecisionsStatus> {
    const { apiKey } = decisionsInputSchema.parse(input);

    await this.vault.put(SECRET, apiKey.trim());

    return this.status();
  }

  async remove(): Promise<DecisionsStatus> {
    await this.vault.discard(SECRET);

    return this.status();
  }

  ask: Ask = async ({ state, instructions, yes, no }, options = {}) => {
    try {
      const key = await this.vault.read(SECRET);

      if (!key) {
        return undefined;
      }

      const response = await this.fetcher(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          state: JSON.stringify(state).slice(0, MAX_STATE_CHARS),
          questions: { answer: { type: 'noul', instructions, criteria: { true: yes, false: no } } },
        }),
        signal: AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ]),
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // The body may echo the question; only the status is logged.
        this.report(`jian: Jev answered ${response.status}; the fixed rule decided instead`);

        return undefined;
      }

      return answerSchema.parse(await response.json()).answers.answer?.noul;
    } catch (error) {
      this.report(
        `jian: Jev did not answer (${error instanceof Error ? error.name : 'error'}); the fixed rule decided instead`,
      );

      return undefined;
    }
  };
}
