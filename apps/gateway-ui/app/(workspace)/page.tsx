'use client';

import { Overview } from '../../components/overview/index';
import { useSection } from '../../lib/workspace';

export default function Page() {
  const { profile, data, api } = useSection();

  return <Overview profile={profile} data={data} api={api} />;
}
