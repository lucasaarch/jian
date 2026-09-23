/** What the agent may do with the people its owner approved. Nothing here reaches a stranger. */
export interface Outreach {
  reachable(
    profileId: string,
  ): Promise<Array<{ id: string; name: string; channel: string; waitingOnThem: boolean }>>;
  ask(
    profileId: string,
    contactId: string,
    fromSessionId: string,
    runId: string,
    text: string,
    expectReply: boolean,
  ): Promise<{ to: string; errandId?: string }>;
  /** Undefined when the session is not a channel conversation. */
  write(
    profileId: string,
    sessionId: string,
    runId: string,
    text: string,
    requestKey: string,
  ): Promise<{ to: string; channel: string; sessionId: string } | undefined>;
}
