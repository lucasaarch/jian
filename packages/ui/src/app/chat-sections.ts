import { AGENT_SESSION_CHANNEL, GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import type { Channel, Project, Session } from '../lib/api';
import { folderName, repositoryName } from '../lib/stores/workspace-choice';

/** Where a conversation came from, for the sections that are not the app's own chats. */
type ChannelKind = 'whatsapp' | 'telegram' | 'api' | 'agents';

/** What a chat works on, by name: a folder and a repository of that name read as one. */
export function workspaceName(session: Session, projects: Project[]): string | undefined {
  const ids = session.projectIds ?? (session.projectId ? [session.projectId] : []);
  const names = [
    ...(session.folders ?? []).map(folderName),
    ...ids.flatMap((id) => {
      const project = projects.find((item) => item.id === id);
      return project ? [repositoryName(project.name)] : [];
    }),
  ].sort((a, b) => a.localeCompare(b));
  return names.length ? names.join(' + ') : undefined;
}

/** A folder of Recent: the chats on one project, or those on none. */
type RecentFolder = { id: string; name: string; sessions: Session[] };

/** The folder of the chats on no project, which a project's own name cannot be mistaken for. */
export const NO_PROJECT = 'no-project:';

export type ChatSection =
  | { id: 'pinned'; kind: 'pinned'; name: string; sessions: Session[] }
  | { id: 'recent'; kind: 'recent'; name: string; folders: RecentFolder[] }
  | { id: ChannelKind; kind: 'channel'; channel: ChannelKind; name: string; sessions: Session[] };

const channelSections: { channel: ChannelKind; name: string }[] = [
  { channel: 'whatsapp', name: 'WhatsApp' },
  { channel: 'telegram', name: 'Telegram' },
  { channel: 'api', name: 'API Server' },
  { channel: 'agents', name: 'Agents' },
];

/** Both WhatsApp connections read as one; a channel the app does not know is the API's. */
export function channelKind(channel: string): ChannelKind {
  if (channel === 'whatsapp' || channel === 'whatsapp-business') return 'whatsapp';
  if (channel === 'telegram') return 'telegram';
  if (channel === AGENT_SESSION_CHANNEL) return 'agents';
  return 'api';
}

export const lastAt = (session: Session) => session.lastMessage?.at ?? session.createdAt;
const newestFirst = (a: Session, b: Session) => lastAt(b).localeCompare(lastAt(a));

/**
 * The sidebar's sections: Recent, a folder for each project that has chats and one for the chats
 * on none, each by when it was last spoken in, a folder's chats likewise; then each channel that
 * is connected or has conversations, in a fixed order, so a channel never moves while it is read.
 */
export function chatSections({
  sessions,
  projects,
  channels,
}: {
  sessions: Session[];
  projects: Project[];
  channels: Channel[];
}): ChatSection[] {
  const pinned = sessions.filter((session) => session.pinned).sort(newestFirst);
  const sorted = sessions.filter((session) => !session.pinned).sort(newestFirst);
  const chats = sorted.filter((session) => session.channel === GATEWAY_SESSION_CHANNEL);
  const others = sorted.filter((session) => session.channel !== GATEWAY_SESSION_CHANNEL);
  // By name, so a folder and a repository of that name are one; newest first already, as `chats`.
  const byName = new Map<string, Session[]>();
  const folders: RecentFolder[] = [];
  for (const session of chats) {
    // A chat whose project is gone stays reachable among those on none.
    const name = workspaceName(session, projects);
    const id = name ?? NO_PROJECT;
    const folder = byName.get(id);
    if (folder) folder.push(session);
    else {
      const sessions = [session];
      byName.set(id, sessions);
      folders.push({ id, name: name ?? 'No project', sessions });
    }
  }

  const connected = new Set(
    channels.filter((channel) => !channel.revokedAt).map((channel) => channelKind(channel.type)),
  );
  const byChannel = channelSections
    .map(({ channel, name }) => ({
      id: channel,
      kind: 'channel' as const,
      channel,
      name,
      sessions: others.filter((session) => channelKind(session.channel) === channel),
    }))
    .filter((section) => section.sessions.length > 0 || connected.has(section.channel));

  return [
    ...(pinned.length
      ? [{ id: 'pinned' as const, kind: 'pinned' as const, name: 'Pinned', sessions: pinned }]
      : []),
    { id: 'recent' as const, kind: 'recent' as const, name: 'Recent', folders },
    ...byChannel,
  ];
}
