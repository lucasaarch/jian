'use client';

import { useState } from 'react';
import type { SectionActions } from '../../components/props';
import {
  type DecisionUse,
  decisionSwitched,
  decisionUses,
} from '../../components/providers/decision-uses';
import { useServiceKey } from '../../components/providers/use-service-key';
import { SettingsGroup, Toggle } from '../../kit';
import type { DecisionsStatus } from '../../lib/api/types';
import { type ServiceChange, ServiceRow } from './service-key-card';

/**
 * The services the whole installation reaches through a key of its own, a line each: searching
 * the web through Tavily, and quick second opinions from Jev — with, once Jev answers, which
 * judgements it makes in place of the fixed rules.
 */
export function ServicesCards({ api, mutate, busy }: SectionActions) {
  const tavily = useServiceKey(api.webSearch, mutate);
  const jev = useServiceKey(api.decisions, mutate);

  return (
    <>
      <SettingsGroup title="Services" note="For every agent">
        <ServiceRow
          service={{
            vendor: 'Tavily',
            source: 'tavily.com',
            description:
              'Lets agents with web search switched on search the internet and read pages. The free plan covers 1,000 searches a month.',
            removal: 'Agents can no longer search the web.',
            save: api.setWebSearch,
            remove: api.removeWebSearch,
          }}
          status={tavily.status}
          change={tavily.change}
          busy={busy}
        />
        <ServiceRow
          service={{
            vendor: 'Jev',
            source: 'typesafe.ai',
            description:
              'Second opinions for every agent from TypeSafe, which receives each message, action or short list it judges; a repeated question is answered from a cache. Without a key, the fixed rules decide.',
            removal: 'The fixed rules decide again.',
            save: api.setDecisions,
            remove: api.removeDecisions,
          }}
          status={jev.status}
          change={jev.change}
          busy={busy}
        />
      </SettingsGroup>
      {jev.status?.configured && (
        <DecisionUses
          status={jev.status}
          change={jev.change}
          updateDecisions={api.updateDecisions}
        />
      )}
    </>
  );
}

/**
 * Each judgement, switched between Jev and the fixed rule. A switch moves the moment it is
 * pressed, while the gateway is told; refused, it goes back to what the gateway holds, and the
 * refusal is said.
 */
function DecisionUses({
  status,
  change,
  updateDecisions,
}: {
  status: DecisionsStatus;
  change: ServiceChange<DecisionsStatus>;
  updateDecisions: SectionActions['api']['updateDecisions'];
}) {
  // What was pressed and not yet answered, over what the gateway last said.
  const [pressed, setPressed] = useState<Partial<Record<DecisionUse, boolean>>>({});

  const flip = async (use: DecisionUse, title: string, on: boolean) => {
    setPressed((current) => ({ ...current, [use]: on }));
    await change(() => updateDecisions({ uses: { [use]: on } }), decisionSwitched(title, on));
    // Answered either way: what the gateway holds now is shown, the new value or the old one.
    setPressed(({ [use]: _settled, ...rest }) => rest);
  };

  return (
    <SettingsGroup title="Decided by Jev" note="Off uses the fixed rule">
      {decisionUses.map(({ use, title, what }) => (
        <Toggle
          key={use}
          label={title}
          detail={what}
          checked={pressed[use] ?? status.uses[use]}
          onCheckedChange={(on) => void flip(use, title, on)}
        />
      ))}
    </SettingsGroup>
  );
}
