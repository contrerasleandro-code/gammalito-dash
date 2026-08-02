// Plantilla de hardening para /api/refresh.js
// Aplicá estos bloques a tu handler existente (el que llama a Stripe).
// Qué cambia respecto de un handler "abierto":
//   1. Solo GET (nada de POST/OPTIONS que amplíen superficie).
//   2. SIN header Access-Control-Allow-Origin: el dashboard vive en el mismo
//      origen, así que el fetch es same-origin y no necesita CORS. Al no
//      emitir el header, ningún otro sitio puede leer la respuesta desde
//      el navegador de un visitante.
//   3. Cache-Control: no-store → la respuesta (con nombres/emails de
//      clientes) no queda en caches intermedios ni en el disco del browser.
//   4. Rate limit simple en memoria por IP (Vercel puede reciclar la
//      instancia, pero frena scraping casual sin infraestructura extra).
//   5. La clave de Stripe SIEMPRE desde process.env.STRIPE_SECRET_KEY,
//      nunca hardcodeada ni reenviada al cliente.
//
// IMPORTANTE: nada de esto autentica al usuario. Como el dashboard es un
// HTML estático con los datos embebidos, la protección real del proyecto
// (página + API juntas) es Vercel → Settings → Deployment Protection
// (Password Protection o Vercel Authentication). Activala: es un toggle,
// no requiere tocar código, y cubre también el index.html con la PII.

const hits = new Map(); // ip -> [timestamps]

export default async function handler(req, res) {
  // 1. Solo GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 4. Rate limit: máx 10 requests por IP cada 10 minutos
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const win = (hits.get(ip) || []).filter(t => now - t < 600_000);
  if (win.length >= 10) return res.status(429).json({ error: 'Too many requests' });
  win.push(now);
  hits.set(ip, win);

  // 3. Sin cache en ningún nivel
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 2. (deliberadamente NO se setea Access-Control-Allow-Origin)

  try {
    // ... acá va tu lógica actual de fetch a Stripe con paginación ...
    // const data = await buildDashboardData(process.env.STRIPE_SECRET_KEY);
    // return res.status(200).json(data);
  } catch (err) {
    // No filtrar detalles internos (mensajes de Stripe pueden incluir IDs)
    console.error('refresh failed:', err);
    return res.status(502).json({ error: 'Upstream error' });
  }
}
