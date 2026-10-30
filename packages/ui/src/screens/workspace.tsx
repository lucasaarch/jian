'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { NewProfileDialog } from '../components/profile/editor';
import { ReleaseNotes } from '../components/releases/dialog';
import { useMobileNavigation } from '../components/shell/mobile-navigation';
import { Sidebar } from '../components/shell/sidebar';
import { TabBar } from '../components/shell/tab-bar';
import { Spinner } from '../components/ui';
import { currentSection } from '../lib/navigation';
import { panelApi } from '../lib/query/client';
import { useProfiles } from '../lib/query/profile';
import { useSavedLayout } from '../lib/stores/layout';
import { useShell } from '../lib/stores/shell';
import { useVisibleViewport } from '../lib/viewport';
import { useAdoptProfile } from '../lib/workspace';
import { usePathname, useRouter } from '../platform/navigation';

/** The chrome every section shares, and the one place the session is checked. */
export function WorkspaceLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  // A signed cookie from an earlier visit is enough to walk straight back in.
  const profiles = useProfiles();

  useEffect(() => {
    if (profiles.isError) {
      router.replace('/sign-in');
    }
  }, [profiles.isError, router]);

  if (!profiles.data) {
    return (
      <main className="boot" aria-busy="true" aria-label="Checking the session">
        <Spinner size={32} />
      </main>
    );
  }

  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The one screen that is an app of its own: it takes the whole area and scrolls inside.
  const fill = currentSection(pathname)?.path === 'sessions';
  const adopt = useAdoptProfile();
  const { creating, setCreating } = useShell();
  const [mobile, setMobile] = useState(false);
  useSavedLayout();
  useVisibleViewport();

  useMobileNavigation(mobile, setMobile);

  return (
    <>
      <div className="app-shell">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Sidebar
          open={mobile}
          onNavigate={() => setMobile(false)}
          onCreateProfile={() => {
            setMobile(false);
            setCreating(true);
          }}
        />
        <div className="workspace" inert={mobile}>
          <main id="main-content" tabIndex={-1} className={`main-content ${fill ? 'fill' : ''}`}>
            {children}
          </main>
        </div>
        <TabBar navigationOpen={mobile} onOpenNavigation={() => setMobile(true)} />
        {creating && (
          <NewProfileDialog
            api={panelApi()}
            close={() => setCreating(false)}
            done={(created) => {
              adopt(created);
              setCreating(false);
            }}
          />
        )}
      </div>
      <ReleaseNotes />
    </>
  );
}
