/**
 * Pure business rules for the call desk — no Google services used here, so
 * every function in this file is unit-tested in Node (call-desk/test/).
 * Design reference: docs/call-desk/CALL_DESK_SYSTEM.md.
 */

var TAGS = [
  'VIP_FAMILY', 'VIP_FINANCE', 'BUYER_TOP', 'BUYER', 'LEAD', 'VENDOR_KEY', 'VENDOR',
  'STAFF', 'TRANSPORT', 'PARTNER', 'GOVT', 'BLOCK', 'UNKNOWN'
];
var PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
var TICKET_STATUSES = ['NEW', 'ASSIGNED', 'ATTEMPTED', 'DONE', 'UNREACHABLE', 'IGNORED'];
var OPEN_STATUSES = ['NEW', 'ASSIGNED', 'ATTEMPTED'];
var MODES = { A: 'AVAILABLE', B: 'BUSY', M: 'MEETING', D: 'DND', T: 'TRAVELLING' };

// ---------------------------------------------------------------- phones

/** Normalizes an Indian number to +91XXXXXXXXXX; other countries need an explicit "+". */
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return null;
  var input = String(raw).trim();
  var hasPlus = input.charAt(0) === '+';
  var digits = input.replace(/\D/g, '');
  if (!digits) return null;
  if (hasPlus) {
    if (digits.indexOf('91') === 0) return digits.length === 12 && digits.charAt(2) !== '0' ? '+' + digits : null;
    return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
  }
  if (digits.indexOf('0091') === 0) digits = digits.slice(4);
  else if (digits.length === 12 && digits.indexOf('91') === 0) digits = digits.slice(2);
  else if (digits.length === 11 && digits.charAt(0) === '0') digits = digits.slice(1);
  if (digits.length !== 10 || digits.charAt(0) === '0') return null;
  return '+91' + digits;
}

/** "vip-family", "Buyer Top" → VIP_FAMILY / BUYER_TOP; unknown → null. */
function parseTag(value) {
  if (value === null || value === undefined || value === '') return null;
  var t = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return TAGS.indexOf(t) >= 0 ? t : null;
}

// ---------------------------------------------------------------- time (IST, no DST)

var IST_OFFSET_MS = 330 * 60000;
var MINUTE = 60000;

function istParts(date) {
  var t = new Date(date.getTime() + IST_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay(), h: t.getUTCHours(), min: t.getUTCMinutes() };
}

function istDate(y, m, d, h, min) {
  return new Date(Date.UTC(y, m, d, h || 0, min || 0) - IST_OFFSET_MS);
}

function istYmd(date) {
  var p = istParts(date);
  return p.y + '-' + ('0' + (p.m + 1)).slice(-2) + '-' + ('0' + p.d).slice(-2);
}

/**
 * hours = { openMin: 600, closeMin: 1140, workDays: [1..6], holidays: ['2026-11-12'] }
 * (minutes after IST midnight; workDays use 0 = Sunday).
 */
function isBusinessDay(date, hours) {
  var p = istParts(date);
  return hours.workDays.indexOf(p.dow) >= 0 && (hours.holidays || []).indexOf(istYmd(date)) < 0;
}

