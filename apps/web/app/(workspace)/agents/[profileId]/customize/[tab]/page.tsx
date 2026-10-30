import { notFound } from 'next/navigation';

const TABS = ['skills', 'memories', 'channels'];

/** Drawn by the layout, which reads this address; a tab Customize does not have is not here. */
export default async function Page({ params }: PageProps<'/agents/[profileId]/customize/[tab]'>) {
  if (!TABS.includes((await params).tab)) notFound();
  return null;
}
