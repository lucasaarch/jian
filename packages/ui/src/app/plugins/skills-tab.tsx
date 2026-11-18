'use client';

import { ScrollText } from 'lucide-react';
import { type SkillItem, skillMeta } from '../../components/skills/skill-items';
import { type PluginItem, PluginList, PluginSection } from './plugin-list';

/** A skill as a row of Plugins: a page of writing for its mark, since a skill has none. */
export const skillRow = (item: SkillItem): PluginItem => ({
  id: item.key,
  icon: <ScrollText size={16} />,
  name: item.name,
  verified: item.kind === 'built-in',
  description: item.description,
  meta: skillMeta(item),
  ...(item.enabled ? {} : { status: 'Off', statusTone: 'quiet' as const }),
});

/**
 * The skills every agent shares, in two groups: the library, which the owner and the agents
 * write and the owner imports into, then the ones built into Jian. A group with nothing left
 * in it is not drawn.
 */
export function SkillsTab({
  items,
  onOpen,
}: {
  items: SkillItem[];
  onOpen: (key: string) => void;
}) {
  const library = items.filter((item) => item.kind !== 'built-in');
  const builtIn = items.filter((item) => item.kind === 'built-in');

  return (
    <>
      {library.length > 0 && (
        <PluginSection title="Library">
          <PluginList label="Library" items={library.map(skillRow)} onOpen={onOpen} />
        </PluginSection>
      )}
      {builtIn.length > 0 && (
        <PluginSection title="Built-in">
          <PluginList label="Built-in" items={builtIn.map(skillRow)} onOpen={onOpen} />
        </PluginSection>
      )}
    </>
  );
}
