'use client';

import { Menu } from '@base-ui/react/menu';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, Link, Lock } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { iconButton, MenuDivider, MenuEntry, MenuSwitch, menuPopup } from '../../../kit';
import type { SessionArtifact } from '../../../lib/api';
import { gatewayOrigin } from '../../../platform/gateway';
import { copy } from './source';
import { type ArtifactsApi, artifactChanged } from './use-artifacts';

/**
 * Who reads an Artifact: the owner alone, or anyone holding its link. Drawn only on a server
 * gateway, over the open one (artifact-view.tsx) and on its line in the agent's page of them
 * (app/artifacts): the gateway a desktop app runs refuses to make one public, since
 * no link from outside reaches it. The link is the gateway's own address, as the world reaches
 * it, and a new one each time it is made public.
 */
export function ArtifactSharing({
  api,
  profileId,
  artifact,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
}) {
  const client = useQueryClient();
  const [changing, setChanging] = useState(false);
  const open = artifact.visibility === 'public';

  const change = async (visibility: SessionArtifact['visibility']) => {
    if (changing) return;
    setChanging(true);
    try {
      const next = await api.setSessionArtifactVisibility(
        profileId,
        artifact.sessionId,
        artifact.id,
        visibility,
      );
      artifactChanged(client, profileId, next);
    } catch (error) {
      // The gateway's own sentence, as when it runs inside a desktop app after all.
      toast.error(error instanceof Error ? error.message : 'The Artifact could not be changed.');
    } finally {
      setChanging(false);
    }
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={open ? 'Public: anyone with the link' : 'Private: only you'}
        className={iconButton}
      >
        {open ? (
          <Globe size={15} className="text-warn" aria-hidden="true" />
        ) : (
          <Lock size={15} aria-hidden="true" />
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} w-64`}>
            <MenuSwitch
              icon={<Globe size={14} />}
              checked={open}
              onCheckedChange={(next) => void change(next ? 'public' : 'private')}
            >
              Public link
            </MenuSwitch>
            <p className="px-2.5 pt-1 pb-1.5 text-xs leading-relaxed text-muted">
              {open
                ? 'Anyone with the link opens its latest version, without signing in. Turning this off ends the link for good.'
                : 'Only you see it. With a public link, anyone who has it opens the latest version without signing in.'}
            </p>
            {artifact.publicPath && (
              <>
                <MenuDivider />
                <MenuEntry
                  icon={<Link size={14} />}
                  onClick={() => void copy(`${gatewayOrigin()}${artifact.publicPath}`, 'Link')}
                >
                  Copy link
                </MenuEntry>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
