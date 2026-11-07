// End-to-end: the real .gs files running against in-memory Sheets/WhatsApp.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');
const L = require('../src/Logic.gs');

// Saturday 7 Nov 2026, 11:00 IST — office open.
const START = L.istDate(2026, 10, 7, 11, 0);

const FOUNDER = '+919800000001';
const DEPUTY = '+919800000002';
const POOJA = '+919800000003';
const ROHIT = '+919800000004';
const SHARMA = '+919810000001'; // top buyer
const GUPTA = '+919810000002'; // vendor, handled by Rohit
const BHAIYA = '+919810000003'; // family
const SPAM = '+919810000004';
const UNKNOWN = '+919899999999';

function setup() {
  const env = createEnv({ start: START });
  env.run('setupSheets()');
  const staff = env.ss.getSheetByName('Staff');
  [['Rajesh', FOUNDER, 'FOUNDER', 'YES'], ['Anil', DEPUTY, 'DEPUTY', 'YES'], ['Pooja', POOJA, 'FRONT_DESK', 'YES'], ['Rohit', ROHIT, 'STAFF', 'YES']]
    .forEach((r) => staff.appendRow(r));
  const contacts = env.ss.getSheetByName('Contacts');
  [
    [SHARMA, '', 'Sharma ji', 'Sharma Traders', 'Indore', 'BUYER_TOP', '', 'NO'],
    [GUPTA, '', 'Gupta ji', 'Gupta Steel', 'Jaipur', 'vendor', 'Rohit', 'NO'],
    [BHAIYA, '', 'Bhaiya', '', '', 'VIP_FAMILY', '', ''],
    [SPAM, '', '', '', '', 'BLOCK', '', ''],
  ].forEach((r) => contacts.appendRow(r));
  env.run("setSetting_('COMPANY_NAME', 'Sharma Steels'); setSetting_('WHATSAPP_ENABLED', 'TRUE'); setSetting_('WA_PHONE_NUMBER_ID', '123')");
  env.props.WA_ACCESS_TOKEN = 'test-token';
  env.props.WA_VERIFY_TOKEN = 'verify-me';
  return env;
}

const missed = (env, from, extra = {}) =>
  env.run(`handleCallEvent(mapGenericEvent(${JSON.stringify({ callId: 'c' + Math.random(), from, status: 'missed', ...extra })}))`);
const message = (env, from, text, contextId) =>
  env.run(`handleIncomingMessage(${JSON.stringify({ from, text, contextId: contextId || null, waId: 'in' + Math.random() })})`);
const ticket = (env, id) => env.table('Tickets').find((t) => Number(t.ID) === id);
const sentTo = (env, phone) => env.sent.filter((s) => s.payload.to === phone.replace('+', ''));

