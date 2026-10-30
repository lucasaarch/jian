import { notFound } from 'next/navigation';

const PAGES = [
  'general',
  'appearance',
  'providers',
  'models',
  'integrations',
  'ssh-keys',
  'machines',
];

/** Drawn by the layout, which reads this address; a page Settings does not have is not here. */
export default async function Page({ params }: PageProps<'/settings/[page]'>) {
  if (!PAGES.includes((await params).page)) notFound();
  return null;
}
