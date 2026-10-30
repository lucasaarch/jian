// This server's own liveness, for its container health check. `/health` is the gateway's,
// passed through, so a web container is not restarted because the gateway is.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
