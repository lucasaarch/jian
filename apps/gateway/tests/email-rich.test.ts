import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { emailHtml } from '../src/channels/email/html.js';
import { brief, mailer, emailSetup as setup, support } from './helpers/email.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-email-rich-')));
const previousRoot = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previousRoot === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previousRoot;
});

const ada = 'ada@mail.test';

/** Ada wrote first and the owner approved her, as anyone becomes a contact. */
async function approvedAda(f: Awaited<ReturnType<typeof setup>>) {
  await f.arrive({ from: ada, text: 'Hello' });
  const contact = await f.contactOf(ada);
  if (!contact) throw new Error('Contact request missing');
  await f.channels.approveContact(f.profile.id, contact.id);
  await f.settle();
}

describe('the HTML of an email', () => {
  it('escapes what the agent wrote and keeps only web and mail links', () => {
    const html = emailHtml(
      [
        '<script>alert(1)</script> <img src=x onerror=alert(2)> <b style="color:red">hi</b>',
        '[open](javascript:alert) [data](data:text/html,x) [page](/relative)',
        '[docs](https://example.test/docs?a=1&b="2") [write](mailto:desk@example.test)',
        '**ready** and `rm -rf <dir>`',
      ].join('\n'),
    );

    // What the agent wrote as markup arrives as its characters; no tag or attribute of it.
    expect(html).not.toMatch(/<(script|img|b)[\s>]|style="color:red/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b style=&quot;color:red&quot;&gt;');
    // A link anywhere but the web or a mailbox keeps its words and loses its target.
    expect(html).not.toMatch(/href="(?!https:|mailto:)/);
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<br>open data page<br>');
    expect(html).toContain('href="https://example.test/docs?a=1&amp;b=%222%22"');
    expect(html).toContain('href="mailto:desk@example.test"');
    expect(html).toContain('<strong>ready</strong>');
    expect(html).toContain('rm -rf &lt;dir&gt;</code>');
  });

  it('keeps a code block as written, without reading Markdown or HTML inside it', () => {
    const html = emailHtml('```\n**not bold** <i>x</i> [a](https://example.test)\n```');

    expect(html).toContain('**not bold** &lt;i&gt;x&lt;/i&gt; [a](https://example.test)</pre>');
    expect(html).not.toContain('<a ');
  });
});

describe('a formatted email', () => {
  it('leaves with a plain part and an HTML part drawn from the same Markdown', async () => {
    const f = await setup();
    try {
      await f.services.errands.email(
        f.profile.id,
        f.owner.id,
        f.writing.id,
        {
          to: support,
          subject: 'VPS down',
          text: 'My VPS **does not boot**.\n\n- since Monday\n- after a reboot',
          brief,
        },
        'formatted',
      );
      await f.channels.dispatch();

      const [mail] = f.resend.sent;
      expect(mail?.text).toBe('My VPS does not boot.\n\n• since Monday\n• after a reboot');
      expect(mail?.html).toContain('<strong>does not boot</strong>');
      expect(mail?.html).toMatch(/<ul[^>]*><li[^>]*>since Monday<\/li><li[^>]*>after a reboot/);
      expect(mail?.cc).toBeUndefined();
      expect(mail?.attachments).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });
});

describe('copying addresses', () => {
  it('asks the owner when one copy is a stranger, lists it, and then each is a correspondent', async () => {
    const f = await setup();
    try {
      await approvedAda(f);
      await f.channels.dispatch();
      const before = f.resend.sent.length;
      const email = { to: ada, cc: [`Desk <${support}>`], subject: 'VPS', text: 'Hi', brief };
      const { run } = await f.ask(email);

      expect(run.status).toBe('waiting');
      expect(run.approval?.title).toBe(`Send an email to ${ada}`);
      expect(run.approval?.detail).toContain(`Cc: ${support}`);
      await f.channels.dispatch();
      expect(f.resend.sent).toHaveLength(before);
      expect(await f.contactOf(support)).toBeUndefined();

      const resume = await f.services.runs.decideApproval(f.profile.id, run.id, {
        decision: 'approve',
      });
      await new AgentRuntime(f.services, () => mailer(email)).execute(f.profile.id, resume.id);
      await f.channels.dispatch();

      expect(f.resend.sent).toHaveLength(before + 1);
      expect(f.resend.sent.at(-1)).toMatchObject({ to: [ada], cc: [support], subject: 'VPS' });
      const desk = await f.contactOf(support);
      expect(desk).toMatchObject({ status: 'approved' });
      if (!desk?.sessionId) throw new Error('Copied correspondent has no conversation');
      expect((await f.messagesOf(desk.sessionId)).join('\n')).toContain('Subject: VPS\n\nHi');

      // Both are approved now: the same email again goes without asking.
      const again = await f.ask({ ...email, subject: 'VPS, again' });
      expect(again.run.status).toBe('completed');
      expect(again.run.approval).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });

  it('refuses a copy that is not an address, and sends nothing', async () => {
    const f = await setup();
    try {
      await expect(
        f.services.errands.email(
          f.profile.id,
          f.owner.id,
          f.writing.id,
          { to: support, cc: ['the whole team'], subject: 'VPS', text: 'Hi', brief },
          'junk',
        ),
      ).rejects.toThrow(/not an email address/);
      await f.channels.dispatch();
      expect(f.resend.sent).toHaveLength(0);
      expect(await f.contactOf(support)).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });
});

describe('attaching files', () => {
  it('sends a workspace file and a conversation file as named base64 attachments', async () => {
    const f = await setup();
    try {
      const report = Buffer.from('%PDF-1.4 synthetic report');
      const path = join(root, 'report.pdf');
      writeFileSync(path, report);
      const note = Buffer.from('boot log: kernel panic');
      const media = await f.services.media.upload(f.profile.id, f.owner.id, {
        mimeType: 'text/plain',
        data: note.toString('base64'),
        name: 'boot.txt',
      });

      const sent = await f.services.errands.email(
        f.profile.id,
        f.owner.id,
        f.writing.id,
        {
          to: support,
          subject: 'VPS down',
          text: 'Logs attached.',
          brief,
          attachments: [{ path }, { mediaId: media.id, name: 'kernel.txt' }],
        },
        'files',
      );
      await f.channels.dispatch();

      expect(sent.attachments).toEqual(['report.pdf', 'kernel.txt']);
      expect(f.resend.sent[0]?.attachments).toEqual([
        { filename: 'report.pdf', content: report.toString('base64') },
        { filename: 'kernel.txt', content: note.toString('base64') },
      ]);
    } finally {
      await f.app.close();
    }
  });

  it('shows each file with its size on the card', async () => {
    const f = await setup();
    try {
      const path = join(root, 'invoice.pdf');
      writeFileSync(path, Buffer.alloc(2048, 1));
      const email = { to: support, subject: 'Invoice', text: 'Attached.', brief };
      const { run } = await f.ask({ ...email, attachments: [{ path }] });

      expect(run.status).toBe('waiting');
      expect(run.approval?.detail).toContain('Attachments: invoice.pdf (2.0 KB)');
    } finally {
      await f.app.close();
    }
  });

  it('refuses files over 20 MB together, and a file of another conversation', async () => {
    const f = await setup();
    try {
      const big = Buffer.alloc(11 * 1024 * 1024, 1);
      writeFileSync(join(root, 'one.pdf'), big);
      writeFileSync(join(root, 'two.pdf'), big);
      const email = { to: support, subject: 'Disk', text: 'Images.', brief };

      await expect(
        f.services.errands.email(
          f.profile.id,
          f.owner.id,
          f.writing.id,
          {
            ...email,
            attachments: [{ path: join(root, 'one.pdf') }, { path: join(root, 'two.pdf') }],
          },
          'too-big',
        ),
      ).rejects.toThrow(/20 MB together/);

      const elsewhere = await f.services.sessions.createSession(f.profile.id, { title: 'Other' });
      const media = await f.services.media.upload(f.profile.id, elsewhere.id, {
        mimeType: 'text/plain',
        data: Buffer.from('private').toString('base64'),
        name: 'private.txt',
      });
      await expect(
        f.services.errands.email(
          f.profile.id,
          f.owner.id,
          f.writing.id,
          { ...email, attachments: [{ mediaId: media.id }] },
          'other-conversation',
        ),
      ).rejects.toThrow(/not part of this conversation/);

      await f.channels.dispatch();
      expect(f.resend.sent).toHaveLength(0);
      expect(await f.contactOf(support)).toBeUndefined();
    } finally {
      await f.app.close();
    }
  });
});
