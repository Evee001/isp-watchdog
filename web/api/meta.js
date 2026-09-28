// Fallback location lookup from Vercel's geo headers. The client IP is never returned or stored.
export const config = { runtime: 'edge' };

export default function handler(req) {
  const h = req.headers;
  const decode = (v) => { try { return v ? decodeURIComponent(v) : null; } catch { return v; } };
  return Response.json(
    {
      city: decode(h.get('x-vercel-ip-city')),
      country: h.get('x-vercel-ip-country'),
      colo: 'Vercel Edge',
      asOrganization: null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
