import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { X_TOOL_GROUPS } from '../src/integrations/x/catalog/index.js';
import { builtinSkillNames, builtinSkills } from '../src/skills/builtin/index.js';
import { machineToolsFor } from '../src/skills/builtin/machine-tools.js';
import { sshKeysFor } from '../src/skills/builtin/ssh-keys.js';
import { xFor } from '../src/skills/builtin/x.js';

const source = fileURLToPath(new URL('../src', import.meta.url));

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === 'builtin' ? [] : sources(path);
    return path.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

const code = sources(source).join('\n');
const defined = new Set(
  [...code.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+): (?:tool|dynamicTool)\(/g)].map(
    (match) => match[1] as string,
  ),
);
const xTools = new Set<string>(Object.values(X_TOOL_GROUPS).flatMap(({ tools }) => [...tools]));
const github = {
  name: 'github',
  transport: 'http' as const,
  url: 'https://api.githubcopilot.com/mcp/',
  auth: 'none' as const,
  headers: [],
  args: [],
  env: [],
  disabledTools: [],
};
// With what only a desktop's run is told: this file runs as a server.
const everything = [
  ...builtinSkills([github], { worktrees: true }),
  machineToolsFor(true),
  sshKeysFor(true),
];
const text = everything.map(({ instructions }) => instructions).join('\n');

/** Written like a tool in a skill, and no tool: fields, actions and values the skills teach. */
const NOT_TOOLS = new Set([
  'create_issue',
  'documentation_url',
  'double_click',
  'end_session',
  'left_click',
  'left_click_drag',
  'mouse_move',
  'node_modules',
  'reply_to',
  'right_click',
]);

/** Plain enough from their own description, so no skill has to teach them. */
const SELF_EVIDENT = new Set(['read_memories', 'load_skill', 'list_activities']);

/** Names of what the panel used to have: a skill that says one sends the owner nowhere. */
const GONE = [
  /\bOverview\b/,
  /\bCustomize\b/,
  /Model defaults/,
  /Gateway →/,
  /→ MCPs/,
  /\bListening\b/,
  /listening for GitHub/,
  // Settings → Integrations became Apps and MCP servers.
  /\bIntegrations\b/,
];

describe('what the built-in skills say', () => {
  it('names only tools that exist', () => {
    const named = [...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map(
      (match) => match[1] as string,
    );
    const unknown = [...new Set(named)].filter(
      (name) =>
        !defined.has(name) &&
        !xTools.has(name) &&
        !NOT_TOOLS.has(name) &&
        !(name in X_TOOL_GROUPS) &&
        // A tool built apart from `tool(`, such as the loaders, is still named in the code.
        !new RegExp(`\\b${name}\\b`).test(code),
    );

    expect(unknown).toEqual([]);
  });

  it('teaches every tool a run can have', () => {
    const untaught = [...defined].filter(
      (name) => !text.includes(name) && !xTools.has(name) && !SELF_EVIDENT.has(name),
    );

    expect(untaught).toEqual([]);
  });

  it('points only at skills that exist', () => {
    const pointed = [...text.matchAll(/`([a-z][a-z0-9-]+)` skill/g)].map(
      (match) => match[1] as string,
    );

    expect(pointed.filter((name) => !builtinSkillNames.has(name))).toEqual([]);
  });

  it('does not send the owner to a place the panel no longer has', () => {
    for (const skill of everything) {
      for (const gone of GONE) expect(skill.instructions, skill.name).not.toMatch(gone);
    }
  });

  it('never teaches X to a run that does not have it', () => {
    const tools = /x_post|x_credits|load_tools/;

    expect(xFor({ connected: true, subagent: false }).instructions).toMatch(tools);
    expect(xFor({ connected: false, subagent: false }).instructions).not.toMatch(tools);
    expect(xFor({ connected: true, subagent: true }).instructions).not.toMatch(tools);
  });
});
