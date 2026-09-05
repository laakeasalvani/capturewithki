import { escapeHtml } from './html.js';
// Reuse email.js's own palette and font stacks rather than keeping a second
// copy here. lib/kea.js already keeps its own private copy of the same
// tokens for a second site; a third copy in this file would make drift
// near-certain. These are the site's own :root design tokens, copied from
// index.html — not new colours invented for contracts.
import { C, SERIF, SANS } from './email.js';

// Strip CR/LF from anything that becomes a single line, so a crafted name
// cannot forge a Subject header or an extra labelled line. Same defence, and
// same reasoning, as oneLine() in email.js.
function oneLine(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}

// Cents are the only unit contracts.js and Stripe deal in. A client's inbox
// is the last place a bad amount should be caught, so anything that is not
// a plain integer renders as $0.00 rather than NaN or a silently wrong
// number (e.g. a string that happened to parse, or a float from a rounding
// bug upstream).
export function formatCents(cents) {
  if (!Number.isInteger(cents)) return '$0.00';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-$' : '$') + grouped + '.' + rest;
}

// ---------------------------------------------------------------------------
// Both emails below follow the same constraints documented in email.js:
//   - No <style> block and no classes — Gmail strips the head. Everything is
//     inline, and layout is tables, because Outlook renders with Word.
//   - Fonts are limited to the site's own fallback stacks (SERIF / SANS
//     above), since custom fonts are stripped by every major mail client.
//   - `text` is never dropped: HTML-only mail is penalised by spam filters
//     and unreadable to anyone whose client is set to plain text.
//   - Every interpolated value goes through escapeHtml in the HTML body
//     (the client's own name is rendered here, and text cannot be markup
//     but HTML can) and through oneLine in the subject, so a crafted name
//     cannot forge a header or smuggle a newline.
// ---------------------------------------------------------------------------

export function readyToSignEmail(o) {
  const d = o || {};
  const name = oneLine(d.clientName);
  const url = oneLine(d.signUrl);
  const date = oneLine(d.eventDate);
  const total = formatCents(d.totalCents);
  const retainer = formatCents(d.retainerCents);

  const subject = 'Your CaptureWithKi agreement is ready to sign';

  const text = [
    'Hi ' + name + ',',
    '',
    'Your photography agreement is ready. You can read and sign it here:',
    url,
    '',
    'Date: ' + date,
    'Total: ' + total,
    'Retainer due on signing: ' + retainer,
    '',
    'Once it is signed and the retainer is paid, your date is held.',
    '',
    'Khiara',
    'CaptureWithKi'
  ].join('\n');

  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.bg + ';padding:24px 0;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
          'style="background:' + C.paper + ';border:1px solid ' + C.line + ';padding:32px;">' +
          '<tr><td style="font-family:' + SERIF + ';font-size:22px;color:' + C.ink + ';">' +
            'Your agreement is ready' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
            'Hi ' + escapeHtml(name) + ', your photography agreement is ready to read and sign.' +
          '</td></tr>' +
          '<tr><td style="padding-top:24px;">' +
            '<a href="' + escapeHtml(url) + '" ' +
               'style="font-family:' + SANS + ';font-size:15px;background:' + C.khaki + ';' +
               'color:#fff;padding:12px 20px;text-decoration:none;display:inline-block;">' +
              'Read and sign' +
            '</a>' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + C.muted + ';padding-top:24px;">' +
            'Date: ' + escapeHtml(date) + '<br>' +
            'Total: ' + escapeHtml(total) + '<br>' +
            'Retainer due on signing: ' + escapeHtml(retainer) +
          '</td></tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>';

  return { subject: subject, text: text, html: html };
}

