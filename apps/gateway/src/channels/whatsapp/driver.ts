import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  jidDecode,
  makeWASocket,
  normalizeMessageContent,
  proto,
  type SignalDataTypeMap,
  type WAMessage,
  type WASocket,
} from 'baileys';
import { MAX_DEVICE_SESSION_BYTES } from './connections.js';
import { readWhatsAppContent } from './media.js';
import { quietLibsignal } from './quiet.js';
import type { DeviceFactory } from './types.js';
import { DEVICE_SEND_TIMEOUT_MS } from './types.js';

/** Signal rotates keys in bursts; one grouped write per burst instead of one per key. */
const SESSION_WRITE_DELAY_MS = 1000;

/** A thumbnail is a few kilobytes; anything much larger is not what was asked for. */
const MAX_AVATAR_BYTES = 120_000;

/** Keeps a fresh QR inside the 45 s window the panel publishes; the library defaults to 60 s. */
const QR_REFRESH_MS = 30_000;

const CONTACT_JID = /^\d+@(c\.us|lid)$/;

/** A room is addressed by the group's own JID; its participants keep their personal ones. */
const GROUP_JID = /^[\d-]{1,80}@g\.us$/;

/** Servers the protocol uses for a single person, mapped onto the JIDs the channel contract takes. */
const CONTACT_SERVERS: Record<string, 'c.us' | 'lid' | undefined> = {
  'c.us': 'c.us',
  hosted: 'c.us',
  's.whatsapp.net': 'c.us',
  'hosted.lid': 'lid',
  lid: 'lid',
};

interface SilentLogger {
  level: string;
  child(): SilentLogger;
  trace(): void;
  debug(): void;
  info(): void;
  warn(): void;
  error(): void;
}

