import { forward } from '../../lib/server/gateway';

// The worker script a remote machine downloads when it is installed, from the address the
// panel printed in its install command.
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return forward(request, '/jian-remote.mjs');
}
