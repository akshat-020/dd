# Call Desk — Google Sheets + Apps Script

The call desk's software: **call log, callback tickets, reminders, WhatsApp
acknowledgements to callers, live alerts and an evening digest for the founder,
and one-tap WhatsApp replies**. It runs inside one Google Sheet, at no hosting
cost. It is **separate from the OMS** and needs nothing from it.

Design: [`docs/call-desk/CALL_DESK_SYSTEM.md`](../docs/call-desk/CALL_DESK_SYSTEM.md).

## What it does

| When | What happens |
|---|---|
| A call is missed | Logged in **Calls**. A callback ticket goes in **Tickets** with priority, owner and deadline (by who called: top buyer → founder, vendor → their staff, unknown → front desk). The caller gets *"Namaste 🙏 … aapka call aaya tha. Aaj shaam 7 pm tak aapko call back hoga."* The owner gets a WhatsApp task. |
| Same number calls again within 10 min (or 3× in 30) | Ticket jumps to **P0**, and the founder gets a live alert with buttons: *Main call karunga / Pooja ko do / Ignore*. |
| Family number | P0 to the founder, no message to the caller. |
| Blocked number | Logged only. |
| Office closed | After-hours message with tomorrow's promise. Deadlines count working hours only (Sundays and holidays skipped). |
| Staff calls back through the business line | Counts as an attempt. If connected ≥30 s, the ticket closes automatically. After 3 failed tries the ticket is marked **UNREACHABLE** and the caller gets *"humne call kiya tha…"*. |
| Halfway to the deadline | Reminder to the owner. |
| P0/P1 overdue | Founder alerted (*"Rohit has not called back"*). The founder's own overdue P0 goes to the deputy. |
| P2 still open the next working morning | Becomes P1. |
| Founder in MEETING/DND | Only P0 is pushed live. The founder's other callbacks come in a list at **1 pm and 5 pm**. |
| ~7:30 pm | **Digest**: calls, answered, missed, callbacks done/pending/overdue, *needs you*, staff on-time scoreboard, untagged numbers calling often. |
| Saturday 6 pm | **Weekly summary**: calls by type, on-time %, late buyer/lead callbacks. |
| A caller replies on WhatsApp | Noted on their open ticket (or a new ticket is made) and the owner is told. |
| Front desk types a phone number on an empty Tickets row | The rest is filled in and the owner is notified. Setting Status to DONE by hand stamps who closed it. |

### WhatsApp commands (founder and staff)

| Send | Meaning |
|---|---|
| `1 #147` | I'll call (founder takes it) |
| `2 Ramesh #147` | Give it to Ramesh |
| `3 #147` | Done |
| `4 #147` | Ignore (founder only) |
| `5 6pm #147` | Remind me at 6 pm |
| `D 147 baat ho gayi` | Staff: callback done, with a note |
| `A` `B` `M 4pm` `D` `T` | Founder mode: Available, Busy, Meeting till 4 pm, DND, Travelling |
| `VIP 98xxxxxxxx bank` | Make a number VIP (`bank`, `family`, `vendor`, `govt`; default top buyer) |
| `BLOCK 98xxxxxxxx` | Block a number |
| `help` | List of commands |

When replying to an alert, the ticket number is optional. The buttons on alerts do the same thing.

## Setup (about 1 hour)

