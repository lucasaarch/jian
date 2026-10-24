'use client';

import type { ProfessionId, ProfessionPreview } from '@jian/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { GatewayApi, Profile } from '../../lib/api';
import { Button, Field, Modal } from '../ui';
import { ProfessionSelect } from './select';

export function ProfessionAssignmentDialog({
  profile,
  api,
  close,
  assigned,
}: {
  profile: Profile;
  api: GatewayApi;
  close: () => void;
  assigned: () => Promise<void>;
}) {
  const [professions, setProfessions] = useState<
    Awaited<ReturnType<GatewayApi['professions']>>['professions']
  >([]);
  const [selected, setSelected] = useState<ProfessionId | ''>('');
  const [preview, setPreview] = useState<ProfessionPreview>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadProfessions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { professions: choices } = await api.professions();
      setProfessions(choices);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load professions.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadProfessions();
  }, [loadProfessions]);

  async function prepare() {
    if (!selected) return;
    setBusy(true);
    setError('');
    setPreview(undefined);
    try {
      setPreview(await api.previewProfession(profile.id, selected, profile.version));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not prepare profession assignment.');
    } finally {
      setBusy(false);
    }
  }

  async function assign() {
    if (!selected || !preview?.assignable) return;
    setBusy(true);
    setError('');
    try {
      await api.assignProfession(profile.id, selected, profile.version);
      await assigned();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not assign this profession.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Choose a profession"
      description={`Choose a profession before using ${profile.name}. This fixes its authority and cannot be changed later. You can switch to another agent while this one is unclassified.`}
      close={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={preview?.assignable ? 'secondary' : 'primary'}
            busy={busy}
            disabled={loading || !selected}
            onClick={() => void prepare()}
          >
            Review assignment
          </Button>
          {preview?.assignable && (
            <Button busy={busy} onClick={() => void assign()}>
              Assign {professions.find((item) => item.id === selected)?.label}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Profession"
          hint="The profession sets this agent’s fixed authority. It cannot be changed after assignment."
        >
          <ProfessionSelect
            id="assign-profession"
            professions={professions}
            value={selected}
            disabled={loading || busy}
            onValueChange={(value) => {
              setSelected(value);
              setPreview(undefined);
              setError('');
            }}
          />
        </Field>
        {loading && (
          <p role="status" className="note text-muted">
            Loading professions…
          </p>
        )}
        {preview && (
          <section className="space-y-2" aria-label="Assignment impact" aria-live="polite">
            <p>
              {preview.assignable
                ? 'Ready to assign.'
                : `Assignment is blocked: ${preview.blockers.join(', ')}.`}
            </p>
            <p className="note text-muted">
              {preview.affected.queuedRuns} queued run(s) and{' '}
              {preview.affected.pendingRemoteTasks - preview.affected.runningRemoteTasks} queued
              Remote task(s) are preserved and resume after assignment. Active and waiting work must
              be resolved first.
            </p>
            <p className="note text-muted">
              {preview.affected.enabledSubscriptions} subscription(s) will be disabled for owner
              review.{' '}
              {preview.incompatibleMcpServers.length
                ? `These MCP servers will remain configured but unavailable: ${preview.incompatibleMcpServers.join(', ')}.`
                : 'Configured MCP servers are compatible with this profession.'}
            </p>
          </section>
        )}
        {error && (
          <div role="alert" className="form-error">
            {error}
            {!professions.length && (
              <Button variant="secondary" onClick={() => void loadProfessions()}>
                Try again
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
