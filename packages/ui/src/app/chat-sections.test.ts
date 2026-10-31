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
    section.kind === 'projects'
      ? [section.name, section.folders.map((folder) => [folder.project.name, ids(folder.sessions)])]
      : [section.name, ids(section.sessions)],
  );

it('keeps each project with chats in a folder of Projects, the one spoken in last first', () => {
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
      'Projects',
      [
        ['harbor', ['harbor-new']],
        ['atlas', ['atlas-new', 'atlas-old']],
      ],
    ],
    ['Conversations', ['loose']],
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
    ['Conversations', []],
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

  expect(names(sections)).toEqual([['Conversations', ['orphan']]]);
});

it('shows pinned chats once at the top and restores their date order when unpinned', () => {
  const old = { ...chat('old', 'gateway', '2026-10-01T00:00:00Z', 'p1'), pinned: true };
  const recent = chat('recent', 'gateway', '2026-10-30T00:00:00Z', 'p1');
  const input = { sessions: [old, recent], projects: [project('p1', 'atlas')], channels: [] };
  expect(names(chatSections(input))).toEqual([
    ['Pinned', ['old']],
    ['Projects', [['atlas', ['recent']]]],
    ['Conversations', []],
  ]);
  expect(names(chatSections({ ...input, sessions: [{ ...old, pinned: false }, recent] }))).toEqual([
    ['Projects', [['atlas', ['recent', 'old']]]],
    ['Conversations', []],
  ]);
});
