'use client';

import { Menu } from '@base-ui/react/menu';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { iconButton, MenuDivider, MenuEntry, menuPopup } from '../../../../kit';
import type { DeckExportQuery, SessionArtifact } from '../../../../lib/api';
import { Spinner } from '../../../ui/spinner';
import { download, fileName, fileOf } from '../source';
import type { ArtifactsApi } from '../use-artifacts';

/**
 * A deck taken away as a file, behind one button of its bar. The page of the slide in view is
 * its source, which the panel already holds. Every other file is the slides drawn, and the panel
 * cannot draw one: it never sees inside the sealed frame a slide runs in. The gateway draws them
 * in a browser of its own, as sealed, and answers the file (the gateway's artifacts/export.ts).
 *
 * `drawn` says the gateway has that browser. The one a desktop app runs has none, so there the
 * menu offers the page alone, rather than files it would refuse to make.
 */
export function DeckDownload({
  api,
  profileId,
  artifact,
  version,
  slide,
  source,
  drawn,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
  /** The version in view. */
  version: number;
  /** The slide in view, counted from 0; undefined until the version is read. */
  slide: number | undefined;
  /** That slide's page as written. */
  source: string | undefined;
  drawn: boolean;
}) {
  // One file at a time: the gateway draws one deck at a time too, and a second would only wait.
  const [drawing, setDrawing] = useState(false);
  const at = slide === undefined ? undefined : slide + 1;

  const take = async (wanted: DeckExportQuery, name: string) => {
    if (drawing) return;
    setDrawing(true);
    try {
      download(
        name,
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
      // The gateway's own sentence: it says why a deck could not be drawn.
      toast.error(error instanceof Error ? error.message : 'The deck could not be downloaded.');
    } finally {
      setDrawing(false);
    }
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Download"
        aria-busy={drawing}
        disabled={drawing}
        className={iconButton}
      >
        {drawing ? <Spinner size={15} /> : <Download size={15} aria-hidden="true" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} min-w-60`}>
            {drawn && (
              <MenuEntry
                disabled={at === undefined}
                onClick={() =>
                  void take({ format: 'pdf' }, fileName(artifact, version, undefined, 'pdf'))
                }
              >
                PDF (.pdf)
              </MenuEntry>
            )}
            <MenuEntry
              disabled={source === undefined}
              onClick={() =>
                source !== undefined && download(fileName(artifact, version, at), source)
              }
            >
              Web page (.html)
            </MenuEntry>
            {drawn && (
              <>
                <MenuEntry
                  disabled={at === undefined}
                  onClick={() =>
                    at !== undefined &&
                    void take({ format: 'png', slide: at }, fileName(artifact, version, at, 'png'))
                  }
                >
                  Current slide as an image (.png)
                </MenuEntry>
                <MenuDivider />
                <MenuEntry
                  disabled={at === undefined}
                  onClick={() =>
                    void take({ format: 'pptx' }, fileName(artifact, version, undefined, 'pptx'))
                  }
                >
                  PowerPoint, current fonts (.pptx)
                </MenuEntry>
                <MenuEntry
                  disabled={at === undefined}
                  onClick={() =>
                    void take(
                      { format: 'pptx', fonts: 'basic' },
                      fileName(artifact, version, undefined, 'basic-fonts.pptx'),
                    )
                  }
                >
                  PowerPoint, basic fonts (.pptx)
                </MenuEntry>
                <p className="px-2.5 pt-1 pb-1.5 text-xs leading-relaxed text-muted">
                  Basic fonts work on any computer
                </p>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
