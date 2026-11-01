import { expect, it } from 'vitest';
import type { Channel, Project, Session } from '../lib/api';
import { profile } from '../test/fixtures';
import { chatSections } from './chat-sections';

const chat = (id: string, channel: string, at: string, projectId?: string) =>
  ({
    id,
    profileId: profile.id,
    title: id,
    channel,
    createdAt: at,
    ...(projectId ? { projectId } : {}),
  }) as Session;

const project = (id: string, name: string) =>
  ({
    id,
    profileId: profile.id,
    name,
    repositoryUrl: `https://example.test/${name}.git`,
    createdAt: '2026-10-01T00:00:00Z',
  }) as Project;

const ids = (sessions: Session[]) => sessions.map((session) => session.id);
const names = (sections: ReturnType<typeof chatSections>) =>
  sections.map((section) =>
    section.kind === 'recent'
      ? [section.name, section.folders.map((folder) => [folder.name, ids(folder.sessions)])]
      : [section.name, ids(section.sessions)],
  );

it('mixes chats and project folders in Recent, by when each was last spoken in', () => {
  const sections = chatSections({
    projects: [project('p1', 'atlas'), project('p2', 'harbor'), project('p3', 'quiet')],
    channels: [],
    sessions: [
      chat('atlas-old', 'gateway', '2026-10-20T00:00:00Z', 'p1'),
      chat('harbor-new', 'gateway', '2026-10-29T00:00:00Z', 'p2'),
      chat('atlas-new', 'gateway', '2026-10-21T00:00:00Z', 'p1'),
      chat('loose', 'gateway', '2026-10-22T00:00:00Z'),
    ],
  });

  expect(names(sections)).toEqual([
    [
      'Recent',
      [
        ['harbor', ['harbor-new']],
        ['No project', ['loose']],
        ['atlas', ['atlas-new', 'atlas-old']],
      ],
    ],
  ]);
});

it('keeps chats on no project, or on one that is gone, in one folder apart from a namesake', () => {
  const sections = chatSections({
    projects: [project('p1', 'No project')],
    channels: [],
    sessions: [
      chat('loose', 'gateway', '2026-10-22T00:00:00Z'),
      chat('orphan', 'gateway', '2026-10-21T00:00:00Z', 'gone'),
      chat('namesake', 'gateway', '2026-10-20T00:00:00Z', 'p1'),
    ],
  });

  expect(names(sections)).toEqual([
    [
      'Recent',
      [
        ['No project', ['loose', 'orphan']],
        ['No project', ['namesake']],
      ],
    ],
  ]);
});

it('keeps a folder and a repository of the same name in one folder', () => {
  const sections = chatSections({
    projects: [project('p1', 'acme/atlas')],
    channels: [],
    sessions: [
      chat('on-repository', 'gateway', '2026-10-21T00:00:00Z', 'p1'),
      { ...chat('on-folder', 'gateway', '2026-10-22T00:00:00Z'), folders: ['/work/atlas'] },
    ],
  });

  expect(names(sections)).toEqual([['Recent', [['atlas', ['on-folder', 'on-repository']]]]]);
});

it('gives a chat on several projects a folder of its own, whichever order they came in', () => {
  const sections = chatSections({
    projects: [project('p1', 'acme/atlas'), project('p2', 'acme/harbor')],
    channels: [],
    sessions: [
      { ...chat('both', 'gateway', '2026-10-22T00:00:00Z'), projectIds: ['p2', 'p1'] },
      { ...chat('again', 'gateway', '2026-10-21T00:00:00Z'), projectIds: ['p1', 'p2'] },
      chat('one', 'gateway', '2026-10-20T00:00:00Z', 'p1'),
    ],
  });

  expect(names(sections)).toEqual([
    [
      'Recent',
      [
        ['atlas + harbor', ['both', 'again']],
        ['atlas', ['one']],
      ],
    ],
  ]);
});

it('shows a channel only when it is connected or has conversations', () => {
  const sections = chatSections({
    projects: [],
    channels: [
      { id: 'c1', type: 'telegram' } as Channel,
      { id: 'c2', type: 'whatsapp', revokedAt: '2026-10-01T00:00:00Z' } as Channel,
    ],
    sessions: [
      chat('business', 'whatsapp-business', '2026-10-20T00:00:00Z'),
      chat('linked', 'whatsapp', '2026-10-21T00:00:00Z'),
      chat('script', 'api', '2026-10-19T00:00:00Z'),
    ],
  });

  expect(names(sections)).toEqual([
    ['Recent', []],
    ['WhatsApp', ['linked', 'business']],
    ['Telegram', []],
    ['API Server', ['script']],
  ]);
});

it('keeps a chat whose project was removed among the conversations', () => {
  const sections = chatSections({
    projects: [],
    channels: [],
    sessions: [chat('orphan', 'gateway', '2026-10-20T00:00:00Z', 'gone')],
  });

  expect(names(sections)).toEqual([['Recent', [['No project', ['orphan']]]]]);
});

it('shows pinned chats once at the top and restores their date order when unpinned', () => {
  const old = { ...chat('old', 'gateway', '2026-10-01T00:00:00Z', 'p1'), pinned: true };
  const recent = chat('recent', 'gateway', '2026-10-30T00:00:00Z', 'p1');
  const input = { sessions: [old, recent], projects: [project('p1', 'atlas')], channels: [] };
  expect(names(chatSections(input))).toEqual([
    ['Pinned', ['old']],
    ['Recent', [['atlas', ['recent']]]],
  ]);
  expect(names(chatSections({ ...input, sessions: [{ ...old, pinned: false }, recent] }))).toEqual([
    ['Recent', [['atlas', ['recent', 'old']]]],
  ]);
});
