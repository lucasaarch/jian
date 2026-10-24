'use client';

import type { EffectiveProfession } from '@jian/contracts';
import { useEffect, useState } from 'react';
import type { GatewayApi, Profile } from '../../lib/api';
import { Badge } from '../ui';

/** Server-derived configuration only. Never infer run authority from these lists. */
export function ProfessionDescriptor({ descriptor }: { descriptor: EffectiveProfession }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <strong>
          {descriptor.status === 'classified'
            ? descriptor.profession.label
            : 'Legacy / unclassified'}
        </strong>
        <Badge>Profession assignment unavailable</Badge>
      </div>
      {descriptor.status === 'legacy_unclassified' ? (
        <p className="muted">
          No profession is assigned. Existing behavior is unchanged. A profession ceiling and
          configuration-effective capabilities are not resolved for this legacy profile; this does
          not mean all capabilities or no capabilities.
        </p>
      ) : (
        <>
          <p className="muted">
            Policy version {descriptor.profession.policyVersion}. The profession ceiling contains{' '}
            {descriptor.ceilingCapabilities.length} capabilities;{' '}
            {descriptor.configurationEffectiveCapabilities.length} remain after profile
            configuration. This does not mean the profession is available for assignment or enabled
            for use.
          </p>
          <details>
            <summary className="cursor-pointer">Configuration capability details</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <CapabilityList
                title="Profession ceiling"
                capabilities={descriptor.ceilingCapabilities}
              />
              <CapabilityList
                title="Configuration-effective capabilities"
                capabilities={descriptor.configurationEffectiveCapabilities}
              />
            </div>
          </details>
        </>
      )}
      <p className="muted small">
        Configuration only — not authorization to run or access a resource. Run context, inherited
        restrictions, resource permissions, and model or service availability can restrict execution
        further.
      </p>
    </>
  );
}

function CapabilityList({ title, capabilities }: { title: string; capabilities: string[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {capabilities.length ? (
        <ul className="mt-2 space-y-1">
          {capabilities.map((capability) => (
            <li key={capability}>
              <code className="small">{capability}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None in this configuration.</p>
      )}
    </div>
  );
}

export function ProfileProfession({ profile, api }: { profile: Profile; api: GatewayApi }) {
  const [state, setState] = useState<{
    profileId: string;
    version: number;
    descriptor?: EffectiveProfession;
    error?: boolean;
  }>();

  useEffect(() => {
    let current = true;
    void api.profileProfession(profile.id).then(
      (descriptor) => {
        if (current) setState({ profileId: profile.id, version: profile.version, descriptor });
      },
      () => {
        if (current) setState({ profileId: profile.id, version: profile.version, error: true });
      },
    );
    return () => {
      current = false;
    };
  }, [api, profile.id, profile.version]);

  const current =
    state?.profileId === profile.id && state.version === profile.version ? state : null;

  return (
    <section aria-label="Profession" className="mb-8 space-y-3 rounded-sm border border-line p-5">
      <h2>Profession</h2>
      {current?.descriptor ? (
        <ProfessionDescriptor descriptor={current.descriptor} />
      ) : current?.error ? (
        <p role="alert" className="form-error">
          Could not load profession details. Identity editing is still available.
        </p>
      ) : (
        <p role="status" className="muted">
          Loading profession details…
        </p>
      )}
    </section>
  );
}
