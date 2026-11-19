import { type ToolSet, tool } from 'ai';
import { ZodError, z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { SecretActor, Secrets } from '../secrets/service.js';

/**
 * The agent's own hand on the installation's Secrets: list the ones it may use, save one the
 * owner gave it in conversation, delete one it made, and let another agent use one.
 *
 * None of them is an action that asks (`ACTION_KINDS`): a Secret only reaches a command through
 * `run_command`, which asks where the conversation does. So they are offered only where someone
 * could approve that command (see the runtime): a contact who may not approve would otherwise
 * have the agent keep, or hand on, whatever they send it.
 *
 * Every call acts as this run's agent, never as anyone the input names: an agent changes or
 * deletes only what it made, and the agents it names on a save are not its to choose.
 */

type SecretService = Pick<Secrets, 'usable' | 'create' | 'update' | 'remove' | 'share'>;

/**
 * Only the shape: the rules for a value are the service's, which says what is wrong in words
 * and without the value. A call the SDK refuses is answered with the whole input quoted, and is
 * stored that way, before anything here could have it masked.
 */
const fieldInput = z.object({
  label: z.string().describe('What the value is, such as "API key" or "Username".'),
  envName: z
    .string()
    .describe(
      'The environment variable a command reads it from: capitals, digits and underscores, such as ACME_API_KEY.',
    ),
  sensitive: z
    .boolean()
    .describe(
      'True for a password, key or token: masked everywhere and never shown again. False for a username, region or account id.',
    ),
  value: z
    .string()
    .optional()
    .describe('The value. Leave it out when changing a Secret to keep the value it has.'),
});

const saveInput = z.object({
  secretId: z
    .uuid()
    .optional()
    .describe('A Secret you made, to change it. Leave it out to save a new one.'),
  title: z.string().describe('What it is for, such as "Acme API".'),
  description: z.string().optional(),
  sites: z
    .array(z.string())
    .optional()
    .describe('The https addresses it may be used on, such as https://app.example.com.'),
  fields: z
    .array(fieldInput)
    .describe('Every variable of the Secret. On a change, they replace the ones it has.'),
});
type SaveInput = z.infer<typeof saveInput>;

/** The sensitive values a save carries, which the run masks before the call is recorded. */
const sensitiveValues = (input: unknown): string[] => {
  const fields = (input as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.flatMap((field) => {
    const { sensitive, value } = (field ?? {}) as { sensitive?: unknown; value?: unknown };
    return sensitive === true && typeof value === 'string' && value ? [value] : [];
  });
};

/**
 * The values a call carries that the run must mask before it records anything of the call: its
 * protection, its card and its start on the timeline all come after this is read.
 */
export const secretsIn = (definition: unknown, input: unknown): string[] =>
  (definition as { secretsIn?: (input: unknown) => string[] }).secretsIn?.(input) ?? [];

/** The service's refusal, in its words: the value's rules never quote the value. */
function said(error: unknown): unknown {
  if (!(error instanceof ZodError)) return error;
  return new GatewayError(
    400,
    error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ` : '') + issue.message)
      .join('; '),
  );
}

const told = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw said(error);
  }
};

export function secretTools({
  secrets,
  profileId,
  lend,
}: {
  secrets: SecretService;
  profileId: string;
  /** Masks a value in everything this run records and returns from here on. */
  lend: (value: string) => void;
}): ToolSet {
  const actor: SecretActor = { kind: 'agent', profileId };

  const tools: ToolSet = {
    list_secrets: tool({
      description:
        'List the Secrets your commands may use: each one’s id, title, sites and variables. A sensitive value is never shown; a plain one, such as a username, is.',
      inputSchema: z.object({}),
      execute: async () => secrets.usable(profileId),
    }),

    save_secret: tool({
      description:
        'Save a password, API key or login the owner gave you as a Secret, so your commands get it through run_command’s `secrets` instead of its text. Mark every password, key and token sensitive: it is masked in everything you see and is never shown again. Never save a value that came back as [REDACTED]. With `secretId`, change a Secret you made; one the owner or another agent made is theirs. Only you may use what you save, until you share it.',
      inputSchema: saveInput,
      execute: async (input: SaveInput) => {
        // Before the service sees it: a refusal may still carry the value back up.
        for (const value of sensitiveValues(input)) lend(value);
        const { secretId, ...asked } = input;
        return told(() =>
          secretId
            ? secrets.update(profileId, secretId, asked, actor)
            : secrets.create(profileId, asked, actor),
        );
      },
    }),

    delete_secret: tool({
      description:
        'Delete a Secret you made, with every value of it, for every agent that uses it. One the owner or another agent made is not yours to delete.',
      inputSchema: z.object({ secretId: z.uuid() }),
      execute: async ({ secretId }) => told(() => secrets.remove(profileId, secretId, actor)),
    }),

    share_secret: tool({
      description:
        'Let another agent of this installation use a Secret you may use; find its id with list_agents. It is recorded that you shared it. Share one only when the owner asked for it.',
      inputSchema: z.object({ secretId: z.uuid(), agentId: z.uuid() }),
      execute: async ({ secretId, agentId }) =>
        told(() => secrets.share(profileId, secretId, agentId)),
    }),
  };
  // Read by the runtime before anything of the call is recorded (`secretsIn`).
  Object.assign(tools.save_secret as object, { secretsIn: sensitiveValues });
  return tools;
}
