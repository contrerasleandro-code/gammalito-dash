// /api/refresh.js — incluye canceled_at (campo "ca") en RAW
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

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

function buildRaw(subs) {
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
      };
      // Incluir canceled_at si existe (campo "ca")
      if (s.canceled_at) entry.ca = s.canceled_at;
      raw.push(entry);
    }
  }
  raw.sort((a, b) => b.c - a.c);
  return raw;
}

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
      if (typeof bt === 'object' && typeof bt.net === 'number') net = bt.net;
    }
    const custId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id;
    const active = activeCustomerIds.has(custId) ? 1 : 0;
    return [inv.created, paid, subtotal, coupon, net, active];
  });
}

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

function buildCmap(invoices) {
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

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!process.env.STRIPE_SECRET_KEY) { res.status(500).json({ error: 'STRIPE_SECRET_KEY no configurada' }); return; }

  try {
    const [subs, invoices] = await Promise.all([fetchAllSubscriptions(), fetchAllInvoices()]);
    const activeCustomerIds = new Set(
      subs.filter(s => s.status === 'active' || s.status === 'trialing')
          .map(s => typeof s.customer === 'string' ? s.customer : s.customer.id)
    );
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      RAW: buildRaw(subs),
      INV_DATA: buildInvData(invoices, activeCustomerIds),
      CUS_MRR: buildCusMrr(subs),
      CMAP: buildCmap(invoices),
      counts: { subscriptions: subs.length, invoices: invoices.length },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Stripe fetch failed', detail: String(err) });
  }
}
