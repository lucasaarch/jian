import { forward } from '../../lib/server/gateway';

// The gateway's health, passed through: a platform that checks this address keeps seeing the
// whole installation. The web container's own liveness is /web/health.
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return forward(request, '/health');
}
