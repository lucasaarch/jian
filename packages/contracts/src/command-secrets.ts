import { z } from 'zod';

/**
 * Names a command already has, which a secret of the same name would replace: what the gateway
 * hands every command (its `PATH`, `HOME`, locale, install paths, the owner's SSH agent, the Git
 * settings `github_git` relies on), what changes how a shell or a program starts, and Jian's own.
 * A secret named `PATH` would hand the owner's key to whatever program the agent names first.
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

/** Whether a command secret may not take this name, as one the command already has. */
export function reservedCommandSecretName(name: string): boolean {
  return RESERVED.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * An environment variable's name, as a command reads it: `ASSEMBLYAI_API_KEY`. Capitals, so a
 * name is never mistaken for a word of the command, and short enough to read on a card.
 */
export const commandSecretNameSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{1,63}$/,
    'Use capitals, digits and underscores, starting with a letter, such as ASSEMBLYAI_API_KEY',
  )
  .refine(
    (name) => !reservedCommandSecretName(name),
    'A command already has a variable of that name, or it is one of Jian’s own',
  );

/**
 * The value, as the service issued it. At least 8 characters: every output of every run is
 * searched for it and masked, and a shorter one would mask ordinary words. A NUL cannot be in an
 * environment variable.
 */
export const commandSecretValueSchema = z
  .string()
  .min(8, 'A secret has at least 8 characters')
  .max(8192)
  .refine((value) => !value.includes('\0'), 'A secret cannot contain a NUL character')
  .refine((value) => value.trim() === value, 'Remove the spaces or line breaks around it');

const description = z.string().trim().max(300);

/**
 * A secret the owner keeps for agents' commands. Its value is never part of it: no route returns
 * it, and an agent only ever learns its name and description.
 */
export const commandSecretSchema = z.strictObject({
  name: z.string(),
  description: z.string().nullable(),
  /** The agents whose commands may receive it. */
  profileIds: z.array(z.uuid()),
  createdAt: z.iso.datetime(),
  /** When its value or who may use it last changed. */
  updatedAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

/** Made from one agent's settings, which may use it whatever `profileIds` says. */
export const commandSecretCreateSchema = z.strictObject({
  name: commandSecretNameSchema,
  value: commandSecretValueSchema,
  description: description.optional(),
  /** Other agents that may use it too. */
  profileIds: z.array(z.uuid()).max(100).optional(),
});

/** What changes; what is left out stays. A value given replaces the one kept. */
export const commandSecretUpdateSchema = z
  .strictObject({
    value: commandSecretValueSchema.optional(),
    description: description.nullable().optional(),
    /** Every agent that may use it, replacing the list; at least one. */
    profileIds: z.array(z.uuid()).min(1).max(100).optional(),
  })
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    'Nothing to change',
  );

export const commandSecretParamsSchema = z.strictObject({
  profileId: z.uuid(),
  name: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
});

export type CommandSecret = z.infer<typeof commandSecretSchema>;
export type CommandSecretCreate = z.infer<typeof commandSecretCreateSchema>;
export type CommandSecretUpdate = z.infer<typeof commandSecretUpdateSchema>;
