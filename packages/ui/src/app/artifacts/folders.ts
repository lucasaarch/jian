import { NO_PROJECT } from '@jian/contracts';
import type { ArtifactFolder, ArtifactFolders, ProfileArtifact, Project } from '../../lib/api';

/*
 * Where the page's Artifacts are kept. Each starts under the project of the conversation it was
 * made in, or under "No project": folders nobody made, which exist while they hold something.
 * The owner makes folders of their own and moves Artifacts into them. A place is any of the
 * three, and "All" is every one of them at once.
 */

export const ALL = 'all';
export const NO_PROJECT_NAME = 'No project';

export type Place = {
  /** What it is told apart by: `all`, a project's id or `none` after `project:`, a folder's id. */
  key: string;
  name: string;
  /** How many it holds; unknown for all of them together. */
  artifacts?: number;
  /** One the owner made, which alone is renamed and deleted. */
  folder?: ArtifactFolder;
  /** A project's id, or `none`: what a new conversation started from here is put in. */
  project?: string;
};

/** All of them at once, which is where the page starts and what it falls back to. */
export const EVERYTHING: Place = { key: ALL, name: 'All' };

/** Every place in the order the page offers them: all, the projects, no project, the owner's. */
export function placesOf(found: ArtifactFolders | undefined): Place[] {
  if (!found) return [EVERYTHING];

  return [
    EVERYTHING,
    ...found.projects.map((project) => ({
      key: `project:${project.projectId ?? NO_PROJECT}`,
      name: project.projectId ? (project.name ?? 'Project') : NO_PROJECT_NAME,
      artifacts: project.artifacts,
      project: project.projectId ?? NO_PROJECT,
    })),
    ...found.folders.map((folder) => ({
      key: `folder:${folder.id}`,
      name: folder.name,
      artifacts: folder.artifacts,
      folder,
    })),
  ];
}

/** What the gateway is asked for the Artifacts of a place; nothing for all of them. */
export function placeQuery(place: Place): { folder?: string; project?: string } {
  if (place.folder) return { folder: place.folder.id };
  if (place.project) return { project: place.project };
  return {};
}

/** The project a conversation started from a place goes in, where the place is a project's. */
export const placeProject = (place: Place) =>
  place.project && place.project !== NO_PROJECT ? place.project : undefined;

/** The name of where an Artifact started, which moving it out of every folder puts it back in. */
export function homeName(artifact: ProfileArtifact, projects: Project[]) {
  if (!artifact.projectId) return NO_PROJECT_NAME;
  return projects.find((project) => project.id === artifact.projectId)?.name ?? 'Its project';
}
