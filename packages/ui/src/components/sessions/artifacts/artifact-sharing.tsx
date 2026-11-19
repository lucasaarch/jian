'use client';

import { Menu } from '@base-ui/react/menu';
import { ARTIFACT_PASSWORD_MAX, ARTIFACT_PASSWORD_MIN } from '@jian/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, GlobeLock, KeyRound, Link, Lock, LockOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Action,
  iconButton,
  MenuDivider,
  MenuEntry,
  MenuSwitch,
  menuPopup,
  Overlay,
  OverlayActions,
  TextField,
} from '../../../kit';
import type { SessionArtifact } from '../../../lib/api';
import { countUsage } from '../../../lib/usage';
import { gatewayOrigin } from '../../../platform/gateway';
import { copy } from './source';
import { type ArtifactsApi, artifactChanged } from './use-artifacts';

/**
 * Who reads an Artifact: the owner alone, anyone holding its link, or anyone holding its link and
 * its password. Drawn only on a server gateway, over the open one (artifact-view.tsx) and in no
 * list of Artifacts: the gateway a desktop app runs refuses to make one public, since no link from
 * outside reaches it. The link is the gateway's own address, as the world reaches it, and a new
 * one each time it is made public; its password stays with it until the owner changes it.
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
  const [asking, setAsking] = useState(false);
  const open = artifact.visibility === 'public';
  const guarded = open && artifact.passwordProtected;

  /** One change to it, saved; whether it was. */
  const apply = async (request: () => Promise<SessionArtifact>) => {
    if (changing) return false;
    setChanging(true);
    try {
      artifactChanged(client, profileId, await request());
      return true;
    } catch (error) {
      // The gateway's own sentence, as when it runs inside a desktop app after all.
      toast.error(error instanceof Error ? error.message : 'The Artifact could not be changed.');
      return false;
    } finally {
      setChanging(false);
    }
  };

  const change = async (visibility: SessionArtifact['visibility']) => {
    const done = await apply(() =>
      api.setSessionArtifactVisibility(profileId, artifact.sessionId, artifact.id, visibility),
    );
    if (done && visibility === 'public') countUsage('artifact_made_public');
  };

  const protect = (password: string | null) =>
    apply(() =>
      api.setSessionArtifactPassword(profileId, artifact.sessionId, artifact.id, password),
    );

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          aria-label={
            guarded
              ? 'Public with a password: anyone with the link and its password'
              : open
                ? 'Public: anyone with the link'
                : 'Private: only you'
          }
          className={iconButton}
        >
          {guarded ? (
            <GlobeLock size={15} className="text-warn" aria-hidden="true" />
          ) : open ? (
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
                {guarded
                  ? 'Anyone with the link opens its latest version once they type its password. Turning this off ends the link for good.'
                  : open
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
                  <MenuEntry icon={<KeyRound size={14} />} onClick={() => setAsking(true)}>
                    {guarded ? 'Change password' : 'Add password'}
                  </MenuEntry>
                  {guarded && (
                    <MenuEntry icon={<LockOpen size={14} />} onClick={() => void protect(null)}>
                      Remove password
                    </MenuEntry>
                  )}
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Overlay
        open={asking}
        onOpenChange={setAsking}
        title={guarded ? 'Change password' : 'Add a password'}
        size="form"
      >
        {asking && (
          <PasswordForm replacing={guarded} save={protect} close={() => setAsking(false)} />
        )}
      </Overlay>
    </>
  );
}

/**
 * The password a public link asks for, typed once: the owner can always set another, so nothing
 * is lost to a typo that a second field would catch. It stays open when it could not be saved.
 */
function PasswordForm({
  replacing,
  save,
  close,
}: {
  replacing: boolean;
  save: (password: string) => Promise<boolean>;
  close: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const enough = password.length >= ARTIFACT_PASSWORD_MIN;

  useEffect(() => form.current?.querySelector('input')?.focus(), []);

  return (
    <form
      ref={form}
      className="grid w-full gap-5 p-7"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!enough) return;
        setBusy(true);
        const saved = await save(password);
        setBusy(false);
        if (saved) close();
      }}
    >
      <div className="grid gap-1.5 pr-10">
        <h2 className="text-lg font-semibold tracking-tight">
          {replacing ? 'Change password' : 'Add a password'}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {replacing
            ? 'Whoever opens the link types the new one, also those who already opened it.'
            : 'Whoever opens the link types it before they see the Artifact.'}
        </p>
      </div>
      <TextField
        label="Password"
        type="password"
        value={password}
        minLength={ARTIFACT_PASSWORD_MIN}
        maxLength={ARTIFACT_PASSWORD_MAX}
        autoComplete="new-password"
        hint={`At least ${ARTIFACT_PASSWORD_MIN} characters.`}
        onChange={(event) => setPassword(event.target.value)}
      />
      <OverlayActions>
        <Action tone="quiet" onClick={close}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy} disabled={!enough}>
          Save
        </Action>
      </OverlayActions>
    </form>
  );
}
