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

// CUS_MRR = monto REAL cobrado por ciclo, por cliente: { cus_X: [cents, interval_count] }
//
// Importante: NO usa item.price.unit_amount (precio de LISTA). Con ~45% de
// descuento promedio por cupones, el precio de lista infla la proyección de
// forma significativa. En su lugar toma el amount_paid de la última factura
// real de cada suscripción.
//
// Solo cuenta facturas de ciclo/creación de suscripción (subscription_cycle,
// subscription_create) — ignora prorrateos y facturas de cambio de plan, que
// tienen montos parciales y no representan el cobro recurrente.
//
// Si un cliente no tiene ninguna factura utilizable, se OMITE del mapa a
// propósito: el dashboard detecta la ausencia, aplica el ratio de descuento
// promedio observado, y marca ese monto con un asterisco. Es preferible un
// estimado marcado que un precio de lista silenciosamente inflado.
export function buildCusMrr(subs, invoices) {
  const BILLING_REASONS_OK = new Set(['subscription_cycle', 'subscription_create']);

  // sub_id -> factura pagada más reciente que representa un cobro de ciclo
  const latestBySub = new Map();
  for (const inv of invoices) {
    if (!inv.amount_paid || inv.amount_paid <= 0) continue;
    if (inv.billing_reason && !BILLING_REASONS_OK.has(inv.billing_reason)) continue;
    // apiVersion 2024-06-20: el sub va en inv.subscription; versiones nuevas
    // lo mueven a inv.parent.subscription_details.subscription — soportamos ambas.
    const subRef =
      inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
    const subId = typeof subRef === 'string' ? subRef : subRef?.id;
    if (!subId) continue;
    const prev = latestBySub.get(subId);
    if (!prev || inv.created > prev.created) {
      latestBySub.set(subId, { created: inv.created, amount: inv.amount_paid });
    }
  }

  const out = {};
  for (const s of subs) {
    if (s.status !== 'active' && s.status !== 'trialing') continue;
    const item = s.items.data[0];
    if (!item) continue;
    const hit = latestBySub.get(s.id);
    if (!hit) continue; // sin factura real -> se omite, el dashboard lo estima
    const custId = typeof s.customer === 'string' ? s.customer : s.customer.id;
    const intervalCount = item.price.recurring?.interval_count || 1;
    // Si un cliente tiene varias suscripciones, nos quedamos con el cobro más
    // reciente entre todas (mismo criterio que el resto del dashboard).
    const existing = out[custId];
    if (!existing || hit.created > (existing[2] || 0)) {
      out[custId] = [hit.amount, intervalCount, hit.created];
    }
  }
  // Recortamos el timestamp auxiliar: el formato final es [cents, interval_count]
  for (const k of Object.keys(out)) out[k] = [out[k][0], out[k][1]];
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
    CUS_MRR: buildCusMrr(subs, invoices),
    CMAP: buildCmap(invoices),
    counts: { subscriptions: subs.length, invoices: invoices.length },
  };
}
