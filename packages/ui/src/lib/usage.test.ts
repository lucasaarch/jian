import type { PanelFeature, PanelUsage } from '@jian/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectGateway } from '../platform/gateway';
import { GatewayAnswer } from './api/result';
import { countUsage, flushUsage, setUsageReporting } from './usage';

const web = {
  origin: 'https://jian.example.test',
  headers: {},
  credentials: 'same-origin' as const,
};

/** What the gateway was handed. */
function gateway(answer: () => Promise<unknown> = async () => undefined) {
  const sent: PanelUsage[] = [];
  const send = vi.fn(async (usage: PanelUsage) => {
    sent.push(structuredClone(usage));
    return answer();
  });
  return { sent, send };
}

const atWidth = (phone: boolean) =>
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: phone } as MediaQueryList);

beforeEach(() => {
  connectGateway(web);
  // Nothing left from another test.
  setUsageReporting(false);
  setUsageReporting(undefined);
});

afterEach(() => vi.restoreAllMocks());

it('hands over what was counted since the last report, by host and width, once', async () => {
  const { sent, send } = gateway();
  setUsageReporting(true);
  countUsage('artifacts_page');
  countUsage('artifacts_page');
  countUsage('message_sent');
  atWidth(true);
  countUsage('chat');

  await flushUsage(send);
  await flushUsage(send);

  expect(sent).toEqual([
    { host: 'web', phone: false, counts: { artifacts_page: 2, message_sent: 1 } },
    { host: 'web', phone: true, counts: { chat: 1 } },
  ]);

  connectGateway({ ...web, host: 'desktop' });
  atWidth(false);
  countUsage('command_run');
  await flushUsage(send);
  expect(sent.at(-1)).toEqual({ host: 'desktop', phone: false, counts: { command_run: 1 } });
});

it('keeps counts while the gateway has not said, and counts nothing once it says off', async () => {
  const { sent, send } = gateway();
  countUsage('panel_opened');
  await flushUsage(send);
  expect(send).not.toHaveBeenCalled();

  setUsageReporting(false);
  countUsage('chat');
  setUsageReporting(true);
  countUsage('new_chat');
  await flushUsage(send);

  expect(sent).toEqual([{ host: 'web', phone: false, counts: { new_chat: 1 } }]);
});

it('counts again what never reached the gateway, and drops what it refused', async () => {
  let answer: () => Promise<unknown> = async () => {
    throw new TypeError('Failed to fetch');
  };
  const { sent, send } = gateway(() => answer());
  setUsageReporting(true);
  countUsage('model_changed');
  await flushUsage(send);
  countUsage('model_changed');

  answer = async () => {
    throw new GatewayAnswer('Invalid request', 400);
  };
  await flushUsage(send);
  answer = async () => undefined;
  await flushUsage(send);

  expect(sent.map((usage) => usage.counts)).toEqual([{ model_changed: 1 }, { model_changed: 2 }]);
});

it('leaves out a key the vocabulary does not have', async () => {
  const { sent, send } = gateway();
  setUsageReporting(true);
  countUsage('Acme launch plan' as PanelFeature);
  countUsage('artifact_hand_edit_sheet');
  await flushUsage(send);

  expect(sent).toEqual([{ host: 'web', phone: false, counts: { artifact_hand_edit_sheet: 1 } }]);
});
