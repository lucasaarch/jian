import { secretEnvNameSchema, secretFieldInputSchema, secretSiteSchema } from '@jian/contracts';
import type { NewSecret, Profile, Secret, SecretPatch } from '../../lib/api';
import { date } from '../../lib/format';

/** One field as it is typed. `value` is empty for a sensitive one the gateway already holds. */
export type FieldDraft = { label: string; envName: string; sensitive: boolean; value: string };

export type SecretDraft = {
  title: string;
  description: string;
  fields: FieldDraft[];
  /** One origin per row, as typed; an empty row is left out. */
  sites: string[];
  /** Agents other than the one whose settings these are. */
  others: string[];
};

/** What is wrong with each part of a field, in the gateway's own words. */
export type FieldProblems = { envName?: string; value?: string };

/** The most a Secret holds of each, as the gateway allows. */
export const MAX_FIELDS = 20;
export const MAX_SITES = 20;

/** A new field is sensitive: most of what is kept here is a key or a password. */
export const blankField = (): FieldDraft => ({
  label: '',
  envName: '',
  sensitive: true,
  value: '',
});

/** As a command reads it: capitals, with an underscore wherever a space or a dash was typed. */
export const envNameOf = (typed: string) => typed.toUpperCase().replace(/[\s-]/g, '_');

/** The Secret as it is, ready to edit: a plain value shows, a sensitive one starts empty. */
export function draftOf(secret: Secret | undefined, profileId: string): SecretDraft {
  return {
    title: secret?.title ?? '',
    description: secret?.description ?? '',
    fields: secret?.fields.map((field) => ({
      label: field.label,
      envName: field.envName,
      sensitive: field.sensitive,
      value: field.value ?? '',
    })) ?? [blankField()],
    sites: secret?.sites ?? [],
    others: secret?.profileIds.filter((id) => id !== profileId) ?? [],
  };
}

/**
 * Whether a field left empty keeps a value: the gateway keeps the stored value of the field with
 * the same variable. Only a sensitive one may be left empty; a plain value shows, so an empty one
 * was cleared, and a field made plain needs its value typed again.
 */
export function keepsValue(field: FieldDraft, editing: Secret | undefined): boolean {
  return (
    field.sensitive && Boolean(editing?.fields.some((stored) => stored.envName === field.envName))
  );
}

/** Problems with what is typed, said only once something is: an empty form is not wrong yet. */
export function fieldProblems(fields: FieldDraft[]): FieldProblems[] {
  return fields.map((field, index) => {
    const problems: FieldProblems = {};
    if (field.envName) {
      const named = secretEnvNameSchema.safeParse(field.envName);
      if (!named.success) problems.envName = named.error.issues[0]?.message;
      else if (fields.slice(0, index).some((other) => other.envName === field.envName)) {
        problems.envName = `Two fields cannot both be ${field.envName}`;
      }
    }
    if (field.value) {
      const checked = secretFieldInputSchema.safeParse({
        label: field.label || 'Field',
        envName: 'FIELD',
        sensitive: field.sensitive,
        value: field.value,
      });
      const issue = checked.error?.issues.find((item) => item.path[0] === 'value');
      if (issue) problems.value = issue.message;
    }
    return problems;
  });
}

/** Each row's origin, or why the gateway would refuse it. An empty row is neither. */
export function siteChecks(sites: string[]): { origin?: string; problem?: string }[] {
  return sites.map((site) => {
    const typed = site.trim();
    if (!typed) return {};
    const parsed = secretSiteSchema.safeParse(typed);
    return parsed.success
      ? { origin: parsed.data }
      : { problem: parsed.error.issues.at(-1)?.message ?? 'Use an https address' };
  });
}

/** Whether the gateway would take it: every field named and valued, nothing refused. */
export function ready(draft: SecretDraft, editing: Secret | undefined): boolean {
  const fieldsFine = draft.fields.every(
    (field) => field.label.trim() && field.envName && (field.value || keepsValue(field, editing)),
  );
  return (
    Boolean(draft.title.trim()) &&
    draft.fields.length > 0 &&
    fieldsFine &&
    fieldProblems(draft.fields).every((problems) => !problems.envName && !problems.value) &&
    siteChecks(draft.sites).every((check) => !check.problem)
  );
}

const originsOf = (sites: string[]) => [
  ...new Set(siteChecks(sites).flatMap((check) => (check.origin ? [check.origin] : []))),
];

/** What creates it, from the agent whose settings these are, which may always use it. */
export function newSecretOf(draft: SecretDraft): NewSecret {
  const description = draft.description.trim();
  const sites = originsOf(draft.sites);
  return {
    title: draft.title.trim(),
    ...(description ? { description } : {}),
    ...(sites.length ? { sites } : {}),
    fields: draft.fields.map((field) => ({
      label: field.label.trim(),
      envName: field.envName,
      sensitive: field.sensitive,
      value: field.value,
    })),
    ...(draft.others.length ? { profileIds: draft.others } : {}),
  };
}

/** The whole Secret again; a sensitive field left empty is sent without a value, and keeps it. */
export function patchOf(draft: SecretDraft, editing: Secret, profileId: string): SecretPatch {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    sites: originsOf(draft.sites),
    fields: draft.fields.map((field) => {
      const kept = {
        label: field.label.trim(),
        envName: field.envName,
        sensitive: field.sensitive,
      };
      return !field.value && keepsValue(field, editing) ? kept : { ...kept, value: field.value };
    }),
    profileIds: [profileId, ...draft.others],
  };
}

/**
 * Which agent handed it to which, as each grant records: "Shared with Atlas by Vega · date".
 * The owner's choices are in the field above, and an agent holding what it made is no share.
 */
export function sharesOf(secret: Secret | undefined, agents: Profile[]): string[] {
  const name = (id: string | null) => agents.find((agent) => agent.id === id)?.name;
  return (secret?.grants ?? []).flatMap((grant) => {
    const to = name(grant.profileId);
    const by = name(grant.grantedByProfileId);
    if (!to || !by || grant.profileId === grant.grantedByProfileId) return [];
    return [`Shared with ${to} by ${by} · ${date(grant.grantedAt)}`];
  });
}
