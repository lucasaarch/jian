'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '../../kit';
import type { ArtifactFolder, ProfileArtifact, SessionArtifact } from '../../lib/api';
import { RenameDialog, type Renaming } from '../chat-row';
import type { ArtifactKeeping } from './use-profile-artifacts';

/** The longest names the gateway keeps, in characters: an Artifact's, and a folder's. */
const TITLE_LENGTH = 120;
const FOLDER_LENGTH = 80;

/** What is being named: an Artifact or a folder again, or a folder for the first time. */
type Naming =
  | { kind: 'artifact'; artifact: SessionArtifact }
  | { kind: 'folder'; folder: ArtifactFolder }
  /** With `moving`, the Artifact the new folder is made for, moved into it once it exists. */
  | { kind: 'new'; moving?: ProfileArtifact };

/** What is about to be deleted. */
type Doomed = { artifact: SessionArtifact } | { folder: ArtifactFolder };

/** Says what the gateway refused with, in its own sentence, as when a paired phone asks. */
const refused = (error: unknown) => {
  toast.error(error instanceof Error ? error.message : 'That could not be done.');
  return undefined;
};

/**
 * Asks the gateway for something and says how it went: `done` when it worked, the gateway's
 * sentence when it did not. True when it was done.
 */
export async function attempt(run: () => Promise<unknown>, done?: string) {
  try {
    await run();
    if (done) toast.success(done);
    return true;
  } catch (error) {
    refused(error);
    return false;
  }
}

/**
 * The page's two dialogs, and what opens them: one that names (an Artifact, a folder, a folder
 * not made yet), one that asks before deleting (an Artifact for good, or a folder alone). What
 * each was opened for is kept while it closes, so its words do not change on the way out.
 */
export function useArtifactDialogs(
  keeping: ArtifactKeeping,
  /** A folder made from the page itself, not for one Artifact: the page goes to it. */
  onFolder: (folder: ArtifactFolder) => void,
) {
  const [naming, setNaming] = useState<Naming>();
  const [namingOpen, setNamingOpen] = useState(false);
  const [doomed, setDoomed] = useState<Doomed>();
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const renaming = (): Renaming | undefined => {
    if (!naming) return undefined;
    if (naming.kind === 'artifact') {
      return {
        what: 'Artifact',
        maxLength: TITLE_LENGTH,
        rename: (title) => attempt(() => keeping.change(naming.artifact, { title })),
      };
    }
    if (naming.kind === 'folder') {
      return {
        what: 'folder',
        maxLength: FOLDER_LENGTH,
        rename: (name) => attempt(() => keeping.renameFolder(naming.folder.id, name)),
      };
    }
    return {
      what: 'folder',
      heading: 'New folder',
      maxLength: FOLDER_LENGTH,
      rename: async (name) => {
        const folder = await keeping.createFolder(name).catch(refused);
        if (!folder) return false;
        const { moving } = naming;
        // The folder exists whatever comes of the move, so the dialog closes either way: asked
        // again, it would make a second folder of the same name.
        if (moving) {
          await attempt(
            () => keeping.change(moving, { folderId: folder.id }),
            `Moved to ${folder.name}.`,
          );
        } else onFolder(folder);
        return true;
      },
    };
  };

  const destroy = async () => {
    if (!doomed || deleting) return;
    setDeleting(true);
    const done =
      'artifact' in doomed
        ? await attempt(() => keeping.remove(doomed.artifact), `Deleted ${doomed.artifact.title}.`)
        : await attempt(
            () => keeping.deleteFolder(doomed.folder.id),
            `Deleted folder ${doomed.folder.name}.`,
          );
    setDeleting(false);
    if (done) setAsking(false);
  };

  const named = renaming();
  const lost = doomed && 'artifact' in doomed ? doomed.artifact : undefined;
  const emptied = doomed && 'folder' in doomed ? doomed.folder : undefined;

  return {
    name: (next: Naming) => {
      setNaming(next);
      setNamingOpen(true);
    },
    doom: (next: Doomed) => {
      setDoomed(next);
      setAsking(true);
    },
    dialogs: (
      <>
        {naming && named && (
          <RenameDialog
            open={namingOpen}
            onOpenChange={setNamingOpen}
            name={
              naming.kind === 'artifact'
                ? naming.artifact.title
                : naming.kind === 'folder'
                  ? naming.folder.name
                  : ''
            }
            renaming={named}
          />
        )}
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          title={`Delete ${lost ? lost.title : emptied ? `folder ${emptied.name}` : ''}?`}
          action={emptied ? 'Delete folder' : 'Delete Artifact'}
          busy={deleting}
          run={() => void destroy()}
        >
          {lost
            ? `It is deleted for good with ${lost.version === 1 ? 'its one version' : `all ${lost.version} of its versions`}${lost.visibility === 'public' ? ', and its public link stops working' : ''}. The conversation it was made in stays as it is.`
            : emptied
              ? `Only the folder is deleted. ${emptied.artifacts === 0 ? 'It holds nothing.' : `What it holds (${emptied.artifacts}) goes back under the project of the conversation each was made in.`}`
              : ''}
        </ConfirmDialog>
      </>
    ),
  };
}
