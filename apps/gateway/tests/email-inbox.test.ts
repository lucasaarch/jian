import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { emailWindows } from '../src/storage/schema.js';
import { emailSetup as setup, support } from './helpers/email.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-email-inbox-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const confirmation = {
  from: 'noreply@mail.contabo.test',
  subject: 'Confirm your account',
  text: 'Your code is 482913.',
  automatic: true,
};

describe('waiting for a signup confirmation', () => {
  it('is the agent’s own call, asks nobody, and names the address to sign up with', async () => {
    const f = await setup();
    try {
      const { run } = await f.askTool('expect_email', {
        domain: 'Contabo.test',
        reason: 'A customer account for the VPS',
      });
      expect(run.status).toBe('completed');
      expect(run.approval).toBeUndefined();
      const [window] = await f.services.store.db.select().from(emailWindows);
      expect(window).toMatchObject({ sessionId: f.owner.id, domain: 'contabo.test' });
      // 30 minutes, give or take the turn.
      const left = (window?.expiresAt.getTime() ?? 0) - Date.now();
      expect(left).toBeGreaterThan(25 * 60 * 1000);
      expect(left).toBeLessThanOrEqual(30 * 60 * 1000);

      expect(
        await f.services.errands.expect(f.profile.id, f.owner.id, 'contabo.test', 'Again'),
      ).toMatchObject({ address: 'mia@agents.test', domain: 'contabo.test' });
      await expect(
        f.services.errands.expect(f.profile.id, f.owner.id, 'not a domain', 'x'),
      ).rejects.toMatchObject({ statusCode: 400 });
    } finally {
      await f.app.close();
    }
  });

  it('brings the service’s mail in the window to the conversation that waits, and nothing else', async () => {
    const f = await setup();
    try {
      const leo = await f.another('Leo', 'leo@agents.test');
      await f.services.errands.expect(f.profile.id, f.owner.id, 'contabo.test', 'VPS account');

      // An automatic confirmation from a subdomain's no-reply address: a turn where it waits.
      const code = await f.arrive(confirmation);
      expect(code).toMatchObject({ accepted: true });
      expect((await f.services.runs.run(f.profile.id, code.runId)).sessionId).toBe(f.owner.id);
      const said = (await f.ownerMessages()).join('\n');
      expect(said).toContain('Your code is 482913.');
      expect(said).toContain('written outside this conversation');
      // It made nobody a contact, and nothing answers it.
      expect(await f.contactOf(confirmation.from)).toBeUndefined();
      await f.settle();
      await f.channels.dispatch();
      expect(f.resend.sent).toHaveLength(0);
      const runs = (await f.services.runs.activities(f.profile.id)).length;

      const others = [
        // Another domain, and one that only ends like it.
        { ...confirmation, from: 'noreply@elsewhere.test', text: 'Elsewhere code 111111.' },
        { ...confirmation, from: 'noreply@notcontabo.test', text: 'Lookalike code 222222.' },
        // Unsigned by the domain it claims.
        { ...confirmation, text: 'Forged code 333333.', dmarc: 'fail', dkim: 'fail' },
      ];
      for (const mail of others) expect(await f.arrive(mail)).toMatchObject({ accepted: false });
      // Another agent's mail from that domain is not this conversation's wait.
      expect(await leo.arrive({ ...confirmation, text: 'Leo code 444444.' })).toMatchObject({
        accepted: false,
      });

      // Past the 30 minutes, it is as before: a machine's mail is dropped, a person's is held.
      await f.services.store.db
        .update(emailWindows)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(emailWindows.profileId, f.profile.id));
      expect(await f.arrive({ ...confirmation, text: 'Late code 555555.' })).toEqual({
        accepted: false,
      });
      expect(
        await f.arrive({ from: 'sales@contabo.test', text: 'Late offer.', subject: 'Offer' }),
      ).toEqual({ accepted: false, contact: 'pending' });

      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(runs);
      const now = (await f.ownerMessages()).join('\n');
      for (const text of ['111111', '222222', '333333', '444444', '555555', 'Late offer.'])
        expect(now).not.toContain(text);
      expect(await f.contactOf(confirmation.from)).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });

  it('stops after a few emails, so a sender cannot fill the conversation', async () => {
    const f = await setup();
    try {
      await f.services.errands.expect(f.profile.id, f.owner.id, 'contabo.test', 'VPS account');
      const results = [];
      for (let index = 0; index < 6; index++) {
        results.push(await f.arrive({ ...confirmation, text: `Mail number ${index}.` }));
        await f.settle();
      }
      expect(results.filter((result) => result.accepted)).toHaveLength(5);
      expect(results[5]).toEqual({ accepted: false });
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
