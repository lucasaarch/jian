'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { NewProfileDialog } from '@/components/profile/editor';
import { ReleaseNotes } from '@/components/releases/dialog';
import { Sidebar } from '@/components/shell/sidebar';
import { TabBar } from '@/components/shell/tab-bar';
import { Spinner } from '@/components/ui';
import { currentSection } from '@/lib/navigation';
import { panelApi } from '@/lib/query/client';
import { useProfiles } from '@/lib/query/profile';
import { useSavedLayout } from '@/lib/stores/layout';
import { useShell } from '@/lib/stores/shell';
import { useVisibleViewport } from '@/lib/viewport';
import { useAdoptProfile } from '@/lib/workspace';

/** The chrome every section shares, and the one place the session is checked. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
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

  useEffect(() => {
    if (!mobile) {
      return;
    }

    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
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
      document.body.style.overflow = previousOverflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [mobile]);

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
