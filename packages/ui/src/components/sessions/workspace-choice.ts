import type { GatewayApi, Project, Session } from '../../lib/api';
import {
  type RepositoryItem,
  repositoryName,
  type WorkspaceChoice,
} from '../../lib/stores/workspace-choice';
import type { ThisMachine } from '../../lib/this-machine';

/** What the gateway is told about a choice, once its repositories are this agent's projects. */
export type WorkspaceInput = {
  projectIds?: string[];
  folders?: string[];
  cloneInto?: string;
  remoteMachineId?: string;
};

/**
 * What a choice means on this gateway. Opening a repository as a project is left to here, so that
 * browsing the list creates nothing: only a chat that starts does.
 */
export async function workspaceInput(
  api: Pick<GatewayApi, 'ensureProject'>,
  profileId: string,
  choice: WorkspaceChoice,
  machine: ThisMachine | undefined,
): Promise<WorkspaceInput> {
  if (choice.kind === 'folders') {
    return {
      folders: choice.folders,
      // On the app's own gateway they are already within reach; on a server, through this machine.
      ...(machine?.machineId ? { remoteMachineId: machine.machineId } : {}),
    };
  }
  const place = choice.place;
  const at: WorkspaceInput =
    place.kind === 'machine'
      ? { remoteMachineId: place.id }
      : place.kind === 'here' && machine?.machineId
        ? { remoteMachineId: machine.machineId, cloneInto: place.cloneInto }
        : {};
  if (choice.kind === 'scratch') return at;

  const projectIds = await Promise.all(
    choice.repositories.map(async (repository) => {
      if (repository.projectId) return repository.projectId;
      const { githubAccountId, githubRepositoryId } = repository;
      if (!githubAccountId || !githubRepositoryId) {
        throw new Error(`${repository.name} is no longer connected.`);
      }
      return (await api.ensureProject(profileId, { githubAccountId, githubRepositoryId })).id;
    }),
  );
  return { projectIds, ...at };
}

const asItem = (project: Project): RepositoryItem => ({
  name: project.name,
  projectId: project.id,
  githubAccountId: project.githubAccountId,
  githubRepositoryId: project.githubRepositoryId,
});

/** The choice a chat was made with, for another one like it: a folder's own new chat. */
export function choiceOfSession(
  session: Session,
  projects: Project[],
  machine: ThisMachine | undefined,
): WorkspaceChoice {
  if (session.folders?.length) return { kind: 'folders', folders: session.folders };
  const ids = session.projectIds ?? (session.projectId ? [session.projectId] : []);
  const repositories = ids.flatMap((id) => {
    const project = projects.find((item) => item.id === id);
    return project ? [asItem(project)] : [];
  });
  const place: Extract<WorkspaceChoice, { kind: 'scratch' }>['place'] = !session.remoteMachineId
    ? { kind: 'cloud' }
    : session.remoteMachineId === machine?.machineId && session.cloneInto
      ? { kind: 'here', cloneInto: session.cloneInto }
      : { kind: 'machine', id: session.remoteMachineId };
  return repositories.length
    ? { kind: 'repositories', repositories, place }
    : { kind: 'scratch', place };
}

/** A project asked for by the address, as an older link or the agent's own may. */
export const choiceOfProject = (project: Project): WorkspaceChoice => ({
  kind: 'repositories',
  repositories: [asItem(project)],
  place: { kind: 'cloud' },
});

/** What the chooser's trigger says. */
export function choiceLabel(choice: WorkspaceChoice, folderName: (path: string) => string) {
  const names =
    choice.kind === 'folders'
      ? choice.folders.map(folderName)
      : choice.kind === 'repositories'
        ? choice.repositories.map((item) => repositoryName(item.name))
        : [];
  if (!names.length) return 'Start from scratch';
  return names.length === 1 ? (names[0] as string) : `${names[0]} + ${names.length - 1}`;
}
