import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SectionActions } from '../../components/props';
import type { GatewayApi, McpServer } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { McpCard } from './mcp-card';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const server = (name: string, url: string) =>
  ({
    name,
    transport: 'http',
    url,
    auth: 'none',
    headers: [],
    args: [],
    env: [],
    disabledTools: [],
  }) as McpServer;

const docs = server('atlas_docs', 'https://docs.example.test/mcp');
const tickets = server('harbor_tickets', 'https://tickets.example.test/mcp');

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) act(cleanup);
});

async function render() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const replaceMcpServers = vi.fn(async (servers: McpServer[]) => servers);
  const actions: SectionActions = {
    api: {
      replaceMcpServers,
      // Its settings ask a saved server what it offers as they open.
      checkMcpServer: async () => ({ reachable: true, tools: [] }),
    } as unknown as GatewayApi,
    mutate: async (action) => {
      await action();
      return true;
    },
    busy: false,
  };
  const client = agentClient({ profile });
  client.setQueryData(keys.mcpServers, [docs, tickets]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  await act(async () =>
    root.render(
      <AgentCache profile={profile} client={client}>
        <McpCard {...actions} />
      </AgentCache>,
    ),
  );
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
      (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
  const type = (input: HTMLInputElement | null | undefined, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return { replaceMcpServers, button, type };
}

it('removes a server only once its name is typed, saving the list without it', async () => {
  const view = await render();

  await act(async () => view.button('Configure atlas_docs')?.click());
  await act(async () => view.button('Remove')?.click());
  const confirm = view.button('Remove server') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);
  expect(view.replaceMcpServers).not.toHaveBeenCalled();

  const field = confirm?.closest('form')?.querySelector('input');
  await view.type(field, 'atlas_docs');
  await act(async () => confirm?.click());

  expect(view.replaceMcpServers).toHaveBeenCalledWith([tickets]);
});

it('adds a server to the end of the list the gateway keeps', async () => {
  const view = await render();

  await act(async () => view.button('Add server')?.click());
  const form = document.querySelector('[role="dialog"] form');
  const [name, url] = [...(form?.querySelectorAll('input') ?? [])];
  await view.type(name, 'lantern_notes');
  await view.type(url, 'https://notes.example.test/mcp');
  await act(async () => form?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());

  expect(view.replaceMcpServers).toHaveBeenCalledWith([
    docs,
    tickets,
    {
      name: 'lantern_notes',
      transport: 'http',
      auth: 'none',
      url: 'https://notes.example.test/mcp',
      headers: [],
      args: [],
      env: [],
    },
  ]);
});
