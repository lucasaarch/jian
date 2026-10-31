import { expect, it, vi } from 'vitest';
import { browserAnswer } from '../src/main/machines/browser-answer';

const profileId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const params = { operation: 'act' as const, profileId, sessionId, input: { action: 'read' } };
const acted = {
  url: 'https://example.com/',
  title: 'Example',
  viewport: { width: 800, height: 600 },
  visible: true,
  screenshot: Buffer.from('picture'),
};
const browser = () => ({
  act: vi.fn(async (..._args: unknown[]) => acted),
  inspect: vi.fn(),
});

it('acts for the conversation on screen, in that gateway’s own logins', async () => {
  const open = browser();

  const answer = await browserAnswer(open as never, 'server', params, () => ({
    gatewayId: 'server',
    sessionId,
  }));

  expect(open.act).toHaveBeenCalledWith(
    { gatewayId: 'server', profileId, sessionId },
    params.input,
    expect.any(AbortSignal),
  );
  expect(answer.acted).toMatchObject({
    url: 'https://example.com/',
    screenshot: Buffer.from('picture').toString('base64'),
  });
});

for (const [why, showing] of [
  ['nothing is on screen', null],
  ['another conversation is', { gatewayId: 'server', sessionId: 'another' }],
  ['a new chat is', { gatewayId: 'server' }],
  ['the same chat of another gateway is', { gatewayId: 'other', sessionId }],
] as const) {
  it(`refuses before doing anything while ${why}`, async () => {
    const open = browser();

    await expect(browserAnswer(open as never, 'server', params, () => showing, 0)).resolves.toEqual(
      {
        notShowing: true,
      },
    );
    expect(open.act).not.toHaveBeenCalled();
  });
}

it('says what went wrong in the browser, for the agent to read', async () => {
  const open = browser();
  open.act.mockRejectedValueOnce(new Error('The page is out of reach'));

  await expect(
    browserAnswer(open as never, 'server', params, () => ({ gatewayId: 'server', sessionId })),
  ).resolves.toEqual({ error: 'The page is out of reach' });
});

it('waits for a new chat the window is about to open, instead of refusing its first action', async () => {
  const open = browser();
  let looks = 0;

  const answer = await browserAnswer(open as never, 'server', params, () =>
    ++looks < 3 ? { gatewayId: 'server' } : { gatewayId: 'server', sessionId },
  );

  expect(answer.acted).toBeDefined();
  expect(open.act).toHaveBeenCalledOnce();
});

it('only says whether it is watching when asked to check, touching nothing', async () => {
  const open = browser();
  const check = { ...params, operation: 'check' as const };

  await expect(
    browserAnswer(open as never, 'server', check, () => ({ gatewayId: 'server', sessionId })),
  ).resolves.toEqual({});
  await expect(browserAnswer(open as never, 'server', check, () => null, 0)).resolves.toEqual({
    notShowing: true,
  });
  expect(open.act).not.toHaveBeenCalled();
  expect(open.inspect).not.toHaveBeenCalled();
});
