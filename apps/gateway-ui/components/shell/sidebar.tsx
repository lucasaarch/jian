'use client';

import { useQuery } from '@tanstack/react-query';
import { LogOut, ScrollText, Star, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { queries } from '@/lib/query/profile';
import { useAgentPath, useLoading, useProfileId, useSignOut } from '@/lib/workspace';
import { currentSection, navigation, navigationGroups } from '../../lib/navigation';
import { useReleaseNotes } from '../releases/dialog';
import { GitHubLogo, Mark } from '../ui';
import { ProfileSwitcher } from './profile-switcher';
import { ThemeSwitcher } from './theme';

export function Sidebar({
  open,
  onNavigate,
  onCreateProfile,
}: {
  open: boolean;
  onNavigate: () => void;
  onCreateProfile: () => void;
}) {
  const pathname = usePathname();
  const active = currentSection(pathname);
  const profileId = useProfileId();
  const loading = useLoading();
  const signOut = useSignOut();
  const contacts = useQuery({ ...queries.contacts(profileId ?? ''), enabled: Boolean(profileId) });
  const releaseNotes = useReleaseNotes();
  // How many releases this installation is behind, for the count beside the notes.
  const behind = useQuery(queries.releases()).data?.behind ?? 0;
  // Requests waiting on the owner, shown wherever they are in the panel.
  const pending = contacts.data?.filter((contact) => contact.status === 'pending').length ?? 0;
  const hrefOf = useAgentPath();

  return (
    <aside
      id="main-navigation"
      className={`sidebar ${open ? 'open' : ''}`}
      role={open ? 'dialog' : undefined}
      aria-label={open ? 'Navigation' : undefined}
    >
      <button
        type="button"
        className="icon-button mobile-menu absolute right-3 top-3"
        aria-label="Close navigation"
        onClick={onNavigate}
      >
        <X size={18} />
      </button>
      <Link className="brand" href="/" onClick={onNavigate}>
        <Mark className={loading ? 'connecting' : contacts.data ? 'connected' : ''} />
        <span>Jian</span>
      </Link>
      <ProfileSwitcher onCreate={onCreateProfile} />
      <nav className="sidebar-nav" aria-label="Main navigation">
        {navigationGroups.map((group) => (
          <div className="nav-group" key={group.id}>
            <span className="nav-label">{group.label}</span>
            {navigation
              .filter((item) => item.group === group.id)
              .map((item) => (
                <Link
                  key={item.path}
                  href={hrefOf(item.path)}
                  className={active === item ? 'active' : ''}
                  aria-current={active === item ? 'page' : undefined}
                  onClick={onNavigate}
                >
                  <item.icon size={18} strokeWidth={1.7} />
                  <span>{item.label}</span>
                  {item.path === 'channels' && pending > 0 && (
                    <span className="nav-count">
                      {pending}
                      <span className="sr-only"> waiting for approval</span>
                    </span>
                  )}
                </Link>
              ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <ThemeSwitcher />
        <GitHubLink />
        <button
          type="button"
          className={behind > 0 ? 'release-update' : undefined}
          onClick={() => {
            onNavigate();
            releaseNotes();
          }}
        >
          <ScrollText size={16} />
          Release notes
          {behind > 0 && (
            <span className="release-update-count">
              {behind}
              <span className="sr-only"> releases behind</span>
            </span>
          )}
        </button>
        <button type="button" onClick={() => void signOut()}>
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}

const REPOSITORY = 'https://github.com/lucasaarch/jian';

/** Stars in the way GitHub shows them: 1.2k past a thousand. */
const starCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Where Jian lives. The count comes through the gateway; the link works without it. */
function GitHubLink() {
  const stars = useQuery(queries.repository()).data?.stars;

  return (
    <a className="sidebar-github" href={REPOSITORY} target="_blank" rel="noreferrer">
      <GitHubLogo size={16} />
      GitHub
      {stars !== undefined && (
        <span className="sidebar-stars">
          <Star size={12} aria-hidden="true" />
          {starCount.format(stars)}
          <span className="sr-only"> stars</span>
        </span>
      )}
    </a>
  );
}
