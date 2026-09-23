import { channelLog } from '../logging.js';

/** libsignal bypasses the socket logger; its session and queue dumps include private keys. */
const LEAKS = [
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Session already closed',
  'Session already open',
  'V1 session storage migration error:',
  'Unhandled bucket type (for naming):',
  'Migrating session to:',
  'Closing open session in favor of incoming prekey bundle',
  'Session error:',
];

const LEVELS = ['info', 'warn', 'log', 'error'] as const;

type Writer = (...args: unknown[]) => void;

/** Marks a writer this module already wrapped, so connecting twice does not stack filters. */
const wrapped = Symbol.for('jian.quietLibsignal');

export function quietLibsignal(target: Record<(typeof LEVELS)[number], Writer> = console): void {
  for (const level of LEVELS) {
    const write = target[level];

    if ((write as Writer & { [wrapped]?: true })[wrapped]) {
      continue;
    }

    const filtered: Writer & { [wrapped]?: true } = (...args) => {
      const [first] = args;

      if (typeof first === 'string' && LEAKS.some((line) => first.startsWith(line))) {
        return;
      }

      if (typeof first === 'string') {
        const event = first.startsWith('Failed to decrypt message with any known session')
          ? 'whatsapp.decrypt.failed'
          : first.startsWith('Decrypted message with closed session.')
            ? 'whatsapp.decrypt.recovered'
            : first.startsWith('WARNING: Expected pubkey of length')
              ? 'whatsapp.key.invalid'
              : undefined;
        if (event) {
          channelLog(event, {}, undefined, (line) => write.call(target, line));
          return;
        }
      }
      write.apply(target, args);
    };

    filtered[wrapped] = true;
    target[level] = filtered;
  }
}
