// ================= card payments (Rivhit iCredit payment page, cleared by UPAY) =================
// Nothing here runs until RIVHIT_GROUP_TOKEN is set on the server, so adding this file changes nothing by itself.
//
// How a payment works:
//   1. A payment record is saved here ("payment"), with the amount fixed by us, never by the customer.
//   2. The customer opens /pay/<id>. The server asks iCredit for a fresh payment page and sends the customer there.
//   3. After a successful charge iCredit sends a message (IPN) to /api/pay/ipn. We ask iCredit to confirm it (Verify),
//      and only then mark the payment as paid and add the income to the money page.
//   iCredit itself emails the customer the receipt (SendMail).
//
// Server settings (Render → Environment):
//   RIVHIT_GROUP_TOKEN   the payment page identifier from iCredit (GroupPrivateToken)
//   RIVHIT_TEST=1        use iCredit's test environment (fake money). Leave out on the live server.
//   RIVHIT_EXEMPT_VAT=1  documents without VAT (only after the accountant confirms)

const crypto = require('crypto');

module.exports = function payments(app, { store, adminOnly, baseOf, secret, getBase }) {
  const TOKEN = process.env.RIVHIT_GROUP_TOKEN || '';
  const TEST = process.env.RIVHIT_TEST === '1';
  const API = process.env.RIVHIT_API || `https://${TEST ? 'testicredit' : 'icredit'}.rivhit.co.il/API/PaymentPageRequest.svc`;   // RIVHIT_API: only for local checks
  const EXEMPT_VAT = process.env.RIVHIT_EXEMPT_VAT === '1';

  const sig = id => crypto.createHmac('sha256', secret).update('pay:' + id).digest('base64url').slice(0, 20);
  const clip = (v, n) => String(v ?? '').trim().slice(0, n);
  const money2 = v => Math.round(parseFloat(String(v).replace(/[^\d.]/g, '')) * 100) / 100;
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const base = req => getBase() || baseOf(req);

  async function rivhit(method, body) {
    const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { throw new Error(`iCredit ${method}: ${r.status} ${txt.slice(0, 150)}`); }
  }

  // ---------- simple English pages for the customer ----------
  function page(res, title, text, code = 200) {
    res.status(code).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{margin:0;font-family:Arial,sans-serif;background:#0b1433;color:#fff;display:grid;place-items:center;min-height:100vh;text-align:center}
.c{max-width:460px;padding:36px 28px;background:#141f4a;border-radius:18px;margin:20px}h1{color:#e9b949;font-size:26px;margin:0 0 14px}p{font-size:17px;line-height:1.55;color:#dfe5ff;margin:0}</style></head>
<body><div class="c"><h1>${esc(title)}</h1><p>${text}</p></div></body></html>`);
  }

  // ---------- create a payment record (used by the admin, and later by the website) ----------
  async function createPayment({ orderKey, amount, desc, name, email, phone, source }) {
    const p = { id: 'pay-' + crypto.randomBytes(6).toString('hex'), kind: 'payment', orderKey: clip(orderKey, 80), source: source || 'manual',
      amount, cur: 'USD', desc: clip(desc, 60) || 'Tricky Trivia', name: clip(name, 60), email: clip(email, 50), phone: clip(phone, 15),
      status: 'open', createdAt: Date.now(), updatedAt: Date.now() };
    await store.set(p.id, p);
    return p;
  }

  // admin: make a payment link for an order (an older open link of the same order stops working, so nobody pays twice)
  app.post('/api/admin/paylink', adminOnly, async (req, res) => {
    if (!TOKEN) return res.status(400).json({ error: 'התשלום באשראי עוד לא מחובר בשרת הזה' });
    const b = req.body, amount = money2(b.amount);
    if (!(amount >= 1 && amount <= 5000)) return res.status(400).json({ error: 'צריך לכתוב סכום בדולרים, בין 1 ל-5000' });
    const orderKey = clip(b.orderKey, 80);
    if (!orderKey) return res.status(400).json({ error: 'חסרה הזמנה' });
    const all = (await store.byKind('payment')).filter(x => x.orderKey === orderKey);
    if (all.some(x => x.status === 'paid')) return res.status(400).json({ error: 'ההזמנה הזאת כבר שולמה' });
    for (const old of all.filter(x => x.status === 'open')) { old.status = 'replaced'; old.updatedAt = Date.now(); await store.set(old.id, old); }
    const p = await createPayment({ orderKey, amount, desc: b.desc, name: b.name, email: b.email, phone: b.phone, source: 'manual' });
    res.json({ ok: true, link: `${base(req)}/pay/${p.id}`, amount });
  });

  // ---------- the customer opens the payment link ----------
  app.get('/pay/:id', async (req, res) => {
    const id = String(req.params.id || '');
    const p = /^pay-[a-f0-9]{12}$/.test(id) ? await store.get(id) : null;
    if (!p || p.kind !== 'payment') return page(res, 'Link not found', 'This payment link is not valid. Please contact us for a new one.', 404);
    if (p.status === 'paid') return page(res, 'Already paid ✓', 'This order is already paid. Thank you!');
    if (p.status === 'replaced') return page(res, 'This link has been replaced', 'We sent you a newer payment link. Please use the latest one.');
    if (!TOKEN) return page(res, 'Payment is not available', 'Card payment is not available right now. Please contact us.', 503);
    try {
      const b = base(req), parts = p.name.split(/\s+/);
      const body = {
        GroupPrivateToken: TOKEN,
        Items: [{ Id: 0, CatalogNumber: 'trivia', UnitPrice: p.amount, Quantity: 1, Description: p.desc }],
        Currency: 2, DocumentLanguage: 'en', MaxPayments: 1,
        CustomerLastName: clip(parts.length > 1 ? parts.slice(1).join(' ') : p.name, 30) || 'Customer',
        Order: p.id.slice(4, 19), Custom1: p.id,
        RedirectURL: `${b}/pay/${p.id}/thanks`,
        IPNURL: `${b}/api/pay/ipn?p=${p.id}&s=${sig(p.id)}`, IPNFailureURL: `${b}/api/pay/ipn?p=${p.id}&s=${sig(p.id)}&f=1`, IPNMethod: 1,
      };
      if (parts.length > 1) body.CustomerFirstName = clip(parts[0], 20);
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) { body.EmailAddress = p.email; body.SendMail = true; }
      if (p.phone) body.PhoneNumber = p.phone.replace(/[^\d+]/g, '').slice(0, 15);
      if (EXEMPT_VAT) body.ExemptVAT = true;
      const r = await rivhit('GetUrl', body);
      if (r.Status !== 0 || !r.URL) throw new Error(`GetUrl status ${r.Status}: ${r.DebugMessage || ''}`);
      p.opens = (p.opens || 0) + 1; p.lastOpen = Date.now(); p.updatedAt = Date.now(); await store.set(p.id, p);
      res.redirect(r.URL);
    } catch (e) {
      p.lastError = String(e.message || e).slice(0, 200); p.updatedAt = Date.now(); await store.set(p.id, p).catch(() => {});
      console.log('pay page error', p.id, p.lastError);
      page(res, 'Something went wrong', 'We could not open the payment page. Please try again in a minute, or contact us.', 502);
    }
  });

  app.get('/pay/:id/thanks', (req, res) =>
    page(res, 'Thank you! 🎉', 'Your payment went through. The receipt is on its way to your email, and your game links will follow.'));

  // ---------- iCredit's message after a charge ----------
  const busy = new Set();
  app.post('/api/pay/ipn', require('express').text({ type: () => true }), (req, res) => {
    res.status(200).send('OK');   // iCredit waits only 1.25 seconds, so answer first and work after
    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = Object.fromEntries(new URLSearchParams(b)); } }
    console.log('ipn', req.query.p, req.query.f ? 'failed' : '', 'fields:', Object.keys(b).slice(0, 12).join(','), 'status:', b.TransactionStatus);
    handleIpn(String(req.query.p || ''), String(req.query.s || ''), !!req.query.f, b).catch(e => console.log('ipn error', e.message));
  });

  async function handleIpn(id, s, failed, b) {
    if (!/^pay-[a-f0-9]{12}$/.test(id) || s !== sig(id)) return console.log('ipn: bad link', id);
    if (busy.has(id)) return; busy.add(id);
    try {
      const p = await store.get(id);
      if (!p || p.kind !== 'payment' || p.status === 'paid') return;
      if (failed || String(b.TransactionStatus ?? '0') !== '0') {   // a declined card: the customer can simply try again
        p.fails = (p.fails || 0) + 1; p.lastError = clip(b.ErrorDescription || b.ErrorMessage || 'declined', 200); p.updatedAt = Date.now();
        return void await store.set(p.id, p);
      }
      if (!b.SaleId) return;
      const v = await rivhit('Verify', { GroupPrivateToken: TOKEN, SaleId: String(b.SaleId), TotalAmount: p.amount });
      if (String(v.Status).toUpperCase() !== 'VERIFIED') {
        p.lastError = 'iCredit did not confirm the payment: ' + JSON.stringify(v).slice(0, 120); p.updatedAt = Date.now();
        return void await store.set(p.id, p);
      }
      Object.assign(p, { status: 'paid', paidAt: Date.now(), saleId: String(b.SaleId), docNum: clip(b.DocumentNum, 30), docUrl: clip(b.DocumentURL, 500),
        card: clip(b.TransactionCardNum, 30), paidCur: clip(b.TransactionCurrency, 5), lastError: '', updatedAt: Date.now() });
      await store.set(p.id, p);
      // the income goes into the money page by itself (one entry per payment, even if iCredit sends the message twice)
      const mid = 'mn-pay-' + p.id.slice(4);
      if (!(await store.get(mid))) await store.set(mid, { id: mid, kind: 'money', type: 'in', date: Date.now(), amount: p.amount, cur: 'USD',
        cat: 'טריוויה', note: `אשראי · ${p.name || ''}${p.docNum ? ` · קבלה ${p.docNum}` : ''}`.slice(0, 200), createdAt: Date.now(), updatedAt: Date.now(), auto: true });
      console.log('PAID', p.id, p.amount);
    } finally { busy.delete(id); }
  }

  // payment state of each order, for the orders list
  return {
    enabled: !!TOKEN, test: TEST,
    async byOrder() {
      const list = (await store.byKind('payment')).filter(p => p.status !== 'replaced').sort((a, b) => a.createdAt - b.createdAt);
      const out = {};
      for (const p of list) if (!out[p.orderKey] || out[p.orderKey].status !== 'paid') out[p.orderKey] = p;
      return out;
    },
  };
};
