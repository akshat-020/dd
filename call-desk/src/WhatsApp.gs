/**
 * WhatsApp Cloud API (Meta). Most Indian BSPs (Interakt, AiSensy, WATI,
 * Gupshup) either expose this same API or their own — if yours differs,
 * only waPost_() needs changing.
 *
 * WHATSAPP_ENABLED = FALSE (the default) sends nothing: every message is
 * written to the Messages tab instead, so the whole flow can be tested
 * safely before the WhatsApp account is approved.
 */

var WA_WINDOW_CLOSED_CODES = [131047, 131026, 470];

function waEnabled_() {
  return truthy_(setting_('WHATSAPP_ENABLED', 'FALSE'));
}

function logMessage_(direction, phone, kind, ticketId, waId, text, result) {
  appendObject_(SHEETS.MESSAGES, {
    Time: new Date(), Direction: direction, Phone: phone, Kind: kind, Ticket: ticketId || '',
    'WhatsApp ID': waId || '', Text: String(text || '').slice(0, 1500), Result: result
  });
}

/** Returns { ok, id, errorCode, error }. */
function waPost_(payload) {
  var url = 'https://graph.facebook.com/' + setting_('WA_API_VERSION', 'v21.0') + '/' + setting_('WA_PHONE_NUMBER_ID', '') + '/messages';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret_('WA_ACCESS_TOKEN') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { /* non-JSON error page */ }
  if (res.getResponseCode() >= 200 && res.getResponseCode() < 300 && body.messages && body.messages[0]) {
    return { ok: true, id: body.messages[0].id };
  }
  var err = body.error || {};
  return { ok: false, errorCode: err.code, error: (err.message || ('HTTP ' + res.getResponseCode())) };
}

function send_(phone, payload, kind, ticketId, textForLog) {
  if (!phone) return { ok: false, error: 'no phone' };
  if (!waEnabled_()) {
    logMessage_('OUT', phone, kind, ticketId, '', textForLog, 'DRY RUN (WHATSAPP_ENABLED is FALSE)');
    return { ok: true, dryRun: true };
  }
  payload.messaging_product = 'whatsapp';
  payload.to = String(phone).replace(/\D/g, '');
  var r;
  try {
    r = waPost_(payload);
  } catch (e) {
    r = { ok: false, error: String(e) };
  }
  logMessage_('OUT', phone, kind, ticketId, r.id, textForLog, r.ok ? 'sent' : 'FAILED: ' + r.error);
  return r;
}

function sendTemplate_(phone, templateName, params, kind, ticketId, textForLog) {
  return send_(phone, {
    type: 'template',
    template: {
      name: templateName,
      language: { code: setting_('WA_TEMPLATE_LANG', 'hi') },
      components: params.length ? [{ type: 'body', parameters: params.map(function (p) { return { type: 'text', text: templateParam_(p) }; }) }] : []
    }
  }, kind, ticketId, textForLog);
}

// WhatsApp rejects template parameters containing newlines, tabs or 4+ spaces.
function templateParam_(text) {
  return String(text).replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').slice(0, 1000);
}

/**
 * Message to the founder or a staff member. Free-form text/buttons only work
 * within 24 hours of their last message to the office number; outside that
 * window it falls back to the approved WA_TEMPLATE_NOTIFY template.
 * buttons: [{ id, title (max 20 chars) }] — at most 3.
 */
function notifyInternal_(phone, text, kind, ticketId, buttons) {
  var payload = buttons && buttons.length
    ? {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: text.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map(function (b) { return { type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } }; }) }
      }
    }
    : { type: 'text', text: { body: text.slice(0, 4096), preview_url: false } };
  var r = send_(phone, payload, kind, ticketId, text);
  if (!r.ok && WA_WINDOW_CLOSED_CODES.indexOf(Number(r.errorCode)) >= 0) {
    r = sendTemplate_(phone, setting_('WA_TEMPLATE_NOTIFY', 'staff_notify'), [text], kind + ' (template)', ticketId, text);
  }
  return r;
}

/** "Aapka call aaya tha…" to a caller — always a template (they haven't messaged us). */
function sendAck_(phone, kind, vars, ticketId) {
  var company = setting_('COMPANY_NAME', 'Office');
  var text = ackText(kind, { company: company, name: vars.name, promise: vars.promise });
  var promise = vars.promise.charAt(0).toUpperCase() + vars.promise.slice(1);
  if (kind === 'VIP') return sendTemplate_(phone, setting_('WA_TEMPLATE_ACK_VIP', 'ack_vip'), [vars.name || 'Sir/Madam', vars.promise, company], 'ACK_VIP', ticketId, text);
  if (kind === 'AFTER_HOURS') return sendTemplate_(phone, setting_('WA_TEMPLATE_ACK_AFTER_HOURS', 'ack_after_hours'), [promise, company], 'ACK_AFTER_HOURS', ticketId, text);
  return sendTemplate_(phone, setting_('WA_TEMPLATE_ACK', 'ack_missed'), [company, promise], 'ACK', ticketId, text);
}

function sendUnreachable_(phone, ticketId) {
  var company = setting_('COMPANY_NAME', 'Office');
  var text = 'Namaste 🙏 ' + company + ' se aapko call kiya tha, baat nahi ho paayi. Free hon toh isi number par call karein.';
  return sendTemplate_(phone, setting_('WA_TEMPLATE_ACK_UNREACHABLE', 'ack_unreachable'), [company], 'ACK_UNREACHABLE', ticketId, text);
}

/** The ticket number or call ref ("C12") of the message an incoming reply quoted. */
function refForReplyContext_(waId) {
  if (!waId) return null;
  var rows = readLastRows_(SHEETS.MESSAGES, 2000);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i]['WhatsApp ID'] === waId && rows[i].Ticket) return String(rows[i].Ticket);
  }
  return null;
}

/** Next-day "kaam hua?" — a template with Haan / Nahi quick-reply buttons. */
function sendFollowup_(phone, ticketId) {
  var company = setting_('COMPANY_NAME', 'Office');
  var text = 'Namaste 🙏 ' + company + ' se kal aapse baat hui thi. Kya aapka kaam ho gaya? [Haan] [Nahi]';
  return send_(phone, {
    type: 'template',
    template: {
      name: setting_('WA_TEMPLATE_FOLLOWUP', 'followup_check'),
      language: { code: setting_('WA_TEMPLATE_LANG', 'hi') },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: templateParam_(company) }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'F' + ticketId + ':Y' }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'F' + ticketId + ':N' }] }
      ]
    }
  }, 'FOLLOWUP', ticketId, text);
}
