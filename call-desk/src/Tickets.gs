/** Callback tickets: create, update, notify. */

function ticketFromRow_(r) {
  return {
    row: r._row,
    id: Number(r.ID),
    created: asDate_(r.Created),
    phone: normalizePhone(r.Phone) || String(r.Phone || ''),
    callerName: r.Name ? String(r.Name) : '',
    tag: r.Tag ? String(r.Tag) : 'UNKNOWN',
    priority: PRIORITIES.indexOf(String(r.Priority)) >= 0 ? String(r.Priority) : 'P2',
    owner: r.Owner ? String(r.Owner) : '',
    deadline: asDate_(r.Deadline),
    status: r.Status ? String(r.Status) : 'NEW',
    summary: r.Summary ? String(r.Summary) : '',
    missedCount: Number(r['Missed calls'] || 0),
    attempts: Number(r.Attempts || 0),
    ackSent: asDate_(r['Ack sent']),
    reminded: truthy_(r.Reminded),
    escalated: asDate_(r.Escalated),
    remindAt: asDate_(r['Remind at']),
    closedAt: asDate_(r['Closed at'])
  };
}

function allTickets_() {
  return readTable_(SHEETS.TICKETS).filter(function (r) { return r.ID !== ''; }).map(ticketFromRow_);
}

function isOpen_(t) {
  return OPEN_STATUSES.indexOf(t.status) >= 0;
}

function ticketById_(id) {
  var list = allTickets_();
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function openTicketForPhone_(phone) {
  var list = allTickets_();
  for (var i = list.length - 1; i >= 0; i--) if (list[i].phone === phone && isOpen_(list[i])) return list[i];
  return null;
}

function nextTicketId_() {
  var max = 0;
  readTable_(SHEETS.TICKETS).forEach(function (r) { if (Number(r.ID) > max) max = Number(r.ID); });
  return max + 1;
}

/** Creates a ticket row and returns the ticket. Caller must hold the lock. */
function createTicket_(fields) {
  var now = new Date();
  var id = nextTicketId_();
  var deadline = computeDeadline(fields.priority, now, businessHours_());
  appendObject_(SHEETS.TICKETS, {
    ID: id, Created: now, Phone: fields.phone, Name: fields.callerName || '', Tag: fields.tag || 'UNKNOWN',
    Priority: fields.priority, Owner: fields.owner, Deadline: deadline, Status: 'ASSIGNED',
    Summary: fields.summary || '', 'Missed calls': fields.missedCount || 0, Attempts: 0, Updated: now
  });
  return ticketById_(id);
}

function updateTicket_(ticket, patch) {
  patch.Updated = new Date();
  updateRow_(SHEETS.TICKETS, ticket.row, patch);
}

function closeTicket_(ticket, status, closedBy, note) {
  updateTicket_(ticket, { Status: status, 'Closed at': new Date(), 'Closed by': closedBy, 'Outcome note': note || '' });
}

function founderMode_() {
  return String(setting_('MODE', 'AVAILABLE')).toUpperCase();
}

/**
 * Tells the right person about a ticket:
 *  - founder-owned P0 always, founder-owned P1 unless in MEETING/DND (those
 *    go out in the 1 pm / 5 pm bundle instead);
 *  - any P0 also reaches the founder even if a staff member owns it;
 *  - otherwise the owning staff member gets a task message.
 */
function notifyForTicket_(ticket, reason) {
  var founder = founder_();
  var mode = founderMode_();
  var ownerIsFounder = ticket.owner === founder.name;
  if (ticket.priority === 'P0' || (ownerIsFounder && ticket.priority === 'P1' && mode !== 'MEETING' && mode !== 'DND')) {
    alertFounder_(ticket, reason);
  }
  if (!ownerIsFounder) notifyOwner_(ticket, null);
}

function alertFounder_(ticket, reason) {
  var founder = founder_();
  var suggested = ticket.owner && ticket.owner !== founder.name ? ticket.owner : (staffByRole_('FRONT_DESK') || {}).name;
  var buttons = [{ id: 'T' + ticket.id + ':1', title: 'Main call karunga' }];
  if (suggested) buttons.push({ id: 'T' + ticket.id + ':2:' + suggested, title: (suggested + ' ko do').slice(0, 20) });
  buttons.push({ id: 'T' + ticket.id + ':4', title: 'Ignore' });
  var text = (reason ? reason + '\n' : '') + alertText(ticket, founderMode_());
  return notifyInternal_(founder.phone, text, 'ALERT', ticket.id, buttons);
}

function notifyOwner_(ticket, fromName) {
  var owner = staffByName_(ticket.owner);
  if (!owner || !owner.phone) return null;
  return notifyInternal_(owner.phone, staffTaskText(ticket, fromName), 'TASK', ticket.id, null);
}
