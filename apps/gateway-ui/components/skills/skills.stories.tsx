import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import * as fixtures from '../../stories/fixtures';
import { sectionProps } from '../../stories/section';
import { Capabilities } from '.';
import { BuiltinSkills } from './built-in';
import { SkillCatalog } from './catalog';
import { SkillImport } from './import';
import { McpResult } from './mcp-check';
import { McpForm } from './mcp-form';
import { McpImport } from './mcp-import';
import { SkillForm } from './skill-form';

const meta = {
  title: 'Sections/Skills and MCP',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const props = () => sectionProps();

export const Skills: Story = { render: () => <Capabilities kind="skills" {...props()} /> };
export const McpServers: Story = {
  render: () => <Capabilities kind="mcpServers" {...props()} others={fixtures.profiles} />,
};
export const BuiltIn: Story = { render: () => <BuiltinSkills {...props()} /> };
export const Catalog: Story = { render: () => <SkillCatalog {...props()} /> };
export const ImportFromUrl: Story = { render: () => <SkillImport {...props()} /> };

export const NewSkill: Story = {
  render: () => <SkillForm busy={false} failed={false} onSave={fn()} onClose={fn()} />,
};

export const EditSkill: Story = {
  render: () => (
    <SkillForm
      skill={fixtures.profiles[0]?.skills[0]}
      busy={false}
      failed={false}
      onSave={fn()}
      onClose={fn()}
    />
  ),
};

/** Zero Two copies Miku's servers; github is refused, because Zero Two has one already. */
export const ImportMcpServers: Story = {
  render: () => {
    const [self, ...others] = fixtures.profiles as [
      (typeof fixtures.profiles)[number],
      ...typeof fixtures.profiles,
    ];

    return (
      <McpImport
        profile={self}
        sources={others.filter((profile) => profile.mcpServers.length > 0)}
        close={fn()}
        importServers={async (_from, servers) => ({ imported: servers, skipped: [], signIn: [] })}
      />
    );
  },
};

/** An agent with fifteen servers to offer: the list scrolls, the header and the button stay. */
export const ImportManyMcpServers: Story = {
  render: () => {
    const [self, miku] = fixtures.profiles as [
      (typeof fixtures.profiles)[number],
      (typeof fixtures.profiles)[number],
    ];
    const names = [
      'notion',
      'slack',
      'figma',
      'stripe',
      'atlassian',
      'vercel',
      'supabase',
      'sentry',
    ];
    const many = Array.from({ length: 15 }, (_, index) => ({
      ...miku.mcpServers[1],
      name: `${names[index % names.length]}${index >= names.length ? `_${index}` : ''}`,
      url: `https://mcp.${names[index % names.length]}.example/mcp`,
    })) as typeof miku.mcpServers;

    return (
      <McpImport
        profile={self}
        sources={[{ ...miku, mcpServers: many }]}
        close={fn()}
        importServers={async (_from, servers) => ({ imported: servers, skipped: [], signIn: [] })}
      />
    );
  },
};

export const NewMcpServer: Story = {
  render: () => <McpForm busy={false} error="" onSave={fn()} onClose={fn()} />,
};

export const EditMcpServer: Story = {
  render: () => (
    <McpForm
      server={fixtures.profiles[0]?.mcpServers[0]}
      busy={false}
      error=""
      onSave={fn()}
      onClose={fn()}
    />
  ),
};

const checkedAt = '2026-09-24T12:00:00.000Z';

export const McpReachable: Story = {
  render: () => (
    <McpResult
      error=""
      status={{
        name: 'github',
        reachable: true,
        tools: [
          { name: 'search_code', description: 'Search code across repositories.' },
          { name: 'create_issue' },
        ],
        checkedAt,
      }}
    />
  ),
};

export const McpNeedsSignIn: Story = {
  render: () => (
    <McpResult
      error=""
      status={{
        name: 'atlassian',
        reachable: false,
        tools: [],
        error: 'The server asked for a sign-in.',
        authorizationUrl: 'https://auth.example.com/authorize',
        checkedAt,
      }}
    />
  ),
};

export const McpUnreachable: Story = {
  render: () => <McpResult error="Outbound request failed (ECONNREFUSED)" />,
};
