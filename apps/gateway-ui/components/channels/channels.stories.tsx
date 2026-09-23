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

/** Telegram opened: its connection, its groups and its contacts, each one revocable. */
export const TelegramExpanded: Story = {
  render: () => <Channels {...sectionProps()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const telegram = canvasElement.querySelector<HTMLButtonElement>(
      'button[aria-controls="channel-telegram"]',
    );

    if (!telegram) throw new Error('No Telegram row');

    await userEvent.click(telegram);
    // The row opens with a short fade, so visibility is awaited rather than read at once.
    await waitFor(() => expect(canvas.getByText('Equipe')).toBeVisible());
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
