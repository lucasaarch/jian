import type { BuiltinSkill, Skill } from '../../lib/api';
import { matchesQuery } from '../../lib/search';
import { sourceOf } from './origin';

/** Where a skill stands to the owner: written for this agent, copied from a repository, or shipped. */
type SkillKind = 'yours' | 'imported' | 'built-in';
export type SkillFilter = SkillKind | 'all';

export const skillFilters: { value: SkillFilter; label: string }[] = [
  { value: 'all', label: 'All skills' },
  { value: 'yours', label: 'Written here' },
  { value: 'imported', label: 'Imported' },
  { value: 'built-in', label: 'Built-in' },
];

/** One card: the agent's own skill or a built-in one, drawn alike. */
export type SkillItem = {
  /** Names may repeat across the two lists, so the kind belongs to the key. */
  key: string;
  kind: SkillKind;
  name: string;
  description: string;
  instructions: string;
  /** Who it is owed to, in a word: Imported, Anthropic, Built-in. */
  source: string;
  /** Its place in the agent's own list; a built-in skill has none. */
  index?: number;
  enabled: boolean;
};

/** The agent's own skills first, in their order, then the built-in ones as the gateway lists them. */
export function skillItems(
  own: Skill[],
  builtIn: BuiltinSkill[],
  agentName: string,
  enabled: (name: string) => boolean,
): SkillItem[] {
  return [
    ...own.map((skill, index): SkillItem => {
      const { label } = sourceOf(skill, agentName);
      return {
        key: `own:${skill.name}`,
        // Only a skill with an address was copied from somewhere; the rest were written here.
        kind: skill.origin?.url ? 'imported' : 'yours',
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        source: label,
        index,
        enabled: true,
      };
    }),
    ...builtIn.map(
      (skill): SkillItem => ({
        key: `built-in:${skill.name}`,
        kind: 'built-in',
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        source: 'Built-in',
        enabled: enabled(skill.name),
      }),
    ),
  ];
}

export function filterSkills(items: SkillItem[], query: string, filter: SkillFilter) {
  return items.filter(
    (item) =>
      (filter === 'all' || item.kind === filter) &&
      matchesQuery(`${item.name} ${item.description} ${item.source}`, query),
  );
}
