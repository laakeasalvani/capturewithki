# Contact Form Backend — Design

First of four backend sub-projects for CaptureWithKi. The others (admin
dashboard, client galleries, payments/contracts) are separate specs and get
built after this one. Payments and contracts are deferred by the owner's
decision.

## Problem

`index.html`'s contact form currently validates name/email/phone in the
browser, prints "Thank you — your inquiry is on its way", and **sends
nothing anywhere**. The site is live and taking real client inquiries, so
every submission is silently lost. This is the highest-priority gap.

## Goal

A couple submits the form. Khiara gets an email she can reply to directly.
They get a warm thank-you. The inquiry is recorded so nothing is ever lost,
and so the admin dashboard (next sub-project) has something to show.

## Architecture

The site stays a static, build-free `index.html` on GitHub Pages. A new
`functions/` directory holds a Firebase Cloud Function and deploys
separately to Firebase. Two deploy targets, one repo.

Email cannot be sent from browser JavaScript without exposing an API key
that would let anyone send mail as Khiara, so the send must happen
server-side. That is the whole reason a backend exists here.

Flow when the form is submitted:

1. Browser calls the callable function `submitInquiry` with the form fields.
2. The function validates the input server-side (the browser's checks are a
   convenience, not a guarantee — anyone can call the endpoint directly).
3. Spam checks (below). A submission that fails them is discarded.
4. The inquiry is written to Firestore `inquiries` via the Admin SDK.
5. Two emails are sent via Resend.
6. The browser shows a real success or a real error.

**Ordering is deliberate: the Firestore write happens BEFORE the emails.**
If email delivery fails, the inquiry still exists and appears in the
dashboard. A lost email is recoverable; a lost inquiry is a lost client.

## Data model

**`inquiries/{autoId}`** — one document per submission:

| field | source |
|---|---|
| `name` | `#n1` |
| `partnerName` | `#n2` (optional) |
| `email` | `#em` |
| `phone` | `#ph` |
| `eventDate` | `#dt` (optional, may be empty) |
| `sessionType` | `#cl` |
| `message` | `#ms` (optional) |
| `createdAt` | server timestamp |
| `status` | `"new"` — the dashboard will later set `"read"` / `"replied"` |
| `emailToOwnerSent` | boolean |
| `emailToClientSent` | boolean |
| `emailError` | string, only present if a send failed |

The two boolean flags and `emailError` let the dashboard show "this inquiry
arrived but the email to you failed" rather than hiding the problem.

## Security rules

```
match /inquiries/{id} {
  allow read: if isAdmin();
  allow write: if false;
}
```

Client-side writes are closed entirely. The function writes with the Admin
SDK, which bypasses rules. So the public can neither read inquiries nor
forge one directly into the database — every submission goes through the
function's validation and spam checks.

This differs from the CMS collections, which are publicly readable because
they render the site. Inquiries contain client contact details and must not
be.

## Spam protection

A public endpoint that sends email is an abuse vector: it can flood
Khiara's inbox and burn the Resend quota. Three layers, all invisible to a
real visitor (the owner explicitly rejected CAPTCHA):

1. **Honeypot** — a hidden form field real users never see. If it has a
   value, the submission is from a bot. The function discards it and
   returns *success*. Returning an error would just tell the bot to retry
   with the field removed.
2. **Rate limit by IP** — the caller's IP (from `rawRequest`) is tracked in
   Firestore `rateLimits/{ipHash}`. More than 5 submissions in an hour is
   rejected. The IP is stored hashed, not raw, so the database holds no
   plain visitor IPs.
3. **Time-to-submit** — the page records when the form was rendered.
   Submission in under 3 seconds is bot-like and discarded (same silent
   success as the honeypot).

## Email

Sent via Resend (owner's choice; free tier 3,000/month, far above need).

**To Khiara** — `netherlyk23@gmail.com`:
- Subject: `New inquiry — {name}` (plus partner name when present)
- Body: every submitted field, plainly laid out
- **`reply_to` set to the client's email**, so replying in Gmail goes
  straight to the couple

**To the client**:
- Subject: `Thank you for reaching out — CaptureWithKi`
- Warm short note: greets them by name, confirms she'll reply within 48
  hours, signed off as Khiara. No recap of their submission (owner's
  choice).

**Sender address.** Khiara does not own `capturewithki.com`, so mail sends
from a Resend-provided address with replies routed to her Gmail. Buying the
domain later would let mail come from `hello@capturewithki.com`; that is a
separate decision and does not block this work.

**The Resend API key is a real secret** — unlike the Firebase web config,
which is safe to publish. It is stored via
`firebase functions:secrets:set RESEND_API_KEY` and must never be committed.

## Failure handling

- Firestore write fails → return an error. The browser tells the visitor
  the inquiry could not be saved and shows Khiara's email address so they
  can reach her directly. Never claim success when nothing was recorded.
- Firestore write succeeds, an email fails → return success (their inquiry
  IS recorded), set the relevant `emailToOwnerSent` / `emailToClientSent`
  flag false and store `emailError`. The dashboard surfaces it.
- Validation fails → return a specific error the browser shows next to the
  form.

## Client-side changes to `index.html`

- Add the hidden honeypot field and a rendered-at timestamp.
- Replace the current `#send` click handler, which only prints a message,
  with one that calls the function and shows real success/failure in the
  existing `#sent` paragraph.
- Keep the current required-field checks and add an email-format check.
- Disable the button while the request is in flight so a double-click
  cannot submit twice.
- The form's CMS-editable labels, placeholders and dropdown options are
  untouched — this work must not regress the CMS.

## Owner setup (cannot be automated)

1. Create a Resend account at resend.com and generate an API key.
2. Run `firebase login` locally so functions can be deployed.
3. Provide the API key so it can be set as a Functions secret.

## Out of scope

- Custom email domain (needs a domain purchase).
- The admin dashboard that displays these inquiries — next sub-project.
- Editing the auto-reply wording through the CMS. Hardcoded for now.
- Attachments or file uploads on the form.
- SMS or any notification other than email.

## Testing plan

- Function unit-level: validation rejects missing/malformed fields;
  honeypot and too-fast submissions return success but write nothing;
  rate limit triggers on the 6th submission in an hour.
- End to end against the real Firebase project, using a test email address:
  submit → confirm the Firestore document, the email to Khiara (including
  that Reply goes to the client address), and the client's thank-you.
- Failure paths: with a deliberately invalid Resend key, confirm the
  inquiry is still written, the flags record the failure, and the visitor
  still sees success.
- Regression: the contact form's CMS editing (labels, placeholders,
  dropdown) still works, and the rest of the site is unaffected.
- Security: confirm a logged-out client cannot read `inquiries` and cannot
  write to it directly.