test('missed call from an unknown number: P2 ticket for the front desk, Hindi ack, task to front desk', () => {
  const env = setup();
  const result = missed(env, '098999 99999');
  assert.equal(result, 'ticket #1 P2 → Pooja + ack');
  const t = ticket(env, 1);
  assert.equal(t.Phone, UNKNOWN);
  assert.equal(t.Status, 'ASSIGNED');
  assert.equal(L.istYmd(t.Deadline) + ' ' + L.istParts(t.Deadline).h, '2026-11-07 19');

  const ack = sentTo(env, UNKNOWN)[0].payload;
  assert.equal(ack.type, 'template');
  assert.equal(ack.template.name, 'ack_missed');
  assert.deepEqual(ack.template.components[0].parameters.map((p) => p.text), ['Sharma Steels', 'Aaj shaam 7 pm tak']);
  assert.equal(env.sent[0].headers.Authorization, 'Bearer test-token');

  const task = sentTo(env, POOJA)[0].payload;
  assert.equal(task.type, 'text');
  assert.match(task.text.body, /#1 .*\+919899999999/);
  assert.equal(env.table('Calls')[0].Ticket, 1);
});

test('repeat calls escalate to P0 and alert the founder; ack is not repeated', () => {
  const env = setup();
  missed(env, UNKNOWN);
  env.advance(5);
  assert.equal(missed(env, UNKNOWN), 'updated #1');
  const t = ticket(env, 1);
  assert.equal(t.Priority, 'P0');
  assert.equal(t['Missed calls'], 2);
  const alert = sentTo(env, FOUNDER)[0].payload;
  assert.equal(alert.type, 'interactive');
  assert.match(alert.interactive.body.text, /Called again and again[\s\S]*🔴 P0 · #1/);
  assert.deepEqual(alert.interactive.action.buttons.map((b) => b.reply.id), ['T1:1', 'T1:2:Pooja', 'T1:4']);
  assert.equal(sentTo(env, UNKNOWN).length, 1);
});

test('top buyer: founder owns it, live alert, VIP ack. Family: P0, no ack. Blocked: nothing', () => {
  const env = setup();
  assert.equal(missed(env, SHARMA), 'ticket #1 P1 → Rajesh + ack');
  assert.equal(sentTo(env, FOUNDER).length, 1);
  const ack = sentTo(env, SHARMA)[0].payload.template;
  assert.equal(ack.name, 'ack_vip');
  assert.equal(ack.components[0].parameters[0].text, 'Sharma ji');

  assert.equal(missed(env, BHAIYA), 'ticket #2 P0 → Rajesh');
  assert.equal(sentTo(env, BHAIYA).length, 0);

  assert.equal(missed(env, SPAM), 'blocked number — logged only');
  assert.equal(env.table('Tickets').length, 2);
  assert.equal(env.table('Calls').length, 3);
});

test("contact's owner staff gets the callback; after hours uses the after-hours ack", () => {
  const env = setup();
  env.setNow(L.istDate(2026, 10, 7, 21, 0));
  assert.equal(missed(env, GUPTA), 'ticket #1 P2 → Rohit + ack');
  const ack = sentTo(env, GUPTA)[0].payload.template;
  assert.equal(ack.name, 'ack_after_hours');
  // Saturday night → Sunday off, Monday working → Monday 7 pm (P2 = end of working day).
  assert.equal(ack.components[0].parameters[0].text, '2026-11-09 shaam 7 pm tak');
  assert.equal(sentTo(env, ROHIT).length, 1);
});

test('founder replies: button to take it, "2 Rohit" by quoting the alert, staff closes with D', () => {
  const env = setup();
  missed(env, UNKNOWN);
  env.advance(3);
  missed(env, UNKNOWN); // P0 → founder alert
  const alert = env.sent.find((s) => s.payload.to === FOUNDER.slice(1) && s.payload.type === 'interactive');
  const alertId = alert.response.body.messages[0].id;

  assert.match(message(env, FOUNDER, '2 Rohit', alertId), /#1 → Rohit/);
  assert.equal(ticket(env, 1).Owner, 'Rohit');
  assert.match(sentTo(env, ROHIT).at(-1).payload.text.body, /Rajesh ne aapko diya/);

  assert.match(message(env, FOUNDER, 'T1:1'), /#1 aapke naam/);
  assert.equal(ticket(env, 1).Owner, 'Rajesh');

  // Rohit no longer owns it and isn't front desk/deputy → can't close it.
  assert.match(message(env, ROHIT, 'D 1 done'), /aapka ticket nahi hai/);
  assert.match(message(env, POOJA, 'D 1 baat ho gayi'), /#1 done/);
  const t = ticket(env, 1);
  assert.equal(t.Status, 'DONE');
  assert.equal(t['Closed by'], 'Pooja');
  assert.equal(t['Outcome note'], 'baat ho gayi');
});

test('founder commands: mode with expiry, VIP/BLOCK, help, unknown text; staff cannot change mode', () => {
  const env = setup();
  assert.match(message(env, FOUNDER, 'M 4pm'), /Mode: MEETING \(till 4 pm\)/);
  env.run('settingsCache_ = null');
  assert.equal(env.run("setting_('MODE')"), 'MEETING');
  assert.match(sentTo(env, POOJA).at(-1).payload.text.body, /Sir ka mode: MEETING/);

  // During a meeting a founder-owned P1 is not pushed live…
  missed(env, SHARMA);
  assert.equal(sentTo(env, FOUNDER).filter((s) => s.payload.type === 'interactive').length, 0);
  // …it goes in the 1 pm / 5 pm bundle.
  env.run('bundleJob()');
  assert.match(sentTo(env, FOUNDER).at(-1).payload.text.body, /Aapke callbacks \(1\):\n#1 Sharma ji \(Sharma Traders\)/);

  // Mode expires at 4 pm.
  env.setNow(L.istDate(2026, 10, 7, 16, 5));
  env.run('remindersJob()');
  env.run('settingsCache_ = null');
  assert.equal(env.run("setting_('MODE')"), 'AVAILABLE');

  assert.match(message(env, FOUNDER, 'VIP 9811111111 bank'), /\+919811111111 → VIP_FINANCE/);
  assert.equal(env.table('Contacts').find((c) => c.Phone === '+919811111111').Tag, 'VIP_FINANCE');
  assert.match(message(env, FOUNDER, 'help'), /Call desk commands/);
  assert.match(message(env, FOUNDER, 'kya scene hai'), /Samajh nahi aaya/);
  assert.match(message(env, ROHIT, 'D'), /Mode sirf founder/);
});

test('callbacks through the business line: connected closes it, 3 failed attempts → unreachable message', () => {
  const env = setup();
  missed(env, UNKNOWN);
  const out = (extra) => env.run(`handleCallEvent(mapGenericEvent(${JSON.stringify({ callId: 'o' + Math.random(), from: '08047000000', to: UNKNOWN, direction: 'outbound', ...extra })}))`);
  assert.equal(out({ status: 'no-answer' }), 'ticket #1 attempt 1');
  assert.equal(ticket(env, 1).Status, 'ATTEMPTED');
  assert.equal(out({ status: 'answered', durationSec: 45, answeredBy: 'Pooja' }), 'ticket #1 done (callback connected)');
  assert.equal(ticket(env, 1).Status, 'DONE');

  missed(env, GUPTA);
  const out2 = (extra) => env.run(`handleCallEvent(mapGenericEvent(${JSON.stringify({ callId: 'o' + Math.random(), to: GUPTA, direction: 'outbound', ...extra })}))`);
  out2({ status: 'no-answer' });
  out2({ status: 'answered', durationSec: 10 }); // too short to count as a conversation
  assert.equal(out2({ status: 'busy' }), 'ticket #2 unreachable');
  assert.equal(ticket(env, 2).Status, 'UNREACHABLE');
  assert.equal(sentTo(env, GUPTA).at(-1).payload.template.name, 'ack_unreachable');
});

test('outside the 24-hour window, staff messages fall back to the approved template', () => {
  const env = setup();
  env.onFetch((payload) => (payload.type === 'template'
    ? { code: 200, body: { messages: [{ id: 'wamid.t' }] } }
    : { code: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }));
  missed(env, UNKNOWN);
  const toPooja = sentTo(env, POOJA);
  assert.equal(toPooja.length, 2);
  assert.equal(toPooja[1].payload.template.name, 'staff_notify');
  assert.doesNotMatch(toPooja[1].payload.template.components[0].parameters[0].text, /\n/);
  assert.match(env.table('Messages').find((m) => m.Kind === 'TASK').Result, /FAILED: Re-engagement/);
});

test('a caller replying on WhatsApp is noted on their ticket; a new number gets a ticket', () => {
  const env = setup();
  missed(env, UNKNOWN);
  assert.equal(message(env, UNKNOWN, 'Rate chahiye 50 bag ka'), 'noted on #1');
  assert.match(ticket(env, 1).Summary, /WhatsApp: Rate chahiye 50 bag ka/);
  assert.equal(message(env, '+919822222222', 'Hello, catalogue bhejo'), 'ticket #2 from WhatsApp');
  assert.equal(message(env, SPAM, 'loan chahiye?'), 'ignored (blocked)');
});

test('reminders at halfway, escalation to founder when a staff callback is overdue, P2 rolls over as P1', () => {
  const env = setup();
  missed(env, '+919833333333'); // unknown → P2 Pooja, deadline 7 pm
  env.run("setSetting_('WHATSAPP_ENABLED','TRUE')");
  missed(env, GUPTA); // vendor → P2 Rohit
  env.run(`updateTicket_(ticketById_(2), { Priority: 'P1', Deadline: computeDeadline('P1', new Date(), businessHours_()) })`);

  env.advance(65); // 12:05 — past P1 halfway (12:00)
  const before = sentTo(env, ROHIT).length;
  env.run('remindersJob()');
  assert.equal(sentTo(env, ROHIT).length, before + 1);
  assert.equal(ticket(env, 2).Reminded, 'YES');

  env.advance(60); // 13:05 — P1 overdue
  env.run('remindersJob()');
  assert.match(sentTo(env, FOUNDER).at(-1).payload.interactive.body.text, /Overdue — Rohit has not called back/);
  env.run('remindersJob()'); // escalates only once
  assert.equal(sentTo(env, FOUNDER).filter((s) => /Overdue/.test(JSON.stringify(s.payload))).length, 1);

  // Ticket 1 (P2) still open Tuesday morning → becomes P1.
  env.setNow(L.istDate(2026, 10, 9, 10, 30));
  env.run('remindersJob()');
  assert.equal(ticket(env, 1).Priority, 'P1');
});

test('founder "5 6pm" reminder fires once at 6 pm', () => {
  const env = setup();
  missed(env, SHARMA);
  assert.match(message(env, FOUNDER, '5 6pm #1'), /6 pm par yaad dilaunga/);
  env.setNow(L.istDate(2026, 10, 7, 18, 1));
  const n = sentTo(env, FOUNDER).length;
  env.run('remindersJob()');
  assert.match(sentTo(env, FOUNDER).at(-1).payload.interactive.body.text, /⏰ Reminder/);
  env.run('remindersJob()');
  assert.equal(sentTo(env, FOUNDER).length, n + 1);
});

test('evening digest counts the day and lists what needs the founder', () => {
  const env = setup();
  missed(env, SHARMA);
  missed(env, UNKNOWN);
  env.run(`handleCallEvent(mapGenericEvent({ callId: 'a1', from: '${GUPTA}', status: 'answered' }))`);
  env.setNow(L.istDate(2026, 10, 7, 19, 30));
  env.run('digestJob()');
  const body = sentTo(env, FOUNDER).at(-1).payload.text.body;
  assert.match(body, /Calls: 3 · Answered: 1 · Missed: 2 · Answered\/acked: 100%/);
  assert.match(body, /NEEDS YOU \(\d\)\n#1 Sharma ji/);
  assert.match(body, /Pooja 0\/1 🔴/);
});

test('webhook: key required, JSON call events, duplicate call IDs ignored, Meta verification, WhatsApp delivery', () => {
  const env = setup();
  const key = env.props.WEBHOOK_KEY;
  assert.ok(key, 'setup generates a webhook key');
  assert.equal(env.run(`doPost({ parameter: { key: 'wrong' }, postData: { contents: '{}' } }).text`), 'unauthorized');

  const post = (params, body) => env.run(`doPost(${JSON.stringify({ parameter: params, postData: { contents: JSON.stringify(body) } })}).text`);
  assert.equal(post({ key, source: 'generic' }, { callId: 'X1', from: UNKNOWN, status: 'missed' }), 'ticket #1 P2 → Pooja + ack');
  assert.equal(post({ key, source: 'generic' }, { callId: 'X1', from: UNKNOWN, status: 'missed' }), 'duplicate X1');

  const exotel = env.run(`doGet(${JSON.stringify({ parameter: { key, source: 'exotel', CallSid: 'E1', CallFrom: '09810000002', DialCallStatus: 'no-answer' } })}).text`);
  assert.equal(exotel, 'ticket #2 P2 → Rohit + ack');

  assert.equal(env.run(`doGet({ parameter: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '42' } }).text`), '42');
  assert.equal(env.run(`doGet({ parameter: { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '42' } }).text`), 'verification failed');

  const wa = { entry: [{ changes: [{ value: { messages: [{ id: 'wamid.in1', from: '919800000003', type: 'text', text: { body: 'D 1 call kar liya' } }] } }] }] };
  assert.match(post({ key, source: 'whatsapp' }, wa), /#1 done/);
  assert.equal(post({ key, source: 'whatsapp' }, wa), 'ok'); // Meta retry → processed once
  assert.equal(ticket(env, 1).Status, 'DONE');

  // A crash inside handling is contained and logged.
  assert.match(post({ key, source: 'whatsapp' }, { entry: [{ changes: [{ value: { messages: [{ id: 'm2', from: '919800000001', type: 'text', text: null }] } }] }] }), /Samajh nahi aaya/);
  assert.equal(post({ key, source: 'whatsapp' }, { entry: 'malformed' }), 'error');
  assert.equal(env.table('Messages').at(-1).Kind, 'ERROR');
});

test('front desk can add a callback by typing on the Tickets tab', () => {
  const env = setup();
  const sh = env.ss.getSheetByName('Tickets');
  sh.appendRow(['', '', '9810000002', '', '', '', '', '', '', 'Payment ke baare mein']);
  const row = sh.getLastRow();
  env.ctx.__e = { range: { getSheet: () => sh, getRow: () => row, getColumn: () => 3 } };
  env.run('onTicketEdit(__e)');
  const t = ticket(env, 1);
  assert.equal(t.Phone, GUPTA);
  assert.equal(t.Owner, 'Rohit');
  assert.equal(t.Priority, 'P2');
  assert.equal(t.Name, 'Gupta ji (Gupta Steel)');
  assert.match(sentTo(env, ROHIT)[0].payload.text.body, /Payment ke baare mein/);
});

test('dry-run mode sends nothing and logs every message', () => {
  const env = setup();
  env.run("setSetting_('WHATSAPP_ENABLED', 'FALSE')");
  missed(env, UNKNOWN);
  assert.equal(env.sent.length, 0);
  const logged = env.table('Messages');
  assert.deepEqual(logged.map((m) => m.Kind), ['TASK', 'ACK']);
  assert.match(logged[1].Text, /Sharma Steels mein aapka call aaya tha/);
  assert.match(logged[1].Result, /DRY RUN/);
});
