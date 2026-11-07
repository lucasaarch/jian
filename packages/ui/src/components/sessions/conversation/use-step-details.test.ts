import { expect, it } from 'vitest';
import type { Message, ToolStep } from '../../../lib/api';
import { stepPlace } from './use-step-details';

const step = (toolCallId: string) => ({ toolCallId }) as ToolStep;
const here = { profileId: 'profile', sessionId: 'session' };

it('reads a tool where it was called: here, or where the other agent answered', () => {
  const call = { profileId: 'other', sessionId: 'there', runId: 'call-run' };
  const state = {
    tools: new Map([['run', [step('mine')]]]),
    callTools: new Map([['call-run', [step('theirs')]]]),
    messages: [{ id: 'm', role: 'assistant', call } as unknown as Message],
  };

  expect(stepPlace(state, 'mine', here)).toEqual(here);
  expect(stepPlace(state, 'theirs', here)).toEqual({ profileId: 'other', sessionId: 'there' });
  expect(stepPlace(state, 'unknown', here)).toEqual(here);
});
