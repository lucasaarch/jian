'use client';

export { Notifications } from './components/shell/notice';
export { QueryProvider } from './components/shell/query';
export { ThemeSync } from './components/shell/theme';
export { VersionMismatch } from './components/shell/version-mismatch';
/**
 * The panel, for a host to draw: its screens, the providers they run in, and the two things a
 * host decides — how it navigates and how it reaches the gateway.
 */
export { SignIn } from './components/sign-in';
export { settingsPath } from './lib/navigation';
export { connectGateway, type GatewayConnection } from './platform/gateway';
export {
  createMemoryNavigation,
  type LinkProps,
  type Navigation,
  NavigationProvider,
} from './platform/navigation';
export { AgentArea } from './screens/agent';
export { Failed } from './screens/failed';
export { Home } from './screens/home';
export * from './screens/sections';
export { SessionsScreen } from './screens/sessions';
export { SettingsArea } from './screens/settings';
export { WorkspaceLayout } from './screens/workspace';
