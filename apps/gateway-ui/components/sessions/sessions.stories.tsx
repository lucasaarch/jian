import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { Channel, Contact, GatewayApi, Run } from '../../lib/api';
import { useWorkspace } from '../../lib/workspace';
import * as fixtures from '../../stories/fixtures';
import { ids } from '../../stories/fixtures';
import { sectionProps } from '../../stories/section';
import { withWorkspace } from '../../stories/workspace';
import { Sessions } from '.';
import { History } from './history';
import { RunProgress } from './progress';

const meta = {
  title: 'Sections/Chats',
  // The list names another agent by its profile, which the workspace holds.
  decorators: [withWorkspace],
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The screen as the page renders it: on the workspace's data, which the live stream keeps
 * current, and on the fixtures until the workspace has loaded.
 */
function Live({ sessionId }: { sessionId?: string | undefined }) {
  const { data } = useWorkspace();

  return (
    <Sessions
      {...sectionProps(data ? { data } : {})}
      {...(sessionId ? { initialSession: sessionId } : {})}
    />
  );
}

/** The messenger fills the height it is given, as it does beside the app's sidebar. */
const open = (sessionId?: string): Story => ({
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div style={{ height: '100dvh' }}>
      <Live sessionId={sessionId} />
    </div>
  ),
});

function BusinessChat({ paused = false }: { paused?: boolean }) {
  const [aiEnabled, setAiEnabled] = useState(!paused);
  const props = sectionProps();
  const session = fixtures.sessions.find((item) => item.id === ids.mayaChat);
  if (!session) throw new Error('Missing conversation fixture');
  const customer = fixtures.contacts.find((item) => item.sessionId === session.id);
  if (!customer) throw new Error('Missing contact fixture');
  const contact = {
    ...customer,
    id: 'business-customer',
    profileId: props.profile.id,
    sessionId: session.id,
    channelId: 'business',
    type: 'whatsapp-business',
    displayName: 'Customer',
    status: 'approved',
    aiEnabled,
  } as Contact;
  return (
    <Sessions
      {...props}
      initialSession={session.id}
      data={{
        ...props.data,
        sessions: [{ ...session, channel: 'whatsapp-business' }],
        contacts: [contact],
        channels: [{ id: 'business', profileId: props.profile.id, enabled: !paused } as Channel],
      }}
      api={{
        ...props.api,
        updateContact: async (_profileId, _id, body) => {
          setAiEnabled(body.aiEnabled ?? true);
          return { ...contact, ...body };
        },
      }}
    />
  );
}

export const BusinessAIReplies: Story = {
  render: () => <BusinessChat />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const control = canvas.getByRole('switch', { name: 'AI replies for Customer' });
    await expect(control).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(control);
    await expect(control).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(control);
    await expect(control).toHaveAttribute('aria-checked', 'true');
  },
};

export const BusinessChannelPaused: Story = {
  render: () => <BusinessChat paused />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Channel automation paused')).toBeVisible();
    const control = canvas.getByRole('switch', { name: 'AI replies for Customer' });
    await userEvent.click(control);
    await expect(control).toHaveAttribute('aria-checked', 'true');
    await expect(canvas.getByText('Channel automation paused')).toBeVisible();
  },
};

/** The gateway conversation: images, documents, voice notes both ways, and many tool calls. */
export const List = open();
/** WhatsApp, one person: her voice note, a photo and a PDF. */
export const WhatsAppContact = open(ids.mayaChat);
/** WhatsApp group: members with and without names or pictures, one known only by an internal id. */
export const WhatsAppGroup = open(ids.launchGroup);
/** Telegram, one person, with the agent working on the answer right now. */
export const Working = open(ids.theoChat);
/** A group read over the agent's shoulder: each member with their face, the agent on the right. */
export const Group = open(ids.designGroup);
/** Another agent of this installation asking for a review. */
export const Agent = open(ids.peerChat);
/** API Server: a report in Markdown behind 33 tools, one of them failed. */
export const ApiReport = open(ids.reportChat);
/** API Server: a request that failed before the agent could answer. */
export const Failed = open(ids.planningChat);
/** API Server: a conversation opened and never written in. */
export const Empty = open(ids.emptyChat);

export const Conversation: Story = {
  render: () => <History api={sectionProps().api} profileId={ids.zero} sessionId={ids.theoChat} />,
};

/** A completed internal worker stays attached to the turn that requested its work. */
export const Subagents: Story = {
  render: () => {
    const parentSessionId = ids.reportChat;
    const childSessionId = 'd3cb02e5-9927-4b82-8437-9bd5a9b1696f';
    const parentRunId = 'b63bd0ee-d31b-4b56-bbd9-777a0b3679aa';
    const childRunId = '5305f7e5-915f-42c6-a328-2784fb4fcf8a';
    const now = new Date().toISOString();
    const api = {
      activities: async () => [],
      messages: async (_profileId: string, sessionId: string) =>
        sessionId === parentSessionId
          ? [
              {
                id: 'a06d75cb-2a4e-41d8-a00d-41e850de408d',
                profileId: ids.zero,
                sessionId: parentSessionId,
                runId: parentRunId,
                role: 'user' as const,
                content: 'Check the release before it goes out.',
                createdAt: now,
              },
            ]
          : [
              {
                id: 'f78dd32d-349a-46a3-b9d5-99e9ec6a6920',
                profileId: ids.zero,
                sessionId: childSessionId,
                runId: childRunId,
                role: 'user' as const,
                content: 'Run the release checks and report the outcome.',
                createdAt: now,
              },
              {
                id: '8d751c2b-b069-44cc-9780-650e96a067ca',
                profileId: ids.zero,
                sessionId: childSessionId,
                runId: childRunId,
                role: 'assistant' as const,
                content: 'All release checks passed.',
                createdAt: now,
              },
            ],
      timeline: async () => [],
      conversationSubagents: async () => [
        {
          runId: childRunId,
          parentRunId,
          sessionId: childSessionId,
          role: 'execute' as const,
          name: 'Release verifier',
          status: 'completed' as const,
          input: 'Run the release checks and report the outcome.',
          output: 'All release checks passed.',
          createdAt: now,
          updatedAt: now,
        },
      ],
    } satisfies Pick<GatewayApi, 'activities' | 'messages' | 'timeline' | 'conversationSubagents'>;
    return <History api={api} profileId={ids.zero} sessionId={parentSessionId} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = (await canvas.findByText('Release verifier')).closest('button');
    if (!button) throw new Error('Subagent control missing');
    await userEvent.click(button);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(canvas.getByText('All release checks passed.')).toBeVisible());
  },
};

const live = fixtures.runs[0] as Run;
const progress = (
  patch: Partial<NonNullable<Run['progress']>>,
  status: Run['status'] = 'running',
) => ({
  ...live,
  status,
  progress: { phase: 'thinking' as const, text: '', steps: 1, updatedAt: live.updatedAt, ...patch },
});

/** What the chat shows while the agent works, one state at a time. */
export const Progress: Story = {
  render: () => (
    <div className="grid gap-4">
      <RunProgress run={progress({}, 'queued')} />
      <RunProgress run={progress({ phase: 'thinking' })} />
      <RunProgress run={progress({ phase: 'tool', tool: 'web_search', steps: 2 })} />
      <RunProgress
        run={progress({ phase: 'writing', text: 'Sent it. Maya has both links', steps: 3 })}
      />
    </div>
  ),
};
