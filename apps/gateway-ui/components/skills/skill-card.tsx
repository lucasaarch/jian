import type { ReactNode } from 'react';

/**
 * One skill as a card: its name, what it is for, where it comes from, and what can be done with
 * it. The grid lays several side by side; a long description is the card's to wrap.
 */
export function SkillCard({
  name,
  description,
  source,
  actions,
}: {
  name: string;
  description: string;
  source: ReactNode;
  actions: ReactNode;
}) {
  return (
    <article className="skill-card" id={`skill-${name}`}>
      <h3>{name}</h3>
      <p>{description}</p>
      <footer>
        <span className="skill-card-source">{source}</span>
        <span className="skill-card-actions">{actions}</span>
      </footer>
    </article>
  );
}
