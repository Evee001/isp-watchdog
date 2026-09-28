// Fallback upload endpoint: reads and discards the request body, reports its size.
export const config = { runtime: 'edge' };

const MAX_BYTES = 4_000_000; // Vercel limits request bodies to ~4.5 MB

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  }
  let received = 0;
  const reader = req.body ? req.body.getReader() : null;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > MAX_BYTES) {
      await reader.cancel();
      return new Response('Payload too large', { status: 413 });
    }
  }
  return Response.json({ bytes: received }, { headers: { 'cache-control': 'no-store' } });
}
