/**
 * What happens after every call (design §4, §7):
 *  - every call is logged; a new number is saved to Contacts as UNKNOWN;
 *  - a missed (or dropped, under SHORT_CALL_SECONDS) incoming call becomes a
 *    callback ticket (or updates the caller's open ticket) and the caller
 *    gets a WhatsApp acknowledgement; repeat calls escalate to P0;
 *  - an answered call asks whoever answered for the outcome (one tap) —
 *    never the founder, who only gets a "save this number?" for new numbers;
 *  - a caller who comes back within CAME_BACK_HOURS of a closed callback is
 *    flagged on that ticket; the second time, it goes to the deputy/founder;
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
    var contact = party ? (ev.direction === 'INBOUND' ? ensureContact_(party, 'Call') : findContact_(party)) : null;
    var recent = party && ev.direction === 'INBOUND' ? readLastRows_(SHEETS.CALLS, 300).filter(function (c) {
      return normalizePhone(c.Phone) === party && c.Direction === 'INBOUND';
    }) : [];
    var answerer = ev.answered ? staffFor_(ev.answeredBy) : null;

    var callRow = appendObject_(SHEETS.CALLS, {
      Time: ev.startedAt || new Date(), 'Call ID': ev.callId, Phone: party || 'withheld', Name: displayName_(contact),
      Tag: contact ? contact.tag : 'UNKNOWN', Direction: ev.direction, Answered: ev.answered ? 'YES' : 'NO',
      'Answered by': answerer ? answerer.name : ev.answeredBy, 'Duration (s)': ev.durationSec, Recording: ev.recordingUrl,
      'Missed by': (ev.missedBy || []).map(function (x) { var s = staffFor_(x); return s ? s.name : x; }).join(', ')
    });

    if (!party) return 'logged (no number)';
    if (ev.direction === 'OUTBOUND') return handleCallback_(ev, callRow);

    var cameBack = noteCameBack_(party, ev.startedAt || new Date());
    var dropped = isDroppedCall(ev, Number(setting_('SHORT_CALL_SECONDS', 15)) || 15);
    if (ev.answered && !dropped) return handleAnswered_(ev, contact, answerer, callRow, cameBack);
    return handleMissed_(ev, contact, recent, callRow, cameBack, dropped);
  });
}

/** Staff member from a phone number or a name, as the phone line reports it. */
function staffFor_(value) {
  if (!value) return null;
  return staffByPhone_(normalizePhone(value)) || staffByName_(value);
}

function callAlreadyLogged_(callId) {
  var rows = readLastRows_(SHEETS.CALLS, 300);
  for (var i = 0; i < rows.length; i++) if (String(rows[i]['Call ID']) === String(callId)) return true;
  return false;
}

/**
 * If this number had callbacks closed as DONE recently, the problem probably
 * wasn't solved: the latest one is marked "Came back". count = how many
 * callbacks for this number were closed within CAME_BACK_HOURS — 2 or more
 * means it's the second time round. Skipped while a ticket is still open
 * (that call just updates the open ticket). Returns { ticket, count } or null.
 */
function noteCameBack_(phone, now) {
  var windowMs = (Number(setting_('CAME_BACK_HOURS', 48)) || 48) * 3600000;
  var mine = allTickets_().filter(function (t) { return t.phone === phone; });
  if (mine.some(isOpen_)) return null;
  var recent = mine.filter(function (t) {
    return t.status === 'DONE' && t.closedAt && now.getTime() - t.closedAt.getTime() <= windowMs;
  });
  if (!recent.length) return null;
  recent.sort(function (a, b) { return a.closedAt - b.closedAt; });
  var latest = recent[recent.length - 1];
  updateTicket_(latest, { 'Came back': latest.cameBack + 1 });
  return { ticket: latest, count: recent.length };
}

/** Second come-back: the deputy takes over (the founder, if the deputy handled it). */
function escalationOwner_(previousOwner) {
  var deputy = staffByRole_('DEPUTY');
  return deputy && deputy.name !== previousOwner ? deputy : founder_();
}

function handleMissed_(ev, contact, recentInbound, callRow, cameBack, dropped) {
  var now = ev.startedAt || new Date();
  var tag = contact ? contact.tag : 'UNKNOWN';
  var repeat = isRepeatCaller(recentInbound.map(function (c) { return asDate_(c.Time); }).filter(Boolean), now);
  var triage = triageFor(tag, contact && contact.voiceOnly, repeat);
  if (!triage) return 'blocked number — logged only';

  var hours = businessHours_();
  var ticket = openTicketForPhone_(ev.from);
  var action;
  var reason = repeat ? '🔁 Called again and again' : null;

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
    if (newPriority === 'P0' && patch.Priority) notifyForTicket_(ticket, reason);
  } else {
    var owner = resolveOwner_(triage.owner, contact);
    var priority = triage.priority;
    var summary = repeat ? 'Called repeatedly' : dropped ? 'Call dropped after ' + ev.durationSec + 's' : 'Missed call';
    if (cameBack && cameBack.count >= 2) {
      owner = escalationOwner_(cameBack.ticket.owner);
      priority = higherPriority(priority, 'P1');
      summary = 'Came back again after #' + cameBack.ticket.id + ' (' + cameBack.ticket.owner + ')';
      reason = reason || '↩️ Came back again — not solved last time';
    }
    ticket = createTicket_({
      phone: ev.from, callerName: displayName_(contact), tag: tag, priority: priority,
      owner: owner.name, summary: summary, missedCount: 1
    });
    action = 'ticket #' + ticket.id + ' ' + ticket.priority + ' → ' + ticket.owner;
    notifyForTicket_(ticket, reason);
  }
  updateRow_(SHEETS.CALLS, callRow, { Ticket: ticket.id, Outcome: 'TICKET' });

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

