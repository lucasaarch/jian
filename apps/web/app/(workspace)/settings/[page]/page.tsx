import { notFound } from 'next/navigation';

const PAGES = [
  'general',
  'appearance',
  'providers',
  'models',
  // No longer pages of Settings: the panel sends these two on to Plugins, which needs the agent
  // in use, known only there. They stay addresses so a bookmark or GitHub's way back still lands.
  'apps',
  'mcp-servers',
  'ssh-keys',
  'machines',
  'mobile',
];

/** Drawn by the layout, which reads this address; a page Settings does not have is not here. */
export default async function Page({ params }: PageProps<'/settings/[page]'>) {
  if (!PAGES.includes((await params).page)) notFound();
  return null;
}
