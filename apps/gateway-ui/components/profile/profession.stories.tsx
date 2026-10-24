import type { EffectiveProfession } from '@jian/contracts';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';
import { sectionProps } from '../../stories/section';
import { ProfessionDescriptor, ProfileProfession } from './profession';

const meta = {
  title: 'Sections/Agent/Profession',
  component: ProfessionDescriptor,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ProfessionDescriptor>;

export default meta;
type Story = StoryObj<typeof meta>;

const legacyProfession: EffectiveProfession = {
  status: 'legacy_unclassified',
  scope: 'configuration',
  assignable: false,
  profession: null,
  ceilingCapabilities: null,
  configurationEffectiveCapabilities: null,
};

const classified: EffectiveProfession = {
  status: 'classified',
  scope: 'configuration',
  assignable: false,
  profession: { id: 'developer', label: 'Developer', policyVersion: 1 },
  ceilingCapabilities: ['workspace.files', 'process.exec', 'web.browse'],
  configurationEffectiveCapabilities: ['workspace.files', 'process.exec'],
};

export const LegacyUnclassified: Story = {
  args: { descriptor: legacyProfession },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Legacy / unclassified')).toBeVisible();
    await expect(canvas.getByText(/Existing behavior is unchanged/)).toBeVisible();
    await expect(canvas.queryByRole('button')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('checkbox')).not.toBeInTheDocument();
  },
};

export const ClassifiedUnavailable: Story = {
  args: { descriptor: classified },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Profession assignment unavailable')).toBeVisible();
    await expect(canvas.getByText(/not authorization to run/)).toBeVisible();
    await userEvent.click(canvas.getByText('Configuration capability details'));
    await expect(canvas.getByRole('heading', { name: 'Profession ceiling' })).toBeVisible();
    await expect(canvas.getByText('web.browse')).toBeVisible();
    await expect(canvas.queryByRole('checkbox')).not.toBeInTheDocument();
  },
};

export const Loading: Story = {
  args: { descriptor: legacyProfession },
  render: () => {
    const { api, profile } = sectionProps();
    return (
      <ProfileProfession
        profile={profile}
        api={{ ...api, profileProfession: () => new Promise(() => {}) }}
      />
    );
  },
};

export const ReadFailure: Story = {
  args: { descriptor: legacyProfession },
  render: () => {
    const { api, profile } = sectionProps();
    return (
      <ProfileProfession
        profile={profile}
        api={{
          ...api,
          profileProfession: async () => {
            throw new Error('Unavailable');
          },
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent(
      'Identity editing is still available',
    );
  },
};
