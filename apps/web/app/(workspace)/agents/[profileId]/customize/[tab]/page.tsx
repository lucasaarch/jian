import { notFound, redirect } from 'next/navigation';

const TABS = ['memories', 'channels'];

/**
 * An older address: the layout opens this page of the agent's settings; any other is not here.
 * Skills left those settings for Plugins, where every agent shares them.
 */
export default async function Page({ params }: PageProps<'/agents/[profileId]/customize/[tab]'>) {
  const { profileId, tab } = await params;
  if (tab === 'skills') redirect(`/agents/${encodeURIComponent(profileId)}/plugins?tab=skills`);
  if (!TABS.includes(tab)) notFound();
  return null;
}
