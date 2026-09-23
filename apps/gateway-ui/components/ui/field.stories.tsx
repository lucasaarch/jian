import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { Field } from './field';
import { Select } from './select';
import { StackedFields } from './stacked-fields';

const meta = {
  title: 'UI/Form',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const TextField: Story = {
  render: () => (
    <div className="max-w-md">
      <Field label="Name" hint="How the other agents address this one.">
        <input defaultValue="Zero Two" />
      </Field>
    </div>
  ),
};

export const Secret: Story = {
  render: () => (
    <div className="max-w-md">
      <Field label="Tavily key" hint="What you save here is never shown again.">
        <input type="password" autoComplete="off" />
      </Field>
    </div>
  ),
};

export const Checkbox: Story = {
  render: () => (
    <label className="check-row max-w-xl">
      <input type="checkbox" defaultChecked />
      <span>
        <strong>Allow web search</strong>
        <small>
          The agent may search the internet and read public pages. Pages are written by strangers
          and can try to steer it.
        </small>
      </span>
    </label>
  ),
};

const efforts = [
  { value: 'low', label: 'Low', detail: 'Fast and cheap' },
  { value: 'medium', label: 'Medium', detail: 'The default' },
  { value: 'high', label: 'High', detail: 'Slow, spends the most' },
];

export const SelectMenu: Story = {
  render: function Render() {
    const [value, setValue] = useState('medium');

    return (
      <div className="max-w-xs">
        <Field label="Reasoning">
          <Select value={value} onValueChange={setValue} options={efforts} aria-label="Reasoning" />
        </Field>
      </div>
    );
  },
};

export const Stacked: Story = {
  render: () => (
    <div className="max-w-xl">
      <StackedFields>
        <Field label="Header">
          <input defaultValue="Authorization" />
        </Field>
        <Field label="Value">
          <input type="password" />
        </Field>
      </StackedFields>
    </div>
  ),
};
