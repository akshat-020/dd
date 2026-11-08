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
    voiceOnly: truthy_(r['Voice only']),
    notes: r.Notes ? String(r.Notes) : '',
    nameGuessed: /\(name from WhatsApp\)/.test(String(r.Notes || ''))
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
    appendObject_(SHEETS.CONTACTS, { Phone: phone, Tag: tag, Updated: new Date(), Source: 'Founder', 'First seen': new Date() });
  }
}

/**
 * A number not in Contacts (and not staff) is saved the first time it calls
 * or messages, tagged UNKNOWN, so the front desk has one "to tag" list
 * (filter Contacts by Tag = UNKNOWN).
 */
function ensureContact_(phone, source) {
  var existing = findContact_(phone);
  if (existing) return existing;
  appendObject_(SHEETS.CONTACTS, { Phone: phone, Tag: 'UNKNOWN', Source: source, 'First seen': new Date(), Updated: new Date() });
  return findContact_(phone);
}

/**
 * Fills in who a caller is. Name only overwrites a blank (or WhatsApp-guessed)
 * name unless force is set; VIP-class tags can only be set by the founder.
 * Returns an error string, or null on success.
 */
function nameContact_(phone, name, tag, byFounder, force) {
  if (tag && VIP_TAGS.indexOf(tag) >= 0 && !byFounder) return 'VIP tag sirf founder laga sakte hain';
  var c = ensureContact_(phone, 'Staff');
  if (!c.row) return 'Yeh staff ka number hai';
  if (c.tag && VIP_TAGS.indexOf(c.tag) >= 0 && tag && tag !== c.tag && !byFounder) return 'VIP contact ka tag sirf founder badal sakte hain';
  var patch = { Updated: new Date() };
  if (name && (force || !c.name || c.nameGuessed)) patch.Name = name;
  if (tag) patch.Tag = tag;
  if (name && c.nameGuessed) patch.Notes = String(c.notes || '').replace(/\s*\(name from WhatsApp\)/, '');
  updateRow_(SHEETS.CONTACTS, c.row, patch);
  // Open tickets for this number pick up the name/tag too.
  allTickets_().filter(function (t) { return t.phone === phone && isOpen_(t); }).forEach(function (t) {
    var tp = {};
    if (patch.Name) tp.Name = patch.Name;
    if (tag) tp.Tag = tag;
    if (tp.Name || tp.Tag) updateTicket_(t, tp);
  });
  return null;
}

/** WhatsApp sends the sender's profile name — a useful guess for an unnamed contact. */
function guessNameFromWhatsApp_(phone, profileName) {
  if (!profileName) return;
  var c = findContact_(phone);
  if (!c || !c.row || c.name) return;
  updateRow_(SHEETS.CONTACTS, c.row, { Name: String(profileName).slice(0, 80), Notes: ((c.notes || '') + ' (name from WhatsApp)').trim(), Updated: new Date() });
}
