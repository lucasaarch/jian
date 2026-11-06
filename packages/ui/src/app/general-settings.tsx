'use client';

import type { GatewaySettings } from '@jian/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GitHubLogo } from '../components/ui';
import { Action, SettingsGroup, SettingsRow, Toggle } from '../kit';
import { panelApi } from '../lib/query/client';
import { keys } from '../lib/query/keys';
import { queries } from '../lib/query/profile';
import { ReleaseNotesRow } from './release-notes';

/** What only the host can do, and what it offers on this page. */
export type AppHost = {
  /** The release in use: the app's own, or on the web the gateway's, which it is served with. */
  version: string;
  openAtLogin?: { read: () => Promise<boolean>; write: (open: boolean) => void };
  /** System notifications the host shows itself, which the owner may turn off. */
  notifications?: { read: () => Promise<boolean>; write: (on: boolean) => void };
  checkForUpdates?: () => void;
  /** Ends the session, for a host whose panel signed in itself. */
  signOut?: () => void;
};

const REPOSITORY = 'https://github.com/lucasaarch/jian';

/** Stars in the way GitHub shows them: 1.2k past a thousand. */
const starCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * The app's own settings: starting with the system, its release and where it lives. `gateway`
 * says a gateway can be read here, for what only it knows: the notes and the star count.
 */
export function GeneralSettings({
  host,
  gateway,
  showOnboarding,
}: {
  host: AppHost;
  gateway: boolean;
  showOnboarding?: () => void;
}) {
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const login = host.openAtLogin;
  useEffect(() => {
    void login?.read().then(setOpenAtLogin);
  }, [login]);
  const [notifying, setNotifying] = useState(false);
  const notifications = host.notifications;
  useEffect(() => {
    void notifications?.read().then(setNotifying);
  }, [notifications]);

  return (
    <>
      {login && (
        <SettingsGroup title="Startup">
          <Toggle
            label="Open at login"
            detail="It starts in the tray, so replies reach you and this computer's gateway is ready."
            checked={openAtLogin}
            onCheckedChange={(checked) => {
              setOpenAtLogin(checked);
              login.write(checked);
            }}
          />
        </SettingsGroup>
      )}
      {notifications && (
        <SettingsGroup title="Notifications">
          <Toggle
            label="Show notifications"
            detail="When an agent replies or needs you, or someone writes to it, in a chat you are not reading."
            checked={notifying}
            onCheckedChange={(checked) => {
              setNotifying(checked);
              notifications.write(checked);
            }}
          />
        </SettingsGroup>
      )}
      {gateway && <Telemetry />}
      <SettingsGroup title="About">
        <SettingsRow title="Version" description={`Jian ${host.version}`}>
          {host.checkForUpdates && (
            <Action tone="outline" size="small" onClick={host.checkForUpdates}>
              Check for updates
            </Action>
          )}
        </SettingsRow>
        {gateway && <ReleaseNotesRow />}
        <SettingsRow title="Source code" description="Jian is open source, on GitHub.">
          <a
            href={REPOSITORY}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-glass-edge bg-glass-hover px-2.5 text-xs font-medium text-ink transition-colors hover:bg-glass-press"
          >
            <GitHubLogo size={13} />
            GitHub
            {gateway && <Stars />}
          </a>
        </SettingsRow>
        {showOnboarding && (
          <SettingsRow title="Onboarding" description="Meet Jian again and set up an agent.">
            <Action tone="outline" size="small" onClick={showOnboarding}>
              Show onboarding
            </Action>
          </SettingsRow>
        )}
      </SettingsGroup>
      {host.signOut && (
        <SettingsGroup title="Session">
          <SettingsRow title="Sign out" description="This browser forgets the session.">
            <Action tone="danger" size="small" onClick={host.signOut}>
              <LogOut size={13} />
              Sign out
            </Action>
          </SettingsRow>
        </SettingsGroup>
      )}
    </>
  );
}

/**
 * The gateway's anonymous daily report, on until the owner turns it off here. Its host can turn it
 * off for good, which this only says; a gateway from before it existed shows nothing.
 */
function Telemetry() {
  const client = useQueryClient();
  const telemetry = useQuery({ queryKey: keys.settings, queryFn: () => panelApi().settings() }).data
    ?.telemetry;
  if (!telemetry) return null;

  return (
    <SettingsGroup title="Privacy">
      {telemetry.source === 'environment' ? (
        <SettingsRow
          title="Anonymous usage data"
          description="Off: this gateway's host turned it off, with DO_NOT_TRACK or JIAN_TELEMETRY=off."
        />
      ) : (
        <Toggle
          label="Share anonymous usage data"
          detail="Once a day this gateway sends counts, under a random id: its version and system, how many agents and runs, which models, tools and apps were used, and why runs failed. Never a message, a name, an address, a file or a credential."
          checked={telemetry.enabled}
          onCheckedChange={(enabled) => {
            client.setQueryData<GatewaySettings>(keys.settings, (known) =>
              known ? { ...known, telemetry: { enabled, source: 'setting' } } : known,
            );
            void panelApi()
              .updateSettings({ telemetry: enabled })
              .then((settings) => client.setQueryData(keys.settings, settings))
              .catch(() => void client.invalidateQueries({ queryKey: keys.settings }));
          }}
        />
      )}
    </SettingsGroup>
  );
}

/** The repository's stars, read through the gateway; the link works without them. */
function Stars() {
  const stars = useQuery(queries.repository()).data?.stars;
  if (stars === undefined) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-muted tabular-nums">
      <Star size={11} aria-hidden="true" />
      {starCount.format(stars)}
      <span className="sr-only"> stars</span>
    </span>
  );
}
