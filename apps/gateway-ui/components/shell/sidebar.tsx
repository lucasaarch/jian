'use client';

import { LogOut, Settings2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { currentSection, groupLabels, navigation } from '../../lib/navigation';
import { useWorkspace } from '../../lib/workspace';
import { Mark } from '../ui';
import { ProfileSwitcher } from './profile-switcher';

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
  const { data, loading, signOut } = useWorkspace();

  return (
    <aside id="main-navigation" className={`sidebar ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="icon-button mobile-menu absolute right-3 top-3"
        aria-label="Close navigation"
        onClick={onNavigate}
      >
        <X size={18} />
      </button>
      <Link className="brand" href="/" onClick={onNavigate}>
        <Mark className={loading ? 'connecting' : data ? 'connected' : ''} />
        <span>
          jian<span className="brand-label">比翼の鳥</span>
        </span>
      </Link>
      <ProfileSwitcher onCreate={onCreateProfile} />
      <nav aria-label="Main navigation">
        {(['workspace', 'capabilities'] as const).map((group) => (
          <div className="nav-group" key={group}>
            <span className="nav-label">{groupLabels[group]}</span>
            {navigation
              .filter((item) => item.group === group)
              .map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active?.href === item.href ? 'active' : ''}
                  aria-current={active?.href === item.href ? 'page' : undefined}
                  onClick={onNavigate}
                >
                  <item.icon size={18} strokeWidth={1.7} />
                  <span>{item.label}</span>
                </Link>
              ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <Link
          href="/settings/appearance"
          className={`settings-link ${pathname.startsWith('/settings') ? 'active' : ''}`}
          aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
          onClick={onNavigate}
        >
          <Settings2 size={17} />
          Settings
        </Link>
        <button type="button" onClick={() => void signOut()}>
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
