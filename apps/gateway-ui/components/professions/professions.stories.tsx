import type { ProfessionDefinition } from '@jian/contracts';
import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { gatewayApi } from '../../lib/api';
import * as fixtures from '../../stories/fixtures';
import { sectionProps } from '../../stories/section';
import { Field } from '../ui';
import { ProfessionAssignmentDialog } from './assignment-dialog';
import { ProfessionSelect } from './select';

const professions: ProfessionDefinition[] = [
  {
    id: 'developer',
    label: 'Developer',
    description: 'Software development with every capability defined for the profession.',
    policyVersion: 1,
    capabilities: [],
  },
  {
    id: 'attendant',
    label: 'Sales Attendant',
    description: 'Customer service within authorized conversations and business integrations.',
    policyVersion: 1,
    capabilities: [],
  },
];

const meta = {
  title: 'Professions/Assignment',
  component: ProfessionSelect,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ProfessionSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Selector: Story = {
  args: {
    professions,
    value: '',
    onValueChange: fn(),
  },
  render: (args) => (
    <Field label="Profession" hint="Profession-specific authority and product experience.">
      <ProfessionSelect {...args} />
    </Field>
  ),
};

export const FirstAssignmentDialog: Story = {
  args: { professions, value: '', onValueChange: fn() },
  render: () => {
    const { profile } = sectionProps();
    return (
      <ProfessionAssignmentDialog
        profile={{ ...profile, professionId: null }}
        api={gatewayApi()}
        close={fn()}
        assigned={fn(async () => {})}
      />
    );
  },
};

export const SalesAttendantAgent: Story = {
  name: 'Sales Attendant',
  args: { professions, value: 'attendant', onValueChange: fn() },
  render: () => {
    const attendant = fixtures.profiles.find((profile) => profile.id === fixtures.ids.ichigo);
    if (!attendant) throw new Error('The fixtures hold no Sales Attendant agent');
    return (
      <div className="max-w-lg space-y-3 rounded-sm border border-line p-5">
        <h2>{attendant.name}</h2>
        <p className="muted">
          Agents with the Sales Attendant profession are excluded from SSH Keys and Remote Control.
        </p>
        <ProfessionSelect
          professions={professions}
          value={attendant.professionId ?? ''}
          onValueChange={fn()}
        />
      </div>
    );
  },
};