/**
 * Answered call: whoever answered taps what happened. The founder is never
 * asked — only offered to save a new number.
 */
function handleAnswered_(ev, contact, answerer, callRow, cameBack) {
  if (!answerer) return 'logged (answered)';
  var who = displayName_(contact) || ev.from;
  var isNew = !contact || !contact.name;
  var ref = 'C' + callRow;
  var mins = Math.max(1, Math.round(ev.durationSec / 60));

  if (answerer.role === 'FOUNDER') {
    updateRow_(SHEETS.CALLS, callRow, { Outcome: 'FOUNDER' });
    if (isNew) {
      notifyInternal_(answerer.phone, 'Naye number se baat hui: ' + ev.from + '\nSave karna ho to is message ka reply: N <naam> <type>\n(jaise: N Mukesh Hardware buyer)', 'SAVE', ref, null);
      return 'logged (founder answered, save prompt)';
    }
    return 'logged (founder answered)';
  }

  updateRow_(SHEETS.CALLS, callRow, { Outcome: 'PENDING' });
  var text = '📞 ' + who + ' se baat (' + mins + ' min). Kya hua?' +
    (cameBack ? '\n↩️ Callback #' + cameBack.ticket.id + ' ke baad phir call kiya' + (cameBack.count > 1 ? ' (' + cameBack.count + ' callbacks in 48h)' : '') + '.' : '') +
    (isNew ? '\nNaya number — reply karke naam bhejiye: N <naam> <type>' : '');
  notifyInternal_(answerer.phone, text, 'OUTCOME', ref, [
    { id: ref + ':1', title: 'Ho gaya' },
    { id: ref + ':2', title: 'Callback chahiye' },
    { id: ref + ':3', title: 'Sir ko batana hai' }
  ]);
  return 'answered by ' + answerer.name + ', outcome asked';
}

function handleCallback_(ev, callRow) {
  var phone = ev.to;
  var ticket = phone ? openTicketForPhone_(phone) : null;
  if (!ticket) return 'logged (outgoing)';
  updateRow_(SHEETS.CALLS, callRow, { Ticket: ticket.id });

  var autoDone = Number(setting_('AUTO_DONE_SECONDS', 30)) || 30;
  if (ev.answered && ev.durationSec >= autoDone) {
    closeTicket_(ticket, 'DONE', staffFor_(ev.answeredBy) ? staffFor_(ev.answeredBy).name : ticket.owner, 'Auto: callback connected ' + ev.durationSec + 's', 'YES');
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

/** Was there an outgoing call through the business line to this number since the ticket was created? */
function callbackMadeFor_(ticket) {
  var since = ticket.created ? ticket.created.getTime() : 0;
  return readLastRows_(SHEETS.CALLS, 3000).some(function (c) {
    var t = asDate_(c.Time);
    return c.Direction === 'OUTBOUND' && normalizePhone(c.Phone) === ticket.phone && t && t.getTime() >= since;
  });
}

/**
 * Outcome tap after an answered call (C<row>:1|2|3) from the person who
 * answered (or the front desk / deputy / founder on their behalf).
 */
function applyOutcome_(sender, callRow, code) {
  var row = readTable_(SHEETS.CALLS).filter(function (r) { return r._row === callRow; })[0];
  if (!row) return 'Call nahi mili.';
  var answeredBy = String(row['Answered by'] || '');
  var canAct = answeredBy === sender.name || ['FOUNDER', 'DEPUTY', 'FRONT_DESK'].indexOf(sender.role) >= 0;
  if (!canAct) return 'Yeh call aapne nahi uthayi thi.';
  if (['PENDING', 'NUDGED', ''].indexOf(String(row.Outcome)) < 0) return 'Is call ka outcome pehle se hai: ' + row.Outcome + '.';

  var phone = normalizePhone(row.Phone);
  var contact = findContact_(phone);
  if (code === 1) {
    updateRow_(SHEETS.CALLS, callRow, { Outcome: 'RESOLVED', 'Outcome by': sender.name });
    return '✅ Theek hai.';
  }
  var triage = triageFor(contact ? contact.tag : 'UNKNOWN', contact && contact.voiceOnly, false) || { priority: 'P2' };
  var existing = openTicketForPhone_(phone);
  if (code === 2) {
    var t = existing || createTicket_({
      phone: phone, callerName: displayName_(contact), tag: contact ? contact.tag : 'UNKNOWN', priority: triage.priority,
      owner: sender.name, summary: 'Callback promised on call (' + sender.name + ')'
    });
    updateRow_(SHEETS.CALLS, callRow, { Outcome: 'CALLBACK', 'Outcome by': sender.name, Ticket: t.id });
    return '📋 #' + t.id + ' ' + (existing ? 'pehle se khula hai (' + t.owner + ')' : 'aapke naam') + ', call by ' + shortTime(t.deadline) +
      '. Kisi aur ko dena ho to "2 Naam #' + t.id + '". Kya baat hui, is message ka reply karke likh dein.';
  }
  var founder = founder_();
  var ft = existing || createTicket_({
    phone: phone, callerName: displayName_(contact), tag: contact ? contact.tag : 'UNKNOWN', priority: higherPriority(triage.priority, 'P1'),
    owner: founder.name, summary: sender.name + ' ne baat ki — Sir ko batana hai'
  });
  updateRow_(SHEETS.CALLS, callRow, { Outcome: 'FOUNDER', 'Outcome by': sender.name, Ticket: ft.id });
  if (!existing) notifyForTicket_(ft, '👤 ' + sender.name + ' ne flag kiya');
  return '📋 #' + ft.id + ' Sir ko bhej diya. Ek line mein kya baat hai, is message ka reply karke likh dein.';
}
