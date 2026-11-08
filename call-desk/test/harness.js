// In-memory stand-ins for the Google Apps Script services the call desk
// uses, so the real .gs files can run end-to-end under Node.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.rows; r++) {
      const line = [];
      for (let c = 0; c < this.cols; c++) {
        const v = (this.sheet.data[this.row - 1 + r] || [])[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  getCell(r, c) { return new FakeRange(this.sheet, this.row + r - 1, this.col + c - 1, 1, 1); }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
  setDataValidation() { return this; }
  setNote() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  set(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    this.data[row - 1][col - 1] = v;
  }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if ((this.data[i] || []).some((v) => v !== '' && v !== undefined)) return i + 1;
    return 0;
  }
  getLastColumn() { return Math.max(0, ...this.data.map((r) => r.length)); }
  getMaxRows() { return 1000; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return new FakeRange(this, 1, 1, 1, 1);
    return new FakeRange(this, a, b, c || 1, d || 1);
  }
  appendRow(values) { this.data.splice(this.getLastRow(), 0, values.slice()); this.data.length = this.getLastRow(); }
  setFrozenRows() {}
  clear() { this.data = []; }
}

class FakeSpreadsheet {
  constructor() { this.sheets = [new FakeSheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
}

function createEnv({ start }) {
  let now = start.getTime();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(now); else super(...args); }
    static now() { return now; }
  }

  const ss = new FakeSpreadsheet();
  const props = {};
  const cache = {};
  const sent = [];
  let fetchHandler = () => ({ code: 200, body: { messages: [{ id: 'wamid.' + (sent.length + 1) }] } });
  const chain = new Proxy({}, { get: (t, k) => (k === 'build' ? () => ({}) : () => chain) });
  const triggerChain = new Proxy({}, { get: () => () => triggerChain });

  const context = {
    Date: FakeDate,
    console,
    SpreadsheetApp: {
      getActive: () => ss,
      getUi: () => ({ alert() {}, createMenu: () => triggerChain, prompt: () => ({}), ButtonSet: {}, Button: {} }),
      newDataValidation: () => chain,
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        const payload = JSON.parse(opts.payload);
        const r = fetchHandler(payload);
        sent.push({ url, payload, headers: opts.headers, response: r });
        return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body) };
      },
    },
    Utilities: {
      formatDate: (d) => d.toISOString().slice(0, 10),
      getUuid: () => 'uuid-' + Math.random().toString(16).slice(2),
    },
    ContentService: { createTextOutput: (s) => ({ text: String(s) }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'pooja@example.com' }) },
    // People API advanced service: env.googleContacts = { groups: [...], people: [...] }
    People: {
      ContactGroups: { list: () => ({ contactGroups: (context.__google || {}).groups || [] }) },
      People: {
        Connections: {
          list: (_who, opts) => {
            const people = (context.__google || {}).people || [];
            const start = opts.pageToken ? Number(opts.pageToken) : 0;
            const page = people.slice(start, start + 2); // small pages to exercise paging
            return { connections: page, nextPageToken: start + 2 < people.length ? String(start + 2) : undefined };
          },
        },
      },
    },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => triggerChain, WeekDay: {}, getService: () => ({ getUrl: () => 'https://script.example/exec' }) },
  };
  vm.createContext(context);
  const dir = path.join(__dirname, '..', 'src');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), context, { filename: file });
  }

  const table = (name) => {
    const sh = ss.getSheetByName(name);
    const [headers, ...rows] = sh.data;
    return rows.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
  };

  return {
    ctx: context,
    ss,
    props,
    sent,
    table,
    advance: (minutes) => { now += minutes * 60000; },
    setNow: (d) => { now = d.getTime(); },
    onFetch: (fn) => { fetchHandler = fn; },
    run: (code) => vm.runInContext(code, context),
  };
}

module.exports = { createEnv };
