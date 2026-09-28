// Fallback download endpoint, used only if Cloudflare's speed test servers are unreachable.
// Streams random bytes: /api/down?bytes=1000000
export const config = { runtime: 'edge' };

const MAX_BYTES = 25_000_000;
let chunk;

export default function handler(req) {
  if (!chunk) {
    chunk = new Uint8Array(65536);
    crypto.getRandomValues(chunk);
  }
  const requested = parseInt(new URL(req.url).searchParams.get('bytes') || '0', 10);
  const total = Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 0), MAX_BYTES);
  let sent = 0;

  const body = new ReadableStream({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(chunk.length, total - sent);
      controller.enqueue(chunk.slice(0, n));
      sent += n;
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(total),
      'cache-control': 'no-store',
    },
  });
}