function dayAt(date, minuteOfDay) {
  var p = istParts(date);
  return istDate(p.y, p.m, p.d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
}

function isOpenAt(date, hours) {
  if (!isBusinessDay(date, hours)) return false;
  var p = istParts(date);
  var m = p.h * 60 + p.min;
  return m >= hours.openMin && m < hours.closeMin;
}

/** The given time if the office is open, else the next opening time. */
function nextOpen(date, hours) {
  if (isOpenAt(date, hours)) return date;
  var p = istParts(date);
  var candidate = istDate(p.y, p.m, p.d, 0, 0);
  if (isBusinessDay(candidate, hours) && p.h * 60 + p.min < hours.openMin) return dayAt(candidate, hours.openMin);
  for (var i = 1; i <= 30; i++) {
    candidate = istDate(p.y, p.m, p.d + i, 0, 0);
    if (isBusinessDay(candidate, hours)) return dayAt(candidate, hours.openMin);
  }
  throw new Error('No business day in the next 30 days — check business hours settings');
}

/** Adds working minutes, skipping nights, Sundays and holidays. */
function addBusinessMinutes(date, minutes, hours) {
  var cursor = nextOpen(date, hours);
  var remaining = minutes;
  for (var guard = 0; guard < 60; guard++) {
    var close = dayAt(cursor, hours.closeMin);
    var available = (close.getTime() - cursor.getTime()) / MINUTE;
    if (remaining <= available) return new Date(cursor.getTime() + remaining * MINUTE);
    remaining -= available;
    cursor = nextOpen(close, hours);
  }
  throw new Error('addBusinessMinutes did not converge');
}

function nextBusinessDayStart(date, hours) {
  var p = istParts(date);
  return nextOpen(istDate(p.y, p.m, p.d + 1, 0, 0), hours);
}

/**
 * Callback deadline by priority (design §7.2):
 *   P0 15 min (any hour) · P1 2 working hours · P2 end of the working day
 *   (next day's close if under 2 working hours remain) · P3 next working day 13:00.
 */
function computeDeadline(priority, createdAt, hours) {
  if (priority === 'P0') return new Date(createdAt.getTime() + 15 * MINUTE);
  if (priority === 'P1') return addBusinessMinutes(createdAt, 120, hours);
  var start = nextOpen(createdAt, hours);
  if (priority === 'P2') {
    var close = dayAt(start, hours.closeMin);
    if ((close.getTime() - start.getTime()) / MINUTE >= 120) return close;
    return dayAt(nextBusinessDayStart(start, hours), hours.closeMin);
  }
  var nextDay = nextBusinessDayStart(start, hours);
  return dayAt(nextDay, Math.min(13 * 60, hours.closeMin));
}

// ---------------------------------------------------------------- triage

/**
 * What happens when a call from this tag goes unanswered.
 * owner: FOUNDER | OWNER_STAFF (contact's handler) | DEPUTY | FRONT_DESK
 * ack:   STANDARD | VIP (founder will call) | NONE
 */
var TRIAGE = {
  VIP_FAMILY: { priority: 'P0', owner: 'FOUNDER', ack: 'NONE' },
  VIP_FINANCE: { priority: 'P1', owner: 'FOUNDER', ack: 'VIP' },
  BUYER_TOP: { priority: 'P1', owner: 'FOUNDER', ack: 'VIP' },
  GOVT: { priority: 'P0', owner: 'FOUNDER', ack: 'VIP' },
  VENDOR_KEY: { priority: 'P1', owner: 'OWNER_STAFF', ack: 'STANDARD' },
  BUYER: { priority: 'P1', owner: 'OWNER_STAFF', ack: 'STANDARD' },
  LEAD: { priority: 'P1', owner: 'OWNER_STAFF', ack: 'STANDARD' },
  TRANSPORT: { priority: 'P1', owner: 'OWNER_STAFF', ack: 'STANDARD' },
  VENDOR: { priority: 'P2', owner: 'OWNER_STAFF', ack: 'STANDARD' },
  PARTNER: { priority: 'P2', owner: 'FOUNDER', ack: 'VIP' },
  STAFF: { priority: 'P2', owner: 'DEPUTY', ack: 'NONE' },
  UNKNOWN: { priority: 'P2', owner: 'FRONT_DESK', ack: 'STANDARD' },
  BLOCK: null
};

/** Returns null for blocked numbers (no ticket, no message). */
function triageFor(tag, voiceOnly, repeatCaller) {
  var rule = TRIAGE[tag || 'UNKNOWN'];
  if (rule === undefined) rule = TRIAGE.UNKNOWN;
  if (rule === null) return null;
  var priority = rule.priority;
  // Voice-only callers can't read the WhatsApp acknowledgement, so the
  // callback itself has to come sooner (design §7.3). Capped at P1.
  if (voiceOnly && priority === 'P2') priority = 'P1';
  if (voiceOnly && priority === 'P3') priority = 'P2';
  if (repeatCaller) priority = 'P0';
  return { priority: priority, owner: rule.owner, ack: rule.ack };
}

/** ≥2 calls in 10 minutes or ≥3 in 30 minutes (the current call included). */
function isRepeatCaller(previousCallTimes, now) {
  var t = now.getTime();
  var in10 = 1, in30 = 1;
  for (var i = 0; i < previousCallTimes.length; i++) {
    var age = t - previousCallTimes[i].getTime();
    if (age < 0) continue;
    if (age <= 10 * MINUTE) in10++;
    if (age <= 30 * MINUTE) in30++;
  }
  return in10 >= 2 || in30 >= 3;
}

function higherPriority(a, b) {
  return PRIORITIES.indexOf(a) <= PRIORITIES.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------- commands

/** "6pm", "6:30 pm", "18:30", "6" (1–7 read as pm) → { h, min } or null. */
function parseClock(text) {
  var m = /^(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?$/i.exec(String(text).trim());
  if (!m) return null;
  var h = Number(m[1]), min = m[2] ? Number(m[2]) : 0, ap = m[3] ? m[3].toLowerCase() : null;
  if (min > 59 || h > 23) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 7) h += 12;
  return { h: h, min: min };
}

/** Next occurrence (today or tomorrow, IST) of a clock time. */
function nextClockTime(clock, now) {
  var p = istParts(now);
  var d = istDate(p.y, p.m, p.d, clock.h, clock.min);
  return d.getTime() > now.getTime() ? d : istDate(p.y, p.m, p.d + 1, clock.h, clock.min);
}

/**
 * Parses a WhatsApp message or button payload from the founder or staff.
 *   Ticket:  "1 #147" call · "2 Ramesh #147" delegate · "3 #147" done ·
 *            "4 #147" ignore · "5 6pm #147" remind · "D 147 note" done (staff)
 *            (ticket number optional when replying to the alert itself)
 *   Button:  "T147:1", "T147:2:Ramesh", "T147:4"
 *   Mode:    A · B · M [4pm] · D / DND · T
 *   Contacts:"VIP 98xxxxxxxx" · "BLOCK 98xxxxxxxx"
 */
function parseCommand(text) {
  var raw = String(text || '').trim();
  if (!raw) return null;

  var button = /^T(\d+):([1-5])(?::(.+))?$/.exec(raw);
  if (button) return ticketCommand(button[2], Number(button[1]), button[3] || null, null);

  var upper = raw.toUpperCase();
  if (upper === 'HELP' || upper === '?') return { type: 'help' };
  if (upper === 'DND') return { type: 'mode', mode: 'DND', until: null };

  var mode = /^([ABMDT])(?:\s+(.+))?$/i.exec(raw);
  if (mode && !(mode[1].toUpperCase() === 'D' && mode[2] && /^#?\d/.test(mode[2]))) {
    var key = mode[1].toUpperCase();
    var until = mode[2] ? parseClock(mode[2]) : null;
    if (mode[2] && !until) return null;
    return { type: 'mode', mode: MODES[key], until: until };
  }

  var contact = /^(VIP|BLOCK)\s+(.+?)(?:\s+(family|finance|bank|buyer|vendor|govt))?$/i.exec(raw);
  if (contact) {
    var phone = normalizePhone(contact[2]);
    if (!phone) return null;
    if (contact[1].toUpperCase() === 'BLOCK') return { type: 'contact', action: 'BLOCK', phone: phone, tag: 'BLOCK' };
    var kinds = { family: 'VIP_FAMILY', finance: 'VIP_FINANCE', bank: 'VIP_FINANCE', buyer: 'BUYER_TOP', vendor: 'VENDOR_KEY', govt: 'GOVT' };
    return { type: 'contact', action: 'VIP', phone: phone, tag: kinds[(contact[3] || 'buyer').toLowerCase()] };
  }

  var done = /^D(?:ONE)?\s+#?(\d+)(?:\s+([\s\S]+))?$/i.exec(raw);
  if (done) return { type: 'ticket', action: 'DONE', ticketId: Number(done[1]), staff: null, remindAt: null, note: done[2] ? done[2].trim() : null };

  var t = /^([1-5])(?:\s+([\s\S]*?))?(?:\s*#(\d+))?\s*$/.exec(raw);
  if (!t) return null;
  var rest = (t[2] || '').trim();
  var ticketId = t[3] ? Number(t[3]) : null;
  if (!ticketId && /^\d+$/.test(rest) && t[1] !== '5') {
    ticketId = Number(rest);
    rest = '';
  }
  return ticketCommand(t[1], ticketId, t[1] === '2' ? rest || null : null, t[1] === '5' ? rest : null);
}

function ticketCommand(code, ticketId, staff, remindText) {
  var actions = { '1': 'CALL', '2': 'DELEGATE', '3': 'DONE', '4': 'IGNORE', '5': 'REMIND' };
  var action = actions[code];
  if (action === 'DELEGATE' && !staff) return null;
  var remindAt = null;
  if (action === 'REMIND') {
    remindAt = parseClock(remindText || '');
    if (!remindAt) return null;
  }
  return { type: 'ticket', action: action, ticketId: ticketId, staff: staff ? String(staff).trim() : null, remindAt: remindAt, note: null };
}

// ---------------------------------------------------------------- telephony events

/**
 * Normalized call event:
 * { callId, from, to, startedAt: Date, durationSec, answered: bool,
 *   answeredBy, recordingUrl, direction: 'INBOUND'|'OUTBOUND' }
 */
function mapGenericEvent(body) {
  var answered = body.answered === true || body.answered === 'true' || /^(answered|completed)$/i.test(String(body.status || ''));
  return {
    callId: String(body.callId || body.call_id || ''),
    from: normalizePhone(body.from),
    to: normalizePhone(body.to),
    startedAt: body.startedAt ? new Date(body.startedAt) : new Date(),
    durationSec: Number(body.durationSec || body.duration || 0) || 0,
    answered: answered,
    answeredBy: body.answeredBy ? String(body.answeredBy) : '',
    recordingUrl: body.recordingUrl ? String(body.recordingUrl) : '',
    direction: /^out/i.test(String(body.direction || '')) ? 'OUTBOUND' : 'INBOUND'
  };
}

/**
 * Exotel Passthru applet (placed after the Connect applet in the flow).
 * Parameter names follow Exotel's Passthru documentation as commonly
 * published — VERIFY against your account before go-live and adjust here.
 */
function mapExotelEvent(params) {
  var dialStatus = String(params.DialCallStatus || params.Status || '').toLowerCase();
  return mapGenericEvent({
    callId: params.CallSid,
    from: params.CallFrom || params.From,
    to: params.CallTo || params.To,
    startedAt: params.StartTime ? new Date(String(params.StartTime).replace(' ', 'T') + '+05:30') : null,
    durationSec: params.DialCallDuration || params.Duration,
    answered: dialStatus === 'completed' || dialStatus === 'answered',
    answeredBy: params.DialWhomNumber,
    recordingUrl: params.RecordingUrl,
    direction: params.Direction
  });
}

// ---------------------------------------------------------------- message text

function shortTime(date) {
  var p = istParts(date);
  var h = p.h % 12 === 0 ? 12 : p.h % 12;
  return h + (p.min ? ':' + ('0' + p.min).slice(-2) : '') + (p.h < 12 ? ' am' : ' pm');
}

/** Plain-Hindi promise like "aaj shaam 7 pm tak" / "kal subah 11 am tak". */
function promiseText(deadline, now) {
  var sameDay = istYmd(deadline) === istYmd(now);
  var tomorrow = istYmd(deadline) === istYmd(new Date(now.getTime() + 24 * 60 * MINUTE));
  var h = istParts(deadline).h;
  var part = h < 12 ? 'subah' : h < 16 ? 'dopahar' : 'shaam';
  var day = sameDay ? 'aaj' : tomorrow ? 'kal' : istYmd(deadline);
  return day + ' ' + part + ' ' + shortTime(deadline) + ' tak';
}

function ackText(kind, vars) {
  var company = vars.company || 'Office';
  if (kind === 'VIP') {
    return 'Namaste ' + (vars.name ? vars.name + ' ji' : 'ji') + ' 🙏 Sir abhi call nahi utha paaye. Woh khud aapko ' + vars.promise + ' call karenge. — ' + company;
  }
  if (kind === 'AFTER_HOURS') {
    return 'Namaste 🙏 Office abhi band hai. Aapka call note ho gaya hai. ' + capitalize(vars.promise) + ' aapko call aayega. — ' + company;
  }
  return 'Namaste 🙏 ' + company + ' mein aapka call aaya tha. ' + capitalize(vars.promise) + ' aapko call back hoga. — ' + company;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function alertText(ticket, mode) {
  var who = ticket.callerName ? ticket.callerName : ticket.phone;
  var tagLabel = ticket.tag && ticket.tag !== 'UNKNOWN' ? ' (' + ticket.tag.replace(/_/g, ' ').toLowerCase() + ')' : '';
  var lines = [
    (ticket.priority === 'P0' ? '🔴 ' : '🟠 ') + ticket.priority + ' · #' + ticket.id + ' · ' + who + tagLabel,
    ticket.summary ? '"' + ticket.summary + '"' : 'Missed call',
    '📞 ' + ticket.phone + (ticket.missedCount > 1 ? ' · ' + ticket.missedCount + ' calls' : ''),
    mode ? 'Mode: ' + mode : null,
    'Reply: 1 I\'ll call · 2 <name> delegate · 3 done · 4 ignore · 5 6pm remind'
  ];
  return lines.filter(function (l) { return l; }).join('\n');
}

function staffTaskText(ticket, fromName) {
  return '📋 #' + ticket.id + ' ' + (ticket.callerName || ticket.phone) + ' (' + ticket.phone + ')\n' +
    (ticket.summary || 'Missed call') + '\n' +
    (fromName ? fromName + ' ne aapko diya. ' : '') + 'Call by ' + shortTime(ticket.deadline) + '.\n' +
    'Ho jaaye toh reply: D ' + ticket.id;
}

/**
 * data = { date, calls, answered, missed, ticketsCreated, done, pending, overdue,
 *          needsFounder: [ticket], staff: [{ name, assigned, onTime, overdue }],
 *          untagged: [{ phone, count }] }
 */
function digestText(data) {
  var out = [];
  out.push('📋 Call report — ' + data.date);
  out.push('');
  var ackRate = data.calls ? Math.round(((data.calls - data.unacked) / data.calls) * 100) : 100;
  out.push('Calls: ' + data.calls + ' · Answered: ' + data.answered + ' · Missed: ' + data.missed + ' · Answered/acked: ' + ackRate + '%');
  out.push('Callbacks: ' + data.ticketsCreated + ' new · ✅ ' + data.done + ' done · ⏳ ' + data.pending + ' pending · 🔴 ' + data.overdue + ' overdue');
  if (data.needsFounder.length) {
    out.push('');
    out.push('🔴 NEEDS YOU (' + data.needsFounder.length + ')');
    data.needsFounder.slice(0, 10).forEach(function (t) {
      out.push('#' + t.id + ' ' + (t.callerName || t.phone) + ' – ' + (t.summary || 'missed call') + (t.overdue ? ' (overdue)' : ''));
    });
  }
  if (data.staff.length) {
    out.push('');
    out.push('👥 CALLBACKS ON TIME');
    out.push(data.staff.map(function (s) {
      return s.name + ' ' + s.onTime + '/' + s.assigned + (s.overdue ? ' 🔴' : '');
    }).join(' · '));
  }
  if (data.untagged.length) {
    out.push('');
    out.push('⚠️ Untagged numbers calling often: ' + data.untagged.map(function (u) { return u.phone + ' (' + u.count + ')'; }).join(', '));
  }
  out.push('');
  out.push('Reply 1/2/3/4 with a ticket number, e.g. "2 Rohit #152".');
  return out.join('\n');
}

// Lets the Node tests load this file with require().
if (typeof module !== 'undefined') {
  module.exports = {
    TAGS: TAGS, normalizePhone: normalizePhone, parseTag: parseTag, istDate: istDate, istParts: istParts, istYmd: istYmd,
    isOpenAt: isOpenAt, nextOpen: nextOpen, addBusinessMinutes: addBusinessMinutes, computeDeadline: computeDeadline,
    triageFor: triageFor, isRepeatCaller: isRepeatCaller, higherPriority: higherPriority, parseClock: parseClock,
    nextClockTime: nextClockTime, parseCommand: parseCommand, mapGenericEvent: mapGenericEvent, mapExotelEvent: mapExotelEvent,
    promiseText: promiseText, ackText: ackText, alertText: alertText, staffTaskText: staffTaskText, digestText: digestText
  };
}
