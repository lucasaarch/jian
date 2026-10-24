'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Field, SectionHeading } from '../../../components/ui';
import { gatewayApi, type Profile, type Team } from '../../../lib/api';

export default function TeamsPage() {
  const api = useMemo(() => gatewayApi(), []);
  const [teams, setTeams] = useState<Team[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Team>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [teamList, profileList] = await Promise.all([
        api.teams(),
        api.profiles() as unknown as Promise<Profile[]>,
      ]);
      setTeams(teamList);
      setProfiles(profileList);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível carregar as equipes.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const profileIds = Array.from(
      (event.currentTarget.elements.namedItem('profileIds') as HTMLSelectElement).selectedOptions,
      (option) => option.value,
    );
    setBusy(true);
    setError('');
    try {
      const body = {
        name: String(form.get('name') ?? '').trim(),
        description: String(form.get('description') ?? '').trim(),
        profileIds,
      };
      if (!body.name) {
        setError('Informe o nome da equipe.');
        return;
      }
      if (editing) await api.updateTeam(editing.id, body);
      else await api.createTeam(body);
      setEditing(undefined);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a equipe.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(team: Team) {
    if (!window.confirm(`Excluir a equipe “${team.name}”?`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteTeam(team.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível excluir a equipe.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="space-y-6">
      <SectionHeading
        title="Equipes"
        description="Organize agentes em equipes. Um agente pode participar de várias equipes."
        action={
          <Button
            type="button"
            onClick={() =>
              setEditing({
                id: '',
                name: '',
                description: '',
                profileIds: [],
                createdAt: '',
                updatedAt: '',
              })
            }
          >
            Nova equipe
          </Button>
        }
      />
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {editing && (
        <form className="connection-form" onSubmit={submit} aria-labelledby="team-form-title">
          <h2 id="team-form-title">{editing.id ? 'Editar equipe' : 'Nova equipe'}</h2>
          <Field label="Nome">
            <input name="name" required maxLength={120} defaultValue={editing.name} />
          </Field>
          <Field label="Descrição">
            <textarea
              name="description"
              rows={3}
              maxLength={2000}
              defaultValue={editing.description}
            />
          </Field>
          <Field
            label="Agentes"
            hint="Use Ctrl (Windows/Linux) ou Command (Mac) para selecionar vários agentes."
          >
            <select
              name="profileIds"
              multiple
              size={Math.min(Math.max(profiles.length, 3), 8)}
              aria-label="Agentes da equipe"
              defaultValue={editing.profileIds}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex gap-3">
            <Button type="submit" busy={busy}>
              Salvar equipe
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              Cancelar
            </Button>
          </div>
        </form>
      )}
      {loading ? (
        <p role="status">Carregando equipes…</p>
      ) : teams.length === 0 ? (
        <p>Nenhuma equipe criada ainda.</p>
      ) : (
        <ul className="space-y-3">
          {teams.map((team) => (
            <li key={team.id} className="resource-row">
              <div>
                <h2>{team.name}</h2>
                {team.description && <p>{team.description}</p>}
                <p>
                  {team.profileIds.length} {team.profileIds.length === 1 ? 'agente' : 'agentes'}
                </p>
                <ul aria-label={`Agentes de ${team.name}`}>
                  {team.profileIds.map((id) => (
                    <li key={id}>{profiles.find((profile) => profile.id === id)?.name ?? id}</li>
                  ))}
                </ul>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setEditing(team)}
                >
                  Editar
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={busy}
                  onClick={() => void remove(team)}
                >
                  Excluir
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
