'use client';

import { ArrowUpRight, ChevronDown, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BuiltinSkill } from '../../lib/api';
import type { SectionProps } from '../props';
import { Button } from '../ui';

/**
 * Skills that ship with the gateway. The owner cannot edit one, so the instructions are shown
 * in full: what an agent was told has to be readable by the person answering for it.
 */
export function BuiltinSkills({
  profile,
  api,
  mutate,
  busy,
}: Pick<SectionProps, 'profile' | 'api' | 'mutate' | 'busy'>) {
  const [skills, setSkills] = useState<BuiltinSkill[]>();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a toggle bumps the version, and the enabled flags are what must be read again.
  useEffect(() => {
    let alive = true;

    api
      .builtinSkills(profile.id)
      .then((list) => alive && setSkills(list))
      .catch(
        (failure) =>
          alive && setError(failure instanceof Error ? failure.message : 'Could not load.'),
      );

    return () => {
      alive = false;
    };
  }, [api, profile.id, profile.version]);

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

  return (
    <section className="built-in-skills" aria-label="Built-in skills">
      <header className="section-row">
        <div>
          <h2>Built in</h2>
          <p className="mt-1 text-sm">
            They ship with the gateway and are already on. They teach the agent to use what Jian
            gives it.
          </p>
        </div>
      </header>
      <div className="resource-list">
        {(skills ?? []).map((skill) => (
          <article className="resource-row built-in-row" key={skill.name}>
            <div className="resource-icon">
              <ShieldCheck size={20} />
            </div>
            <div className="grow">
              <h3>{skill.name}</h3>
              <p>{skill.description}</p>
              {skill.origin && (
                <div className="tag-list">
                  <a href={skill.origin.url} target="_blank" rel="noreferrer">
                    {skill.origin.marketplace ?? 'Marketplace'}
                    <ArrowUpRight size={13} />
                  </a>
                </div>
              )}
              <button
                type="button"
                className="text-button"
                aria-expanded={open === skill.name}
                onClick={() => setOpen(open === skill.name ? undefined : skill.name)}
              >
                <ChevronDown size={14} />
                {open === skill.name ? 'Hide the instructions' : 'Read the instructions'}
              </button>
              {open === skill.name && <pre className="skill-body">{skill.instructions}</pre>}
            </div>
            <Button variant="quiet" busy={busy} onClick={() => void toggle(skill)}>
              {skill.enabled ? 'Turn off' : 'Turn on'}
            </Button>
          </article>
        ))}
      </div>
    </section>
  );
}
