import { AGENT_SESSION_CHANNEL, GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import type { Channel, Project, Session } from '../lib/api';

/** Where a conversation came from, for the sections that are not the app's own chats. */
type ChannelKind = 'whatsapp' | 'telegram' | 'api' | 'agents';

/** A project in the Projects section: a folder of the chats that work on its repository. */
type ProjectFolder = { project: Project; sessions: Session[] };

export type ChatSection =
  | { id: 'projects'; kind: 'projects'; name: string; folders: ProjectFolder[] }
  | { id: 'conversations'; kind: 'conversations'; name: string; sessions: Session[] }
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
 * The sidebar's sections: Projects, a folder for each project that has chats, the project spoken
 * in last first and its chats likewise; the chats in no project; then each channel that is connected or has
 * conversations, in a fixed order, so a channel never moves while it is being read.
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
  const sorted = [...sessions].sort(newestFirst);
  const chats = sorted.filter((session) => session.channel === GATEWAY_SESSION_CHANNEL);
  const others = sorted.filter((session) => session.channel !== GATEWAY_SESSION_CHANNEL);
  const known = new Set(projects.map((project) => project.id));

  const folders = projects
    .map((project) => ({
      project,
      sessions: chats.filter((session) => session.projectId === project.id),
    }))
    // A project shows once it has a chat; the composer starts the first one in it.
    .filter((folder) => folder.sessions.length > 0)
    .sort((a, b) =>
      lastAt(b.sessions[0] as Session).localeCompare(lastAt(a.sessions[0] as Session)),
    );

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
    ...(folders.length
      ? [{ id: 'projects' as const, kind: 'projects' as const, name: 'Projects', folders }]
      : []),
    {
      id: 'conversations',
      kind: 'conversations',
      name: 'Conversations',
      // A chat whose project is gone stays reachable here.
      sessions: chats.filter((session) => !session.projectId || !known.has(session.projectId)),
    },
    ...byChannel,
  ];
}
