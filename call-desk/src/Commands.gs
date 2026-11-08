/**
 * Incoming WhatsApp messages to the office number:
 *  - from the founder: ticket actions, mode changes, VIP/BLOCK;
 *  - from staff: "D 147 note" to close their callbacks (and the same ticket
 *    actions on their own tickets);
 *  - from anyone else (a caller replying to the acknowledgement): noted on
 *    their open ticket so it never falls into a void.
 */

var HELP_TEXT = [
  'Call desk commands:',
  '1 #147 – main call karunga',
  '2 Ramesh #147 – Ramesh ko do',
  '3 #147 – ho gaya',
  '4 #147 – ignore',
  '5 6pm #147 – 6 baje yaad dilao',
  'D 147 note – staff: callback done',
  'A / B / M 4pm / D / T – Available, Busy, Meeting till 4pm, DND, Travelling',
  'VIP 98xxxxxxxx [bank|family|vendor] · BLOCK 98xxxxxxxx',
  'N Mukesh Hardware buyer – (reply to a call message) save the caller',
  'Any other reply to a ticket message is saved as a note on it',
  '(Replying to an alert? The ticket number is optional.)'
].join('\n');

function handleIncomingMessage(msg) {
  // msg = { from: '+91…', text, contextId, waId, profileName }
  if (!msg.from) return 'ignored (no sender)';
  return withLock_(function () {
    logMessage_('IN', msg.from, 'MESSAGE', '', msg.waId, msg.text, 'received');
    var cmd = parseCommand(msg.text);
    var sender = staffByPhone_(msg.from);
    if (!sender) {
      if (cmd && cmd.type === 'followup') return applyFollowup_(msg.from, cmd);
      return noteFromCaller_(msg);
    }
    // Which ticket or call the message is replying to, if it quotes one of ours.
    var ref = refForReplyContext_(msg.contextId);
    var isFounder = sender.role === 'FOUNDER';

    if (!cmd || cmd.type === 'followup') {
      // Free text replying to a ticket/call message is a note on that ticket.
      var noteTicket = ticketFromRef_(ref);
      if (noteTicket && String(msg.text || '').trim()) {
        appendTicketNote_(noteTicket, sender.name + ': ' + String(msg.text).trim());
        return reply_(sender, '📝 #' + noteTicket.id + ' mein likh diya.', noteTicket.id);
      }
      return reply_(sender, 'Samajh nahi aaya. "help" bhejiye.');
    }
    if (cmd.type === 'help') return reply_(sender, HELP_TEXT);
    if (cmd.type === 'mode') {
      if (!isFounder) return reply_(sender, 'Mode sirf founder badal sakte hain.');
      return setMode_(sender, cmd);
    }
    if (cmd.type === 'contact') {
      if (!isFounder) return reply_(sender, 'VIP/BLOCK sirf founder kar sakte hain.');
      setContactTag_(cmd.phone, cmd.tag);
      return reply_(sender, '✅ ' + cmd.phone + ' → ' + cmd.tag);
    }
    if (cmd.type === 'outcome') {
      return reply_(sender, applyOutcome_(sender, cmd.callRow, cmd.code), 'C' + cmd.callRow);
    }
    if (cmd.type === 'name') {
      var phone = phoneFromRef_(ref);
      if (!phone) return reply_(sender, 'Kis number ka naam? Call wale message ka reply karke bhejiye.');
      var err = nameContact_(phone, cmd.name, cmd.tag, isFounder, isFounder);
      return reply_(sender, err ? '⚠️ ' + err : '✅ ' + phone + ' = ' + cmd.name + (cmd.tag ? ' (' + cmd.tag + ')' : ''), ref);
    }

    var ticket = cmd.ticketId ? ticketById_(cmd.ticketId) : ticketFromRef_(ref);
    if (!ticket) {
      return reply_(sender, cmd.ticketId ? 'Ticket #' + cmd.ticketId + ' nahi mila.' : 'Kaunsa ticket? Number ke saath bhejiye, jaise "3 #147".');
    }
    return applyTicketCommand_(sender, isFounder, ticket, cmd);
  });
}

function reply_(staff, text, ref) {
  notifyInternal_(staff.phone, text, 'REPLY', ref || null, null);
  return text;
}

/** A ref is a ticket number ("147") or an answered call ("C12" = Calls row 12). */
function ticketFromRef_(ref) {
  if (!ref) return null;
  var s = String(ref);
  if (/^\d+$/.test(s)) return ticketById_(Number(s));
  var m = /^C(\d+)$/.exec(s);
  if (!m) return null;
  var row = readTable_(SHEETS.CALLS).filter(function (r) { return r._row === Number(m[1]); })[0];
  return row && Number(row.Ticket) ? ticketById_(Number(row.Ticket)) : null;
}

function phoneFromRef_(ref) {
  if (!ref) return null;
  var m = /^C(\d+)$/.exec(String(ref));
  if (m) {
    var row = readTable_(SHEETS.CALLS).filter(function (r) { return r._row === Number(m[1]); })[0];
    return row ? normalizePhone(row.Phone) : null;
  }
  var t = ticketFromRef_(ref);
  return t ? t.phone : null;
}

function appendTicketNote_(ticket, note) {
  updateTicket_(ticket, { Summary: ((ticket.summary ? ticket.summary + ' | ' : '') + note).slice(-500) });
}

