'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { GatewayApi } from '../../../lib/api';
import { readOnce, type StepDetails } from '../step-details';
import type { ConversationState, ConversationStore } from './store';

type Place = { profileId: string; sessionId: string };

/**
 * Where a turn's tools were called: here, or, for the other agent's turn that answered a
 * question this profile carried, in that agent's session, where its timeline was read.
 */
export function stepPlace(
  state: Pick<ConversationState, 'callTools' | 'messages'>,
  runId: string,
  here: Place,
): Place {
  if (!state.callTools.has(runId)) return here;
  const call = state.messages.find((message) => message.call?.runId === runId)?.call;
  return call ? { profileId: call.profileId, sessionId: call.sessionId } : here;
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
  useEffect(() => {
    read.current = api.toolStep;
  }, [api.toolStep]);
  const readable = Boolean(api.toolStep);

  return useMemo(() => {
    if (!readable) return undefined;
    return readOnce((runId, toolCallId) => {
      const place = stepPlace(store.getState(), runId, { profileId, sessionId });
      const toolStep = read.current;
      if (!toolStep) return Promise.reject(new Error('Tool steps cannot be read here.'));
      return toolStep(place.profileId, place.sessionId, runId, toolCallId);
    });
  }, [readable, profileId, sessionId, store]);
}
