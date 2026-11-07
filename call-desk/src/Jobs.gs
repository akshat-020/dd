/** Time-driven jobs (installed by Call Desk → Install timers). */

/** Every 10 minutes: reminders, overdue escalation, founder "remind me", mode expiry. */
function remindersJob() {
  withLock_(function () {
    var now = new Date();
    var hours = businessHours_();
    expireMode_(now);
    var founder = founder_();

    allTickets_().filter(isOpen_).forEach(function (t) {
      if (t.remindAt && now >= t.remindAt) {
        updateTicket_(t, { 'Remind at': '' });
        alertFounderOrOwner_(t, '⏰ Reminder');
        return;
      }
      if (!t.deadline || !t.created) return;

      // P2 left open overnight comes back next working morning as P1.
      if (t.priority === 'P2' && now > t.deadline && isOpenAt(now, hours) && istYmd(now) !== istYmd(t.deadline)) {
        updateTicket_(t, { Priority: 'P1', Deadline: computeDeadline('P1', now, hours), Reminded: '', Escalated: '' });
        notifyOwner_(ticketById_(t.id), null);
        return;
      }

      var halfway = t.created.getTime() + (t.deadline.getTime() - t.created.getTime()) / 2;
      if (!t.reminded && now.getTime() >= halfway && now < t.deadline) {
        updateTicket_(t, { Reminded: 'YES' });
        notifyOwner_(t, null);
        return;
      }

      // Overdue P0/P1: tell the founder (or, for the founder's own P0, the deputy).
      if (now > t.deadline && !t.escalated && (t.priority === 'P0' || t.priority === 'P1')) {
        updateTicket_(t, { Escalated: now });
        if (t.owner !== founder.name) {
          alertFounder_(t, '⚠️ Overdue — ' + t.owner + ' has not called back');
        } else if (t.priority === 'P0') {
          var deputy = staffByRole_('DEPUTY');
          if (deputy && deputy.phone) notifyInternal_(deputy.phone, '⚠️ Sir ka P0 callback overdue:\n' + alertText(t, ''), 'ESCALATION', t.id, null);
        }
      }
    });
  });
}

function alertFounderOrOwner_(t, reason) {
  if (t.owner === founder_().name) alertFounder_(t, reason);
  else notifyOwner_(t, null);
}

function expireMode_(now) {
  var until = asDate_(setting_('MODE_UNTIL', ''));
  if (until && now >= until) {
    setSetting_('MODE', 'AVAILABLE');
    setSetting_('MODE_UNTIL', '');
  }
}

/** 1 pm and 5 pm: founder's P1 tickets that weren't alerted live (Meeting/DND). */
function bundleJob() {
  var founder = founder_();
  var pending = allTickets_().filter(function (t) { return isOpen_(t) && t.owner === founder.name && t.priority === 'P1'; });
  if (!pending.length) return;
  var lines = ['🟠 Aapke callbacks (' + pending.length + '):'];
  pending.slice(0, 15).forEach(function (t) {
    lines.push('#' + t.id + ' ' + (t.callerName || t.phone) + ' – ' + (t.summary || 'missed call') + ' · ' + t.phone);
  });
  lines.push('Reply "1 #id", "2 Name #id", "3 #id" or "4 #id".');
  notifyInternal_(founder.phone, lines.join('\n'), 'BUNDLE', null, null);
}

/** Evening WhatsApp digest to the founder. */
function digestJob() {
  var founder = founder_();
  notifyInternal_(founder.phone, digestText(digestData_(new Date())), 'DIGEST', null, null);
}

