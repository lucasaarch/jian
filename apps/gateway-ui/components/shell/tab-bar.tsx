'use client';

import { useQuery } from '@tanstack/react-query';
import { Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { currentSection, navigation } from '@/lib/navigation';
import { queries } from '@/lib/query/profile';
import { useAgentPath, useWorkingAgentId } from '@/lib/workspace';

/** The sections a phone keeps under the thumb; every other one is a tap away in the menu. */
const TABS = ['', 'sessions', 'channels', 'schedules'];

/**
 * A phone's navigation: four sections and the menu, along the bottom where a thumb reaches.
 * It stands in for the header, which a phone no longer shows.
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
    <nav className="tab-bar" aria-label="Sections">
      {tabs.map((item) => (
        <Link
          key={item.path}
          href={hrefOf(item.path)}
          aria-current={active === item ? 'page' : undefined}
        >
          <span className="tab-bar-icon">
            <item.icon size={22} strokeWidth={1.7} aria-hidden="true" />
            {item.path === 'channels' && pending > 0 && (
              <span className="tab-bar-count">
                {pending}
                <span className="sr-only"> waiting for approval</span>
              </span>
            )}
          </span>
          <span>{item.label}</span>
        </Link>
      ))}
      <button
        type="button"
        aria-expanded={navigationOpen}
        aria-controls="main-navigation"
        onClick={onOpenNavigation}
      >
        <span className="tab-bar-icon">
          <Menu size={22} strokeWidth={1.7} aria-hidden="true" />
        </span>
        <span>Menu</span>
      </button>
    </nav>
  );
}
