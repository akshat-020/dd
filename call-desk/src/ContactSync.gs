/**
 * Nightly one-way sync: the founder's Google Contacts → the Contacts tab.
 * Google Contacts labels (set on the phone) become tags via CONTACT_LABELS.
 * The sheet stays the master: tags and names already in the sheet are never
 * overwritten. Uses the People API advanced service (see appsscript.json),
 * so it reads the contacts of the Google account that owns this script.
 */
function syncContactsJob() {
  var labelNames = {};
  var groupsResp = People.ContactGroups.list({ pageSize: 1000 });
  (groupsResp.contactGroups || []).forEach(function (g) { labelNames[g.resourceName] = g.formattedName || g.name; });

  var google = [];
  var pageToken = null;
  do {
    var resp = People.People.Connections.list('people/me', {
      personFields: 'names,phoneNumbers,memberships',
      pageSize: 1000,
      pageToken: pageToken
    });
    (resp.connections || []).forEach(function (p) {
      google.push({
        name: p.names && p.names[0] ? p.names[0].displayName : '',
        phones: (p.phoneNumbers || []).map(function (n) { return n.canonicalForm || n.value; }),
        labels: (p.memberships || []).map(function (m) {
          return m.contactGroupMembership ? labelNames[m.contactGroupMembership.contactGroupResourceName] : null;
        }).filter(Boolean)
      });
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);

  return withLock_(function () {
    var existing = readTable_(SHEETS.CONTACTS).map(contactFromRow_);
    var plan = planContactSync(existing, google, parseLabelMap(setting_('CONTACT_LABELS', '')), truthy_(setting_('SYNC_ONLY_LABELLED', 'TRUE')));
    var now = new Date();
    plan.updates.forEach(function (u) {
      var patch = { Updated: now };
      if (u.name) patch.Name = u.name;
      if (u.tag) patch.Tag = u.tag;
      updateRow_(SHEETS.CONTACTS, u.row, patch);
    });
    plan.adds.forEach(function (a) {
      appendObject_(SHEETS.CONTACTS, { Phone: a.phone, 'Phone 2': a.phone2, Name: a.name, Tag: a.tag, Source: 'Google Contacts', 'First seen': now, Updated: now });
    });
    return 'contacts sync: ' + plan.adds.length + ' added, ' + plan.updates.length + ' updated (of ' + google.length + ' Google contacts)';
  });
}

function syncContactsNow() {
  SpreadsheetApp.getUi().alert(syncContactsJob());
}
