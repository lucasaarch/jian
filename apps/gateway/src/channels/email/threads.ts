import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../../storage/database.js';
import { emailThreads } from '../../storage/schema.js';
import { type EmailThread, envelope, referencesOf } from './text.js';

/** As far as a message id may go into a field the gateway keeps for it. */
export const ID_CHARS = 200;

/** The thread a reply to this person continues, when either side has written in one. */
export async function findEmailThread(
  db: Queryable,
  channelId: string,
  chatId: string,
): Promise<EmailThread | undefined> {
  const [row] = await db
    .select({
      subject: emailThreads.subject,
      messageId: emailThreads.messageId,
      references: emailThreads.references,
    })
    .from(emailThreads)
    .where(and(eq(emailThreads.channelId, channelId), eq(emailThreads.chatId, chatId)))
    .limit(1);
  return row;
}

export async function saveEmailThread(
  db: Queryable,
  channelId: string,
  chatId: string,
  thread: EmailThread,
) {
  const values = { channelId, chatId, ...thread, updatedAt: new Date() };
  await db
    .insert(emailThreads)
    .values(values)
    .onConflictDoUpdate({
      target: [emailThreads.channelId, emailThreads.chatId],
      set: {
        subject: values.subject,
        messageId: values.messageId,
        references: values.references,
        updatedAt: values.updatedAt,
      },
    });
}

/**
 * After an email went out, it is the latest message of its thread: the next one to this person
 * answers it, so a second email sent before they reply stays in the same conversation instead of
 * opening a thread named after its first line. Without the `Message-ID` the provider read back,
 * the thread stays as it was.
 */
export async function keepSentThread(
  db: Queryable,
  channelId: string,
  chatId: string,
  text: string,
  remoteMessageIds: ReadonlyArray<string | number>,
) {
  const messageId = remoteMessageIds.find(
    (id): id is string =>
      typeof id === 'string' && /^<[^<>\s]+>$/.test(id) && id.length <= ID_CHARS,
  );
  if (!messageId) return;
  const previous = await findEmailThread(db, channelId, chatId);
  const mail = envelope(text, previous);
  await saveEmailThread(db, channelId, chatId, {
    subject: mail.subject,
    messageId,
    references: referencesOf(mail.inReplyTo ? previous?.references : undefined, messageId),
  });
}
