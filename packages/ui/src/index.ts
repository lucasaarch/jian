'use client';

/** The desktop app's screen and settings, drawn with the glass kit. */
export { AgentPicker } from './app/agent-picker';
export { AgentSettings } from './app/agent-settings';
export { Appearance } from './app/appearance';
export { ChatsApp } from './app/chats';
export { CreateAgent } from './app/create-agent';
export { Notifications } from './components/shell/notice';
export { QueryProvider } from './components/shell/query';
export { ThemeSync, useThemeChoice } from './components/shell/theme';
export { VersionMismatch } from './components/shell/version-mismatch';
/**
 * The panel, for a host to draw: its screens, the providers they run in, and the two things a
 * host decides — how it navigates and how it reaches the gateway.
 */
export { SignIn } from './components/sign-in';
/** The panel's own controls, for what a host draws around it in the same look. */
export { Button, Field, Mark } from './components/ui';
export * from './kit';
export { settingsPath } from './lib/navigation';
export { connectGateway, type GatewayConnection } from './platform/gateway';
export {
  createMemoryNavigation,
  type LinkProps,
  type Navigation,
  NavigationProvider,
  useRouter,
} from './platform/navigation';
export { AgentArea } from './screens/agent';
export { Failed } from './screens/failed';
export { Home } from './screens/home';
export * from './screens/sections';
export { SessionsScreen } from './screens/sessions';
export { SettingsArea } from './screens/settings';
export { WorkspaceLayout } from './screens/workspace';
/** Where a new chat of an agent opens: its chats, asked to start one. */
export const newChatPath = (profileId: string) =>
  `/agents/${encodeURIComponent(profileId)}/sessions?new`;
export { toast } from 'sonner';
export { useProfileId } from './lib/workspace';
