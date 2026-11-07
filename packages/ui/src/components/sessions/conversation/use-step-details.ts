'use client';

import { useMemo, useRef } from 'react';
import type { GatewayApi } from '../../../lib/api';
import { readOnce, type StepDetails } from '../step-details';
import type { ConversationState, ConversationStore } from './store';

type Place = { profileId: string; sessionId: string };

/**
 * Where a tool of this conversation was called: here, or, for the other agent's turn that
 * answered a question this profile carried, in that agent's session, where its timeline was read.
 */
export function stepPlace(
  state: Pick<ConversationState, 'tools' | 'callTools' | 'messages'>,
  toolCallId: string,
  here: Place,
): Place {
  const has = (steps: { toolCallId: string }[]) =>
    steps.some((step) => step.toolCallId === toolCallId);
  if ([...state.tools.values()].some(has)) return here;
  for (const [runId, steps] of state.callTools) {
    if (!has(steps)) continue;
    const call = state.messages.find((message) => message.call?.runId === runId)?.call;
    if (call) return { profileId: call.profileId, sessionId: call.sessionId };
  }
  return here;
}

/**
 * The whole steps of this conversation's tools, read once each, for the Thought Line's tools a
 * brief timeline cut. None without `toolStep`: each tool then shows what its step has.
 */
export function useStepDetails(
  api: Partial<Pick<GatewayApi, 'toolStep'>>,
  profileId: string,
  sessionId: string,
  store: ConversationStore,
): StepDetails | undefined {
  // The client may be built again on any render; what was read stays with the conversation.
  const read = useRef(api.toolStep);
  read.current = api.toolStep;
  const readable = Boolean(api.toolStep);

  return useMemo(() => {
    if (!readable) return undefined;
    return readOnce((toolCallId) => {
      const place = stepPlace(store.getState(), toolCallId, { profileId, sessionId });
      const toolStep = read.current;
      if (!toolStep) return Promise.reject(new Error('Tool steps cannot be read here.'));
      return toolStep(place.profileId, place.sessionId, toolCallId);
    });
  }, [readable, profileId, sessionId, store]);
}
