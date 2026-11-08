/** Time-driven jobs (installed by Call Desk → Install timers). */

/** Every 10 minutes: reminders, overdue escalation, founder "remind me", mode expiry. */
function remindersJob() {
  withLock_(function () {
    var now = new Date();
    var hours = businessHours_();
    expireMode_(now);
    var founder = founder_();
    nudgeOutcomes_(now);

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

/** One reminder to staff who haven't tapped an outcome after an answered call. */
function nudgeOutcomes_(now) {
  var waitMs = (Number(setting_('OUTCOME_NUDGE_MINUTES', 60)) || 60) * 60000;
  readLastRows_(SHEETS.CALLS, 500).forEach(function (c) {
    var t = asDate_(c.Time);
    if (c.Outcome !== 'PENDING' || !t || now.getTime() - t.getTime() < waitMs) return;
    var staff = staffByName_(c['Answered by']);
    updateRow_(SHEETS.CALLS, c._row, { Outcome: 'NUDGED' });
    if (!staff || !staff.phone) return;
    var ref = 'C' + c._row;
    notifyInternal_(staff.phone, '⏰ ' + (c.Name || c.Phone) + ' wali call ka outcome? (' + shortTime(t) + ')', 'OUTCOME_NUDGE', ref, [
      { id: ref + ':1', title: 'Ho gaya' },
      { id: ref + ':2', title: 'Callback chahiye' },
      { id: ref + ':3', title: 'Sir ko batana hai' }
    ]);
  });
}

/**
 * Daily late morning: "kaam hua?" to callers in FOLLOWUP_TAGS whose callback
 * was closed as DONE yesterday. "Nahi" reopens the ticket for the deputy.
 */
function followupJob() {
  var tags = String(setting_('FOLLOWUP_TAGS', '')).split(/[,\s]+/).map(parseTag).filter(Boolean);
  if (!tags.length) return 'follow-ups off';
  var now = new Date();
  var yesterday = istYmd(new Date(now.getTime() - 86400000));
  var sent = 0;
  withLock_(function () {
    allTickets_().forEach(function (t) {
      if (t.status !== 'DONE' || !t.closedAt || istYmd(t.closedAt) !== yesterday || t.followUp || tags.indexOf(t.tag) < 0) return;
      var contact = findContact_(t.phone);
      if (contact && contact.voiceOnly) return; // can't read it — the callback was the check
      var r = sendFollowup_(t.phone, t.id);
      updateTicket_(t, { 'Follow-up': r.ok ? 'SENT' : 'FAILED' });
      if (r.ok) sent++;
    });
  });
  return sent + ' follow-ups sent';
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

  var requireLine = truthy_(setting_('REQUIRE_CALLBACK_VIA_LINE', 'FALSE'));
  return {
    noOutcome: calls.filter(function (c) { return c.Outcome === 'PENDING' || c.Outcome === 'NUDGED'; }).length,
    cameBack: tickets.filter(function (t) { return t.cameBack > 0 && t.closedAt && now.getTime() - t.closedAt.getTime() < 2 * 86400000; }).length,
    unverified: requireLine ? tickets.filter(function (t) { return t.verified === 'NO' && t.closedAt && istYmd(t.closedAt) === today; }).length : 0,
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

/** Saturday evening: the week in numbers, a scorecard per staff member, and calls to spot-check. */
function weeklyJob() {
  var now = new Date();
  var founder = founder_();
  notifyInternal_(founder.phone, weeklyText_(now, Math.random), 'WEEKLY', null, null);
}

function weeklyText_(now, random) {
  var weekAgo = now.getTime() - 7 * 86400000;
  var calls = readLastRows_(SHEETS.CALLS, 6000).filter(function (c) {
    var t = asDate_(c.Time);
    return t && t.getTime() >= weekAgo;
  });
  var inbound = calls.filter(function (c) { return c.Direction === 'INBOUND'; });
  var byTag = {};
  inbound.forEach(function (c) { byTag[c.Tag || 'UNKNOWN'] = (byTag[c.Tag || 'UNKNOWN'] || 0) + 1; });
  var tickets = allTickets_().filter(function (t) { return t.created && t.created.getTime() >= weekAgo; });
  var lostLeads = tickets.filter(function (t) {
    return (t.tag === 'LEAD' || t.tag === 'BUYER' || t.tag === 'BUYER_TOP') &&
      (t.status === 'UNREACHABLE' || (isOpen_(t) && t.deadline && now > t.deadline) || (t.closedAt && t.deadline && t.closedAt > t.deadline));
  });

  var lines = ['📊 Weekly call summary', ''];
  lines.push('Incoming calls: ' + inbound.length + ' · answered ' + inbound.filter(function (c) { return c.Answered === 'YES'; }).length);
  lines.push('By type: ' + Object.keys(byTag).sort(function (a, b) { return byTag[b] - byTag[a]; })
    .map(function (k) { return k.toLowerCase().replace(/_/g, ' ') + ' ' + byTag[k]; }).join(' · '));
  lines.push('Buyer/lead callbacks late or missed: ' + lostLeads.length);
  lostLeads.slice(0, 8).forEach(function (t) { lines.push('  #' + t.id + ' ' + (t.callerName || t.phone) + ' (' + t.owner + ')'); });

  lines.push('');
  lines.push('👥 SCORECARD');
  var perStaff = Math.max(0, Number(setting_('RECORDINGS_PER_STAFF', 5)) || 0);
  var spot = [];
  staffList_().filter(function (s) { return s.role !== 'FOUNDER'; }).forEach(function (s) {
    var rung = 0, answered = 0;
    inbound.forEach(function (c) {
      var by = String(c['Answered by'] || '');
      var missed = String(c['Missed by'] || '').split(/,\s*/);
      if (by === s.name) { rung++; answered++; } else if (missed.indexOf(s.name) >= 0) rung++;
    });
    var mine = tickets.filter(function (t) { return t.owner === s.name; });
    var onTime = mine.filter(function (t) { return t.status === 'DONE' && t.closedAt && t.deadline && t.closedAt <= t.deadline; }).length;
    var verified = mine.filter(function (t) { return t.verified === 'YES'; }).length;
    var cameBack = mine.filter(function (t) { return t.cameBack > 0; }).length;
    var noOutcome = inbound.filter(function (c) { return c['Answered by'] === s.name && (c.Outcome === 'PENDING' || c.Outcome === 'NUDGED'); }).length;
    lines.push(s.name + ' — rung ' + rung + ' · answered ' + answered + (rung ? ' (' + Math.round((answered / rung) * 100) + '%)' : '') +
      ' · callbacks ' + mine.length + ', on time ' + onTime + ', verified ' + verified +
      ' · came back ' + cameBack + (noOutcome ? ' · no outcome ' + noOutcome : ''));

    var recorded = inbound.filter(function (c) { return c['Answered by'] === s.name && c.Recording; });
    for (var i = 0; i < perStaff && recorded.length; i++) {
      var pick = recorded.splice(Math.floor(random() * recorded.length), 1)[0];
      spot.push(s.name + ': ' + (pick.Name || pick.Phone) + ' ' + pick.Recording);
    }
  });
  if (spot.length) {
    lines.push('');
    lines.push('🎧 Calls to spot-check:');
    spot.forEach(function (x) { lines.push(x); });
  }
  return lines.join('\n');
}
