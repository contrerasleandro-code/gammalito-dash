// api/_stripe-data.mjs — lógica compartida de fetch + build para Stripe.
//
// Usada por DOS consumidores:
//   1. api/refresh.js         -> sirve JSON en vivo al botón "Actualizar" del navegador
//   2. scripts/refresh-and-bake.mjs -> hornea los mismos datos directo en index.html vía GitHub Action
//
// Vive en un solo lugar a propósito: así el bug de CUS_MRR (guarda precio de
// lista, no precio con cupón — pendiente de decidir cómo resolver) solo hay
// que arreglarlo una vez, y los dos consumidores quedan siempre consistentes
// entre sí.

import Stripe from 'stripe';

export function getStripeClient() {
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
  });
}

export async function fetchAllSubscriptions(stripe) {
  const all = [];
  let starting_after;
  for (;;) {
    const page = await stripe.subscriptions.list({
      status: 'all',
      limit: 100,
      starting_after,
    });
    all.push(...page.data);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return all;
}

export async function fetchAllInvoices(stripe) {
  const all = [];
  let starting_after;
  for (;;) {
    const page = await stripe.invoices.list({
      status: 'paid',
      limit: 100,
      starting_after,
      expand: ['data.charge.balance_transaction'],
    });
    all.push(...page.data);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return all;
}

// RAW row shape: { c, s, p, a, i, n, cus, id, cpe, ca? }
// - id:  sub_id de Stripe (sub_...)
// - cpe: current_period_end REAL del subscription item (epoch segundos) —
//        Cash Flow lo usa como ancla en vez de reconstruir desde "created".
export function buildRaw(subs) {
  const raw = [];
  for (const s of subs) {
    for (const item of s.items.data) {
      const entry = {
        c: s.created,
        s: s.status,
        p: item.price.product,
        a: item.price.unit_amount,
        i: item.price.recurring?.interval || 'month',
        n: item.price.recurring?.interval_count || 1,
        cus: typeof s.customer === 'string' ? s.customer : s.customer.id,
        id: s.id,
        cpe: item.current_period_end,
      };
      if (s.canceled_at) entry.ca = s.canceled_at;
      raw.push(entry);
    }
  }
  raw.sort((a, b) => b.c - a.c);
  return raw;
}

export function buildInvData(invoices, activeCustomerIds) {
  return invoices.map((inv) => {
    const paid = inv.amount_paid;
    const subtotal = inv.subtotal ?? paid;
    let coupon = '';
    const dAmt = inv.discount?.coupon;
    if (dAmt) coupon = dAmt.name || dAmt.id || '';
    if (!coupon && Array.isArray(inv.discounts) && inv.discounts.length) {
      coupon = inv.discounts[0]?.coupon?.name || inv.discounts[0]?.coupon?.id || '';
    }
    let net = paid;
    const charge = inv.charge;
    if (charge && typeof charge === 'object' && charge.balance_transaction) {
      const bt = charge.balance_transaction;
      if (typeof bt === 'object' && typeof bt.net === 'number') net = bt.net;
    }
    const custId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    const active = activeCustomerIds.has(custId) ? 1 : 0;
    return [inv.created, paid, subtotal, coupon, net, active];
  });
}

// NOTA — bug conocido, sin resolver a propósito (ver mensaje del chat):
// esto guarda item.price.unit_amount, que es precio de LISTA, no el precio
// real pagado con cupón. El CUS_MRR ya horneado en index.html SÍ tiene
// precios con descuento (viene de una generación anterior). Hasta que se
// decida cómo recalcularlo (¿tomar el último invoice pagado del cliente,
// como ya hace buildInvData?), esta función se deja igual que en el
// refresh.js original para no introducir un cambio de comportamiento no
// pedido.
export function buildCusMrr(subs) {
  const out = {};
  for (const s of subs) {
    if (s.status !== 'active' && s.status !== 'trialing') continue;
    const item = s.items.data[0];
    if (!item) continue;
    const custId = typeof s.customer === 'string' ? s.customer : s.customer.id;
    out[custId] = [item.price.unit_amount, item.price.recurring?.interval_count || 1];
  }
  return out;
}

export function buildCmap(invoices) {
  const out = {};
  for (const inv of invoices) {
    const custId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    if (!custId || out[custId]) continue;
    const name = inv.customer_name || '';
    const email = inv.customer_email || '';
    if (name || email) out[custId] = [name, email];
  }
  return out;
}

// Fetches everything and returns the four datasets, ready either to send as
// JSON (api/refresh.js) or to bake into index.html (refresh-and-bake.mjs).
export async function fetchStripeDataset() {
  const stripe = getStripeClient();
  const [subs, invoices] = await Promise.all([
    fetchAllSubscriptions(stripe),
    fetchAllInvoices(stripe),
  ]);
  const activeCustomerIds = new Set(
    subs
      .filter((s) => s.status === 'active' || s.status === 'trialing')
      .map((s) => (typeof s.customer === 'string' ? s.customer : s.customer.id))
  );
  return {
    RAW: buildRaw(subs),
    INV_DATA: buildInvData(invoices, activeCustomerIds),
    CUS_MRR: buildCusMrr(subs),
    CMAP: buildCmap(invoices),
    counts: { subscriptions: subs.length, invoices: invoices.length },
  };
}
