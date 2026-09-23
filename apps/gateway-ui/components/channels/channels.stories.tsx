import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import * as fixtures from '../../stories/fixtures';
import { ids } from '../../stories/fixtures';
import { emptyHandlers } from '../../stories/handlers';
import { profileData, sectionProps } from '../../stories/section';
import { Channels } from '.';
import { Conversations } from './conversations';
import { Pairing } from './pairing';

const meta = {
  title: 'Sections/Channels',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Someone new wrote on WhatsApp: that row opens by itself, the request first in its list. */
export const List: Story = { render: () => <Channels {...sectionProps()} /> };

/** Opens a channel's row unless it already opened itself for a pending request. */
const open =
  (type: string) =>
  async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const toggle = canvasElement.querySelector<HTMLButtonElement>(
      `button[aria-controls="channel-${type}"]`,
    );

    if (!toggle) throw new Error(`No ${type} row`);

    if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
  };

/** Telegram opened: a group asking to be approved, then its groups and contacts. */
export const TelegramExpanded: Story = {
  render: () => <Channels {...sectionProps()} />,
  play: async (context) => {
    await open('telegram')(context);
    // The row opens with a short fade, so visibility is awaited rather than read at once.
    await waitFor(() => expect(within(context.canvasElement).getByText('Equipe')).toBeVisible());
  },
};

/** Someone new wrote on WhatsApp: who, what they said, and the two answers. */
export const WhatsAppRequest: Story = {
  render: () => <Channels {...sectionProps()} />,
  play: async (context) => {
    await open('whatsapp')(context);
    await waitFor(() =>
      expect(within(context.canvasElement).getByText(/Peguei esse número/)).toBeVisible(),
    );
  },
};

export const NothingConnected: Story = {
  parameters: { msw: { handlers: emptyHandlers } },
  render: () => (
    <Channels
      {...sectionProps({ data: { ...profileData, channels: [], contacts: [], groups: [] } })}
    />
  ),
};

export const ChannelConversations: Story = {
  render: () => {
    const channel = fixtures.channels.find((item) => item.id === ids.telegram);

    if (!channel) throw new Error('No Telegram channel in the fixtures');

    return <Conversations {...sectionProps()} channel={channel} />;
  },
};

/** Scanning the QR to link WhatsApp. */
export const WhatsAppPairing: Story = {
  render: () => {
    const channel = fixtures.channels.find((item) => item.id === ids.whatsapp);

    if (!channel) throw new Error('No WhatsApp channel in the fixtures');

    return <Pairing profileId={ids.zero} channel={channel} api={sectionProps().api} close={fn()} />;
  },
};
