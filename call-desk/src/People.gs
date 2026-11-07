/** Staff and contact lookups. */

function staffList_() {
  return readTable_(SHEETS.STAFF)
    .filter(function (s) { return s.Name && (s.Active === '' || truthy_(s.Active)); })
    .map(function (s) {
      return { name: String(s.Name).trim(), phone: normalizePhone(s.Phone), role: String(s.Role || 'STAFF').trim().toUpperCase() };
    });
}

function staffByRole_(role) {
  var list = staffList_();
  for (var i = 0; i < list.length; i++) if (list[i].role === role) return list[i];
  return null;
}

function founder_() {
  var f = staffByRole_('FOUNDER');
  if (!f) throw new Error('Add the founder to the Staff tab with Role = FOUNDER');
  return f;
}

/** Exact name first, then a unique prefix ("ram" → Ramesh). */
function staffByName_(name) {
  if (!name) return null;
  var q = String(name).trim().toLowerCase();
  var list = staffList_();
  var exact = list.filter(function (s) { return s.name.toLowerCase() === q; });
  if (exact.length) return exact[0];
  var prefix = list.filter(function (s) { return s.name.toLowerCase().indexOf(q) === 0; });
  return prefix.length === 1 ? prefix[0] : null;
}

function staffByPhone_(phone) {
  var list = staffList_();
  for (var i = 0; i < list.length; i++) if (list[i].phone && list[i].phone === phone) return list[i];
  return null;
}

/** Resolves a triage owner (FOUNDER / OWNER_STAFF / DEPUTY / FRONT_DESK) to a staff member. */
function resolveOwner_(ownerRule, contact) {
  var chain = {
    FOUNDER: ['FOUNDER'],
    DEPUTY: ['DEPUTY', 'FOUNDER'],
    FRONT_DESK: ['FRONT_DESK', 'DEPUTY', 'FOUNDER'],
    OWNER_STAFF: ['FRONT_DESK', 'DEPUTY', 'FOUNDER']
  }[ownerRule] || ['FRONT_DESK', 'DEPUTY', 'FOUNDER'];
  if (ownerRule === 'OWNER_STAFF' && contact && contact.ownerStaff) {
    var named = staffByName_(contact.ownerStaff);
    if (named) return named;
  }
  for (var i = 0; i < chain.length; i++) {
    var s = staffByRole_(chain[i]);
    if (s) return s;
  }
  return founder_();
}

// ---------------------------------------------------------------- contacts

function contactFromRow_(r) {
  return {
    row: r._row,
    phones: [normalizePhone(r.Phone), normalizePhone(r['Phone 2'])].filter(function (p) { return p; }),
    name: r.Name ? String(r.Name) : '',
    firm: r.Firm ? String(r.Firm) : '',
    tag: parseTag(r.Tag) || 'UNKNOWN',
    ownerStaff: r['Owner staff'] ? String(r['Owner staff']) : '',
    voiceOnly: truthy_(r['Voice only'])
  };
}

function findContact_(phone) {
  if (!phone) return null;
  var rows = readTable_(SHEETS.CONTACTS);
  for (var i = 0; i < rows.length; i++) {
    var c = contactFromRow_(rows[i]);
    if (c.phones.indexOf(phone) >= 0) return c;
  }
  // A staff member calling is a contact too.
  var staff = staffByPhone_(phone);
  if (staff) return { row: null, phones: [phone], name: staff.name, firm: '', tag: 'STAFF', ownerStaff: '', voiceOnly: false };
  return null;
}

function displayName_(contact) {
  if (!contact) return '';
  return contact.firm && contact.name ? contact.name + ' (' + contact.firm + ')' : contact.name || contact.firm;
}

/** Founder's "VIP 98…" / "BLOCK 98…" commands. */
function setContactTag_(phone, tag) {
  var existing = findContact_(phone);
  if (existing && existing.row) {
    updateRow_(SHEETS.CONTACTS, existing.row, { Tag: tag, Updated: new Date() });
  } else {
    appendObject_(SHEETS.CONTACTS, { Phone: phone, Tag: tag, Updated: new Date() });
  }
}
