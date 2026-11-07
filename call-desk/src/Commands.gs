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
  '(Replying to an alert? The ticket number is optional.)'
].join('\n');

function handleIncomingMessage(msg) {
  // msg = { from: '+91…', text, contextId, waId }
  if (!msg.from) return 'ignored (no sender)';
  return withLock_(function () {
    logMessage_('IN', msg.from, 'MESSAGE', '', msg.waId, msg.text, 'received');
    var sender = staffByPhone_(msg.from);
    if (!sender) return noteFromCaller_(msg);

    var cmd = parseCommand(msg.text);
    if (!cmd) return reply_(sender, 'Samajh nahi aaya. "help" bhejiye.');
    if (cmd.type === 'help') return reply_(sender, HELP_TEXT);

    var isFounder = sender.role === 'FOUNDER';
    if (cmd.type === 'mode') {
      if (!isFounder) return reply_(sender, 'Mode sirf founder badal sakte hain.');
      return setMode_(sender, cmd);
    }
    if (cmd.type === 'contact') {
      if (!isFounder) return reply_(sender, 'VIP/BLOCK sirf founder kar sakte hain.');
      setContactTag_(cmd.phone, cmd.tag);
      return reply_(sender, '✅ ' + cmd.phone + ' → ' + cmd.tag);
    }

    var ticketId = cmd.ticketId || ticketForReplyContext_(msg.contextId);
    if (!ticketId) return reply_(sender, 'Kaunsa ticket? Number ke saath bhejiye, jaise "3 #147".');
    var ticket = ticketById_(ticketId);
    if (!ticket) return reply_(sender, 'Ticket #' + ticketId + ' nahi mila.');
    return applyTicketCommand_(sender, isFounder, ticket, cmd);
  });
}

function reply_(staff, text) {
  notifyInternal_(staff.phone, text, 'REPLY', null, null);
  return text;
}

function applyTicketCommand_(sender, isFounder, ticket, cmd) {
  var canManage = isFounder || sender.role === 'DEPUTY' || sender.role === 'FRONT_DESK' || ticket.owner === sender.name;
  if (!canManage) return reply_(sender, '#' + ticket.id + ' aapka ticket nahi hai.');
  if (!isOpen_(ticket) && cmd.action !== 'DONE') return reply_(sender, '#' + ticket.id + ' pehle se band hai (' + ticket.status + ').');
  var hours = businessHours_();
  var now = new Date();

  switch (cmd.action) {
    case 'CALL':
      updateTicket_(ticket, { Owner: sender.name, Status: 'ASSIGNED', Deadline: computeDeadline(ticket.priority, now, hours), Reminded: '', Escalated: '' });
      return reply_(sender, '✅ #' + ticket.id + ' aapke naam. Call: ' + ticket.phone);
    case 'DELEGATE': {
      var staff = staffByName_(cmd.staff);
      if (!staff) return reply_(sender, '"' + cmd.staff + '" Staff tab mein nahi mila.');
      updateTicket_(ticket, { Owner: staff.name, Status: 'ASSIGNED', Deadline: computeDeadline(ticket.priority, now, hours), Reminded: '', Escalated: '' });
      notifyOwner_(ticketById_(ticket.id), sender.name);
      return reply_(sender, '✅ #' + ticket.id + ' → ' + staff.name);
    }
    case 'DONE':
      if (!isOpen_(ticket)) return reply_(sender, '#' + ticket.id + ' pehle se band hai.');
      closeTicket_(ticket, 'DONE', sender.name, cmd.note || '');
      return reply_(sender, '✅ #' + ticket.id + ' done. Shukriya!');
    case 'IGNORE':
      if (!isFounder) return reply_(sender, 'Ignore sirf founder kar sakte hain.');
      closeTicket_(ticket, 'IGNORED', sender.name, '');
      return reply_(sender, '✅ #' + ticket.id + ' ignored.');
    case 'REMIND': {
      var at = nextClockTime(cmd.remindAt, now);
      updateTicket_(ticket, { 'Remind at': at, Owner: sender.name });
      return reply_(sender, '⏰ #' + ticket.id + ' – ' + shortTime(at) + ' par yaad dilaunga.');
    }
  }
  return reply_(sender, HELP_TEXT);
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
