/** Small helpers for treating a sheet tab as a table of objects keyed by header. */

function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '" — run Call Desk → Set up sheets');
  return sh;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

function rowToObject_(headers, values, rowNumber) {
  var o = { _row: rowNumber };
  for (var i = 0; i < headers.length; i++) o[headers[i]] = values[i];
  return o;
}

/** All data rows as objects (each has _row = its sheet row number). */
function readTable_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var headers = headers_(sh);
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values.map(function (v, i) { return rowToObject_(headers, v, i + 2); });
}

/** Only the last n data rows — for big, append-only tabs like Calls. */
function readLastRows_(name, n) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var start = Math.max(2, last - n + 1);
  var headers = headers_(sh);
  var values = sh.getRange(start, 1, last - start + 1, headers.length).getValues();
  return values.map(function (v, i) { return rowToObject_(headers, v, start + i); });
}

function appendObject_(name, obj) {
  var sh = sheet_(name);
  var headers = headers_(sh);
  sh.appendRow(headers.map(function (h) { return obj[h] === undefined || obj[h] === null ? '' : obj[h]; }));
  return sh.getLastRow();
}

/** Writes only the given fields of one row. */
function updateRow_(name, rowNumber, patch) {
  var sh = sheet_(name);
  var headers = headers_(sh);
  var range = sh.getRange(rowNumber, 1, 1, headers.length);
  var values = range.getValues()[0];
  var changed = false;
  for (var key in patch) {
    var col = headers.indexOf(key);
    if (col < 0) throw new Error('Unknown column "' + key + '" in ' + name);
    values[col] = patch[key] === null || patch[key] === undefined ? '' : patch[key];
    changed = true;
  }
  if (changed) range.setValues([values]);
}

function truthy_(v) {
  return v === true || /^(true|yes|y|1|haan)$/i.test(String(v || '').trim());
}

function asDate_(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- settings

var settingsCache_ = null;

function settings_() {
  if (settingsCache_) return settingsCache_;
  var map = {};
  readTable_(SHEETS.SETTINGS).forEach(function (r) { if (r.Key) map[String(r.Key).trim()] = r.Value; });
  settingsCache_ = map;
  return map;
}

function setting_(key, fallback) {
  var v = settings_()[key];
  return v === undefined || v === '' ? fallback : v;
}

function setSetting_(key, value) {
  var rows = readTable_(SHEETS.SETTINGS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].Key === key) {
      updateRow_(SHEETS.SETTINGS, rows[i]._row, { Value: value });
      settingsCache_ = null;
      return;
    }
  }
  appendObject_(SHEETS.SETTINGS, { Key: key, Value: value });
  settingsCache_ = null;
}

function clockToMinutes_(v, fallback) {
  if (v instanceof Date) return v.getHours() * 60 + v.getMinutes(); // a sheet may turn "10:00" into a time value
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

function businessHours_() {
  var days = String(setting_('WORK_DAYS', 'Mon,Tue,Wed,Thu,Fri,Sat')).toUpperCase().split(/[,\s]+/)
    .map(function (d) { return DAY_NAMES.indexOf(d.slice(0, 3)); })
    .filter(function (i) { return i >= 0; });
  var holidays = String(setting_('HOLIDAYS', '')).split(/[,\s]+/).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); });
  return {
    openMin: clockToMinutes_(setting_('OPEN_TIME', '10:00'), 600),
    closeMin: clockToMinutes_(setting_('CLOSE_TIME', '19:00'), 1140),
    workDays: days.length ? days : [1, 2, 3, 4, 5, 6],
    holidays: holidays
  };
}

function secret_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}
