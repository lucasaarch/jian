import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AgentCache } from '@/test/agent';
import { profile } from '@/test/fixtures';
import type { BuiltinSkill, GatewayApi, Mutation } from '../../lib/api';
import { BuiltinSkills } from './built-in';

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const skill = (name: string, description: string, enabled = true) =>
  ({ name, description, instructions: `# ${name}`, enabled }) as BuiltinSkill;

it('finds a built-in skill by what it says, accents aside, and switches it off', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const updateProfile = vi.fn(async () => profile);
  const api = {
    builtinSkills: async () => [
      skill('schedules', 'Do something later, once or on a repetition.'),
      skill('web-research', 'Search the web and read public pages, citing each résumé.'),
      skill('ssh-keys', 'Keys for Git over SSH, shared by every agent.'),
    ],
    updateProfile,
  } as unknown as GatewayApi;
  const mutate: Mutation = async (action) => {
    await action();
    return true;
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const names = () =>
    [...element.querySelectorAll('.skill-card h3')].map((title) => title.textContent);

  try {
    await act(async () =>
      root.render(
        <AgentCache profile={profile}>
          <BuiltinSkills profile={profile} api={api} mutate={mutate} busy={false} />
        </AgentCache>,
      ),
    );
    await settle();
    expect(names()).toEqual(['schedules', 'web-research', 'ssh-keys']);

    const search = element.querySelector<HTMLInputElement>('[aria-label="Search built-in skills"]');
    await act(async () => {
      if (!search) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        search,
        'RESUME web',
      );
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(names()).toEqual(['web-research']);

    await act(async () => element.querySelector<HTMLButtonElement>('[role="switch"]')?.click());
    expect(updateProfile).toHaveBeenCalledWith(profile.id, {
      expectedVersion: profile.version,
      disabledSkills: [...profile.disabledSkills, 'web-research'],
    });
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
