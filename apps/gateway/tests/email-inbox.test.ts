import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { emailDomains } from '../src/storage/schema.js';
import { emailSetup as setup, support } from './helpers/email.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-email-inbox-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

afterEach(() => {
  vi.useRealTimers();
});

const DAY_MS = 24 * 60 * 60 * 1000;

const confirmation = {
  from: 'noreply@mail.contabo.test',
  subject: 'Confirm your account',
  text: 'Your code is 482913.',
  automatic: true,
};

describe('expecting mail from a service', () => {
  it('is the agent’s own call, asks nobody, lasts 30 days and names the address', async () => {
    const f = await setup();
    try {
      const { run } = await f.askTool('expect_email', {
        domain: 'Contabo.test',
        reason: 'A customer account for the VPS',
      });
      expect(run.status).toBe('completed');
      expect(run.approval).toBeUndefined();
      const [expected] = await f.services.store.db.select().from(emailDomains);
      expect(expected).toMatchObject({ domain: 'contabo.test', sessionId: null });
      const left = (expected?.expiresAt.getTime() ?? 0) - Date.now();
      expect(left).toBeGreaterThan(29 * DAY_MS);
      expect(left).toBeLessThanOrEqual(30 * DAY_MS);

      // Asked again when a day is left, it counts 30 days from then, in the one row.
      await f.services.store.db
        .update(emailDomains)
        .set({ expiresAt: new Date(Date.now() + DAY_MS) })
        .where(eq(emailDomains.profileId, f.profile.id));
      expect(await f.services.errands.expect(f.profile.id, 'contabo.test', 'Again')).toMatchObject({
        address: 'mia@agents.test',
        domain: 'contabo.test',
      });
      const rows = await f.services.store.db.select().from(emailDomains);
      expect(rows).toHaveLength(1);
      expect((rows[0]?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(29 * DAY_MS);

      await expect(
        f.services.errands.expect(f.profile.id, 'not a domain', 'x'),
      ).rejects.toMatchObject({ statusCode: 400 });
    } finally {
      await f.app.close();
    }
  });

  it('refuses a mailbox provider, where anyone has an address', async () => {
    const f = await setup();
    try {
      for (const domain of ['gmail.com', 'Gmail.com', 'yahoo.com.br', 'gmx.de', 'outlook.com'])
        await expect(f.services.errands.expect(f.profile.id, domain, 'x')).rejects.toMatchObject({
          statusCode: 400,
        });
      expect(await f.services.store.db.select().from(emailDomains)).toEqual([]);
    } finally {
      await f.app.close();
    }
  });

  it('keeps its automatic code days later, logged and with no turn, and nothing else', async () => {
    const f = await setup();
    try {
      const leo = await f.another('Leo', 'leo@agents.test');
      await f.services.errands.expect(f.profile.id, 'contabo.test', 'VPS account');
      const runs = (await f.services.runs.activities(f.profile.id)).length;

      // Two days later, a subdomain's no-reply address sends the code.
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(Date.now() + 2 * DAY_MS);
      expect(await f.arrive(confirmation)).toEqual({ accepted: false });

      // The run that signed up finds it, and it is kept in the domain's conversation.
      expect(
        await f.services.errands.searchEmail(f.profile.id, { address: 'contabo.test' }),
      ).toMatchObject([
        { direction: 'received', from: confirmation.from, text: 'Your code is 482913.' },
      ]);
      const [expected] = await f.services.store.db.select().from(emailDomains);
      if (!expected?.sessionId) throw new Error('Domain conversation missing');
      expect(expected.sessionId).not.toBe(f.owner.id);
      const kept = (await f.messagesOf(expected.sessionId)).join('\n');
      expect(kept).toContain('Your code is 482913.');
      expect(kept).toContain('An automatic email');
      // No turn, no answer, no contact.
      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(runs);
      await f.channels.dispatch();
      expect(f.resend.sent).toHaveLength(0);
      expect(await f.contactOf(confirmation.from)).toBeUndefined();

      const others = [
        // Another domain, and one that only ends like it.
        { ...confirmation, from: 'noreply@elsewhere.test', text: 'Elsewhere code 111111.' },
        { ...confirmation, from: 'noreply@notcontabo.test', text: 'Lookalike code 222222.' },
        // Unsigned by the domain it claims.
        { ...confirmation, text: 'Forged code 333333.', dmarc: 'fail', dkim: 'fail' },
      ];
      for (const mail of others) expect(await f.arrive(mail)).toEqual({ accepted: false });
      // Another agent's mail from that domain is not this one's to expect.
      expect(await leo.arrive({ ...confirmation, text: 'Leo code 444444.' })).toEqual({
        accepted: false,
      });
      expect(await f.services.errands.searchEmail(leo.profile.id, {})).toEqual([]);

      // Past the 30 days, it is as before: a machine's mail is dropped, a person's is held.
      await f.services.store.db
        .update(emailDomains)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(emailDomains.profileId, f.profile.id));
      expect(await f.arrive({ ...confirmation, text: 'Late code 555555.' })).toEqual({
        accepted: false,
      });
      expect(
        await f.arrive({ from: 'sales@contabo.test', text: 'Late offer.', subject: 'Offer' }),
      ).toEqual({ accepted: false, contact: 'pending' });

      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(runs);
      const found = await f.services.errands.searchEmail(f.profile.id, {});
      const everywhere = [
        ...found.map((mail) => mail.text),
        ...(await f.messagesOf(expected.sessionId)),
        ...(await f.ownerMessages()),
      ].join('\n');
      for (const text of ['111111', '222222', '333333', '444444', '555555'])
        expect(everywhere).not.toContain(text);
    } finally {
      await f.app.close();
    }
  });

  it('makes a person writing from that domain a correspondent, in a conversation of their own', async () => {
    const f = await setup();
    try {
      await f.services.errands.expect(f.profile.id, 'contabo.test', 'VPS account');
      const welcome = await f.arrive({
        from: 'sales@contabo.test',
        subject: 'Welcome',
        text: 'Can I help you choose a plan?',
      });
      expect(welcome).toMatchObject({ accepted: true });
      const person = await f.contactOf('sales@contabo.test');
      expect(person).toMatchObject({ status: 'approved' });
      const started = await f.services.runs.run(f.profile.id, welcome.runId);
      expect(started.sessionId).toBe(person?.sessionId);
      expect(started.sessionId).not.toBe(f.owner.id);
      expect((await f.ownerMessages()).join('\n')).not.toContain('choose a plan');
    } finally {
      await f.app.close();
    }
  });
});

describe('searching the mail', () => {
  it('finds this profile’s mail, newest first, by address, domain, words and direction', async () => {
    const f = await setup();
    try {
      const leo = await f.another('Leo', 'leo@agents.test');
      await f.outreach();
      await f.arrive({
        from: support,
        text: 'We restarted the host.',
        inReplyTo: '<sent-1@resend.test>',
      });
      await f.settle();
      await f.arrive({ from: 'ada@mail.test', subject: 'Lunch', text: 'Tuesday at 100% sure?' });
      await leo.arrive({ from: support, subject: 'Leo only', text: 'Leo private reply.' });

      const search = (query: Parameters<typeof f.services.errands.searchEmail>[1]) =>
        f.services.errands.searchEmail(f.profile.id, query);

      expect(await search({ address: 'contabo.test' })).toMatchObject([
        { direction: 'received', from: support, text: 'We restarted the host.' },
        { direction: 'sent', to: support, subject: 'VPS down', text: 'My VPS does not boot.' },
      ]);
      expect(await search({ address: 'SUPPORT@contabo.test', text: 'RESTARTED' })).toHaveLength(1);
      expect(await search({ direction: 'sent' })).toMatchObject([{ to: support }]);
      expect(await search({ text: 'lunch' })).toMatchObject([{ from: 'ada@mail.test' }]);
      expect(await search({ address: 'contabo.test', text: 'lunch' })).toEqual([]);
      // `%` is a character to find, not a wildcard.
      expect(await search({ text: '100%' })).toHaveLength(1);
      expect(await search({ text: '%' })).toHaveLength(1);
      expect(await search({ limit: 1 })).toHaveLength(1);

      // Another agent's mail is never this one's, and the other way round.
      expect(await search({ text: 'Leo private' })).toEqual([]);
      expect(
        await f.services.errands.searchEmail(leo.profile.id, { address: 'contabo.test' }),
      ).toMatchObject([{ from: support, text: 'Leo private reply.' }]);
    } finally {
      await f.app.close();
    }
  });
});
