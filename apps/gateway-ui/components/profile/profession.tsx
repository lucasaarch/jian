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
        <Badge>
          {descriptor.status === 'classified' ? 'Immutable assignment' : 'Assignment required'}
        </Badge>
      </div>
      {descriptor.status === 'legacy_unclassified' ? (
        <p className="muted">
          No profession is assigned. New and persisted work is held until you choose one; queued
          work is preserved and resumes after assignment. Choosing a profession does not delete
          profile data.
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
  const [professions, setProfessions] = useState<
    { id: 'developer' | 'attendant'; label: string }[]
  >([]);
  const [selectedProfession, setSelectedProfession] = useState<'developer' | 'attendant'>(
    'attendant',
  );
  const [preview, setPreview] = useState<Awaited<
    ReturnType<GatewayApi['previewProfession']>
  > | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assignmentError, setAssignmentError] = useState('');

  useEffect(() => {
    let current = true;
    void api
      .professions?.()
      .then(({ professions: values }) => {
        if (current) setProfessions(values);
      })
      .catch(() => {
        if (current) setAssignmentError('Could not load profession choices.');
      });
    return () => {
      current = false;
    };
  }, [api]);

  const prepareAssignment = async () => {
    setAssigning(true);
    setAssignmentError('');
    try {
      setPreview(await api.previewProfession(profile.id, selectedProfession, profile.version));
    } catch (error) {
      setAssignmentError(
        error instanceof Error ? error.message : 'Could not prepare profession assignment.',
      );
    } finally {
      setAssigning(false);
    }
  };

  const confirmAssignment = async () => {
    if (!preview?.assignable) return;
    const queuedRuns = preview.affected.queuedRuns;
    const queuedRemoteTasks =
      preview.affected.pendingRemoteTasks - preview.affected.runningRemoteTasks;
    const message = `Assign ${selectedProfession} to this agent? This changes its authority. No profile data will be deleted. ${queuedRuns} queued run(s) and ${queuedRemoteTasks} queued Remote task(s) will remain paused until assignment, then resume. ${preview.affected.enabledSchedules} schedule(s) remain configured. ${preview.affected.enabledSubscriptions} subscription(s) will be disabled for owner review. Incompatible MCP configurations are kept but unavailable under the selected profession.`;
    if (!window.confirm(message)) return;
    setAssigning(true);
    setAssignmentError('');
    try {
      await api.assignProfession(profile.id, selectedProfession, profile.version);
      setPreview(null);
      const descriptor = await api.profileProfession(profile.id);
      setState({ profileId: profile.id, version: profile.version, descriptor });
    } catch (error) {
      setAssignmentError(error instanceof Error ? error.message : 'Could not assign profession.');
    } finally {
      setAssigning(false);
    }
  };

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
        <>
          <ProfessionDescriptor descriptor={current.descriptor} />
          {current.descriptor.status === 'legacy_unclassified' && (
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block">Choose profession</span>
                <select
                  value={selectedProfession}
                  disabled={assigning || !professions.length}
                  onChange={(event) => {
                    setSelectedProfession(event.target.value as 'developer' | 'attendant');
                    setPreview(null);
                  }}
                >
                  {professions.map((profession) => (
                    <option key={profession.id} value={profession.id}>
                      {profession.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button button-secondary"
                disabled={assigning || !professions.length}
                onClick={() => void prepareAssignment()}
              >
                Preview assignment
              </button>
              {preview && (
                <div className="space-y-2" role="status">
                  <p>
                    {preview.assignable
                      ? 'Ready to assign.'
                      : `Cannot assign yet: ${preview.blockers.join(', ')}.`}
                  </p>
                  <p className="muted">
                    Queued runs: {preview.affected.queuedRuns}; queued Remote tasks:{' '}
                    {preview.affected.pendingRemoteTasks - preview.affected.runningRemoteTasks}.
                    Active or waiting work must be resolved before assignment.
                  </p>
                  <p className="muted">
                    Schedules: {preview.affected.enabledSchedules} retained. Subscriptions:{' '}
                    {preview.affected.enabledSubscriptions} will be disabled for owner review. Open
                    objectives: {preview.affected.openObjectives} retained. Incompatible MCP
                    servers: {preview.incompatibleMcpServers.join(', ') || 'none'} (kept in
                    configuration, but unavailable under this profession).
                  </p>
                  {preview.assignable && (
                    <button
                      type="button"
                      className="button"
                      disabled={assigning}
                      onClick={() => void confirmAssignment()}
                    >
                      Assign profession
                    </button>
                  )}
                </div>
              )}
              {assignmentError && (
                <p role="alert" className="form-error">
                  {assignmentError}
                </p>
              )}
            </div>
          )}
        </>
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
