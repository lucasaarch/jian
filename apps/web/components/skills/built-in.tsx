'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Eye, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Profile } from '@/lib/api';
import { keys } from '@/lib/query/keys';
import { matchesQuery } from '@/lib/search';
import type { BuiltinSkill } from '../../lib/api';
import type { SectionActions } from '../props';
import { Button, SearchField, Switch } from '../ui';
import { SkillCard } from './skill-card';
import { SkillView } from './skill-view';

/**
 * Skills that ship with the gateway. The owner cannot edit one, so the instructions are shown
 * in full: what an agent was told has to be readable by the person answering for it.
 */
export function BuiltinSkills({
  profile,
  api,
  mutate,
  busy,
}: SectionActions & { profile: Profile }) {
  const [open, setOpen] = useState<string>();
  const [query, setQuery] = useState('');
  // Keyed by the profile's version: a toggle, here or by the agent, changes which are enabled.
  const builtIn = useQuery({
    queryKey: [...keys.builtinSkills(profile.id), profile.version],
    queryFn: () => api.builtinSkills(profile.id),
    placeholderData: keepPreviousData,
  });
  const skills = builtIn.data ?? [];
  const shown = skills.filter((skill) => matchesQuery(`${skill.name} ${skill.description}`, query));
  const error = builtIn.error
    ? builtIn.error instanceof Error
      ? builtIn.error.message
      : 'Could not load.'
    : '';

  const toggle = (skill: BuiltinSkill) =>
    mutate(
      () =>
        api.updateProfile(profile.id, {
          expectedVersion: profile.version,
          disabledSkills: skill.enabled
            ? [...profile.disabledSkills, skill.name]
            : profile.disabledSkills.filter((name) => name !== skill.name),
        }),
      skill.enabled ? `${skill.name} switched off.` : `${skill.name} switched on.`,
    );

  if (error) {
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  }

  const viewing = skills.find((skill) => skill.name === open);

  return (
    <section className="row-group" aria-labelledby="skills-built-in">
      <div className="skills-heading">
        <div>
          <h2 id="skills-built-in">Built in</h2>
          <p>They ship with the gateway and teach the agent to use what Jian gives it.</p>
        </div>
        <SearchField
          aria-label="Search built-in skills"
          placeholder="Search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {shown.length ? (
        <div className="skill-grid">
          {shown.map((skill) => (
            <SkillCard
              key={skill.name}
              name={skill.name}
              description={skill.description}
              source={
                <>
                  <ShieldCheck size={14} aria-hidden="true" />
                  Built in
                </>
              }
              actions={
                <>
                  <Button variant="quiet" onClick={() => setOpen(skill.name)}>
                    <Eye size={14} />
                    View
                  </Button>
                  <Switch
                    checked={skill.enabled}
                    label={`${skill.name} ${skill.enabled ? 'on' : 'off'}`}
                    disabled={busy}
                    onChange={() => void toggle(skill)}
                  />
                </>
              }
            />
          ))}
        </div>
      ) : (
        skills.length > 0 && <p className="skill-grid-empty">No built-in skill matches.</p>
      )}
      {viewing && (
        <SkillView
          name={viewing.name}
          description={viewing.description}
          instructions={viewing.instructions}
          close={() => setOpen(undefined)}
        />
      )}
    </section>
  );
}
