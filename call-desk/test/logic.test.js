// Run with: node --test call-desk/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const L = require(path.join(__dirname, '..', 'src', 'Logic.gs'));

const HOURS = { openMin: 600, closeMin: 1140, workDays: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-09'] };
// 2026-11-07 is a Saturday, 2026-11-08 a Sunday, 2026-11-09 a (configured) holiday Monday.
const ist = (d, h, m) => L.istDate(2026, 10, d, h, m);
const iso = (date) => {
  const p = L.istParts(date);
  return `${L.istYmd(date)} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
};

test('normalizePhone handles the formats people and telephony providers use', () => {
  for (const [input, out] of [
    ['9812345678', '+919812345678'],
    ['098123 45678', '+919812345678'],
    ['+91-98123-45678', '+919812345678'],
    ['919812345678', '+919812345678'],
    ['00919812345678', '+919812345678'],
    [9812345678, '+919812345678'],
    ['0141 2345678', '+911412345678'],
    ['+14155550123', '+14155550123'],
  ]) assert.equal(L.normalizePhone(input), out, String(input));
  for (const bad of ['', null, '12345', '0000000000', 'abc', '+910812345678']) assert.equal(L.normalizePhone(bad), null, String(bad));
});

test('parseTag accepts sheet spellings', () => {
  assert.equal(L.parseTag('vip-family'), 'VIP_FAMILY');
  assert.equal(L.parseTag(' Buyer Top '), 'BUYER_TOP');
  assert.equal(L.parseTag('customer'), null);
});

test('business hours: open/closed and next opening skip Sunday and holidays', () => {
  assert.equal(L.isOpenAt(ist(7, 11, 0), HOURS), true);
  assert.equal(L.isOpenAt(ist(7, 19, 0), HOURS), false);
  assert.equal(L.isOpenAt(ist(8, 11, 0), HOURS), false); // Sunday
  assert.equal(iso(L.nextOpen(ist(7, 20, 0), HOURS)), '2026-11-10 10:00'); // Sat night → Tue (Mon holiday)
  assert.equal(iso(L.nextOpen(ist(10, 8, 30), HOURS)), '2026-11-10 10:00');
});

test('deadlines per priority', () => {
  const sat11 = ist(7, 11, 0);
  assert.equal(iso(L.computeDeadline('P0', sat11, HOURS)), '2026-11-07 11:15');
  assert.equal(iso(L.computeDeadline('P1', sat11, HOURS)), '2026-11-07 13:00');
  assert.equal(iso(L.computeDeadline('P2', sat11, HOURS)), '2026-11-07 19:00');
  assert.equal(iso(L.computeDeadline('P3', sat11, HOURS)), '2026-11-10 13:00');
  // P1 late in the day carries over working time to the next working day.
  assert.equal(iso(L.computeDeadline('P1', ist(7, 18, 0), HOURS)), '2026-11-10 11:00');
  // P2 with less than 2 working hours left → next working day's close.
  assert.equal(iso(L.computeDeadline('P2', ist(7, 17, 30), HOURS)), '2026-11-10 19:00');
  // After hours: clock starts at next opening; P0 ignores office hours.
  assert.equal(iso(L.computeDeadline('P1', ist(7, 22, 0), HOURS)), '2026-11-10 12:00');
  assert.equal(iso(L.computeDeadline('P0', ist(7, 23, 50), HOURS)), '2026-11-08 00:05');
});

test('triage by tag, voice-only bump, repeat-caller escalation, blocked numbers', () => {
  assert.equal(L.triageFor('BLOCK', false, false), null);
  assert.deepEqual(L.triageFor('VIP_FINANCE', false, false), { priority: 'P1', owner: 'FOUNDER', ack: 'VIP' });
  assert.deepEqual(L.triageFor('VIP_FAMILY', false, false), { priority: 'P0', owner: 'FOUNDER', ack: 'NONE' });
  assert.equal(L.triageFor('VENDOR', false, false).priority, 'P2');
  assert.equal(L.triageFor('VENDOR', true, false).priority, 'P1');
  assert.equal(L.triageFor('UNKNOWN', false, true).priority, 'P0');
  assert.equal(L.triageFor('SOMETHING_ODD', false, false).owner, 'FRONT_DESK');
  assert.equal(L.higherPriority('P2', 'P0'), 'P0');
});

test('repeat caller: 2 in 10 min or 3 in 30 min', () => {
  const now = ist(7, 12, 0);
  const ago = (min) => new Date(now.getTime() - min * 60000);
  assert.equal(L.isRepeatCaller([], now), false);
  assert.equal(L.isRepeatCaller([ago(8)], now), true);
  assert.equal(L.isRepeatCaller([ago(20)], now), false);
  assert.equal(L.isRepeatCaller([ago(20), ago(25)], now), true);
  assert.equal(L.isRepeatCaller([ago(40), ago(50)], now), false);
});

test('parseClock and nextClockTime', () => {
  assert.deepEqual(L.parseClock('6pm'), { h: 18, min: 0 });
  assert.deepEqual(L.parseClock('6:30 PM'), { h: 18, min: 30 });
  assert.deepEqual(L.parseClock('18:30'), { h: 18, min: 30 });
  assert.deepEqual(L.parseClock('4'), { h: 16, min: 0 });
  assert.deepEqual(L.parseClock('11'), { h: 11, min: 0 });
  assert.equal(L.parseClock('25:00'), null);
  assert.equal(L.parseClock('soon'), null);
  assert.equal(iso(L.nextClockTime({ h: 18, min: 0 }, ist(7, 12, 0))), '2026-11-07 18:00');
  assert.equal(iso(L.nextClockTime({ h: 9, min: 0 }, ist(7, 12, 0))), '2026-11-08 09:00');
});

test('parseCommand: ticket actions, buttons, modes, contacts', () => {
  assert.deepEqual(L.parseCommand('1 #147'), { type: 'ticket', action: 'CALL', ticketId: 147, staff: null, remindAt: null, note: null });
  assert.deepEqual(L.parseCommand('1'), { type: 'ticket', action: 'CALL', ticketId: null, staff: null, remindAt: null, note: null });
  assert.deepEqual(L.parseCommand('3 147').ticketId, 147);
  assert.deepEqual(L.parseCommand('2 Ramesh #147'), { type: 'ticket', action: 'DELEGATE', ticketId: 147, staff: 'Ramesh', remindAt: null, note: null });
  assert.equal(L.parseCommand('2 Ramesh').ticketId, null);
  assert.equal(L.parseCommand('2'), null); // delegate needs a name
  assert.deepEqual(L.parseCommand('5 6pm #12').remindAt, { h: 18, min: 0 });
  assert.equal(L.parseCommand('5 later'), null);
  assert.deepEqual(L.parseCommand('T147:2:Rohit'), { type: 'ticket', action: 'DELEGATE', ticketId: 147, staff: 'Rohit', remindAt: null, note: null });
  assert.equal(L.parseCommand('T9:4').action, 'IGNORE');
  assert.deepEqual(L.parseCommand('D 147 baat ho gayi, kal maal jayega'), { type: 'ticket', action: 'DONE', ticketId: 147, staff: null, remindAt: null, note: 'baat ho gayi, kal maal jayega' });
  assert.deepEqual(L.parseCommand('D'), { type: 'mode', mode: 'DND', until: null });
  assert.deepEqual(L.parseCommand('dnd'), { type: 'mode', mode: 'DND', until: null });
  assert.deepEqual(L.parseCommand('M 4pm'), { type: 'mode', mode: 'MEETING', until: { h: 16, min: 0 } });
  assert.deepEqual(L.parseCommand('a'), { type: 'mode', mode: 'AVAILABLE', until: null });
  assert.equal(L.parseCommand('M whenever'), null);
  assert.deepEqual(L.parseCommand('VIP 98100 00001'), { type: 'contact', action: 'VIP', phone: '+919810000001', tag: 'BUYER_TOP' });
  assert.equal(L.parseCommand('vip 9810000001 bank').tag, 'VIP_FINANCE');
  assert.equal(L.parseCommand('VIP 9810000001 family').tag, 'VIP_FAMILY');
  assert.deepEqual(L.parseCommand('block +91 9810000002'), { type: 'contact', action: 'BLOCK', phone: '+919810000002', tag: 'BLOCK' });
  assert.equal(L.parseCommand('kya haal hai'), null);
  assert.deepEqual(L.parseCommand('help'), { type: 'help' });
});

test('event mapping: generic JSON and Exotel passthru', () => {
  const g = L.mapGenericEvent({ callId: 'c1', from: '09810000001', status: 'missed', durationSec: '0' });
  assert.equal(g.from, '+919810000001');
  assert.equal(g.answered, false);
  assert.equal(g.direction, 'INBOUND');
  const e = L.mapExotelEvent({ CallSid: 'abc', CallFrom: '09810000001', CallTo: '08047000000', DialCallStatus: 'completed', StartTime: '2026-11-07 11:05:00', DialWhomNumber: '09810000099' });
  assert.equal(e.answered, true);
  assert.equal(e.callId, 'abc');
  assert.equal(iso(e.startedAt), '2026-11-07 11:05');
  assert.equal(L.mapExotelEvent({ CallSid: 'x', CallFrom: '9810000001', DialCallStatus: 'no-answer' }).answered, false);
});

test('caller-facing text is plain Hinglish with a concrete promise', () => {
  const now = ist(7, 11, 0);
  assert.equal(L.promiseText(ist(7, 19, 0), now), 'aaj shaam 7 pm tak');
  assert.equal(L.promiseText(ist(8, 11, 0), now), 'kal subah 11 am tak');
  const msg = L.ackText('STANDARD', { company: 'Sharma Steels', promise: 'aaj shaam 7 pm tak' });
  assert.equal(msg, 'Namaste 🙏 Sharma Steels mein aapka call aaya tha. Aaj shaam 7 pm tak aapko call back hoga. — Sharma Steels');
  assert.match(L.ackText('VIP', { name: 'Verma', promise: 'aaj dopahar 1 pm tak' }), /Verma ji .* khud aapko aaj dopahar 1 pm tak call karenge/);
});

test('alert and digest formatting', () => {
  const ticket = { id: 147, priority: 'P0', phone: '+919810000002', callerName: 'Sharma Traders', tag: 'BUYER_TOP', summary: '', missedCount: 3, deadline: ist(7, 12, 0) };
  const alert = L.alertText(ticket, 'MEETING');
  assert.match(alert, /^🔴 P0 · #147 · Sharma Traders \(buyer top\)/);
  assert.match(alert, /3 calls/);
  assert.match(L.staffTaskText(ticket, 'Founder'), /reply: D 147/);
  const digest = L.digestText({
    date: 'Sat 7 Nov', calls: 10, answered: 7, missed: 3, unacked: 0, ticketsCreated: 3, done: 2, pending: 1, overdue: 1,
    needsFounder: [ticket], staff: [{ name: 'Rohit', assigned: 2, onTime: 1, overdue: 1 }], untagged: [{ phone: '+919899999999', count: 4 }],
  });
  assert.match(digest, /Calls: 10 · Answered: 7 · Missed: 3 · Answered\/acked: 100%/);
  assert.match(digest, /NEEDS YOU \(1\)\n#147 Sharma Traders/);
  assert.match(digest, /Rohit 1\/2 🔴/);
  assert.match(digest, /\+919899999999 \(4\)/);
});
