// Planning Dayan 3D : crée une commande à chaque paiement réussi de la boutique du site.
//
// Stripe envoie l'événement « checkout.session.completed » à cette fonction.
// La fonction vérifie la signature, ignore les paiements de factures (Payment Links),
// lit le détail de l'achat chez Stripe, puis crée (ou retrouve) la fiche client et la commande.
//
// Secrets à définir dans Supabase (Edge Functions > Secrets) :
//   STRIPE_SECRET_KEY       clé secrète Stripe (sk_live_...)
//   STRIPE_WEBHOOK_SECRET   secret de signature du webhook (whsec_...)
//   SHOP_URL_CONTAINS       (facultatif) texte que doit contenir l'adresse de retour du paiement,
//                           « dayan-3d.ch » par défaut. Mettre une valeur vide pour tout accepter.
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY existent déjà automatiquement.

const enc = new TextEncoder();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Vérifie l'en-tête « Stripe-Signature » (HMAC SHA-256 du texte « horodatage.corps »).
async function verifySignature(body: string, header: string, secret: string, toleranceSec = 300): Promise<boolean> {
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = v;
    if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`)));
  return signatures.some((s) => safeEqual(s, expected));
}

function formatAddress(a: any): string {
  if (!a) return '';
  return [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ');
}

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

async function supa(path: string, init: RequestInit & { prefer?: string } = {}): Promise<Response> {
  const url = `${Deno.env.get('SUPABASE_URL')}/rest/v1/${path}`;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (init.prefer) headers.Prefer = init.prefer;
  return fetch(url, { method: init.method ?? 'GET', headers, body: init.body });
}

async function findOrCreateClient(name: string, email: string, phone: string, address: string): Promise<string | null> {
  if (email) {
    const pattern = email.replace(/[\\%_]/g, (c) => `\\${c}`);
    const r = await supa(`clients?email=ilike.${encodeURIComponent(pattern)}&select=id&limit=1`);
    if (r.ok) {
      const rows = await r.json();
      if (rows.length) return rows[0].id;
    }
  }
  const r = await supa('clients', {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify({
      name: name || email || 'Client de la boutique',
      email: email || null,
      phone: phone || null,
      address: address || null,
      notes: 'Fiche créée automatiquement depuis la boutique du site.',
    }),
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0]?.id ?? null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ ok: true, info: 'Webhook Stripe de la boutique Dayan 3D' });

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!secret || !stripeKey) return json({ error: 'STRIPE_WEBHOOK_SECRET ou STRIPE_SECRET_KEY manquant' }, 500);

  const body = await req.text();
  const header = req.headers.get('stripe-signature') ?? '';
  if (!(await verifySignature(body, header, secret))) return json({ error: 'signature invalide' }, 400);

  let event: any;
  try { event = JSON.parse(body); } catch { return json({ error: 'corps illisible' }, 400); }

  if (event.type !== 'checkout.session.completed') return json({ ignored: event.type });
  const s = event.data?.object ?? {};
  if (s.payment_status !== 'paid') return json({ ignored: 'paiement non confirmé' });
  if (s.payment_link) return json({ ignored: 'paiement de facture (Payment Link)' });

  const must = Deno.env.get('SHOP_URL_CONTAINS') ?? 'dayan-3d.ch';
  if (must && !`${s.success_url ?? ''} ${s.cancel_url ?? ''}`.includes(must)) return json({ ignored: 'paiement hors boutique' });

  // détail complet de l'achat (articles, adresse)
  const sr = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(s.id)}?expand[]=line_items`, {
    headers: { Authorization: `Bearer ${stripeKey}` },
  });
  if (sr.status === 404) return json({ ignored: 'session introuvable chez Stripe' });
  if (!sr.ok) return json({ error: `Stripe a répondu ${sr.status}` }, 500);
  const full = await sr.json();

  const cd = full.customer_details ?? {};
  const ship = full.shipping_details ?? full.collected_information?.shipping_details ?? null;
  const name: string = cd.name || ship?.name || '';
  const email: string = cd.email || '';
  const phone: string = cd.phone || '';
  const address = formatAddress(ship?.address ?? cd.address);
  const currency: string = String(full.currency || 'chf').toUpperCase();
  const items: any[] = full.line_items?.data ?? [];

  const lines = items.map((it) => `- ${it.quantity ?? 1} × ${it.description ?? 'Article'} (${money(it.amount_total ?? 0, currency)})`);
  const shippingCents = full.total_details?.amount_shipping ?? 0;
  if (shippingCents > 0) lines.push(`- Livraison (${money(shippingCents, currency)})`);

  const first = items[0]?.description ?? 'Commande boutique';
  const title = (items.length > 1 ? `${first} et ${items.length - 1} autre${items.length > 2 ? 's' : ''} article${items.length > 2 ? 's' : ''}` : first).slice(0, 140);

  const notes = [
    'Commande reçue depuis la boutique du site, payée par carte (Stripe).',
    lines.length ? `\nArticles :\n${lines.join('\n')}` : '',
    `\nTotal payé : ${money(full.amount_total ?? 0, currency)}`,
    name || email || phone || address ? `\nClient : ${[name, email, phone, address].filter(Boolean).join(' | ')}` : '',
    `\nPaiement Stripe : ${full.id}`,
  ].join('').trim();

  const clientId = await findOrCreateClient(name, email, phone, address);

  const r = await supa('orders?on_conflict=stripe_session_id', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=representation',
    body: JSON.stringify({
      client: name || email || null,
      client_id: clientId,
      title,
      status: 'todo',
      priority: 'normal',
      price_chf: (full.amount_total ?? 0) / 100,
      tags: ['boutique'],
      notes,
      source: 'boutique',
      stripe_session_id: full.id,
    }),
  });
  if (!r.ok) return json({ error: `création de la commande impossible (${r.status}) : ${await r.text()}` }, 500);
  const rows = await r.json();
  return json(rows.length ? { created: rows[0].id } : { ignored: 'commande déjà enregistrée' });
});
