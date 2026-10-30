'use client';

import { useQuery } from '@tanstack/react-query';
import { Menu } from 'lucide-react';
import { currentSection, navigation } from '../../lib/navigation';
import { queries } from '../../lib/query/profile';
import { useAgentPath, useWorkingAgentId } from '../../lib/workspace';
import { Link, usePathname } from '../../platform/navigation';

/** The sections a phone keeps under the thumb; every other one is a tap away in the menu. */
const TABS = ['', 'sessions', 'channels', 'schedules'];

/**
 * A phone's navigation: four sections and the menu, along the bottom where a thumb reaches,
 * by their icons; each says its name to a screen reader. It stands in for the header, which a
 * phone no longer shows.
 */
export function TabBar({
  onOpenNavigation,
  navigationOpen,
}: {
  onOpenNavigation: () => void;
  navigationOpen: boolean;
}) {
  const active = currentSection(usePathname());
  const hrefOf = useAgentPath();
  const profileId = useWorkingAgentId();
  const contacts = useQuery({ ...queries.contacts(profileId ?? ''), enabled: Boolean(profileId) });
  // Requests waiting on the owner, as the menu counts them beside Channels.
  const pending = contacts.data?.filter((contact) => contact.status === 'pending').length ?? 0;
  const tabs = TABS.flatMap((path) => navigation.filter((item) => item.path === path));

  return (
    // Under the menu while it is open, and out of reach like the rest of the workspace.
    <nav className="tab-bar" aria-label="Sections" inert={navigationOpen}>
      {tabs.map((item) => (
        <Link
          key={item.path}
          href={hrefOf(item.path)}
          aria-label={
            item.path === 'channels' && pending > 0
              ? `${item.label}, ${pending} waiting for approval`
              : item.label
          }
          aria-current={active === item ? 'page' : undefined}
        >
          <span className="tab-bar-icon">
            <item.icon size={22} strokeWidth={1.7} aria-hidden="true" />
            {item.path === 'channels' && pending > 0 && (
              <span className="tab-bar-count" aria-hidden="true">
                {pending}
              </span>
            )}
          </span>
        </Link>
      ))}
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={navigationOpen}
        aria-controls="main-navigation"
        onClick={onOpenNavigation}
      >
        <span className="tab-bar-icon">
          <Menu size={22} strokeWidth={1.7} aria-hidden="true" />
        </span>
      </button>
    </nav>
  );
}
