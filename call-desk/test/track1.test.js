// Track 1: contacts sync, unknown numbers, answered-call outcomes, staff accountability.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');
const L = require('../src/Logic.gs');

const START = L.istDate(2026, 10, 7, 11, 0); // Saturday 11:00 IST
const FOUNDER = '+919800000001';
const DEPUTY = '+919800000002';
const POOJA = '+919800000003';
const ROHIT = '+919800000004';
const SHARMA = '+919810000001'; // BUYER
const UNKNOWN = '+919899999999';

function setup() {
  const env = createEnv({ start: START });
  env.run('setupSheets()');
  const staff = env.ss.getSheetByName('Staff');
  [['Rajesh', FOUNDER, 'FOUNDER', 'YES'], ['Anil', DEPUTY, 'DEPUTY', 'YES'], ['Pooja', POOJA, 'FRONT_DESK', 'YES'], ['Rohit', ROHIT, 'STAFF', 'YES']]
    .forEach((r) => staff.appendRow(r));
  env.ss.getSheetByName('Contacts').appendRow([SHARMA, '', 'Sharma ji', 'Sharma Traders', 'Indore', 'BUYER', 'Rohit', 'NO']);
  env.run("setSetting_('COMPANY_NAME', 'Sharma Steels'); setSetting_('WHATSAPP_ENABLED', 'TRUE'); setSetting_('WA_PHONE_NUMBER_ID', '1')");
  env.props.WA_ACCESS_TOKEN = 't';
  return env;
}

const call = (env, ev) => env.run(`handleCallEvent(mapGenericEvent(${JSON.stringify({ callId: 'c' + Math.random(), ...ev })}))`);
const message = (env, from, text, contextId, profileName) =>
  env.run(`handleIncomingMessage(${JSON.stringify({ from, text, contextId: contextId || null, waId: 'in' + Math.random(), profileName: profileName || '' })})`);
const ticket = (env, id) => env.table('Tickets').find((t) => Number(t.ID) === id);
const contact = (env, phone) => env.table('Contacts').find((c) => c.Phone === phone);
const sentTo = (env, phone) => env.sent.filter((s) => s.payload.to === phone.replace('+', ''));
const lastTo = (env, phone) => sentTo(env, phone).at(-1);
const waId = (s) => s.response.body.messages[0].id;
const body = (s) => (s.payload.text ? s.payload.text.body : s.payload.interactive ? s.payload.interactive.body.text : JSON.stringify(s.payload.template));

test('unknown numbers are saved once to Contacts as UNKNOWN', () => {
  const env = setup();
  call(env, { from: UNKNOWN, status: 'missed' });
  env.advance(120);
  call(env, { from: UNKNOWN, status: 'missed' });
  const rows = env.table('Contacts').filter((c) => c.Phone === UNKNOWN);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Tag, 'UNKNOWN');
  assert.equal(rows[0].Source, 'Call');
  assert.ok(rows[0]['First seen']);
});

