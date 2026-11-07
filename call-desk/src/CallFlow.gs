/**
 * What happens after every call (design §4, §7):
 *  - every call is logged;
 *  - a missed incoming call becomes a callback ticket (or updates the
 *    caller's open ticket) and the caller gets a WhatsApp acknowledgement;
 *  - repeat calls escalate to P0;
 *  - an outgoing callback through the business line counts as an attempt,
 *    closes the ticket if it connected, or marks it UNREACHABLE after
 *    MAX_ATTEMPTS.
 * Returns a short description of what was done (shown in webhook logs/tests).
 */
function handleCallEvent(ev) {
  return withLock_(function () {
    if (ev.callId && callAlreadyLogged_(ev.callId)) return 'duplicate ' + ev.callId;

    // The other party: the caller for incoming calls, the person called for callbacks.
    var party = ev.direction === 'OUTBOUND' ? ev.to : ev.from;
    var contact = findContact_(party);
    var recent = party && ev.direction === 'INBOUND' ? readLastRows_(SHEETS.CALLS, 300).filter(function (c) {
      return normalizePhone(c.Phone) === party && c.Direction === 'INBOUND';
    }) : [];

    var callRow = appendObject_(SHEETS.CALLS, {
      Time: ev.startedAt || new Date(), 'Call ID': ev.callId, Phone: party || 'withheld', Name: displayName_(contact),
      Tag: contact ? contact.tag : 'UNKNOWN', Direction: ev.direction, Answered: ev.answered ? 'YES' : 'NO',
      'Answered by': ev.answeredBy, 'Duration (s)': ev.durationSec, Recording: ev.recordingUrl
    });

    if (!party) return 'logged (no number)';
    if (ev.direction === 'OUTBOUND') return handleCallback_(ev, callRow);
    if (ev.answered) return 'logged (answered)';
    return handleMissed_(ev, contact, recent, callRow);
  });
}

function callAlreadyLogged_(callId) {
  var rows = readLastRows_(SHEETS.CALLS, 300);
  for (var i = 0; i < rows.length; i++) if (String(rows[i]['Call ID']) === String(callId)) return true;
  return false;
}

function handleMissed_(ev, contact, recentInbound, callRow) {
  var now = ev.startedAt || new Date();
  var tag = contact ? contact.tag : 'UNKNOWN';
  var repeat = isRepeatCaller(recentInbound.map(function (c) { return asDate_(c.Time); }).filter(Boolean), now);
  var triage = triageFor(tag, contact && contact.voiceOnly, repeat);
  if (!triage) return 'blocked number — logged only';

  var hours = businessHours_();
  var ticket = openTicketForPhone_(ev.from);
  var action;

  if (ticket) {
    var newPriority = higherPriority(ticket.priority, triage.priority);
    var patch = { 'Missed calls': ticket.missedCount + 1 };
    if (newPriority !== ticket.priority) {
      patch.Priority = newPriority;
      patch.Deadline = computeDeadline(newPriority, now, hours);
      patch.Reminded = '';
      patch.Escalated = '';
    }
    updateTicket_(ticket, patch);
    ticket = ticketById_(ticket.id);
    action = 'updated #' + ticket.id;
    if (newPriority === 'P0' && patch.Priority) notifyForTicket_(ticket, repeat ? '🔁 Called again and again' : null);
  } else {
    var owner = resolveOwner_(triage.owner, contact);
    ticket = createTicket_({
      phone: ev.from, callerName: displayName_(contact), tag: tag, priority: triage.priority,
      owner: owner.name, summary: repeat ? 'Called repeatedly' : 'Missed call', missedCount: 1
    });
    action = 'ticket #' + ticket.id + ' ' + ticket.priority + ' → ' + ticket.owner;
    notifyForTicket_(ticket, repeat ? '🔁 Called again and again' : null);
  }
  updateRow_(SHEETS.CALLS, callRow, { Ticket: ticket.id });

  if (triage.ack !== 'NONE' && ackDue_(ticket, now)) {
    var kind = triage.ack === 'VIP' ? 'VIP' : (isOpenAt(now, hours) ? 'STANDARD' : 'AFTER_HOURS');
    var r = sendAck_(ev.from, kind, { name: contact ? contact.name : '', promise: promiseText(ticket.deadline, now) }, ticket.id);
    if (r.ok) updateTicket_(ticket, { 'Ack sent': now });
    action += r.ok ? ' + ack' : ' (ack failed)';
  }
  return action;
}

function ackDue_(ticket, now) {
  if (!ticket.ackSent) return true;
  var cooldownH = Number(setting_('ACK_COOLDOWN_HOURS', 6)) || 6;
  return now.getTime() - ticket.ackSent.getTime() > cooldownH * 3600000;
}

function handleCallback_(ev, callRow) {
  var phone = ev.to;
  var ticket = phone ? openTicketForPhone_(phone) : null;
  if (!ticket) return 'logged (outgoing)';
  updateRow_(SHEETS.CALLS, callRow, { Ticket: ticket.id });

  var autoDone = Number(setting_('AUTO_DONE_SECONDS', 30)) || 30;
  if (ev.answered && ev.durationSec >= autoDone) {
    closeTicket_(ticket, 'DONE', ev.answeredBy || ticket.owner, 'Auto: callback connected ' + ev.durationSec + 's');
    return 'ticket #' + ticket.id + ' done (callback connected)';
  }
  var attempts = ticket.attempts + 1;
  var maxAttempts = Number(setting_('MAX_ATTEMPTS', 3)) || 3;
  if (attempts >= maxAttempts) {
    updateTicket_(ticket, { Attempts: attempts });
    closeTicket_(ticket, 'UNREACHABLE', ticket.owner, attempts + ' callback attempts, no answer');
    sendUnreachable_(phone, ticket.id);
    return 'ticket #' + ticket.id + ' unreachable';
  }
  updateTicket_(ticket, { Attempts: attempts, Status: 'ATTEMPTED' });
  return 'ticket #' + ticket.id + ' attempt ' + attempts;
}
