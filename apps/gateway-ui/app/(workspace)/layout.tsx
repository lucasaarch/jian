'use client';

import { LoaderCircle, Plus } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { NewProfileDialog } from '../../components/profile/editor';
import { ReleaseDialog } from '../../components/releases/dialog';
import { NoticeBar } from '../../components/shell/notice';
import { Sidebar } from '../../components/shell/sidebar';
import { Topbar } from '../../components/shell/topbar';
import { Button, Empty } from '../../components/ui';
import { gatewayApi, type Profile } from '../../lib/api';
import { useWorkspace, WorkspaceProvider } from '../../lib/workspace';

/** The chrome every section shares, and the one place the session is checked. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[]>();
  const [checking, setChecking] = useState(true);

  // A signed cookie from an earlier visit is enough to walk straight back in.
  useEffect(() => {
    gatewayApi()
      .profiles()
      .then(setProfiles)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!checking && !profiles) {
      router.replace('/sign-in');
    }
  }, [checking, profiles, router]);

  if (!profiles) {
    return (
      <main className="boot" aria-busy="true">
        <LoaderCircle size={22} className="spin" aria-label="Checking the session" />
      </main>
    );
  }

  return (
    <WorkspaceProvider initialProfiles={profiles} onSignOut={() => router.replace('/sign-in')}>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const settings = usePathname().startsWith('/settings');
  const { profiles, profile, data, loading, refresh, adopt } = useWorkspace();
  const [mobile, setMobile] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!mobile) {
      return;
    }

    const previous = document.activeElement;
    const sidebar = document.getElementById('main-navigation');
    const focusable = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => focusable()[0]?.focus({ preventScroll: true }));
    const desktop = window.matchMedia('(min-width: 761px)');
    const resize = () => {
      if (desktop.matches) setMobile(false);
    };
    const close = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') setMobile(false);
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !sidebar?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !sidebar?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', close);
    desktop.addEventListener('change', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', close);
      desktop.removeEventListener('change', resize);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [mobile]);

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <ReleaseDialog />
      {mobile && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <Sidebar
        open={mobile}
        onNavigate={() => setMobile(false)}
        onCreateProfile={() => {
          setMobile(false);
          setCreating(true);
        }}
      />
      <div className="workspace" inert={mobile}>
        <Topbar navigationOpen={mobile} onOpenNavigation={() => setMobile(true)} />
        <main id="main-content" tabIndex={-1} className="main-content">
          <NoticeBar />
          {settings ? (
            children
          ) : !profiles.length ? (
            <Empty
              title="Bring your first agent to life"
              action={
                <Button onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  Create a profile
                </Button>
              }
            >
              Start with a name and instructions. Connect your providers next.
            </Empty>
          ) : profile && data ? (
            <div key={profile.id} className="page-enter">
              {children}
            </div>
          ) : (
            <div className="loading-state" role="status">
              {loading ? (
                <>
                  <LoaderCircle className="spin" size={24} />
                  Loading your workspace…
                </>
              ) : (
                <Button variant="secondary" onClick={() => void refresh()}>
                  Tentar carregar novamente
                </Button>
              )}
            </div>
          )}
        </main>
      </div>
      {creating && (
        <NewProfileDialog
          api={gatewayApi()}
          close={() => setCreating(false)}
          done={(created) => {
            adopt(created);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}
