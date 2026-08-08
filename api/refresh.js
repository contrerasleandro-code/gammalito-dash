// /api/refresh.js — sirve el JSON en vivo para el botón "Actualizar" del
// navegador. La lógica de fetch/build vive en ./_stripe-data.mjs, compartida
// con scripts/refresh-and-bake.mjs (el que hornea los datos en index.html).
import { fetchStripeDataset } from './_stripe-data.mjs';

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!process.env.STRIPE_SECRET_KEY) { res.status(500).json({ error: 'STRIPE_SECRET_KEY no configurada' }); return; }

  try {
    const dataset = await fetchStripeDataset();
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      ...dataset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stripe fetch failed', detail: String(err) });
  }
}
