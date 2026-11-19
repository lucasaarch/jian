import { z } from 'zod';

/**
 * Names a command already has, which a secret of the same name would replace: what the gateway
 * hands every command (its `PATH`, `HOME`, locale, install paths, the owner's SSH agent, the Git
 * settings `github_git` relies on), what changes how a shell or a program starts, and Jian's own.
 * A field named `PATH` would hand the owner's key to whatever program the agent names first.
 */
const RESERVED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'HOSTNAME',
  'TMPDIR',
  'PWD',
  'OLDPWD',
  'IFS',
  'ENV',
  'BASH_ENV',
  'SHLVL',
  'GOPATH',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NPM_CONFIG_PREFIX',
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND',
]);
const RESERVED_PREFIXES = ['JIAN_', 'LC_', 'GIT_CONFIG_', 'LD_', 'DYLD_'];

/** Whether a secret field may not take this name, as one the command already has. */
export function reservedSecretEnvName(name: string): boolean {
  return RESERVED.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * An environment variable's name, as a command reads it: `ASSEMBLYAI_API_KEY`. Capitals, so a
 * name is never mistaken for a word of the command, and short enough to read on a card.
 */
export const secretEnvNameSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{1,63}$/,
    'Use capitals, digits and underscores, starting with a letter, such as ASSEMBLYAI_API_KEY',
  )
  .refine(
    (name) => !reservedSecretEnvName(name),
    'A command already has a variable of that name, or it is one of Jian’s own',
  );

/**
 * A sensitive value, as the service issued it. At least 8 characters: every output of every run is
 * searched for it and masked, and a shorter one would mask ordinary words. A NUL cannot be in an
 * environment variable.
 */
const sensitiveValue = z
  .string()
  .min(8, 'A secret has at least 8 characters')
  .max(8192)
  .refine((value) => !value.includes('\0'), 'A secret cannot contain a NUL character')
  .refine((value) => value.trim() === value, 'Remove the spaces or line breaks around it');

/** A value that is not masked in output, so it may be short: a username, a region, an account id. */
const plainValue = z
  .string()
  .min(1, 'Give a value')
  .max(8192)
  .refine((value) => !value.includes('\0'), 'A value cannot contain a NUL character')
  .refine((value) => value.trim() === value, 'Remove the spaces or line breaks around it');

/**
 * Tool output shows a masked secret as `[REDACTED]`. A model that copies it back would overwrite
 * the real value with the mask, so it is refused wherever a value is written.
 */
const notMasked = (value: string | undefined) => !value?.includes('[REDACTED]');
const MASKED = 'That value was masked before you saw it; it cannot be saved';

/**
 * An address a secret may be used on. Only the origin is kept: a path or a query says nothing about
 * who is trusted with the value, and credentials in the URL would be stored in the clear.
 */
export const secretSiteSchema = z
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an https address, such as https://app.example.com')
  .transform((value) => new URL(value).origin);

const label = z.string().trim().min(1).max(60);
const description = z.string().trim().max(300);

export const secretFieldInputSchema = z
  .strictObject({
    label,
    envName: secretEnvNameSchema,
    sensitive: z.boolean(),
    /** Left out on an update, the field keeps the value it has. */
    value: z.string().optional(),
  })
  .superRefine((field, ctx) => {
    if (field.value === undefined) return;
    const rules = field.sensitive ? sensitiveValue : plainValue;
    const parsed = rules.safeParse(field.value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: issue.message });
      }
    } else if (!notMasked(field.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: MASKED });
    }
  });

/** One variable of a secret. A sensitive field's value is never returned: it is null. */
export const secretFieldSchema = z.strictObject({
  label: z.string(),
  envName: z.string(),
  sensitive: z.boolean(),
  value: z.string().nullable(),
});

/** An agent that may use a secret, and who said so. */
export const secretGrantSchema = z.strictObject({
  profileId: z.uuid(),
  grantedByProfileId: z.uuid().nullable(),
  grantedAt: z.iso.datetime(),
});

/**
 * A credential the owner keeps for agents' commands: one or more fields, each an environment
 * variable. A sensitive value is never part of it: no route returns it, and an agent only learns
 * its label and name.
 */
export const secretSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  /** Origins where it may be used, such as https://app.example.com. */
  sites: z.array(z.string()),
  fields: z.array(secretFieldSchema),
  /** The agents whose commands may receive it. */
  profileIds: z.array(z.uuid()),
  grants: z.array(secretGrantSchema),
  createdByProfileId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  /** When its fields or who may use it last changed. */
  updatedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

const title = z.string().trim().min(1).max(80);

/** Two fields with one name would leave a command with only the last of them. */
function duplicateEnvName(fields: { envName: string }[] | undefined): string | undefined {
  const seen = new Set<string>();
  for (const { envName } of fields ?? []) {
    if (seen.has(envName)) return envName;
    seen.add(envName);
  }
  return undefined;
}

function uniqueEnvNames(
  input: { fields?: { envName: string }[] | undefined },
  ctx: z.RefinementCtx,
) {
  const envName = duplicateEnvName(input.fields);
  if (envName) {
    ctx.addIssue({
      code: 'custom',
      path: ['fields'],
      message: `Two fields cannot both be ${envName}`,
    });
  }
}

/** Made from one agent's settings, which may use it whatever `profileIds` says. */
export const secretCreateSchema = z
  .strictObject({
    title,
    description: description.optional(),
    sites: z.array(secretSiteSchema).max(20).optional(),
    fields: z
      .array(
        secretFieldInputSchema.refine((field) => field.value !== undefined, {
          path: ['value'],
          message: 'Give a value',
        }),
      )
      .min(1)
      .max(20),
    /** Other agents that may use it too. */
    profileIds: z.array(z.uuid()).max(100).optional(),
  })
  .superRefine(uniqueEnvNames);

/** What changes; what is left out stays. Fields replace the list; one without a value keeps its own. */
export const secretUpdateSchema = z
  .strictObject({
    title: title.optional(),
    description: description.nullable().optional(),
    sites: z.array(secretSiteSchema).max(20).optional(),
    fields: z.array(secretFieldInputSchema).min(1).max(20).optional(),
    /** Every agent that may use it, replacing the list; at least one. */
    profileIds: z.array(z.uuid()).min(1).max(100).optional(),
  })
  .superRefine(uniqueEnvNames)
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    'Nothing to change',
  );

export const secretParamsSchema = z.strictObject({
  profileId: z.uuid(),
  secretId: z.uuid(),
});

export type Secret = z.infer<typeof secretSchema>;
export type SecretCreate = z.infer<typeof secretCreateSchema>;
export type SecretUpdate = z.infer<typeof secretUpdateSchema>;
export type SecretField = z.infer<typeof secretFieldSchema>;
export type SecretFieldInput = z.infer<typeof secretFieldInputSchema>;
