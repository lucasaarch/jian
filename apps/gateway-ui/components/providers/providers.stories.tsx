import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, userEvent, within } from 'storybook/test';
import { profileData, sectionProps } from '../../stories/section';
import { withWorkspace } from '../../stories/workspace';
import { Providers } from '.';
import { ModelDefaults } from './model-defaults';
import { DecisionsRow, WebSearchRow } from './service-keys';

const meta = {
  title: 'Sections/Providers',
  decorators: [withWorkspace],
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connected: Story = { render: () => <Providers {...sectionProps()} /> };

export const NoneConnected: Story = {
  render: () => (
    <Providers {...sectionProps({ data: { ...profileData, providers: [], providerModels: {} } })} />
  ),
};

export const ModelChoices: Story = { render: () => <ModelDefaults {...sectionProps()} /> };

/** One activity's provider, model and effort, opened from its card. */
export const ConfigureConversations: Story = {
  render: () => <ModelDefaults {...sectionProps()} />,
  play: async ({ canvasElement }) => {
    const [configure] = within(canvasElement).getAllByRole('button', { name: /Configure/ });

    if (!configure) throw new Error('No activity card');
    await userEvent.click(configure);
    await expect(await within(document.body).findByText('Provider')).toBeInTheDocument();
  },
};

export const ServiceKeys: Story = {
  render: () => {
    const { api, mutate, busy } = sectionProps();

    return (
      <div className="resource-list">
        <WebSearchRow api={api} mutate={mutate} busy={busy} />
        <DecisionsRow api={api} mutate={mutate} busy={busy} />
      </div>
    );
  },
};
