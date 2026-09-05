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

// A Date is the natural type for "when this was signed" (contracts.js and
// Firestore both deal in real timestamps), but oneLine() must still see a
// string. toISOString() is used rather than toLocaleString() so the result
// does not depend on the server's timezone or locale, and rather than a
// bespoke formatter that could throw on an unexpected input.
function formatSignedAt(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return oneLine(v);
}

export function signedCopyEmail(o) {
  const d = o || {};
  const name = oneLine(d.clientName);
  const url = oneLine(d.contractUrl);
  const signedAt = formatSignedAt(d.signedAt);

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
