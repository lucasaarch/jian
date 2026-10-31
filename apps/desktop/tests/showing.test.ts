import { expect, it } from 'vitest';
import { showingFrom } from '../src/main/showing';

it('keeps the agent of a new chat, which has no chat to say it yet', () => {
  expect(showingFrom({ gatewayId: 'local', profileId: 'atlas' })).toEqual({
    gatewayId: 'local',
    profileId: 'atlas',
  });
});

it('keeps an open chat and the agent beside it', () => {
  const chat = { profileId: 'atlas', sessionId: 'one' };
  expect(showingFrom({ gatewayId: 'local', chat, profileId: 'atlas' })).toEqual({
    gatewayId: 'local',
    chat,
    profileId: 'atlas',
  });
});

it('takes nothing beyond the shape it knows', () => {
  expect(showingFrom(null)).toBeNull();
  expect(showingFrom({ chat: {} })).toBeNull();
  expect(
    showingFrom({ gatewayId: 'local', chat: { profileId: 1 }, profileId: 2, other: 3 }),
  ).toEqual({ gatewayId: 'local' });
});
