'use strict';

// LandlordReady - api/webhook.js
// Stripe webhook handler
// ENV VARS: STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, RESEND_API_KEY, NOTION_API_KEY, NEXT_PUBLIC_SITE_URL

var crypto = require('crypto');
var https = require('https');

module.exports.config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, header, secret) {
  var parts = header.split(',').reduce(function(acc, part) {
    var kv = part.split('='); acc[kv[0]] = kv[1]; return acc;
  }, {});
  var timestamp = parts['t'], sig = parts['v1'];
  if (!timestamp || !sig) throw new Error('Invalid signature header');
  var expected = crypto.createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error('Signature mismatch');
}

function sendEmail(apiKey, to, subject, html) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({ from: 'LandlordReady <noreply@landlordready.co.uk>', to: [to], subject: subject, html: html });
    var opts = { hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    var req = https.request(opts, function(res) {
      var chunks = []; res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(JSON.parse(Buffer.concat(chunks).toString())); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function logToNotion(notionKey, data) {
  var dbId = process.env.NOTION_ORDERS_DB_ID || '971331b17eb44c3a9a2497c5e04cc62c';
  var props = {
    'Email': { title: [{ text: { content: data.email || 'unknown' } }] },
    'Name': { rich_text: [{ text: { content: data.name || '' } }] },
    'Product': { select: { name: data.product || 'unknown' } },
    'Amount': { number: data.amount || 0 },
    'Stripe Session': { rich_text: [{ text: { content: data.session_id || '' } }] },
    'Purchased': { date: { start: new Date().toISOString().split('T')[0] } }
  };
  var body = JSON.stringify({ parent: { database_id: dbId }, properties: props });
  await new Promise(function(resolve) {
    var opts = { hostname: 'api.notion.com', port: 443, path: '/v1/pages', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + notionKey, 'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28', 'Content-Length': Buffer.byteLength(body) } };
    var req = https.request(opts, function(res) { res.on('data', function(){}); res.on('end', resolve); });
    req.on('error', function(e) { console.error('[Notion]', e.message); resolve(); });
    req.write(body); req.end();
  });
}

function packEmail(name, siteUrl, sessionId) {
  var url = siteUrl + '/download?session_id=' + sessionId;
  return '<html><body style="font-family:Arial,sans-serif;background:#f8f6f1;padding:40px 0"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden"><div style="background:#0d1b2a;padding:32px 40px"><p style="margin:0;font-size:20px;font-weight:700;color:#fff">Landlord<span style="color:#c97d0a">Ready</span></p></div><div style="padding:40px"><h1 style="color:#0d1b2a">Your document pack is ready, ' + (name||'there') + '.</h1><p style="color:#6b7280">Thank you for your purchase. Your Renters Rights Act 2025 Document Pack is ready to download.</p><p><strong>Your pack includes:</strong><br>1. Assured Periodic Tenancy Agreement<br>2. Section 8 Possession Notice templates<br>3. Government Information Sheet (due to tenants by 31 May 2026)<br>4. Section 13 Rent Increase Notice<br>5. Compliance Action Checklist</p><a href="' + url + '" style="display:inline-block;background:#c97d0a;color:#0d1b2a;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none">Download Document Pack &rarr;</a><p style="color:#6b7280;font-size:13px;margin-top:16px">Link valid 48 hours. If expired, reply to this email.</p><hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"><p style="color:#9ca3af;font-size:12px">LandlordReady &middot; landlordready.co.uk &mdash; general information only, not legal advice.</p></div></div></body></html>';
}

function trackerEmail(name, siteUrl, sessionId) {
  var url = siteUrl + '/tracker?session_id=' + sessionId;
  return '<html><body style="font-family:Arial,sans-serif;background:#f8f6f1;padding:40px 0"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden"><div style="background:#0d1b2a;padding:32px 40px"><p style="margin:0;font-size:20px;font-weight:700;color:#fff">Landlord<span style="color:#c97d0a">Ready</span></p></div><div style="padding:40px"><h1 style="color:#0d1b2a">Welcome to the Certificate Tracker, ' + (name||'there') + '.</h1><p style="color:#6b7280">Your subscription is active. Add properties and certificate dates — we send reminders at 60, 30, and 7 days before expiry.</p><a href="' + url + '" style="display:inline-block;background:#c97d0a;color:#0d1b2a;font-weight:700;padding:14px 28px;border-radius:8px;text-decoration:none">Open Your Tracker &rarr;</a><p style="color:#374151;font-size:14px;margin-top:24px">Tracks: Gas Safety (annual), EICR (5yr), EPC (10yr), HMO licence, PRS Database, smoke/CO alarms.</p><hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"><p style="color:#9ca3af;font-size:12px">LandlordReady &middot; &pound;7/month &mdash; cancel anytime. Questions? Reply to this email.</p></div></div></body></html>';
}

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  var webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) { console.error('[Webhook] STRIPE_WEBHOOK_SECRET not set'); return res.status(503).end(); }
  var rawBody;
  try { rawBody = await getRawBody(req); } catch(e) { return res.status(400).end(); }
  var sig = req.headers['stripe-signature'];
  try { verifyStripeSignature(rawBody.toString(), sig, webhookSecret); } catch(e) {
    console.error('[Webhook] Bad signature:', e.message); return res.status(400).json({ error: 'Invalid signature' });
  }
  var event;
  try { event = JSON.parse(rawBody.toString()); } catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  var siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://landlordready.co.uk';
  var resendKey = process.env.RESEND_API_KEY;
  var notionKey = process.env.NOTION_API_KEY;
  if (event.type === 'checkout.session.completed') {
    var session = event.data.object;
    var email = session.customer_details && session.customer_details.email;
    var name = (session.metadata && session.metadata.name) || '';
    var product = session.metadata && session.metadata.product;
    var sessionId = session.id;
    var amount = session.amount_total ? session.amount_total / 100 : 0;
    console.log('[Webhook] Payment:', product, email, amount);
    if (notionKey && email) { try { await logToNotion(notionKey, { email, name, product, amount, session_id: sessionId }); } catch(e) { console.error('[Notion]', e.message); } }
    if (resendKey && email) {
      try {
        if (product === 'pack') { await sendEmail(resendKey, email, 'Your LandlordReady Document Pack is ready', packEmail(name, siteUrl, sessionId)); console.log('[Webhook] Pack email sent:', email); }
        else if (product === 'tracker_monthly' || product === 'tracker_yearly') { await sendEmail(resendKey, email, 'Welcome to LandlordReady Certificate Tracker', trackerEmail(name, siteUrl, sessionId)); console.log('[Webhook] Tracker email sent:', email); }
      } catch(e) { console.error('[Webhook] Email error:', e.message); }
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    var sub = event.data.object;
    console.log('[Webhook] Subscription cancelled:', sub.id, sub.customer);
  }
  return res.status(200).json({ received: true });
};
