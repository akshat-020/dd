/**
 * Web app entry points (Deploy → New deployment → Web app).
 *
 *   Phone line:  POST/GET <web app URL>?source=generic&key=<WEBHOOK_KEY>   (JSON body, see README)
 *                GET      <web app URL>?source=exotel&key=<WEBHOOK_KEY>    (Exotel Passthru applet)
 *   WhatsApp:    <web app URL>?source=whatsapp&key=<WEBHOOK_KEY>           (Meta webhook callback URL)
 *
 * Apps Script cannot read request headers, so authentication is the secret
 * key in the URL (and Meta's verify token for the WhatsApp handshake).
 * Treat the full URL like a password.
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  // Meta's one-time webhook verification handshake.
  if (p['hub.mode'] === 'subscribe') {
    var ok = p['hub.verify_token'] && p['hub.verify_token'] === secret_('WA_VERIFY_TOKEN');
    return ContentService.createTextOutput(ok ? p['hub.challenge'] : 'verification failed');
  }
  if (!keyOk_(p)) return text_('unauthorized');
  if (p.source === 'exotel') return text_(safely_(function () { return handleCallEvent(mapExotelEvent(p)); }));
  if (p.source === 'generic' && p.from) return text_(safely_(function () { return handleCallEvent(mapGenericEvent(p)); }));
  return text_('call desk ok');
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  if (!keyOk_(p)) return text_('unauthorized');
  var body = {};
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { body = {}; }

  if (p.source === 'whatsapp') return text_(safely_(function () { return handleWhatsAppWebhook_(body); }));
  if (p.source === 'exotel') return text_(safely_(function () { return handleCallEvent(mapExotelEvent(Object.keys(body).length ? body : p)); }));
  return text_(safely_(function () { return handleCallEvent(mapGenericEvent(body)); }));
}

function keyOk_(p) {
  var key = secret_('WEBHOOK_KEY');
  return !!key && p.key === key;
}

function text_(s) {
  return ContentService.createTextOutput(String(s));
}

/** Never let one bad event break the endpoint; errors are logged to the Messages tab. */
function safely_(fn) {
  try {
    return fn();
  } catch (err) {
    try { logMessage_('ERR', '', 'ERROR', '', '', String(err && err.stack || err), 'error'); } catch (ignored) { /* sheet unavailable */ }
    return 'error';
  }
}

function handleWhatsAppWebhook_(body) {
  var results = [];
  var cache = CacheService.getScriptCache();
  (body.entry || []).forEach(function (entry) {
    (entry.changes || []).forEach(function (change) {
      var value = change.value || {};
      (value.messages || []).forEach(function (m) {
        // Meta retries deliveries it thinks failed — process each message once.
        if (cache.get('wa:' + m.id)) return;
        cache.put('wa:' + m.id, '1', 21600);
        var text = '';
        if (m.type === 'text') text = m.text && m.text.body;
        else if (m.type === 'button') text = m.button && (m.button.payload || m.button.text);
        else if (m.type === 'interactive') text = m.interactive && m.interactive.button_reply && m.interactive.button_reply.id;
        else text = '[' + m.type + ']';
        results.push(handleIncomingMessage({
          from: normalizePhone('+' + m.from),
          text: text,
          contextId: m.context && m.context.id,
          waId: m.id
        }));
      });
      (value.statuses || []).forEach(function (s) {
        if (s.status === 'failed') {
          var err = (s.errors && s.errors[0] && (s.errors[0].title || s.errors[0].message)) || 'failed';
          logMessage_('STATUS', normalizePhone('+' + s.recipient_id), 'DELIVERY', '', s.id, '', 'FAILED: ' + err);
        }
      });
    });
  });
  return results.join('; ') || 'ok';
}
