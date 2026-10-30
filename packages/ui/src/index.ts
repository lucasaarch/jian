'use client';

export { toast } from 'sonner';
export { type AppHost, AppSettings, type GatewaySettings } from './app/app-settings';
export { ChatsApp } from './app/chats';
export { CreateAgent } from './app/create-agent';
export type { GatewayActions, GatewayInfo } from './app/gateway-connection';
export type { ThisComputer } from './app/settings/machines-page';
export {
  type History,
  SidebarBar,
  type SidebarShortcuts,
  searchChats,
  toggleSidebar,
} from './app/sidebar-bar';
/**
 * The panel, for a host to draw: its screens, the providers they run in, and the two things a
 * host decides — how it navigates and how it reaches the gateway.
 */
export { SignIn } from './app/sign-in';
export {
  type AppUpdate,
  openUpdates,
  type UpdatesHost,
} from './app/updates/app-update';
export { AppUpdates, UpdateBadge } from './app/updates/app-updates';
/** The web's panel: the app's chats behind a signed-in session, its overlays at addresses. */
export { WebApp } from './app/web-app';
export { Notifications } from './components/shell/notice';
export { QueryProvider } from './components/shell/query';
export { ThemeSync, useThemeChoice } from './components/shell/theme';
export { VersionMismatch } from './components/shell/version-mismatch';
export * from './kit';
export { agentSettingsPath, newChatPath } from './lib/navigation';
export { useGatewayOnline } from './lib/query/online';
export { forgetGatewayCache } from './lib/query/persist';
export { useProfileId } from './lib/workspace';
export { connectGateway, type GatewayConnection } from './platform/gateway';
export {
  createMemoryNavigation,
  type LinkProps,
  type Navigation,
  NavigationProvider,
  useRouter,
} from './platform/navigation';