test('answered by staff: outcome buttons; "Callback chahiye" makes their ticket; replies become notes; N saves the caller', () => {
  const env = setup();
  const r = call(env, { from: UNKNOWN, status: 'answered', durationSec: 150, answeredBy: '09800000003' });
  assert.equal(r, 'answered by Pooja, outcome asked');
  const calls = env.table('Calls');
  assert.equal(calls[0]['Answered by'], 'Pooja');
  assert.equal(calls[0].Outcome, 'PENDING');

  const prompt = lastTo(env, POOJA);
  assert.match(prompt.payload.interactive.body.text, /se baat \(3 min\)\. Kya hua\?\nNaya number/);
  const ids = prompt.payload.interactive.action.buttons.map((b) => b.reply.id);
  assert.deepEqual(ids, ['C2:1', 'C2:2', 'C2:3']);

  // Name the caller by replying to the prompt.
  assert.match(message(env, POOJA, 'N Mukesh Hardware lead', waId(prompt)), /\+919899999999 = Mukesh Hardware \(LEAD\)/);
  assert.equal(contact(env, UNKNOWN).Name, 'Mukesh Hardware');
  assert.equal(contact(env, UNKNOWN).Tag, 'LEAD');

  assert.match(message(env, POOJA, 'C2:2'), /#1 aapke naam/);
  assert.equal(ticket(env, 1).Owner, 'Pooja');
  assert.equal(ticket(env, 1).Name, 'Mukesh Hardware');
  assert.equal(env.table('Calls')[0].Outcome, 'CALLBACK');
  assert.match(message(env, POOJA, 'C2:1'), /outcome pehle se hai: CALLBACK/);

  // Free text replying to the confirmation is saved on the ticket.
  const confirm = lastTo(env, POOJA);
  assert.match(message(env, POOJA, '50 bag ka rate chahiye, kal tak', waId(confirm)), /#1 mein likh diya/);
  assert.match(ticket(env, 1).Summary, /Pooja: 50 bag ka rate chahiye, kal tak/);

  // Rohit didn't answer it and isn't front desk → can't set the outcome of someone else's call.
  call(env, { from: SHARMA, status: 'answered', durationSec: 60, answeredBy: 'Pooja' });
  assert.match(message(env, ROHIT, 'C3:1'), /aapne nahi uthayi/);
});

test('"Sir ko batana hai" creates a founder ticket and alerts him', () => {
  const env = setup();
  call(env, { from: SHARMA, status: 'answered', durationSec: 90, answeredBy: ROHIT });
  assert.match(message(env, ROHIT, 'C2:3'), /Sir ko bhej diya/);
  const t = ticket(env, 1);
  assert.equal(t.Owner, 'Rajesh');
  assert.equal(t.Priority, 'P1');
  assert.match(body(lastTo(env, FOUNDER)), /Rohit ne flag kiya[\s\S]*#1 · Sharma ji/);
});

test('founder is never asked for an outcome; a new number gets a save prompt and he can set VIP tags', () => {
  const env = setup();
  assert.equal(call(env, { from: SHARMA, status: 'answered', durationSec: 60, answeredBy: FOUNDER }), 'logged (founder answered)');
  assert.equal(sentTo(env, FOUNDER).length, 0);
  assert.equal(call(env, { from: UNKNOWN, status: 'answered', durationSec: 60, answeredBy: FOUNDER }), 'logged (founder answered, save prompt)');
  const prompt = lastTo(env, FOUNDER);
  assert.match(message(env, FOUNDER, 'N Verma ji bank', waId(prompt)), /Verma ji \(VIP_FINANCE\)/);
  assert.equal(contact(env, UNKNOWN).Tag, 'VIP_FINANCE');

  // Staff can't hand out VIP tags.
  call(env, { from: '+919877777777', status: 'answered', durationSec: 60, answeredBy: POOJA });
  const p2 = lastTo(env, POOJA);
  assert.match(message(env, POOJA, 'N Big Party top', waId(p2)), /VIP tag sirf founder/);
  assert.equal(contact(env, '+919877777777').Tag, 'UNKNOWN');
});

test('a very short answered call is treated as dropped', () => {
  const env = setup();
  assert.equal(call(env, { from: UNKNOWN, status: 'answered', durationSec: 6, answeredBy: POOJA }), 'ticket #1 P2 → Pooja + ack');
  assert.equal(ticket(env, 1).Summary, 'Call dropped after 6s');
});

test('one nudge if no outcome after an hour; digest counts calls with no outcome', () => {
  const env = setup();
  call(env, { from: UNKNOWN, status: 'answered', durationSec: 90, answeredBy: POOJA });
  const before = sentTo(env, POOJA).length;
  env.advance(30);
  env.run('remindersJob()');
  assert.equal(sentTo(env, POOJA).length, before);
  env.advance(35);
  env.run('remindersJob()');
  assert.match(body(lastTo(env, POOJA)), /wali call ka outcome\?/);
  env.run('remindersJob()');
  assert.equal(sentTo(env, POOJA).length, before + 1);
  assert.equal(env.table('Calls')[0].Outcome, 'NUDGED');
  // The nudge's buttons still work.
  assert.match(message(env, POOJA, 'C2:1'), /Theek hai/);

  call(env, { from: SHARMA, status: 'answered', durationSec: 90, answeredBy: ROHIT });
  env.run('digestJob()');
  assert.match(body(lastTo(env, FOUNDER)), /CHECK: 1 answered calls with no outcome/);
});

test('callbacks closed without a call are recorded as unverified and flagged once the line is live', () => {
  const env = setup();
  call(env, { from: UNKNOWN, status: 'missed' });
  message(env, POOJA, 'D 1 baat ho gayi');
  assert.equal(ticket(env, 1).Verified, 'NO');

  env.advance(60);
  call(env, { from: SHARMA, status: 'missed' }); // #2 → Rohit
  call(env, { to: SHARMA, direction: 'outbound', status: 'answered', durationSec: 12 }); // too short to auto-close
  message(env, ROHIT, 'D 2');
  assert.equal(ticket(env, 2).Verified, 'YES');

  env.run('digestJob()');
  assert.doesNotMatch(body(lastTo(env, FOUNDER)), /closed without a call/);
  env.run("setSetting_('REQUIRE_CALLBACK_VIA_LINE', 'TRUE')");
  env.run('digestJob()');
  assert.match(body(lastTo(env, FOUNDER)), /1 callbacks closed without a call/);
});

test('caller coming back after a closed callback is flagged; the second time it goes to the deputy', () => {
  const env = setup();
  call(env, { from: UNKNOWN, status: 'missed' }); // #1 Pooja
  message(env, POOJA, 'D 1');
  env.advance(120);
  assert.equal(call(env, { from: UNKNOWN, status: 'missed' }), 'ticket #2 P2 → Pooja + ack');
  assert.equal(ticket(env, 1)['Came back'], 1);
  message(env, POOJA, 'D 2');
  env.advance(120);
  assert.equal(call(env, { from: UNKNOWN, status: 'missed' }), 'ticket #3 P1 → Anil + ack');
  assert.match(ticket(env, 3).Summary, /Came back again after #2 \(Pooja\)/);
  assert.match(body(lastTo(env, DEPUTY)), /#3/);

  // Outside the window it's a fresh start.
  message(env, DEPUTY, 'D 3');
  env.advance(49 * 60);
  call(env, { from: UNKNOWN, status: 'missed' });
  assert.equal(ticket(env, 4).Owner, 'Pooja');
});

test('next-day "kaam hua?" for buyers: Haan thanks them, Nahi reopens for the deputy', () => {
  const env = setup();
  call(env, { from: SHARMA, status: 'missed' }); // #1 BUYER → Rohit
  call(env, { from: UNKNOWN, status: 'missed' }); // #2 UNKNOWN → not in FOLLOWUP_TAGS
  message(env, ROHIT, 'D 1');
  message(env, POOJA, 'D 2');
  env.run('followupJob()'); // same day → nothing
  assert.equal(ticket(env, 1)['Follow-up'], '');

  env.setNow(L.istDate(2026, 10, 8, 11, 30));
  assert.equal(env.run('followupJob()'), '1 follow-ups sent');
  const f = lastTo(env, SHARMA).payload.template;
  assert.equal(f.name, 'followup_check');
  assert.deepEqual(f.components.slice(1).map((c) => c.parameters[0].payload), ['F1:Y', 'F1:N']);
  assert.equal(ticket(env, 1)['Follow-up'], 'SENT');
  assert.equal(env.run('followupJob()'), '0 follow-ups sent');

  // Someone else can't answer for this ticket.
  assert.match(message(env, UNKNOWN, 'F1:N'), /noted on|ticket #/);
  assert.equal(ticket(env, 1).Status, 'DONE');

  assert.equal(message(env, SHARMA, 'F1:N'), 'follow-up #1: reopened → Anil');
  const t = ticket(env, 1);
  assert.equal(t.Status, 'ASSIGNED');
  assert.equal(t.Owner, 'Anil');
  assert.equal(t.Priority, 'P1');
  assert.match(t.Summary, /NOT solved \(closed by Rohit\)/);
  assert.match(body(lastTo(env, SHARMA)), /Maaf kijiye 🙏 Anil ji aapko/);
});

test('Google Contacts sync: labels become tags, sheet tags and names win, personal contacts stay out', () => {
  const env = setup();
  env.ss.getSheetByName('Contacts').appendRow([UNKNOWN, '', '', '', '', 'UNKNOWN']);
  env.ctx.__google = {
    groups: [{ resourceName: 'contactGroups/a1', formattedName: 'VIP' }, { resourceName: 'contactGroups/b2', formattedName: 'Bank' }],
    people: [
      { names: [{ displayName: 'Mukesh' }], phoneNumbers: [{ canonicalForm: '+919899999999' }], memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/a1' } }] },
      { names: [{ displayName: 'Sharma New Name' }], phoneNumbers: [{ value: '98100 00001' }], memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/a1' } }] },
      { names: [{ displayName: 'SBI RM' }], phoneNumbers: [{ value: '9810000020' }], memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/b2' } }] },
      { names: [{ displayName: 'Dentist' }], phoneNumbers: [{ value: '9810000021' }], memberships: [] },
      { names: [{ displayName: 'Starred only' }], phoneNumbers: [{ value: '9810000022' }], memberships: [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/starred' } }] },
    ],
  };
  assert.equal(env.run('syncContactsJob()'), 'contacts sync: 1 added, 1 updated (of 5 Google contacts)');
  assert.equal(contact(env, UNKNOWN).Name, 'Mukesh');
  assert.equal(contact(env, UNKNOWN).Tag, 'BUYER_TOP');
  assert.equal(contact(env, SHARMA).Name, 'Sharma ji'); // sheet name kept
  assert.equal(contact(env, SHARMA).Tag, 'BUYER'); // sheet tag kept
  assert.equal(contact(env, '+919810000020').Tag, 'VIP_FINANCE');
  assert.equal(contact(env, '+919810000020').Source, 'Google Contacts');
  assert.equal(contact(env, '+919810000021'), undefined);
  assert.equal(env.run('syncContactsJob()'), 'contacts sync: 0 added, 0 updated (of 5 Google contacts)');
});

test('naming or tagging a caller on the Tickets tab saves to Contacts; VIP tags are refused there', () => {
  const env = setup();
  call(env, { from: UNKNOWN, status: 'missed' });
  const sh = env.ss.getSheetByName('Tickets');
  const headers = sh.data[0];
  const edit = (col, value) => {
    sh.set(2, headers.indexOf(col) + 1, value);
    env.ctx.__e = { range: { getSheet: () => sh, getRow: () => 2, getColumn: () => headers.indexOf(col) + 1 } };
    env.run('onTicketEdit(__e)');
  };
  edit('Name', 'Mukesh Hardware');
  edit('Tag', 'LEAD');
  assert.equal(contact(env, UNKNOWN).Name, 'Mukesh Hardware');
  assert.equal(contact(env, UNKNOWN).Tag, 'LEAD');
  edit('Tag', 'VIP_FAMILY');
  assert.equal(contact(env, UNKNOWN).Tag, 'LEAD');
  assert.match(ticket(env, 1)['Outcome note'], /VIP tag sirf founder/);
});

test("WhatsApp profile name fills in an unnamed caller until staff give the real name", () => {
  const env = setup();
  assert.equal(message(env, UNKNOWN, 'Hello', null, 'Mukesh K'), 'ticket #1 from WhatsApp');
  assert.equal(contact(env, UNKNOWN).Name, 'Mukesh K');
  assert.match(contact(env, UNKNOWN).Notes, /name from WhatsApp/);
  const task = lastTo(env, POOJA);
  message(env, POOJA, 'N Mukesh Hardware buyer', waId(task));
  assert.equal(contact(env, UNKNOWN).Name, 'Mukesh Hardware');
  assert.doesNotMatch(contact(env, UNKNOWN).Notes, /name from WhatsApp/);
});

test('weekly scorecard per staff member with spot-check recordings', () => {
  const env = setup();
  call(env, { from: UNKNOWN, status: 'answered', durationSec: 90, answeredBy: POOJA, recordingUrl: 'https://rec/1', missedBy: [ROHIT] });
  call(env, { from: SHARMA, status: 'missed', missedBy: 'Rohit, Pooja' }); // #1 → Rohit
  message(env, ROHIT, 'D 1');
  env.advance(60);
  call(env, { from: SHARMA, status: 'missed' }); // came back
  const text = env.run('weeklyText_(new Date(), function () { return 0; })');
  assert.match(text, /Pooja — rung 2 · answered 1 \(50%\) · callbacks 0, on time 0, verified 0 · came back 0 · no outcome 1/);
  assert.match(text, /Rohit — rung 2 · answered 0 \(0%\) · callbacks 2, on time 1, verified 0 · came back 1/);
  assert.match(text, /Calls to spot-check:\nPooja: Mukesh|Calls to spot-check:\nPooja: \+919899999999 https:\/\/rec\/1/);
  assert.doesNotMatch(text, /Rajesh —/);
});
