// /api/refresh.js
// Vercel Serverless Function — Node runtime
// Fetches fresh data from Stripe and returns it in the exact shape
// the GAMMALito dashboard expects for RAW, INV_DATA, CUS_MRR and CMAP.
//
// Env vars needed (set in Vercel project settings):
//   STRIPE_SECRET_KEY = sk_live_xxx   (Restricted key with read-only access
//                                      to Subscriptions, Invoices, Customers
//                                      is enough)
//
// Optional env vars:
//   ALLOWED_ORIGIN = https://tu-dominio.com  (for CORS, defaults to "*")

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// --- helpers -------------------------------------------------------------

async function fetchAllSubscriptions() {
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

async function fetchAllInvoices() {
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

// Build RAW: one row per subscription item
function buildRaw(subs) {
  const raw = [];
  for (const s of subs) {
    for (const item of s.items.data) {
      raw.push({
        c: s.created,
        s: s.status,
        p: item.price.product,
        a: item.price.unit_amount,
        i: item.price.recurring?.interval || 'month',
        n: item.price.recurring?.interval_count || 1,
        cus: typeof s.customer === 'string' ? s.customer : s.customer.id,
      });
    }
  }
  // Most recent first, matching the existing dataset's ordering
  raw.sort((a, b) => b.c - a.c);
  return raw;
}

// Build INV_DATA: [created, paid_amount, subtotal_before_discount, coupon, net, active_flag]
function buildInvData(invoices, activeCustomerIds) {
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
      if (typeof bt === 'object' && typeof bt.net === 'number') {
        net = bt.net;
      }
    }

    const custId =
      typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    const active = activeCustomerIds.has(custId) ? 1 : 0;

    return [inv.created, paid, subtotal, coupon, net, active];
  });
}

// Build CUS_MRR: { cus_id: [amount, interval_count] } for active subscriptions
function buildCusMrr(subs) {
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

// Build CMAP: { cus_id: [name, email] } sourced from invoice customer details
function buildCmap(invoices) {
  const out = {};
  for (const inv of invoices) {
    const custId =
      typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    if (!custId || out[custId]) continue;
    const name = inv.customer_name || '';
    const email = inv.customer_email || '';
    if (name || email) out[custId] = [name, email];
  }
  return out;
}

// --- handler ---------------------------------------------------------------

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    res.status(500).json({ error: 'STRIPE_SECRET_KEY no configurada' });
    return;
  }

  try {
    const [subs, invoices] = await Promise.all([
      fetchAllSubscriptions(),
      fetchAllInvoices(),
    ]);

    const activeCustomerIds = new Set(
      subs
        .filter((s) => s.status === 'active' || s.status === 'trialing')
        .map((s) => (typeof s.customer === 'string' ? s.customer : s.customer.id))
    );

    const RAW = buildRaw(subs);
    const INV_DATA = buildInvData(invoices, activeCustomerIds);
    const CUS_MRR = buildCusMrr(subs);
    const CMAP = buildCmap(invoices);

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      RAW,
      INV_DATA,
      CUS_MRR,
      CMAP,
      counts: {
        subscriptions: subs.length,
        invoices: invoices.length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stripe fetch failed', detail: String(err) });
  }
}
