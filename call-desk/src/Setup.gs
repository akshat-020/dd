/** Menu, one-time setup, timers, and manual-entry support for the front desk. */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Call Desk')
    .addItem('1. Set up sheets', 'setupSheets')
    .addItem('2. Set secrets (webhook key, WhatsApp)', 'setSecrets')
    .addItem('3. Install timers', 'installTriggers')
    .addItem('Show webhook URLs', 'showWebhookUrls')
    .addSeparator()
    .addItem('Test: simulate a missed call', 'simulateMissedCall')
    .addItem('Send today\'s digest now', 'digestJob')
    .addItem('Build routing lists for the phone line', 'buildRoutingLists')
    .addToUi();
}

function setupSheets() {
  var ss = SpreadsheetApp.getActive();
  Object.keys(COLUMNS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = COLUMNS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      // Add any columns introduced by an update, never remove/reorder existing ones.
      var existing = headers_(sh);
      headers.forEach(function (h) {
        if (existing.indexOf(h) < 0) sh.getRange(1, sh.getLastColumn() + 1).setValue(h).setFontWeight('bold');
      });
    }
    // Phone numbers must stay text, or "+91…" turns into a number.
    headers_(sh).forEach(function (h, i) {
      if (/^Phone/.test(h) || h === 'Call ID' || h === 'WhatsApp ID') sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });

  var settings = ss.getSheetByName(SHEETS.SETTINGS);
  var have = readTable_(SHEETS.SETTINGS).map(function (r) { return r.Key; });
  DEFAULT_SETTINGS.forEach(function (row) { if (have.indexOf(row[0]) < 0) settings.appendRow(row); });
  settings.getRange('B:B').setNumberFormat('@');

  validation_(SHEETS.CONTACTS, 'Tag', TAGS);
  validation_(SHEETS.CONTACTS, 'Voice only', ['YES', 'NO']);
  validation_(SHEETS.STAFF, 'Role', STAFF_ROLES);
  validation_(SHEETS.STAFF, 'Active', ['YES', 'NO']);
  validation_(SHEETS.TICKETS, 'Priority', PRIORITIES);
  validation_(SHEETS.TICKETS, 'Status', TICKET_STATUSES);

  var dflt = ss.getSheetByName('Sheet1');
  if (dflt && dflt.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(dflt);
  if (!secret_('WEBHOOK_KEY')) PropertiesService.getScriptProperties().setProperty('WEBHOOK_KEY', Utilities.getUuid().replace(/-/g, ''));
  SpreadsheetApp.getUi().alert('Sheets are ready. Next: fill in the Staff tab (one row with Role = FOUNDER is required) and Settings, then Install timers.');
}

function validation_(sheetName, header, values) {
  var sh = sheet_(sheetName);
  var col = headers_(sh).indexOf(header) + 1;
  if (!col) return;
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build();
  sh.getRange(2, col, sh.getMaxRows() - 1, 1).setDataValidation(rule);
}

function setSecrets() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var token = ui.prompt('WhatsApp Cloud API access token', 'Paste the permanent access token (leave blank to keep the current one).', ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK) return;
  if (token.getResponseText().trim()) props.setProperty('WA_ACCESS_TOKEN', token.getResponseText().trim());
  if (!props.getProperty('WA_VERIFY_TOKEN')) props.setProperty('WA_VERIFY_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  if (!props.getProperty('WEBHOOK_KEY')) props.setProperty('WEBHOOK_KEY', Utilities.getUuid().replace(/-/g, ''));
  ui.alert('Saved. Use "Show webhook URLs" to see what to paste into the phone line and Meta.');
}

function showWebhookUrls() {
  var url = ScriptApp.getService().getUrl();
  var key = secret_('WEBHOOK_KEY');
  var msg = !url
    ? 'Deploy first: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone). Then run this again.'
    : 'Phone line (generic JSON POST):\n' + url + '?source=generic&key=' + key +
    '\n\nExotel Passthru (GET):\n' + url + '?source=exotel&key=' + key +
    '\n\nWhatsApp callback URL:\n' + url + '?source=whatsapp&key=' + key +
    '\nWhatsApp verify token: ' + secret_('WA_VERIFY_TOKEN') +
    '\n\nKeep these private — anyone with the URL can post call events.';
  SpreadsheetApp.getUi().alert(msg);
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  var tz = 'Asia/Kolkata';
  ScriptApp.newTrigger('remindersJob').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('bundleJob').timeBased().atHour(13).everyDays(1).inTimezone(tz).create();
  ScriptApp.newTrigger('bundleJob').timeBased().atHour(17).everyDays(1).inTimezone(tz).create();
  ScriptApp.newTrigger('digestJob').timeBased().atHour(19).nearMinute(30).everyDays(1).inTimezone(tz).create();
  ScriptApp.newTrigger('weeklyJob').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(18).inTimezone(tz).create();
  ScriptApp.newTrigger('onTicketEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  SpreadsheetApp.getUi().alert('Timers installed: reminders every 10 min, founder bundles at 1 pm and 5 pm, digest ~7:30 pm, weekly summary Saturday 6 pm.');
}

/**
 * Front desk can add a callback by typing a Phone (and optionally Name,
 * Summary, Priority, Owner) on an empty Tickets row — the rest is filled in
 * and the owner is notified. Setting Status to DONE by hand stamps the close.
 */
function onTicketEdit(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== SHEETS.TICKETS || e.range.getRow() < 2) return;
  withLock_(function () {
    var sh = e.range.getSheet();
    var headers = headers_(sh);
    var row = e.range.getRow();
    var r = rowToObject_(headers, sh.getRange(row, 1, 1, headers.length).getValues()[0], row);
    var editor = (Session.getActiveUser().getEmail() || 'sheet').split('@')[0];

    if (!r.ID && r.Phone) {
      var phone = normalizePhone(r.Phone);
      if (!phone) return updateRow_(SHEETS.TICKETS, row, { Summary: '⚠️ Phone number not valid — fix it and edit again' });
      var contact = findContact_(phone);
      var triage = triageFor(contact ? contact.tag : 'UNKNOWN', contact && contact.voiceOnly, false) || { priority: 'P3', owner: 'FRONT_DESK' };
      var priority = PRIORITIES.indexOf(String(r.Priority)) >= 0 ? String(r.Priority) : triage.priority;
      var owner = staffByName_(r.Owner) || resolveOwner_(triage.owner, contact);
      var now = new Date();
      updateRow_(SHEETS.TICKETS, row, {
        ID: nextTicketId_(), Created: now, Phone: phone, Name: r.Name || displayName_(contact), Tag: contact ? contact.tag : 'UNKNOWN',
        Priority: priority, Owner: owner.name, Deadline: computeDeadline(priority, now, businessHours_()), Status: 'ASSIGNED',
        Summary: r.Summary || '', 'Missed calls': 0, Attempts: 0, Updated: now
      });
      var t = ticketById_(Number(sh.getRange(row, headers.indexOf('ID') + 1).getValue()));
      notifyForTicket_(t, '📝 Front desk');
      return;
    }
    if (r.ID && headers[e.range.getColumn() - 1] === 'Status' && (r.Status === 'DONE' || r.Status === 'IGNORED') && !r['Closed at']) {
      updateRow_(SHEETS.TICKETS, row, { 'Closed at': new Date(), 'Closed by': editor, Updated: new Date() });
    }
  });
}

/**
 * Lists to load into the phone-line provider's own routing (VIPs ring the
 * founder directly, blocked numbers are rejected, each staff member's
 * callers ring them first). Live routing happens inside the provider —
 * this sheet just keeps those lists in one place.
 */
function buildRoutingLists() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SHEETS.ROUTING) || ss.insertSheet(SHEETS.ROUTING);
  sh.clear();
  var groups = { 'Founder direct (VIP)': [], 'Blocked': [] };
  readTable_(SHEETS.CONTACTS).map(contactFromRow_).forEach(function (c) {
    var group = ['VIP_FAMILY', 'VIP_FINANCE', 'BUYER_TOP', 'VENDOR_KEY', 'GOVT'].indexOf(c.tag) >= 0 ? 'Founder direct (VIP)'
      : c.tag === 'BLOCK' ? 'Blocked'
        : c.ownerStaff ? 'Rings ' + c.ownerStaff + ' first' : null;
    if (!group) return;
    groups[group] = groups[group] || [];
    c.phones.forEach(function (p) { groups[group].push(p); });
  });
  var names = Object.keys(groups);
  var depth = Math.max.apply(null, names.map(function (n) { return groups[n].length; }).concat([0]));
  var grid = [names];
  for (var i = 0; i < depth; i++) grid.push(names.map(function (n) { return groups[n][i] || ''; }));
  sh.getRange(1, 1, grid.length, names.length).setNumberFormat('@').setValues(grid);
  sh.getRange(1, 1, 1, names.length).setFontWeight('bold');
  sh.getRange(1, 1, 1, names.length).getCell(1, 1).setNote('Upload each column to the matching caller group in your phone-line provider. Rebuild after editing Contacts.');
  SpreadsheetApp.getUi().alert('Routing lists rebuilt on the "' + SHEETS.ROUTING + '" tab.');
}

function simulateMissedCall() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Simulate a missed call', 'Caller phone number:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var result = handleCallEvent(mapGenericEvent({ callId: 'sim-' + Date.now(), from: r.getResponseText(), status: 'missed' }));
  ui.alert('Result: ' + result + '\n\nSee the Calls, Tickets and Messages tabs.');
}