/** Caller pressed Haan/Nahi on the next-day "kaam hua?" message. */
function applyFollowup_(phone, cmd) {
  var t = ticketById_(cmd.ticketId);
  if (!t || t.phone !== phone) return noteFromCaller_({ from: phone, text: cmd.ok ? 'Haan' : 'Nahi' });
  if (cmd.ok) {
    updateTicket_(t, { 'Follow-up': 'YES' });
    notifyInternal_(phone, 'Dhanyavaad 🙏', 'FOLLOWUP_THANKS', t.id, null);
    return 'follow-up #' + t.id + ': yes';
  }
  var now = new Date();
  var owner = escalationOwner_(t.owner);
  var priority = higherPriority(t.priority, 'P1');
  updateTicket_(t, {
    'Follow-up': 'NO', Status: 'ASSIGNED', Owner: owner.name, Priority: priority,
    Deadline: computeDeadline(priority, now, businessHours_()), 'Closed at': '', 'Closed by': '', Reminded: '', Escalated: '',
    Summary: ((t.summary ? t.summary + ' | ' : '') + 'Caller says NOT solved (closed by ' + t.owner + ')').slice(-500)
  });
  var reopened = ticketById_(t.id);
  notifyForTicket_(reopened, '↩️ Caller says not solved');
  notifyInternal_(phone, 'Maaf kijiye 🙏 ' + owner.name + ' ji aapko ' + promiseText(reopened.deadline, now) + ' call karenge.', 'FOLLOWUP_SORRY', t.id, null);
  return 'follow-up #' + t.id + ': reopened → ' + owner.name;
}

function applyTicketCommand_(sender, isFounder, ticket, cmd) {
  var replyT_ = function (text) { return reply_(sender, text, ticket.id); };
  var canManage = isFounder || sender.role === 'DEPUTY' || sender.role === 'FRONT_DESK' || ticket.owner === sender.name;
  if (!canManage) return replyT_('#' + ticket.id + ' aapka ticket nahi hai.');
  if (!isOpen_(ticket) && cmd.action !== 'DONE') return replyT_('#' + ticket.id + ' pehle se band hai (' + ticket.status + ').');
  var hours = businessHours_();
  var now = new Date();

  switch (cmd.action) {
    case 'CALL':
      updateTicket_(ticket, { Owner: sender.name, Status: 'ASSIGNED', Deadline: computeDeadline(ticket.priority, now, hours), Reminded: '', Escalated: '' });
      return replyT_('✅ #' + ticket.id + ' aapke naam. Call: ' + ticket.phone);
    case 'DELEGATE': {
      var staff = staffByName_(cmd.staff);
      if (!staff) return replyT_('"' + cmd.staff + '" Staff tab mein nahi mila.');
      updateTicket_(ticket, { Owner: staff.name, Status: 'ASSIGNED', Deadline: computeDeadline(ticket.priority, now, hours), Reminded: '', Escalated: '' });
      notifyOwner_(ticketById_(ticket.id), sender.name);
      return replyT_('✅ #' + ticket.id + ' → ' + staff.name);
    }
    case 'DONE':
      if (!isOpen_(ticket)) return replyT_('#' + ticket.id + ' pehle se band hai.');
      closeTicket_(ticket, 'DONE', sender.name, cmd.note || '');
      return replyT_('✅ #' + ticket.id + ' done. Shukriya!');
    case 'IGNORE':
      if (!isFounder) return replyT_('Ignore sirf founder kar sakte hain.');
      closeTicket_(ticket, 'IGNORED', sender.name, '');
      return replyT_('✅ #' + ticket.id + ' ignored.');
    case 'REMIND': {
      var at = nextClockTime(cmd.remindAt, now);
      updateTicket_(ticket, { 'Remind at': at, Owner: sender.name });
      return replyT_('⏰ #' + ticket.id + ' – ' + shortTime(at) + ' par yaad dilaunga.');
    }
  }
  return replyT_(HELP_TEXT);
}

function setMode_(founder, cmd) {
  var until = cmd.until ? nextClockTime(cmd.until, new Date()) : '';
  setSetting_('MODE', cmd.mode);
  setSetting_('MODE_UNTIL', until);
  var frontDesk = staffByRole_('FRONT_DESK');
  var label = cmd.mode + (until ? ' (till ' + shortTime(until) + ')' : '');
  if (frontDesk && frontDesk.phone) notifyInternal_(frontDesk.phone, 'Sir ka mode: ' + label, 'MODE', null, null);
  return reply_(founder, '✅ Mode: ' + label);
}

function noteFromCaller_(msg) {
  ensureContact_(msg.from, 'WhatsApp');
  guessNameFromWhatsApp_(msg.from, msg.profileName);
  var ticket = openTicketForPhone_(msg.from);
  if (!ticket) {
    // Not a known caller with an open ticket — make one so the message is answered.
    var contact = findContact_(msg.from);
    if (contact && contact.tag === 'BLOCK') return 'ignored (blocked)';
    var triage = triageFor(contact ? contact.tag : 'UNKNOWN', contact && contact.voiceOnly, false) || { priority: 'P2', owner: 'FRONT_DESK' };
    ticket = createTicket_({
      phone: msg.from, callerName: displayName_(contact), tag: contact ? contact.tag : 'UNKNOWN', priority: triage.priority,
      owner: resolveOwner_(triage.owner, contact).name, summary: 'WhatsApp: ' + String(msg.text || '').slice(0, 200)
    });
    notifyForTicket_(ticket, '💬 WhatsApp message');
    return 'ticket #' + ticket.id + ' from WhatsApp';
  }
  var summary = (ticket.summary ? ticket.summary + ' | ' : '') + 'WhatsApp: ' + String(msg.text || '').slice(0, 200);
  updateTicket_(ticket, { Summary: summary.slice(-500) });
  notifyOwner_(ticketById_(ticket.id), null);
  return 'noted on #' + ticket.id;
}
