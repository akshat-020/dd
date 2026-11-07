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
  Contacts: ['Phone', 'Phone 2', 'Name', 'Firm', 'City', 'Tag', 'Owner staff', 'Voice only', 'Notes', 'Updated'],
  Calls: ['Time', 'Call ID', 'Phone', 'Name', 'Tag', 'Direction', 'Answered', 'Answered by', 'Duration (s)', 'Recording', 'Ticket'],
  Tickets: ['ID', 'Created', 'Phone', 'Name', 'Tag', 'Priority', 'Owner', 'Deadline', 'Status', 'Summary', 'Missed calls',
    'Attempts', 'Ack sent', 'Reminded', 'Escalated', 'Remind at', 'Outcome note', 'Closed at', 'Closed by', 'Updated'],
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
  ['WA_TEMPLATE_NOTIFY', 'staff_notify', 'Template used to reach founder/staff when the 24-hour WhatsApp window is closed']
];

var DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
