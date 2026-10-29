import { forward } from '../../lib/server/gateway';

// The contract the gateway publishes, under the address SDK users already know.
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return forward(request, '/openapi.json');
}