/** The socket demands a logger. Session material flows through it, so it stays a sink. */
const silent: SilentLogger = {
  level: 'silent',
  child: () => silent,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The gateway stores `@c.us`/`@lid` allowlists; the protocol addresses users by `@s.whatsapp.net`. */
const toContactJid = (jid: string | null | undefined) => {
  const decoded = jidDecode(jid ?? undefined);
  const server = decoded && CONTACT_SERVERS[decoded.server];
  const contact = server ? `${decoded?.user}@${server}` : '';

  return CONTACT_JID.test(contact) ? contact : undefined;
};

const toDeviceJid = (chatId: string) => {
  if (GROUP_JID.test(chatId)) {
    return chatId;
  }

  return CONTACT_JID.test(chatId) ? chatId.replace(/@c\.us$/, '@s.whatsapp.net') : undefined;
};

/** Where a message says whom it mentions and which message it answers. */
const contextOf = (message: WAMessage) => {
  const content = normalizeMessageContent(message.message);

  return (content?.extendedTextMessage ?? content?.imageMessage ?? content?.audioMessage)
    ?.contextInfo;
};

/** The close reason travels as a Boom payload; read it structurally rather than depend on Boom. */
const statusCodeOf = (error: unknown) =>
  (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

/** The persisted shape: credentials plus the Signal key buckets, both JSON with encoded binaries. */
type StoredSession = { creds: AuthenticationCreds; keys: Record<string, Record<string, unknown>> };

export function createWhatsAppDeviceFactory(): DeviceFactory {
  return async (_id, store, callbacks) => {
    const saved = await store.load();
    const session: StoredSession = saved
      ? (JSON.parse(saved.toString('utf8'), BufferJSON.reviver) as StoredSession)
      : { creds: initAuthCreds(), keys: {} };

    if (!session?.creds?.noiseKey) {
      throw new Error('Stored WhatsApp session is unusable');
    }

    let socket: WASocket | undefined;
    const subjects = new Map<string, string | undefined>();
    let closed = false;
    let dirty = false;
    let writing: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopping: Promise<void> | undefined;

    const persist = async () => {
      dirty = false;
      const data = Buffer.from(JSON.stringify(session, BufferJSON.replacer), 'utf8');

      if (data.length > MAX_DEVICE_SESSION_BYTES) {
        throw new Error('Device session size limit exceeded');
      }

      // Serialize the writes: the store rewrites the whole session, so order decides the survivor.
      writing = writing.catch(() => {}).then(() => store.save(data));
      await writing;
    };

    const flush = async () => {
      clearTimeout(timer);
      timer = undefined;

      if (dirty) {
        await persist();
      }

      await writing;
    };

    const scheduleWrite = () => {
      dirty = true;

      if (timer || closed) return;

      timer = setTimeout(() => {
        timer = undefined;
        void persist().catch(failed);
      }, SESSION_WRITE_DELAY_MS);
      timer.unref();
    };

    const stop = (logout: boolean): Promise<void> => {
      if (stopping) return stopping;

      stopping = (async () => {
        const current = socket;
        closed = true;
        current?.ev.removeAllListeners('connection.update');
        current?.ev.removeAllListeners('creds.update');
        current?.ev.removeAllListeners('messages.upsert');

        if (logout) {
          clearTimeout(timer);
          timer = undefined;
          dirty = false;
          await current?.logout().catch(() => {});
          await store.clear().catch(() => {});
        } else {
          // A dropped last write unpairs the device on the next start; never leave one pending.
          await flush().catch(() => {});
        }

        await current?.end(undefined).catch(() => {});
      })();

      return stopping;
    };

    const failed = async () => {
      if (closed) return;
      await callbacks.failed().catch(() => {});
      await stop(false).catch(() => {});
    };

    const handle = (action: () => Promise<void>) => {
      if (!closed) void action().catch(failed);
    };

    const auth: AuthenticationState = {
      creds: session.creds,
      keys: {
        get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const bucket = session.keys[type];
          const found: { [id: string]: SignalDataTypeMap[T] } = {};

          for (const id of ids) {
            const value = bucket?.[id];

            if (value === undefined || value === null) continue;

            // JSON keeps this one as a plain object; the socket expects the decoded protobuf.
            found[id] = (
              type === 'app-state-sync-key'
                ? proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>)
                : value
            ) as SignalDataTypeMap[T];
          }

          return found;
        },
        set: (data) => {
          for (const [type, entries] of Object.entries(data)) {
            session.keys[type] ??= {};
            const bucket = session.keys[type];

            for (const [id, value] of Object.entries(entries ?? {})) {
              if (value === null || value === undefined) {
                delete bucket[id];
              } else {
                bucket[id] = value;
              }
            }
          }

          scheduleWrite();
        },
      },
    };

    const opened = async () => {
      const accountId = toContactJid(socket?.user?.id);

      if (!accountId) {
        throw new Error('WhatsApp did not report a linked account');
      }

      // Pairing credentials are only durable once written; report connected after they land.
      await flush();
      await callbacks.ready(accountId);
    };

    const dropped = async (loggedOut: boolean) => {
      if (!loggedOut) {
        await flush().catch(() => {});
      }

      closed = true;
      clearTimeout(timer);
      timer = undefined;
      await callbacks.disconnected(loggedOut);
    };

    /** Asked once per room and kept in memory: a subject is a label, never an authorization. */
    const subjectOf = async (jid: string) => {
      if (subjects.has(jid)) {
        return subjects.get(jid);
      }

      const subject = await socket
        ?.groupMetadata(jid)
        .then((data) => data.subject?.slice(0, 100))
        .catch(() => undefined);

      subjects.set(jid, subject);

      return subject;
    };

    /**
     * A participant as the gateway addresses them: the phone JID. Rooms increasingly name people
     * by LID, in mentions and quotes too, and a LID is compared with nothing the gateway stores,
     * so it is resolved through the account's mapping — this account's own LID included.
     */
    const personOf = async (jid: string | null | undefined) => {
      const contact = toContactJid(jid);

      if (!contact?.endsWith('@lid')) {
        return contact;
      }

      if (jidDecode(socket?.user?.lid)?.user === contact.split('@')[0]) {
        return toContactJid(socket?.user?.id);
      }

      return (
        toContactJid(await socket?.signalRepository.lidMapping.getPNForLID(jid ?? '')) ?? contact
      );
    };

    const deliver = async (message: WAMessage) => {
      if (message.key.fromMe || !message.key.id) return;
      const address = message.key.remoteJid ?? '';
      if (!GROUP_JID.test(address) && !toContactJid(address)) return;
      const { text, media } = await readWhatsAppContent(message);
      const requestKey = message.key.id;

      if (message.key.fromMe || !requestKey || !text?.trim() || text.length > 8000) {
        return;
      }

      const remote = message.key.remoteJid ?? '';

      // In a room the conversation is the group and the sender is the participant, so the two
      // identifiers part ways: approval is decided about the room, delivery goes back to it.
      if (GROUP_JID.test(remote)) {
        const from = await personOf(message.key.participantAlt ?? message.key.participant);

        if (!from) return;

        const subject = await subjectOf(remote);
        const context = contextOf(message);
        const mentions = (
          await Promise.all((context?.mentionedJid ?? []).map((jid) => personOf(jid)))
        ).filter((jid): jid is string => Boolean(jid));
        const replyTo = context?.stanzaId ? await personOf(context.participant) : undefined;

        await callbacks.message({
          actorId: from,
          chatId: remote,
          text,
          ...(media ? { media } : {}),
          requestKey,
          scope: 'group',
          ...(subject ? { groupName: subject } : {}),
          ...(message.pushName ? { displayName: message.pushName.slice(0, 100) } : {}),
          mentions,
          ...(replyTo ? { replyTo } : {}),
        });

        return;
      }

      // WhatsApp may address a contact by LID. Resolve its authenticated phone mapping so an
      // existing phone allowlist still works after WhatsApp switches identifier formats.
      const phone = remote.endsWith('@lid')
        ? (message.key.remoteJidAlt ??
          (await socket?.signalRepository.lidMapping.getPNForLID(remote)))
        : undefined;
      const sender = toContactJid(phone) ?? toContactJid(remote);

      if (!sender) return;

      // Use the authenticated message's sender, never an actor ID supplied inside its text.
      await callbacks.message({
        actorId: sender,
        chatId: sender,
        text,
        ...(media ? { media } : {}),
        requestKey,
        scope: 'direct',
        mentions: [],
      });
    };

    return {
      start: async () => {
        if (socket || closed) return;

        quietLibsignal();

        socket = makeWASocket({
          auth,
          logger: silent,
          browser: ['Jian Gateway', 'Chrome', '1.0.0'],
          qrTimeout: QR_REFRESH_MS,
          markOnlineOnConnect: false,
          syncFullHistory: false,
          shouldSyncHistoryMessage: () => false,
        });

        socket.ev.on('creds.update', scheduleWrite);
        socket.ev.on('connection.update', (update) => {
          const qr = update.qr;

          if (qr) {
            handle(() => callbacks.qr(qr));
          }

          if (update.connection === 'open') {
            handle(opened);
          }

          if (update.connection === 'close') {
            const reason = statusCodeOf(update.lastDisconnect?.error);
            handle(() => dropped(reason === DisconnectReason.loggedOut));
          }
        });
        socket.ev.on('messages.upsert', ({ messages }) => {
          // Messages queued while the worker was down arrive as 'append'; the inbox dedupes them.
          for (const message of messages) {
            handle(() => deliver(message));
          }
        });
      },
      avatar: async (chatId) => {
        const jid = toDeviceJid(chatId);

        if (closed || !socket || !jid) {
          return undefined;
        }

        // `preview` is the thumbnail: a few kilobytes, which is all a list of contacts needs.
        const url = await socket.profilePictureUrl(jid, 'preview').catch(() => undefined);

        if (!url) {
          return undefined;
        }

        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const bytes = Buffer.from(await response.arrayBuffer());

        return response.ok && bytes.length <= MAX_AVATAR_BYTES
          ? { mimeType: 'image/jpeg', data: bytes.toString('base64') }
          : undefined;
      },
      typing: async (chatId) => {
        const jid = toDeviceJid(chatId);

        if (closed || !socket || !jid) {
          return;
        }

        try {
          await socket.sendPresenceUpdate('composing', jid);
        } catch {
          // A bubble nobody saw is not worth failing anything over.
        }
      },
      send: async (chatId, text, signal, media) => {
        const jid = toDeviceJid(chatId);

        if (closed || !socket || !jid) {
          throw new Error('Device unavailable');
        }

        const deadline = AbortSignal.any([signal, AbortSignal.timeout(DEVICE_SEND_TIMEOUT_MS)]);
        deadline.throwIfAborted();
        let abort: () => void = () => {};
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('WhatsApp send interrupted'));
          deadline.addEventListener('abort', abort, { once: true });
        });

        try {
          const result = await Promise.race([
            socket.sendMessage(
              jid,
              media
                ? media.mimeType.startsWith('image/')
                  ? {
                      image: Buffer.from(media.data, 'base64'),
                      mimetype: media.mimeType,
                      ...(text ? { caption: text } : {}),
                    }
                  : {
                      audio: Buffer.from(media.data, 'base64'),
                      mimetype:
                        media.mimeType === 'audio/ogg' ? 'audio/ogg; codecs=opus' : media.mimeType,
                      ptt: media.mimeType === 'audio/ogg',
                    }
                : { text },
            ),
            interrupted,
          ]);

          if (!result?.key.id) {
            throw new Error('WhatsApp send was not confirmed');
          }

          return result.key.id;
        } catch {
          // Closing the socket prevents later sends; the caller records this effect as uncertain.
          void failed();
          throw new Error('WhatsApp send was not confirmed');
        } finally {
          deadline.removeEventListener('abort', abort);
        }
      },
      stop,
    };
  };
}
