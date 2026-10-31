import { notFound } from 'next/navigation';

const TABS = ['skills', 'memories', 'channels'];

/** An older address: the layout opens this page of the agent's settings; any other is not here. */
export default async function Page({ params }: PageProps<'/agents/[profileId]/customize/[tab]'>) {
  if (!TABS.includes((await params).tab)) notFound();
  return null;
}
