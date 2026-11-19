'use client';

import { Menu } from '@base-ui/react/menu';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { iconButton, MenuEntry, menuPopup } from '../../../kit';
import type { DeckExportQuery, SessionArtifact } from '../../../lib/api';
import { countUsage } from '../../../lib/usage';
import { Spinner } from '../../ui/spinner';
import { download, fileName, fileOf } from './source';
import type { ArtifactsApi } from './use-artifacts';

/**
 * A Document or a spreadsheet taken away as a file, behind one button of its bar. The source is
 * the panel's own to save (Markdown); every other file is made by the gateway (artifacts/export.ts
 * there). Word, Excel and CSV need no browser, so every gateway makes them; a Document's PDF is
 * drawn by one, which only a server gateway has (`drawn`), so the desktop app's own does not offer it.
 */
export function ArtifactDownload({
  api,
  profileId,
  artifact,
  version,
  source,
  drawn,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
  /** The version in view. */
  version: number;
  /** Its source as written; undefined until it is read. */
  source: string | undefined;
  drawn: boolean;
}) {
  // One file at a time: a PDF waits for the gateway's one browser anyway.
  const [making, setMaking] = useState(false);
  const document = artifact.type === 'markdown';

  const take = async (wanted: DeckExportQuery, extension: string) => {
    if (making) return;
    setMaking(true);
    countUsage(`artifact_downloaded_${wanted.format}`);
    try {
      download(
        fileName(artifact, version, undefined, extension),
        fileOf(
          await api.exportSessionArtifact(
            profileId,
            artifact.sessionId,
            artifact.id,
            version,
            wanted,
          ),
        ),
      );
    } catch (error) {
      // The gateway's own sentence: it says why a file could not be made.
      toast.error(error instanceof Error ? error.message : 'The file could not be downloaded.');
    } finally {
      setMaking(false);
    }
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Download"
        aria-busy={making}
        disabled={making}
        className={iconButton}
      >
        {making ? <Spinner size={15} /> : <Download size={15} aria-hidden="true" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} min-w-60`}>
            {document ? (
              <>
                <MenuEntry onClick={() => void take({ format: 'docx' }, 'docx')}>
                  Word (.docx)
                </MenuEntry>
                {drawn && (
                  <MenuEntry onClick={() => void take({ format: 'pdf' }, 'pdf')}>
                    PDF (.pdf)
                  </MenuEntry>
                )}
                <MenuEntry
                  disabled={source === undefined}
                  onClick={() => {
                    if (source === undefined) return;
                    countUsage('artifact_downloaded_source');
                    download(fileName(artifact, version), source);
                  }}
                >
                  Markdown (.md)
                </MenuEntry>
              </>
            ) : (
              <>
                <MenuEntry onClick={() => void take({ format: 'xlsx' }, 'xlsx')}>
                  Excel (.xlsx)
                </MenuEntry>
                <MenuEntry onClick={() => void take({ format: 'csv' }, 'csv')}>
                  CSV, values (.csv)
                </MenuEntry>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
