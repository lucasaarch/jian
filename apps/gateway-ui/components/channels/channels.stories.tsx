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
    await waitFor(() =>
      expect(within(context.canvasElement).getByText('Design Team')).toBeVisible(),
    );
  },
};

const permissionsProps = sectionProps();
const whatsapp = profileData.channels.find((channel) => channel.type === 'whatsapp');
if (!whatsapp) throw new Error('No WhatsApp channel in the fixtures');
const updateChannel = fn(async () => ({ ...whatsapp, allowAllContacts: true }));

/** The opt-in is WhatsApp-only and saves through the channel settings API. */
export const AllowAllContacts: Story = {
  render: () => <Channels {...permissionsProps} api={{ ...permissionsProps.api, updateChannel }} />,
  play: async (context) => {
    await open('whatsapp')(context);
    const canvas = within(context.canvasElement);
    const toggle = canvas.getByRole('switch', { name: 'Allow all contacts' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle);
    await expect(updateChannel).toHaveBeenCalledWith(permissionsProps.profile.id, ids.whatsapp, {
      allowAllContacts: true,
    });
    await open('telegram')(context);
    await expect(canvas.queryByRole('switch', { name: 'Allow all contacts' })).toBeNull();
  },
};

/** Someone new wrote on WhatsApp: who, what they said, and the two answers. */
export const WhatsAppRequest: Story = {
  render: () => <Channels {...sectionProps()} />,
  play: async (context) => {
    await open('whatsapp')(context);
    await waitFor(() =>
      expect(within(context.canvasElement).getByText(/Omar gave me this number/)).toBeVisible(),
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

/** Manual setup is deliberately separate from Baileys QR pairing. */
export const MetaSetup: Story = {
  render: () => (
    <Channels
      {...sectionProps({ data: { ...profileData, channels: [], contacts: [], groups: [] } })}
    />
  ),
  play: async (context) => {
    await open('whatsapp-business')(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.queryByLabelText('Access token')).toBeNull();
    await expect(canvas.queryByLabelText('App secret')).toBeNull();
    await expect(canvas.getByLabelText('Verify token')).toHaveAttribute('type', 'password');
  },
};

/** Saving is configuration, not proof that Meta is subscribed or delivery works. */
export const MetaConfigured: Story = {
  render: () => (
    <Channels
      {...sectionProps({
        data: {
          ...profileData,
          channels: [
            {
              id: ids.whatsapp,
              profileId: ids.zero,
              type: 'whatsapp-business',
              whatsappBusinessStatus: 'configured',
              createdAt: '2026-10-23T12:00:00Z',
              allowAllContacts: false,
            },
          ],
          contacts: [],
          groups: [],
        },
      })}
    />
  ),
  play: async (context) => {
    await open('whatsapp-business')(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByText('Configured', { exact: true })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Meta callback URL' })).toHaveValue(
      `${window.location.origin}/v1/whatsapp-business/${ids.whatsapp}`,
    );
    await expect(canvas.queryByText('Groups', { exact: true })).toBeNull();
  },
};

/** The reserved callback works for GET challenges; message setup is still incomplete. */
export const MetaPending: Story = {
  render: () => (
    <Channels
      {...sectionProps({
        data: {
          ...profileData,
          channels: [
            {
              id: ids.whatsapp,
              profileId: ids.zero,
              type: 'whatsapp-business',
              whatsappBusinessStatus: 'pending',
              createdAt: '2026-10-23T12:00:00Z',
              allowAllContacts: false,
            },
          ],
          contacts: [],
          groups: [],
        },
      })}
    />
  ),
  play: async (context) => {
    await open('whatsapp-business')(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByText('Setup pending', { exact: true })).toBeVisible();
    await expect(canvas.getByLabelText('Access token')).toHaveAttribute('type', 'password');
    await expect(canvas.getByLabelText('App secret')).toHaveAttribute('type', 'password');
    await expect(canvas.queryByLabelText('Verify token')).toBeNull();
    await expect(canvas.getByRole('textbox', { name: 'Meta callback URL' })).toHaveValue(
      `${window.location.origin}/v1/whatsapp-business/${ids.whatsapp}`,
    );
  },
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