// A Date is the natural type for "when this happened" (contracts.js deals in
// real timestamps for signContract's own callback), but chaseContracts hands
// these functions raw Firestore Timestamp objects straight off a document
// (Object.assign({id}, doc.data())), which are neither a Date nor a string.
// toISOString() is used rather than toLocaleString() so the result does not
// depend on the server's timezone or locale, and rather than a bespoke
// formatter that could throw on an unexpected input.
function formatTimestamp(v) {
  if (v && typeof v.toDate === 'function') {
    const d = v.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : oneLine(v);
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return oneLine(v);
}

// The dashboard has no per-contract deep link (int/contracts.js has no hash
// routing), so this is the dashboard's own address — the same one anyone
// would type to go look. It gets Khiara to the right screen, not a specific
// row on it.
const DASHBOARD_URL = 'https://capturewithki.com/int/#contracts';

export function signedCopyEmail(o) {
  const d = o || {};
  const name = oneLine(d.clientName);
  const url = oneLine(d.contractUrl);
  const signedAt = formatTimestamp(d.signedAt);

  const subject = 'Your signed CaptureWithKi agreement';

  const text = [
    'Hi ' + name + ',',
    '',
    'Your photography agreement was signed on ' + signedAt + '.',
    '',
    'You can view your signed copy here, any time:',
    url,
    '',
    'Khiara',
    'CaptureWithKi'
  ].join('\n');

  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.bg + ';padding:24px 0;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
          'style="background:' + C.paper + ';border:1px solid ' + C.line + ';padding:32px;">' +
          '<tr><td style="font-family:' + SERIF + ';font-size:22px;color:' + C.ink + ';">' +
            'Your agreement is signed' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
            'Hi ' + escapeHtml(name) + ', your photography agreement was signed on ' +
            escapeHtml(signedAt) + '.' +
          '</td></tr>' +
          '<tr><td style="padding-top:24px;">' +
            '<a href="' + escapeHtml(url) + '" ' +
               'style="font-family:' + SANS + ';font-size:15px;background:' + C.khaki + ';' +
               'color:#fff;padding:12px 20px;text-decoration:none;display:inline-block;">' +
              'View signed copy' +
            '</a>' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + C.muted + ';padding-top:24px;">' +
            'This link is your permanent record of the signed agreement.' +
          '</td></tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>';

  return { subject: subject, text: text, html: html };
}

// ---------------------------------------------------------------------------
// The chase ladder (Task 6). All four below are built by chaseContracts in
// index.js from a raw contract document — a plain object with an `id` and
// whatever Firestore has on it, never something these functions fetch or
// shape themselves.
//
// A NOTE ON LINKS THE CLIENT-FACING TWO DO NOT HAVE: signReminderEmail and
// payReminderEmail cannot carry a fresh "click here to sign" / "click here to
// pay" link. That link is `SITE_ORIGIN + '/sign/?t=' + token`, and the raw
// token is never persisted anywhere — only tokenHash (contract-crypto.js's
// hashToken, one-way sha256) is stored, by design, so that a Firestore read
// can never hand out a working credential. There is no honest way to
// reconstruct it here, and minting a fresh token silently on a reminder would
// invalidate the link already sitting in the client's inbox from
// readyToSignEmail/signedCopyEmail without warning them. So both reminders
// instead point the client back to that original email and offer a human
// fallback (reply, or call) if they cannot find it — true today, and never
// wrong in a way that costs Khiara a client who says "I never got a link."
// ---------------------------------------------------------------------------

export function signReminderEmail(c) {
  const d = c || {};
  const name = oneLine(d.clientName);
  const date = oneLine(d.eventDate);

  const subject = 'A quick reminder about your CaptureWithKi agreement';

  const text = [
    'Hi ' + name + ',',
    '',
    'Just a friendly note that your photography agreement for ' + date +
      ' is still waiting on your signature.',
    '',
    'You can find the link to review and sign it in the email we sent you ' +
      'titled "Your CaptureWithKi agreement is ready to sign." If you can\'t ' +
      'find it, just reply to this email and we will send it right over.',
    '',
    'Your date is not held until the agreement is signed and the retainer is paid.',
    '',
    'Khiara',
    'CaptureWithKi'
  ].join('\n');

  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.bg + ';padding:24px 0;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
          'style="background:' + C.paper + ';border:1px solid ' + C.line + ';padding:32px;">' +
          '<tr><td style="font-family:' + SERIF + ';font-size:22px;color:' + C.ink + ';">' +
            'Still waiting on your signature' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
            'Hi ' + escapeHtml(name) + ', just a friendly note that your photography ' +
            'agreement for ' + escapeHtml(date) + ' is still waiting on your signature.' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
            'You can find the link to review and sign it in the email we sent titled ' +
            '&ldquo;Your CaptureWithKi agreement is ready to sign.&rdquo; If you can&rsquo;t find it, ' +
            'just reply to this email and we will send it right over.' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + C.muted + ';padding-top:16px;">' +
            'Your date is not held until the agreement is signed and the retainer is paid.' +
          '</td></tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>';

  return { subject: subject, text: text, html: html };
}

export function payReminderEmail(c) {
  const d = c || {};
  const name = oneLine(d.clientName);
  const date = oneLine(d.eventDate);
  const retainer = formatCents(d.retainerCents);

  const subject = 'Your CaptureWithKi retainer is still outstanding';

  const text = [
    'Hi ' + name + ',',
    '',
    'Your agreement for ' + date + ' is signed, but the retainer of ' + retainer +
      ' has not come through yet.',
    '',
    'The payment link is on the same page you signed from — the email titled ' +
      '"Your signed CaptureWithKi agreement" has the link. If you can\'t find it, ' +
      'just reply to this email and we will send it right over.',
    '',
    'Your date is not yet held.',
    '',
    'Khiara',
    'CaptureWithKi'
  ].join('\n');

  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.bg + ';padding:24px 0;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
          'style="background:' + C.paper + ';border:1px solid ' + C.line + ';padding:32px;">' +
          '<tr><td style="font-family:' + SERIF + ';font-size:22px;color:' + C.ink + ';">' +
            'Your retainer is still outstanding' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
            'Hi ' + escapeHtml(name) + ', your agreement for ' + escapeHtml(date) +
            ' is signed, but the retainer of ' + escapeHtml(retainer) + ' has not come through yet.' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
            'The payment link is on the same page you signed from &mdash; the email titled ' +
            '&ldquo;Your signed CaptureWithKi agreement&rdquo; has the link. If you can&rsquo;t find it, ' +
            'just reply to this email and we will send it right over.' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:14px;font-weight:bold;color:' + C.ink + ';padding-top:16px;">' +
            'Your date is not yet held.' +
          '</td></tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>';

  return { subject: subject, text: text, html: html };
}

export function neverOpenedAlertEmail(c) {
  const d = c || {};
  const name = oneLine(d.clientName);
  const email = oneLine(d.clientEmail);
  const phone = oneLine(d.clientPhone) || 'not given';
  const sentAt = formatTimestamp(d.sentAt);
  const subject = oneLine(name) + ' has not opened their contract';

  const text = [
    name + '\'s contract email was sent on ' + sentAt + ' and has not been opened.',
    '',
    'Email: ' + email,
    'Phone: ' + phone,
    '',
    'The email may have been filed as spam — consider texting them.',
    '',
    DASHBOARD_URL
  ].join('\n');

  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.bg + ';padding:24px 0;"><tr><td align="center">' +
      '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
        'style="background:' + C.paper + ';border:1px solid ' + C.line + ';padding:32px;">' +
        '<tr><td style="font-family:' + SERIF + ';font-size:20px;color:' + C.ink + ';">' +
          escapeHtml(name) + ' has not opened their contract' +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
          'Sent ' + escapeHtml(sentAt) + '. Still unopened.' +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + C.muted + ';padding-top:16px;">' +
          escapeHtml(email) + '<br>' + escapeHtml(phone) +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:15px;font-weight:bold;color:' + C.ink + ';padding-top:16px;">' +
          'The email may have been filed as spam — consider texting them.' +
        '</td></tr>' +
        '<tr><td style="padding-top:24px;">' +
          '<a href="' + DASHBOARD_URL + '" style="font-family:' + SANS + ';font-size:15px;background:' +
            C.khaki + ';color:#fff;padding:12px 20px;text-decoration:none;display:inline-block;">' +
            'Open the dashboard</a>' +
        '</td></tr>' +
      '</table></td></tr></table>';

  return { subject: subject, text: text, html: html };
}

export function unpaidEscalationEmail(c) {
  const d = c || {};
  const name = oneLine(d.clientName);
  const email = oneLine(d.clientEmail);
  const phone = oneLine(d.clientPhone) || 'not given';
  const signedAt = formatTimestamp(d.signedAt);
  const amount = formatCents(d.retainerCents);
  const reminders = String(d.payReminderCount || 0);
  const subject = 'ACTION NEEDED: ' + oneLine(name) + ' signed but has not paid';

  const text = [
    name + ' signed their agreement on ' + signedAt + ' and the retainer is still unpaid.',
    '',
    'Retainer: ' + amount,
    'Email: ' + email,
    'Phone: ' + phone,
    'Reminders sent: ' + reminders,
    '',
    'THE DATE IS NOT HELD.',
    '',
    DASHBOARD_URL
  ].join('\n');

  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.bg + ';padding:24px 0;"><tr><td align="center">' +
      '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
        'style="background:' + C.paper + ';border:1px solid ' + C.line + ';padding:32px;">' +
        '<tr><td style="font-family:' + SERIF + ';font-size:20px;color:' + C.ink + ';">' +
          escapeHtml(name) + ' signed but has not paid' +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
          'Signed ' + escapeHtml(signedAt) + '. Retainer of ' + escapeHtml(amount) +
          ' is still outstanding after ' + escapeHtml(reminders) + ' reminder(s).' +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:15px;font-weight:bold;color:' + C.ink + ';padding-top:16px;">' +
          'The date is not held.' +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + C.muted + ';padding-top:16px;">' +
          escapeHtml(email) + '<br>' + escapeHtml(phone) +
        '</td></tr>' +
        '<tr><td style="padding-top:24px;">' +
          '<a href="' + DASHBOARD_URL + '" style="font-family:' + SANS + ';font-size:15px;background:' +
            C.khaki + ';color:#fff;padding:12px 20px;text-decoration:none;display:inline-block;">' +
            'Open the dashboard</a>' +
        '</td></tr>' +
      '</table></td></tr></table>';

  return { subject: subject, text: text, html: html };
}
