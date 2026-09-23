import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import * as fixtures from '../../stories/fixtures';
import { ids } from '../../stories/fixtures';
import { emptyHandlers } from '../../stories/handlers';
import { profileData, sectionProps } from '../../stories/section';
import { Channels } from '.';
import { Known } from './known';
import { Pairing } from './pairing';
import { Requests } from './requests';
import { Rooms } from './rooms';

const meta = {
  title: 'Sections/Channels',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = { render: () => <Channels {...sectionProps()} /> };

export const NothingConnected: Story = {
  parameters: { msw: { handlers: emptyHandlers } },
  render: () => (
    <Channels
      {...sectionProps({ data: { ...profileData, channels: [], contacts: [], groups: [] } })}
    />
  ),
};

/** A stranger wrote first and waits for the owner. */
export const PendingRequests: Story = { render: () => <Requests {...sectionProps()} /> };

export const KnownContacts: Story = { render: () => <Known {...sectionProps()} /> };

export const GroupRooms: Story = { render: () => <Rooms {...sectionProps()} /> };

/** Scanning the QR to link WhatsApp. */
export const WhatsAppPairing: Story = {
  render: () => {
    const channel = fixtures.channels.find((item) => item.id === ids.whatsapp);

    if (!channel) throw new Error('No WhatsApp channel in the fixtures');

    return <Pairing profileId={ids.zero} channel={channel} api={sectionProps().api} close={fn()} />;
  },
};
