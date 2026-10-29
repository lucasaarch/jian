import { githubInstallInputSchema } from '@jian/contracts';
import { expect, it } from 'vitest';

// The gateway redirects the owner to `${origin}${returnPath}` after GitHub, so the path is the
// one part of that address a request controls. It must stay a page of the panel.
const agent = '5c52c291-4620-4829-aa8b-6adf08d8c833';
const accepts = (returnPath: string) => githubInstallInputSchema.safeParse({ returnPath }).success;

it('sends the owner back to the agent the connection started from', () => {
  expect(accepts(`/agents/${agent}/integrations`)).toBe(true);
  expect(accepts(`/agents/${agent}/integrations/github`)).toBe(true);
});

it('never lets the return path leave the panel', () => {
  expect(accepts('//attacker.example/agents')).toBe(false);
  expect(accepts(`/agents/${agent}/integrations@attacker.example`)).toBe(false);
  expect(accepts(`/agents/${agent}/integrations/../../v1/profiles`)).toBe(false);
  expect(accepts(`/agents/${agent}/integrations?next=https://attacker.example`)).toBe(false);
  expect(accepts('/agents/not-an-id/integrations')).toBe(false);
  expect(accepts('/integrations')).toBe(false);
});
