'use client';
import { Menu } from 'lucide-react';
export function Topbar({
  onOpenNavigation,
  navigationOpen,
}: {
  onOpenNavigation: () => void;
  navigationOpen: boolean;
}) {
  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button"
        aria-label="Open navigation"
        aria-expanded={navigationOpen}
        aria-controls="main-navigation"
        onClick={onOpenNavigation}
      >
        <Menu size={20} />
      </button>
      <span className="font-display text-2xl">jian</span>
    </header>
  );
}
