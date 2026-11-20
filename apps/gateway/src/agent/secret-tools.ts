import { jsonSchema, type ToolSet, tool } from 'ai';
import { ZodError, z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { SecretActor, Secrets } from '../secrets/service.js';

/**
 * The agent's own hand on the installation's Secrets: list the ones it may use, save a value it
 * already has, delete one it made, and let another agent use one.
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

/** The shape the model is shown; checked in `execute`, after the values are masked. */
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

/**
 * What the SDK checks a call against: anything. A call it refuses is answered, and stored, with
 * its whole input quoted in the error, before `execute` or the runtime could mask a value in it.
 * So every call reaches `execute`, which masks first and checks the shape after.
 */
const anySaveInput = jsonSchema<unknown>(
  // As the SDK would convert it, so the model is shown the same shape.
  z.toJSONSchema(saveInput, { target: 'draft-7', io: 'input' }) as Parameters<typeof jsonSchema>[0],
  {
    validate: (value) => ({ success: true, value }),
  },
);

/**
 * A `"value": "…"` of a call's input that is not even JSON, as it was written: closed or not,
 * since a call cut off mid-value still carries the value, and cut after a backslash too.
 */
const WRITTEN_VALUE = /"value"\s*:\s*"((?:[^"\\]|\\.)*)\\?(?:"|$)/g;

const writtenValues = (text: string): string[] =>
  [...text.matchAll(WRITTEN_VALUE)].flatMap(([, written]) => {
    try {
      return [JSON.parse(`"${written}"`) as string];
    } catch {
      return written ? [written] : [];
    }
  });

/**
 * Every value a save carries that may be sensitive, which the run masks before the call is
 * recorded. Fail-safe: every string under a `value` key, at any depth, is kept out unless its
 * sibling `sensitive` is `false` in so many words, so a call of the wrong shape (`"true"`, no flag
 * at all, fields where they do not belong) is masked too. A string may be JSON in turn (`fields`
 * written as a string), and input that is not JSON at all has its values read from its text.
 */
const sensitiveValues = (input: unknown): string[] => {
  if (typeof input === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return writtenValues(input);
    }
    // A string parsed from a string is shorter than it, so this ends.
    return sensitiveValues(parsed);
  }
  if (Array.isArray(input)) return input.flatMap(sensitiveValues);
  if (!input || typeof input !== 'object') return [];
  const { sensitive, value, ...rest } = input as Record<string, unknown>;
  const own =
    typeof value === 'string'
      ? sensitive !== false && value
        ? [value]
        : []
      : sensitiveValues(value);
  return [...own, ...Object.values(rest).flatMap(sensitiveValues)];
};

/**
 * The values a call carries that the run must mask before it records anything of the call: its
 * protection, its card and its start on the timeline all come after this is read.
 */
export const secretsIn = (definition: unknown, input: unknown): string[] =>
  // No definition at all for a call to a tool the run does not have.
  (definition as { secretsIn?: (input: unknown) => string[] } | undefined)?.secretsIn?.(input) ??
  [];

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
        'Save a password, API key or login you already have as a Secret, such as one the owner typed to you or a key you just made on a site, so your commands get it through run_command’s `secrets` instead of its text. Mark every password, key and token sensitive: it is masked in everything you see and is never shown again. Never save a value that came back as [REDACTED]. With `secretId`, change a Secret you made; one the owner or another agent made is theirs. Only you may use what you save, until you share it.',
      inputSchema: anySaveInput,
      execute: async (input: unknown) => {
        // Before anything checks it: a refusal may still carry the value back up.
        for (const value of sensitiveValues(input)) lend(value);
        const checked = saveInput.safeParse(input);
        if (!checked.success) throw said(checked.error);
        const { secretId, ...asked } = checked.data;
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
        'Let another agent of this installation use a Secret you may use; find its id with list_agents. It is recorded that you shared it, and the owner is not asked. Share one when another agent asks you for it for a job the owner gave it, and never pass on one it does not need.',
      inputSchema: z.object({ secretId: z.uuid(), agentId: z.uuid() }),
      execute: async ({ secretId, agentId }) =>
        told(() => secrets.share(profileId, secretId, agentId)),
    }),
  };
  // Read by the runtime before anything of the call is recorded (`secretsIn`).
  Object.assign(tools.save_secret as object, { secretsIn: sensitiveValues });
  return tools;
}
