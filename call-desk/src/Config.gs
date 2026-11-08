/**
 * Sheet layout and settings. Column headers here ARE the sheet headers —
 * Setup creates the tabs from these lists, and code reads rows by header.
 * Don't rename a header in the sheet without changing it here.
 */

var SHEETS = {
  SETTINGS: 'Settings',
  STAFF: 'Staff',
  CONTACTS: 'Contacts',
  CALLS: 'Calls',
  TICKETS: 'Tickets',
  MESSAGES: 'Messages',
  ROUTING: 'Routing lists'
};

var COLUMNS = {
  Settings: ['Key', 'Value', 'What it means'],
  Staff: ['Name', 'Phone', 'Role', 'Active'],
  // New columns are only ever appended at the end, so an existing sheet upgrades in place.
  Contacts: ['Phone', 'Phone 2', 'Name', 'Firm', 'City', 'Tag', 'Owner staff', 'Voice only', 'Notes', 'Updated', 'Source', 'First seen'],
  Calls: ['Time', 'Call ID', 'Phone', 'Name', 'Tag', 'Direction', 'Answered', 'Answered by', 'Duration (s)', 'Recording', 'Ticket',
    'Missed by', 'Outcome', 'Outcome by'],
  Tickets: ['ID', 'Created', 'Phone', 'Name', 'Tag', 'Priority', 'Owner', 'Deadline', 'Status', 'Summary', 'Missed calls',
    'Attempts', 'Ack sent', 'Reminded', 'Escalated', 'Remind at', 'Outcome note', 'Closed at', 'Closed by', 'Updated',
    'Verified', 'Came back', 'Follow-up'],
  Messages: ['Time', 'Direction', 'Phone', 'Kind', 'Ticket', 'WhatsApp ID', 'Text', 'Result']
};

var STAFF_ROLES = ['FOUNDER', 'DEPUTY', 'FRONT_DESK', 'STAFF'];

// Shown on the Settings tab. Secrets (WhatsApp access token, webhook key)
// are NOT kept here — the sheet is visible to staff — but in Script
// Properties, via the "Call Desk → Set secrets" menu.
var DEFAULT_SETTINGS = [
  ['COMPANY_NAME', 'Our Company', 'Name callers know you by — used in WhatsApp messages'],
  ['OPEN_TIME', '10:00', 'Office opens (24h, IST)'],
  ['CLOSE_TIME', '19:00', 'Office closes (24h, IST)'],
  ['WORK_DAYS', 'Mon,Tue,Wed,Thu,Fri,Sat', 'Working days'],
  ['HOLIDAYS', '', 'Comma-separated dates, e.g. 2026-11-12,2026-12-25'],
  ['MODE', 'AVAILABLE', 'Founder mode: AVAILABLE / BUSY / MEETING / DND / TRAVELLING (founder can change it by WhatsApp)'],
  ['MODE_UNTIL', '', 'When the current mode ends (set automatically)'],
  ['ACK_COOLDOWN_HOURS', '6', "Don't send the same caller another 'aapka call aaya tha' message within this many hours"],
  ['AUTO_DONE_SECONDS', '30', 'A callback through the business line connected for at least this long closes the ticket automatically'],
  ['MAX_ATTEMPTS', '3', 'Unanswered callback attempts before a ticket is marked UNREACHABLE'],
  ['WHATSAPP_ENABLED', 'FALSE', 'TRUE sends real WhatsApp messages. FALSE only writes them to the Messages tab (safe for testing)'],
  ['WA_PHONE_NUMBER_ID', '', 'WhatsApp Cloud API phone number ID (from Meta / your BSP)'],
  ['WA_API_VERSION', 'v21.0', 'Graph API version — check Meta docs for the current one'],
  ['WA_TEMPLATE_LANG', 'hi', 'Language code of your approved templates'],
  ['WA_TEMPLATE_ACK', 'ack_missed', 'Template: missed call during office hours'],
  ['WA_TEMPLATE_ACK_AFTER_HOURS', 'ack_after_hours', 'Template: missed call when office is closed'],
  ['WA_TEMPLATE_ACK_VIP', 'ack_vip', 'Template: VIP missed call — founder will call personally'],
  ['WA_TEMPLATE_ACK_UNREACHABLE', 'ack_unreachable', 'Template: we tried calling back and could not reach you'],
  ['WA_TEMPLATE_NOTIFY', 'staff_notify', 'Template used to reach founder/staff when the 24-hour WhatsApp window is closed'],
  ['SHORT_CALL_SECONDS', '15', 'An answered call shorter than this is treated as dropped (handled like a missed call)'],
  ['OUTCOME_NUDGE_MINUTES', '60', 'Remind staff once if they have not tapped an outcome after an answered call'],
  ['CAME_BACK_HOURS', '48', 'A caller calling again within this many hours of a closed callback counts as "came back"'],
  ['REQUIRE_CALLBACK_VIA_LINE', 'FALSE', 'TRUE once the phone line is live: callbacks closed with no call through the line are flagged'],
  ['FOLLOWUP_TAGS', 'BUYER_TOP,BUYER', 'Next-day "kaam hua?" WhatsApp goes to these caller types after a callback (blank = off)'],
  ['WA_TEMPLATE_FOLLOWUP', 'followup_check', 'Template: next-day "kaam hua?" check with Haan / Nahi buttons'],
  ['CONTACT_LABELS', 'VIP=BUYER_TOP,Bank=VIP_FINANCE,Family=VIP_FAMILY,Buyer=BUYER,Lead=LEAD,Vendor=VENDOR,Key vendor=VENDOR_KEY,Staff=STAFF,Transport=TRANSPORT,Partner=PARTNER,Govt=GOVT,Block=BLOCK',
    'Google Contacts label = tag, used by the nightly contact sync'],
  ['SYNC_ONLY_LABELLED', 'TRUE', 'TRUE: only copy Google contacts that have one of the labels above (keeps personal contacts out of the sheet)'],
  ['RECORDINGS_PER_STAFF', '5', 'Random recorded calls per staff member listed in the Saturday summary for review']
];

var DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
