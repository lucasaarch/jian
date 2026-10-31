import {
  API_DEFAULT_MODEL,
  type ModelSelection,
  type ProtectionMode,
  type ReasoningEffort,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { readModelDefaults } from '../providers/repository.js';
import type { SessionStart, SessionWriter } from '../sessions/port.js';
import type { Store } from '../storage/database.js';
import { ApiModels } from './api-models.js';
import type { IncomingMessage } from './channel.js';

/**
 * How every conversation of an API channel starts, and the most its caller may ask for. Nobody
 * is there to approve what an outside system's conversation does, so it starts on Auto; Full
 * would let a caller switch off the guardrail, which only the owner, in Jian, may do.
 */
export const API_SESSION_START: SessionStart = { protection: 'auto' };

const PROTECTION_RANK: Record<ProtectionMode, number> = { ask: 0, auto: 1, full: 2 };

/**
 * What one message asks of its conversation, resolved before the message is taken in so that a
 * refusal leaves nothing behind. Absent fields leave the conversation as it is.
 */
export type ConversationChange = {
  protection?: ProtectionMode;
  /** Null goes back to the gateway's Capabilities. */
  model?: ModelSelection | null;
  /** Asked for without a model: it applies to whichever model the conversation runs on. */
  effort?: ReasoningEffort;
};

const sameModel = (a: ModelSelection | null | undefined, b: ModelSelection | null | undefined) =>
  a?.providerId === b?.providerId &&
  a?.modelId === b?.modelId &&
  a?.reasoningEffort === b?.reasoningEffort;

/** A gateway built without model discovery knows no model by id. */
const NO_MODELS = new ApiModels(
  { providers: async () => [] },
  {
    list: async () => {
      throw new GatewayError(503, 'Model discovery is not configured');
    },
  },
);

/** What an API channel's caller may change about its conversation, and the change itself. */
export class ApiConversations {
  private models = NO_MODELS;

  constructor(
    private readonly services: {
      store: Store;
      sessions: Pick<SessionWriter, 'session' | 'setModel' | 'setProtection'>;
    },
    private readonly clock: Clock = Date.now,
  ) {}

  useModels(models: ApiModels): void {
    this.models = models;
  }

  available() {
    return this.models.available();
  }

  /** The model the gateway answers channels with when nothing else is chosen. */
  private async gatewayDefault(): Promise<ModelSelection | undefined> {
    const defaults = await readModelDefaults(this.services.store.db, nowIso(this.clock));

    return defaults.channel ?? defaults.conversation ?? undefined;
  }

  /** The gateway's default model at this effort. */
  private async defaultAt(effort: ReasoningEffort, missing: string): Promise<ModelSelection> {
    const base = await this.gatewayDefault();

    if (!base) throw new GatewayError(400, missing);

    return this.models.withEffort(base, effort);
  }

  /**
   * Refuses what a caller may not ask for: a protection above Auto, a model no provider lists,
   * an effort the model does not offer.
   */
  async change(
    request: Pick<IncomingMessage, 'protection' | 'model' | 'effort'>,
  ): Promise<ConversationChange | undefined> {
    const { protection, model, effort } = request;

    if (!protection && !model && !effort) return undefined;

    const ceiling = API_SESSION_START.protection;

    if (protection && PROTECTION_RANK[protection] > PROTECTION_RANK[ceiling]) {
      throw new GatewayError(403, `API channels allow protection up to ${ceiling}.`);
    }

    const change: ConversationChange = protection ? { protection } : {};

    if (model === API_DEFAULT_MODEL) {
      change.model = effort
        ? await this.defaultAt(effort, 'There is no default model to set a reasoning effort on')
        : null;
    } else if (model) {
      change.model = await this.models.select(model, effort);
    } else if (effort) {
      change.effort = effort;
    }

    return change;
  }

  /**
   * Written to the conversation before its turn is submitted, so that turn already runs on it,
   * and kept for the turns after it. Only what differs is written.
   */
  async apply(profileId: string, sessionId: string, change: ConversationChange): Promise<void> {
    const session = await this.services.sessions.session(profileId, sessionId);

    if (change.protection && change.protection !== session.protection) {
      await this.services.sessions.setProtection(profileId, sessionId, {
        protection: change.protection,
      });
    }

    let model = change.model;

    if (model === undefined && change.effort) {
      model = session.model
        ? await this.models.withEffort(session.model, change.effort)
        : await this.defaultAt(change.effort, 'Name a model to set a reasoning effort on');
    }

    if (model !== undefined && !sameModel(model, session.model)) {
      await this.services.sessions.setModel(profileId, sessionId, { model });
    }
  }
}