1. **Create the sheet.** Make a new Google Sheet with the business Google account, then open Extensions → Apps Script.
2. **Add the code.** Create one script file per file in `src/` with the same name, and paste in its contents. Replace `appsscript.json`; to see it, tick Project Settings → *Show "appsscript.json"*.
   - Or use [clasp](https://github.com/google/clasp): `cd call-desk/src && clasp create --type sheets && clasp push`.
3. **Set up the tabs.** Reload the sheet. A **Call Desk** menu appears. Run **1. Set up sheets** and approve the permissions.
4. **Fill in Staff:** one row per person with name, WhatsApp number and role. Exactly one **FOUNDER** row is required. Add one DEPUTY, one FRONT_DESK, and everyone else as STAFF.
5. **Fill in Contacts** from the tagging session (design §3):
   - **Tag**: `VIP_FAMILY`, `VIP_FINANCE`, `BUYER_TOP`, `BUYER`, `LEAD`, `VENDOR_KEY`, `VENDOR`, `STAFF`, `TRANSPORT`, `PARTNER`, `GOVT`, `BLOCK`.
   - **Owner staff**: the person who handles them, spelled exactly as in Staff.
   - **Voice only**: `YES` for callers who can't read. Their callbacks get a higher priority.
6. **Settings tab:** company name, office hours, working days and holidays. Leave `WHATSAPP_ENABLED = FALSE` for now.
7. **Test without WhatsApp:**
   - Run **Test: simulate a missed call** with a few numbers.
   - Check Calls, Tickets and Messages. In dry-run mode every message is written to Messages instead of being sent.
   - Reply-command handling can't be tried from the sheet; it needs WhatsApp (step 10).
8. **Run 3. Install timers.**
9. **Deploy the web app:**
   - Deploy → New deployment → Web app, with *Execute as: Me* and *Who has access: Anyone*.
   - Then run **Show webhook URLs**. Each URL contains a secret key, so share it only with whoever sets up the phone line.
10. **Connect WhatsApp** (Meta WhatsApp Cloud API, directly or through a provider that offers it):
    - Run **2. Set secrets** and paste the permanent access token.
    - In Settings, put the `WA_PHONE_NUMBER_ID`.
    - In Meta's webhook settings, set the callback URL to the *WhatsApp callback URL* and the verify token to the one shown. Subscribe to `messages`.
    - Get the five templates below approved.
    - Set `WHATSAPP_ENABLED = TRUE`.
    - The founder and staff should send "help" to the office number once. That opens the 24-hour window, so free-form messages and buttons work without templates.
11. **Connect the phone line.** Point the provider's "call ended" webhook or Passthru at the phone-line URL (see below).
12. **Routing lists:** run **Build routing lists for the phone line** and load the lists into the provider's caller groups. That's where live routing happens: VIPs ring the founder, blocked numbers are rejected. Rebuild after editing Contacts.

### WhatsApp templates to submit (category: Utility, language: Hindi)

| Setting | Template name | Body |
|---|---|---|
| `WA_TEMPLATE_ACK` | `ack_missed` | `Namaste 🙏 {{1}} mein aapka call aaya tha. {{2}} aapko call back hoga.` |
| `WA_TEMPLATE_ACK_AFTER_HOURS` | `ack_after_hours` | `Namaste 🙏 Office abhi band hai. Aapka call note ho gaya hai. {{1}} aapko call aayega. — {{2}}` |
| `WA_TEMPLATE_ACK_VIP` | `ack_vip` | `Namaste {{1}} ji 🙏 Sir abhi call nahi utha paaye. Woh khud aapko {{2}} call karenge. — {{3}}` |
| `WA_TEMPLATE_ACK_UNREACHABLE` | `ack_unreachable` | `Namaste 🙏 {{1}} se aapko call kiya tha, baat nahi ho paayi. Free hon toh isi number par call karein.` |
| `WA_TEMPLATE_NOTIFY` | `staff_notify` | `Office update: {{1}}` |

Meta may ask for sample values, e.g. `Sharma Steels` / `Aaj shaam 7 pm tak`. If a name is changed during approval, update it in Settings.

### Phone-line webhook format

**Any provider (generic):** after each call, `POST` JSON to the *generic* URL. The ticket logic needs `from`, `status` and, for callbacks, `to` + `direction`:

```json
{ "callId": "abc123", "from": "09812345678", "to": "08047000000",
  "status": "missed", "direction": "inbound", "durationSec": 0,
  "answeredBy": "", "recordingUrl": "" }
```

- `status`: `answered` / `completed` count as answered; anything else is missed.
- For callbacks made through the line, send `"direction": "outbound"` with `to` = the customer.
- Phone numbers can be in any Indian format.
- The same `callId` is only processed once.

**Exotel:** add a *Passthru* applet after *Connect* in the call flow, pointing to the *Exotel* URL. `mapExotelEvent` in `Logic.gs` reads `CallSid`, `CallFrom`, `CallTo`, `DialCallStatus`, `StartTime`, `DialWhomNumber`, `RecordingUrl`, `Direction`. **Check these names against your Exotel account** and adjust that one function if they differ. Other providers: use the generic format, or add a similar mapping function.

## Things to verify before go-live

- **Webhook redirects.** Apps Script answers web requests with a redirect to `script.googleusercontent.com`. The data is received either way. But if Meta or the phone provider treats the redirect as a failure, they retry, and duplicates are already ignored (by call ID / message ID). If a provider refuses to work with it at all, put a tiny relay (e.g. a Make.com scenario or a Cloudflare Worker) in front.
- **Meta callback URL with query parameters.** Confirm Meta accepts the `?source=whatsapp&key=…` URL. If not, use the relay above.
- **Apps Script limits** (free Google accounts): timers can run about 90 minutes a day in total. The 10-minute reminder job uses a few seconds per run. Keep the Calls tab under ~20,000 rows by moving old months to an archive sheet.
- **Live routing is not done here.** Sheets is too slow to decide where a ringing call goes. Routing (VIP → founder, owner staff first, fallbacks) is configured in the phone-line provider using the routing lists. This sheet handles everything after the ring.
- **Not built yet** (design Phase 2): call recording transcription, AI summaries and the after-hours AI voice. The Calls tab already stores the recording link for when that's added.

## Tests

The business rules (`Logic.gs`) and the full flow run in Node against an in-memory stand-in for Sheets and WhatsApp:

```bash
node --test call-desk/test/*.test.js
```
