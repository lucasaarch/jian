import { describe, expect, it } from 'vitest';
import { quietLibsignal } from '../src/channels/whatsapp/quiet.js';

const session = {
  currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('7847', 'hex') } },
};

function console_() {
  const printed: unknown[][] = [];
  const write = (...args: unknown[]) => {
    printed.push(args);
  };

  return { printed, target: { info: write, warn: write, log: write, error: write } };
}

describe('what libsignal is allowed to print', () => {
  it('drops the lines that carry the ratchet keys', () => {
    const { printed, target } = console_();

    quietLibsignal(target);
    target.info('Closing session:', session);
    target.warn('Session already closed', session);
    target.info('Opening session:', session);
    target.info('Removing old closed session:', session);
    target.warn('Unhandled bucket type (for naming):', 'object', session);
    target.error('V1 session storage migration error: registrationId', session);

    expect(printed).toEqual([]);
  });

  it('keeps unrelated logs while reducing protocol diagnostics to safe events', () => {
    const { printed, target } = console_();

    quietLibsignal(target);
    target.warn('Decrypted message with closed session.');
    target.log('Anything else');

    expect(JSON.parse(String(printed[0]?.[0]))).toMatchObject({
      component: 'channels',
      event: 'whatsapp.decrypt.recovered',
    });
    expect(printed[1]).toEqual(['Anything else']);
  });

  it('discards decryption exception details instead of dumping their payload', () => {
    const { printed, target } = console_();
    quietLibsignal(target);
    target.error('Failed to decrypt message with any known session...', session);
    target.error('Session error: synthetic private error', session);
    expect(printed).toHaveLength(1);
    expect(JSON.parse(String(printed[0]?.[0]))).toMatchObject({
      event: 'whatsapp.decrypt.failed',
      level: 50,
    });
    expect(JSON.stringify(printed)).not.toContain('privKey');
  });

  it('does not stack a second filter when a device reconnects', () => {
    const { printed, target } = console_();

    quietLibsignal(target);
    const once = target.info;

    quietLibsignal(target);

    expect(target.info).toBe(once);

    target.info('Still here');

    expect(printed).toEqual([['Still here']]);
  });
});
