import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, McpServer } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { AgentCache, agentClient } from '../../test/agent';
import { profile } from '../../test/fixtures';
import { CustomConnector, McpEditor } from './custom-connector';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const api = vi.hoisted(() => ({
  replaceMcpServers: vi.fn(async (servers: unknown[]) => servers),
  // Its line asks a saved server what it offers as it opens.
  checkMcpServer: vi.fn(async () => ({ reachable: true, tools: [] })),
}));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: api as unknown as GatewayApi,
    mutate: async (run: () => Promise<unknown>) => {
      await run();
      return true;
    },
    busy: false,
  }),
}));

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
// One of Jian's own connectors: saved with the rest, in its place among them.
const linear = { ...server('linear', 'https://mcp.linear.app/mcp'), auth: 'oauth' } as McpServer;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) act(cleanup);
  api.replaceMcpServers.mockClear();
});

function Adding() {
  const [open, setOpen] = useState(true);
  return <McpEditor editing="new" open={open} onOpenChange={setOpen} />;
}

async function render(of: McpServer | 'new') {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const close = vi.fn();
  const client = agentClient({ profile });
  client.setQueryData(keys.mcpServers, [docs, linear, tickets]);
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
        {of === 'new' ? <Adding /> : <CustomConnector server={of} close={close} />}
      </AgentCache>,
    ),
  );
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLElement>('button')].find(
      (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
  const type = (input: HTMLInputElement | null | undefined, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const submit = () =>
    act(async () =>
      document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')?.click(),
    );
  return { close, button, type, submit };
}

it('removes a server only once its name is typed, saving the list without it', async () => {
  const view = await render(docs);

  await act(async () => view.button('Configure atlas_docs')?.click());
  await act(async () => view.button('Remove')?.click());
  const confirm = view.button('Remove server') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);
  expect(api.replaceMcpServers).not.toHaveBeenCalled();
  expect(view.close).not.toHaveBeenCalled();

  const field = confirm?.closest('[role="dialog"]')?.querySelector('input');
  await view.type(field, 'atlas_docs');
  await act(async () => confirm?.click());

  expect(api.replaceMcpServers).toHaveBeenCalledWith([linear, tickets]);
  // Its row is gone with it: what it was opened from closes too.
  expect(view.close).toHaveBeenCalled();
});

it("keeps one of Jian's own beside it in its place when a custom server is removed", async () => {
  const view = await render(tickets);

  await act(async () => view.button('Configure harbor_tickets')?.click());
  await act(async () => view.button('Remove')?.click());
  const confirm = view.button('Remove server') as HTMLButtonElement | undefined;
  await view.type(confirm?.closest('[role="dialog"]')?.querySelector('input'), 'harbor_tickets');
  await act(async () => confirm?.click());

  expect(api.replaceMcpServers).toHaveBeenCalledWith([docs, linear]);
});

it('saves a changed server in its own place in the list', async () => {
  const view = await render(tickets);

  await act(async () => view.button('Configure harbor_tickets')?.click());
  const form = document.querySelector('[role="dialog"] form');
  const [, url] = [...(form?.querySelectorAll('input') ?? [])];
  await view.type(url, 'https://desk.example.test/mcp');
  await view.submit();

  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    docs,
    linear,
    expect.objectContaining({ name: 'harbor_tickets', url: 'https://desk.example.test/mcp' }),
  ]);
  expect(view.close).toHaveBeenCalled();
});

it('adds a server to the end of the list the gateway keeps', async () => {
  const view = await render('new');

  const form = document.querySelector('[role="dialog"] form');
  const [name, url] = [...(form?.querySelectorAll('input') ?? [])];
  await view.type(name, 'lantern_notes');
  await view.type(url, 'https://notes.example.test/mcp');
  await view.submit();

  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    docs,
    linear,
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
