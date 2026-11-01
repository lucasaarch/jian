import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** A GitHub repository as it can be offered, whether or not this agent has opened it yet. */
export type RepositoryItem = {
  name: string;
  githubAccountId?: string | undefined;
  githubRepositoryId?: number | undefined;
  /** Already this agent's project. Without it, one is opened when the chat starts. */
  projectId?: string | undefined;
};

/** Where a repository, or a chat from scratch, is worked on. */
export type ChatPlace =
  | { kind: 'cloud' }
  | { kind: 'machine'; id: string }
  /** This computer, cloning into a folder the owner picked. */
  | { kind: 'here'; cloneInto: string };

/** What a new chat will work on. */
export type WorkspaceChoice =
  | { kind: 'scratch'; place: ChatPlace }
  | { kind: 'folders'; folders: string[] }
  | { kind: 'repositories'; repositories: RepositoryItem[]; place: ChatPlace };

export const FROM_SCRATCH: WorkspaceChoice = { kind: 'scratch', place: { kind: 'cloud' } };

type Workspaces = {
  /** Newest first, and never forgotten: a folder picked once stays a click away. */
  folders: string[];
  remember: (folder: string) => void;
  /** What the next new chat starts on, as a folder's own new chat asks. Taken once. */
  next?: WorkspaceChoice | undefined;
  startOn: (choice: WorkspaceChoice) => void;
  takeNext: () => WorkspaceChoice | undefined;
};

/** Kept per browser and app: a folder belongs to the computer it is on, whichever gateway. */
export const useWorkspaces = create<Workspaces>()(
  persist(
    (set, get) => ({
      folders: [],
      remember: (folder) =>
        set(({ folders }) => ({ folders: [folder, ...folders.filter((item) => item !== folder)] })),
      startOn: (next) => set({ next }),
      takeNext: () => {
        const { next } = get();
        if (next) set({ next: undefined });
        return next;
      },
    }),
    { name: 'jian-workspace-folders', partialize: ({ folders }) => ({ folders }) },
  ),
);

/** A folder by its last name, as the sidebar and the chooser call it. */
export const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path;

/** A repository by its own name, without its owner, so it meets a folder of that name. */
export const repositoryName = (name: string) => name.split('/').pop() || name;
