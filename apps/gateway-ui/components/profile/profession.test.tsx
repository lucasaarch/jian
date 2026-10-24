import type { EffectiveProfession } from '@jian/contracts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Profile } from '../../lib/api';
import { ProfessionDescriptor, ProfileProfession } from './profession';

const legacy: EffectiveProfession = {
  status: 'legacy_unclassified',
  assignable: true,
  scope: 'configuration',
  profession: null,
  ceilingCapabilities: null,
  configurationEffectiveCapabilities: null,
};
const classified: EffectiveProfession = {
  status: 'classified',
  assignable: false,
  scope: 'configuration',
  profession: { id: 'developer', label: 'Developer', policyVersion: 2 },
  ceilingCapabilities: ['workspace.files', 'web.browse'],
  configurationEffectiveCapabilities: ['workspace.files'],
};

let root: Root;
function setup() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  return element;
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

it('honestly describes legacy behavior without treating null lists as all or none', async () => {
  const element = setup();
  await act(async () => root.render(<ProfessionDescriptor descriptor={legacy} />));
  expect(element.textContent).toContain('Legacy / unclassified');
  expect(element.textContent).toContain('work is held until you choose one');
  expect(element.textContent).toContain('does not delete profile data');
  expect(element.textContent).toContain('Assignment required');
  expect(element.querySelector('details, button, input')).toBeNull();
});

it('distinguishes configuration from authorization and keeps raw capabilities in a disclosure', async () => {
  const element = setup();
  await act(async () => root.render(<ProfessionDescriptor descriptor={classified} />));
  expect(element.textContent).toContain('Developer');
  expect(element.textContent).toContain('Policy version 2');
  expect(element.textContent).toContain('not authorization to run or access a resource');
  expect(element.textContent).toContain('Immutable assignment');
  expect(element.querySelector('details')?.open).toBe(false);
  expect(element.querySelector('summary')?.textContent).toBe('Configuration capability details');
  expect(Array.from(element.querySelectorAll('ul')).map((list) => list.textContent)).toEqual([
    'workspace.filesweb.browse',
    'workspace.files',
  ]);
  expect(element.querySelector('button, input')).toBeNull();
});

it('describes an empty effective list as configuration, not missing legacy data', async () => {
  const element = setup();
  await act(async () =>
    root.render(
      <ProfessionDescriptor
        descriptor={{ ...classified, configurationEffectiveCapabilities: [] }}
      />,
    ),
  );
  expect(element.textContent).toContain('None in this configuration.');
  expect(element.textContent).not.toContain('Legacy / unclassified');
});

it('discards a late response from the previous profile and refreshes on version changes', async () => {
  const element = setup();
  let resolveFirst: (descriptor: EffectiveProfession) => void = () => {};
  const profileProfession = vi
    .fn<GatewayApi['profileProfession']>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValue(legacy);
  const api = { profileProfession } as unknown as GatewayApi;
  const profile = { id: 'first', version: 1 } as Profile;

  await act(async () => root.render(<ProfileProfession profile={profile} api={api} />));
  expect(element.querySelector('[role="status"]')?.textContent).toContain('Loading');
  await act(async () =>
    root.render(<ProfileProfession profile={{ ...profile, id: 'second' }} api={api} />),
  );
  await act(async () => resolveFirst(classified));
  expect(element.textContent).toContain('Legacy / unclassified');
  expect(element.textContent).not.toContain('Developer');

  await act(async () =>
    root.render(<ProfileProfession profile={{ ...profile, id: 'second', version: 2 }} api={api} />),
  );
  expect(profileProfession.mock.calls).toEqual([['first'], ['second'], ['second']]);
});