function digestData_(now) {
  var today = istYmd(now);
  var calls = readLastRows_(SHEETS.CALLS, 3000).filter(function (c) {
    var t = asDate_(c.Time);
    return t && istYmd(t) === today && c.Direction === 'INBOUND';
  });
  var tickets = allTickets_();
  var created = tickets.filter(function (t) { return t.created && istYmd(t.created) === today; });
  var open = tickets.filter(isOpen_);
  var founder = founder_();

  var staff = {};
  tickets.forEach(function (t) {
    if (!t.deadline || istYmd(t.deadline) !== today || t.owner === founder.name) return;
    var s = staff[t.owner] || (staff[t.owner] = { name: t.owner, assigned: 0, onTime: 0, overdue: 0 });
    s.assigned++;
    if (t.status === 'DONE' && t.closedAt && t.closedAt <= t.deadline) s.onTime++;
    if (isOpen_(t) && now > t.deadline) s.overdue++;
  });

  var unacked = calls.filter(function (c) {
    if (c.Answered === 'YES') return false;
    var t = Number(c.Ticket) ? tickets.filter(function (x) { return x.id === Number(c.Ticket); })[0] : null;
    return !t || (!t.ackSent && t.tag !== 'VIP_FAMILY' && t.tag !== 'STAFF');
  }).length;

  // Numbers not in Contacts that called 3+ times in the last 7 days.
  var weekAgo = now.getTime() - 7 * 86400000;
  var counts = {};
  readLastRows_(SHEETS.CALLS, 5000).forEach(function (c) {
    var t = asDate_(c.Time);
    if (!t || t.getTime() < weekAgo || c.Tag !== 'UNKNOWN' || c.Direction !== 'INBOUND') return;
    var p = normalizePhone(c.Phone);
    if (p) counts[p] = (counts[p] || 0) + 1;
  });
  var untagged = Object.keys(counts).filter(function (p) { return counts[p] >= 3 && !findContact_(p); })
    .map(function (p) { return { phone: p, count: counts[p] }; });

  return {
    date: Utilities.formatDate(now, 'Asia/Kolkata', 'EEE d MMM'),
    calls: calls.length,
    answered: calls.filter(function (c) { return c.Answered === 'YES'; }).length,
    missed: calls.filter(function (c) { return c.Answered !== 'YES'; }).length,
    unacked: unacked,
    ticketsCreated: created.length,
    done: tickets.filter(function (t) { return t.status === 'DONE' && t.closedAt && istYmd(t.closedAt) === today; }).length,
    pending: open.length,
    overdue: open.filter(function (t) { return t.deadline && now > t.deadline; }).length,
    needsFounder: open.filter(function (t) { return t.owner === founder.name || (t.priority !== 'P2' && t.priority !== 'P3' && t.deadline && now > t.deadline); })
      .map(function (t) { return { id: t.id, phone: t.phone, callerName: t.callerName, summary: t.summary, overdue: t.deadline && now > t.deadline }; }),
    staff: Object.keys(staff).map(function (k) { return staff[k]; }),
    untagged: untagged
  };
}

/** Saturday evening: the week in numbers. */
function weeklyJob() {
  var now = new Date();
  var weekAgo = now.getTime() - 7 * 86400000;
  var calls = readLastRows_(SHEETS.CALLS, 6000).filter(function (c) {
    var t = asDate_(c.Time);
    return t && t.getTime() >= weekAgo && c.Direction === 'INBOUND';
  });
  var byTag = {};
  calls.forEach(function (c) { byTag[c.Tag || 'UNKNOWN'] = (byTag[c.Tag || 'UNKNOWN'] || 0) + 1; });
  var tickets = allTickets_().filter(function (t) { return t.created && t.created.getTime() >= weekAgo; });
  var closedOnTime = tickets.filter(function (t) { return t.status === 'DONE' && t.closedAt && t.deadline && t.closedAt <= t.deadline; }).length;
  var lostLeads = tickets.filter(function (t) {
    return (t.tag === 'LEAD' || t.tag === 'BUYER' || t.tag === 'BUYER_TOP') && (t.status === 'UNREACHABLE' || (isOpen_(t) && t.deadline && now > t.deadline) || (t.closedAt && t.deadline && t.closedAt > t.deadline));
  });

  var lines = ['📊 Weekly call summary', ''];
  lines.push('Incoming calls: ' + calls.length + ' · answered ' + calls.filter(function (c) { return c.Answered === 'YES'; }).length);
  lines.push('By type: ' + Object.keys(byTag).sort(function (a, b) { return byTag[b] - byTag[a]; }).map(function (k) { return k.toLowerCase().replace(/_/g, ' ') + ' ' + byTag[k]; }).join(' · '));
  lines.push('Callbacks: ' + tickets.length + ' · on time ' + (tickets.length ? Math.round((closedOnTime / tickets.length) * 100) : 100) + '%');
  lines.push('Buyer/lead callbacks late or missed: ' + lostLeads.length);
  lostLeads.slice(0, 8).forEach(function (t) { lines.push('  #' + t.id + ' ' + (t.callerName || t.phone) + ' (' + t.owner + ')'); });
  notifyInternal_(founder_().phone, lines.join('\n'), 'WEEKLY', null, null);
}
