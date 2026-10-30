import { apiPath, forward } from '../../../lib/server/gateway';

// Every request is the gateway's to answer; nothing here may be cached or prerendered.
export const dynamic = 'force-dynamic';

async function handle(request: Request, { params }: RouteContext<'/v1/[...path]'>) {
  return forward(request, apiPath((await params).path));
}

// OPTIONS stays Next's own answer, with no CORS headers: the panel cookie relies on another
// site's preflight failing.
export {
  handle as DELETE,
  handle as GET,
  handle as HEAD,
  handle as PATCH,
  handle as POST,
  handle as PUT,
};
