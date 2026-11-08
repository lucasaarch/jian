import type { EmailSearch } from '../channels/email/log.js';
import type { EmailRequest, EmailSent, Errands } from './service.js';

/**
 * What the agent may do with the people its owner approved. The one way to a stranger is
 * `email`, and only after the owner read the first email of the exchange (`needsOwner`).
 */
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
  mailbox(profileId: string): Promise<{ channelId: string; address: string } | undefined>;
  /** Whether the owner decides an email to these addresses, `to` and every copy. */
  needsOwner(profileId: string, recipients: readonly string[]): Promise<boolean>;
  email(
    profileId: string,
    fromSessionId: string,
    runId: string,
    request: EmailRequest,
    requestKey: string,
  ): Promise<EmailSent>;
  expect(
    profileId: string,
    domain: string,
    reason: string,
  ): Promise<{ address: string; domain: string; expectedUntil: string; note: string }>;
  searchEmail(profileId: string, search: EmailSearch): ReturnType<Errands['searchEmail']>;
}
