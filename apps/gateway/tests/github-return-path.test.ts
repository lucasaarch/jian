import { githubInstallInputSchema } from '@jian/contracts';
import { expect, it } from 'vitest';

// The gateway redirects the owner to `${origin}${returnPath}` after GitHub, so the path is the
// one part of that address a request controls. It must stay a page of the panel.
const accepts = (returnPath: string) => githubInstallInputSchema.safeParse({ returnPath }).success;

it('sends the owner back to the Integrations page the connection started from', () => {
  expect(accepts('/settings/integrations')).toBe(true);
  expect(accepts('/settings/integrations/github')).toBe(true);
});

it('never lets the return path leave the panel', () => {
  expect(accepts('//attacker.example/settings/integrations')).toBe(false);
  expect(accepts('/settings/integrations@attacker.example')).toBe(false);
  expect(accepts('/settings/integrations/../../v1/profiles')).toBe(false);
  expect(accepts('/settings/integrations?next=https://attacker.example')).toBe(false);
  expect(accepts('/agents/5c52c291-4620-4829-aa8b-6adf08d8c833/integrations')).toBe(false);
  expect(accepts('/integrations')).toBe(false);
});
