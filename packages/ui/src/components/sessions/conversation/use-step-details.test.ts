import { expect, it } from 'vitest';
import type { Message, ToolStep } from '../../../lib/api';
import { stepPlace } from './use-step-details';

const here = { profileId: 'profile', sessionId: 'session' };

it('reads a turn’s tools where they were called: here, or where the other agent answered', () => {
  const call = { profileId: 'other', sessionId: 'there', runId: 'call-run' };
  const state = {
    callTools: new Map([['call-run', [{ toolCallId: 'a' } as ToolStep]]]),
    messages: [{ id: 'm', role: 'assistant', call } as unknown as Message],
  };

  expect(stepPlace(state, 'run', here)).toEqual(here);
  expect(stepPlace(state, 'call-run', here)).toEqual({ profileId: 'other', sessionId: 'there' });
});
