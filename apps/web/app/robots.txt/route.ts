export function GET() {
  return new Response('User-agent: *\nDisallow: /\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' },
  });
}
