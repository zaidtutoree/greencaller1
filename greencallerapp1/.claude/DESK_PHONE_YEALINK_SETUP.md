# Desk Phone (Yealink) Setup — exact settings that work

Verified 2026-10-04 on a Yealink SIP-T73W (firmware 185.87.0.15) for
zaid@greencaller.co.uk / 02046203845. Inbound rings the handset together with the
web/exe/mobile apps; outbound presents the user's number; calls land in Call
History tagged "Desk phone".

## 1. Telnyx side (done by the admin "Desk phone" button, or by hand)

Each desk phone gets its OWN Telnyx **Credential Connection**. Never register a
handset with an app user's credential or the shared legacy credential — Telnyx
delivers one INVITE per credential and the handset will hijack the apps.

| Setting | Value | Why |
|---|---|---|
| Connection name | `Greencaller Desk - <user>` | one per handset |
| Webhook URL | `https://wofpxloehneavpoiqpal.supabase.co/functions/v1/telnyx-call-events`, API v2 | call history for calls made on the handset |
| Outbound voice profile | same as the desktop connection (`2867806477618250914`) | billing/routing parity |
| Outbound → Caller ID override | the user's assigned number, "always" | handset presents the right number |
| Outbound → Localization | GB | national dialling from the handset |
| **SIP URI calling** (`sip_uri_calling_preference`) | **internal** | REQUIRED. Default (disabled) makes Telnyx answer every inbound leg with SIP 403 — handset never rings inbound while outbound works |
| Encrypted media | **none** | with SRTP required, Telnyx rejects the plain-RTP leg coming from TeXML |
| Codecs | G722, G711U, G711A | |
| Credential for the handset | an **on-demand telephony credential** on that connection, no expiry | telnyx-incoming-call dials `sip:<credential>@sip.telnyx.com` |

Do NOT use the connection's own user_name/password in the handset. The admin
function (`supabase/functions/admin-deskphone`) does all of the above and shows the
credential in the dialog (`src/components/admin/DeskPhoneDialog.tsx`).

The user's phone number stays on the TeXML application ("New Calling"); do not
assign it to the desk connection.

## 2. Yealink web portal

Find the phone's IP: press **OK** on the handset (or Menu → Status). Browse to
`http://<ip>` (or `https://`). Default login `admin` / `admin`.

### Account → Register (Account 1)

```
Line Active:                  Enabled
Label / Display Name:         <user's name>
Register Name:                <credential username>   (paste — 48 chars)
User Name:                    <credential username>   (same value)
Password:                     <credential password>
SIP Server 1 → Server Host:   sip.telnyx.com    Port: 5060
Transport:                    UDP
Server Expires:               180
Enable Outbound Proxy Server: Disabled          ← REQUIRED (see below)
```

Click **Confirm**, wait ~30 s, status must read **Registered**.

### Account → Advanced (Account 1)

```
RTP Encryption (SRTP):        Disabled
```

Confirm. (With SRTP "Optional" the handset still offers encrypted media and Telnyx
answers outbound calls with SIP 488 "Not Acceptable Here".)

## 3. Gotchas we hit

- **Outbound Proxy enabled = phone sends nothing.** With the proxy enabled (even
  pointing at sip.telnyx.com) this firmware never sent a REGISTER at all — a packet
  capture showed zero DNS/SIP traffic. Disable it.
- **TLS 5061** did not register on this firmware either; UDP 5060 works.
- **"Not Acceptable Here" on outbound** = SRTP mismatch. Set SRTP Disabled on the
  phone and Encrypted Media none on the connection.
- **Handset registers but never rings inbound (SIP 403)** = SIP URI calling disabled
  on the connection. Set it to `internal`.
- This firmware has no "Local Log Level". Diagnose with **Settings → Configuration
  → Pcap Feature** (Start → reproduce → Stop → Export) or, server-side, the Telnyx
  TeXML Calls API (`GET /v2/texml/Accounts/<sid>/Calls`) which lists each `<Sip>`
  leg with its `sip_hangup_cause`.

## 4. How the pieces fit

- `desk_phones` table: user_id, phone_number_id, telnyx_connection_id,
  telnyx_credential_id, sip_username/password, label, is_active.
- `telnyx-incoming-call` adds one `<Sip>` per active desk phone to the same
  `<Dial>` as the apps → simultaneous ring, first answer wins.
- `telnyx-call-events` (the desk connection's webhook) inserts outbound history
  rows for handset calls, stamps `device = deskphone` when an inbound call is
  answered on the handset, and writes a terminal row if the leg dies before the
  initiated event is processed.
- `call_history.device` → "Desk phone" chip in `CallHistory.tsx` (web + exe).
