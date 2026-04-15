'use strict';

// LandlordReady - api/reminders.js
// Certificate expiry reminder emails
//
// ENV VARS: CRON_SECRET, RESEND_API_KEY, NEXT_PUBLIC_SITE_URL

var https = require('https');

function sendEmail(apiKey, to, subject, html) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({ from: 'LandlordReady Reminders <reminders@landlordready.co.uk>', to: [to], subject, html });
    var opts = { hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    var req = https.request(opts, function(res) {
      var chunks = []; res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(JSON.parse(Buffer.concat(chunks).toString())); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

mmodule.exports = async function(req, res) {
  var secret = req.query && req.query.secret;
  var cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(503).json({ error: 'Not configured' });
  if (secret !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method === 'POST') {
    var body = req.body || {};
    var { email, name, certType, propName, daysUntil } = body;
    if (!email || !certType || !propName) return res.status(400).json({ error: 'Missing fields' });
    var resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(503).json({ error: 'Email not configured' });
    var siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://landlordready.co.uk';
    var days = parseInt(daysUntil) || 0;
    var urgency = days <= 7 ? 'URGENT: ' : days <= 30 ? 'Action needed: ' : 'Reminder: ';
    try {
      var result = await sendEmail(resendKey, email, urgency + certType + ' for ' + propName, '<p>Certificate: ' + certType + ' for ' + propName + ' expires in ' + days + ' days.</p><a href=' + siteUrl + '/tracker>Open tracker</a>');
      return res.status(200).json({ sent: true, id: result.id });
    } catch(e) { return res.status(500).json({ error: 'Failed to send' }); }
  }
  return res.status(200).json({ status: 'ok', message: 'Reminders endpoint ready' });
};
