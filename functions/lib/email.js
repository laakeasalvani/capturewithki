// Resend's shared "onboarding" sandbox sender is test-only: it can deliver
// ONLY to the email address on the Resend account, and any other recipient
// gets a 403. The client thank-you email must reach real couples, so this
// uses the owner's own domain instead. Sending will only work once
// capturewithki.com is added and verified in the Resend dashboard.
const FROM = 'CaptureWithKi <hello@capturewithki.com>';

// Strip CR/LF from single-line fields so a crafted value cannot forge extra
// labelled lines in the owner's email, or smuggle a newline into Subject.
// The message body is deliberately NOT stripped: real couples write
// paragraphs, and it is the last section, so it cannot fake a field above it.
function oneLine(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\r\n]+/g, ' ');
}

function orNone(v) {
  const s = oneLine(v).trim();
  return s ? s : 'Not given';
}

function orNoneMultiline(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s ? s : 'Not given';
}

// ---------------------------------------------------------------------------
// HTML versions
//
// Both emails keep their plain-text body and gain an HTML one beside it.
// HTML-only mail is penalised by spam filters and unreadable to anyone whose
// client is set to plain text, so `text` is never dropped.
//
// Constraints that shaped everything below, none of them negotiable:
//   - Custom fonts are stripped by Gmail, Outlook and Apple Mail. The stacks
//     here are the site's OWN fallbacks from index.html's :root, so this is
//     what a visitor already sees when the webfonts fail — not a guess.
//   - No <style> block and no classes: Gmail strips the head. Everything is
//     inline, and layout is tables, because Outlook renders with Word.
//   - Images are blocked by default in many clients, so nothing structural may
//     depend on the banner and it carries alt text.
// ---------------------------------------------------------------------------

// Site tokens, copied from index.html :root.
const C = {
  bg: '#F2ECE0',
  paper: '#FAF6EE',
  ink: '#171614',
  muted: '#6B6560',
  line: '#DCD0BC',
  khaki: '#6E7C5C'
};
const SERIF = "Georgia, 'Times New Roman', Times, serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// The plain-text emails could pass a stranger's name and message through
// untouched, because text cannot be markup. In HTML it can.
export function escapeHtml(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only a Storage URL belonging to this project may be embedded. The value
// comes from Firestore and only an admin can write it, but an <img src>
// pointing elsewhere would leak the reader's IP address to a third party the
// owner never chose.
export function safeImageUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/capturewithki-69dd3\./.test(trimmed)) return '';
  // A quote or angle bracket would break out of the attribute even after the
  // host check passes.
  if (/["'<>\s]/.test(trimmed)) return '';
  return trimmed;
}

// Her template is plain text she typed. Preserve her paragraph breaks without
// trusting the content: escape first, then rebuild the breaks.
function textToParagraphs(text, style) {
  return String(text)
    .split(/\n\s*\n/)
    .map(function (block) { return block.trim(); })
    .filter(function (block) { return block.length > 0; })
    .map(function (block) {
      return '<p style="' + style + '">' + escapeHtml(block).split('\n').join('<br>') + '</p>';
    })
    .join('');
}

function shell(inner) {
  // The charset declaration is not optional. Without it her em dashes and
  // curly apostrophes arrive as "â€”" — caught rendering this for review.
  return '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '</head>' +
    '<body style="margin:0;padding:0;background:' + C.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="background:' + C.bg + ';margin:0;padding:0;">' +
      '<tr><td align="center" style="padding:28px 12px;">' +
        // width="600" is for Outlook, which ignores CSS max-width. Everywhere
        // else the CSS governs: width:100% lets it shrink to a phone, capped
        // at 600. Stated the other way round (width:600px;max-width:100%) the
        // hard 600 pushes the layout viewport wider than the screen and the
        // reader has to pinch and scroll sideways — which is exactly what it
        // did before this was caught on a 375px render.
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" ' +
          'style="width:100%;max-width:600px;background:' + C.paper + ';">' +
          inner +
        '</table>' +
      '</td></tr>' +
    '</table>' +
    '</body></html>';
}

function wordmark() {
  return '<tr><td align="center" style="padding:28px 32px 0;">' +
    '<div style="font-family:' + SERIF + ';font-style:italic;font-size:30px;' +
      'letter-spacing:.02em;color:' + C.khaki + ';">CaptureWithKi</div>' +
    '</td></tr>';
}

function rule() {
  return '<tr><td style="padding:20px 32px 0;">' +
    '<div style="height:1px;background:' + C.line + ';font-size:0;line-height:0;">&nbsp;</div>' +
    '</td></tr>';
}

function footer() {
  return '<tr><td align="center" style="padding:26px 32px 32px;">' +
    '<div style="font-family:' + SANS + ';font-size:11px;letter-spacing:.16em;' +
      'text-transform:uppercase;color:' + C.muted + ';">' +
      'capturewithki.com &nbsp;&middot;&nbsp; @capturewithki' +
    '</div></td></tr>';
}

export function clientEmailHtml(i, template, imageUrl) {
  const first = oneLine(i && i.name).trim().split(' ')[0] || 'there';
  const t = (template && typeof template === 'object' && !Array.isArray(template)) ? template : {};
  const rawBody = typeof t.clientBody === 'string' ? t.clientBody.trim() : '';
  const body = (rawBody || DEFAULT_CLIENT_BODY).split('{first_name}').join(first);

  const src = safeImageUrl(imageUrl);
  // No photo set, or one that failed the check: skip the banner rather than
  // leave an empty frame in a client's inbox.
  const banner = src
    ? '<tr><td style="padding:0;">' +
        '<img src="' + src + '" width="600" alt="A photograph by Khiara Salvani" ' +
          'style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;">' +
      '</td></tr>'
    : '';

  const paragraphs = textToParagraphs(body,
    'margin:0 0 16px;font-family:' + SANS + ';font-size:15px;line-height:1.85;color:' + C.muted + ';');

  return shell(
    banner +
    wordmark() +
    rule() +
    '<tr><td style="padding:24px 32px 4px;">' + paragraphs + '</td></tr>' +
    footer()
  );
}

export function ownerEmailHtml(i) {
  const rows = [
    ['Name', orNone(i.name)],
    ['Partner', orNone(i.partnerName)],
    ['Email', orNone(i.email)],
    ['Phone', orNone(i.phone)],
    ['Date', orNone(i.eventDate)],
    ['Session', orNone(i.sessionType)]
  ].map(function (pair) {
    return '<tr>' +
      '<td style="padding:7px 14px 7px 0;font-family:' + SANS + ';font-size:11px;' +
        'letter-spacing:.16em;text-transform:uppercase;color:' + C.muted + ';' +
        'white-space:nowrap;vertical-align:top;">' + escapeHtml(pair[0]) + '</td>' +
      '<td style="padding:7px 0;font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';">' +
        escapeHtml(pair[1]) + '</td>' +
    '</tr>';
  }).join('');

  // No photo here by choice: this is a work alert she scans on a phone, and a
  // banner would push the details she actually needs below the fold.
  return shell(
    '<tr><td style="padding:18px 32px;background:' + C.khaki + ';">' +
      '<div style="font-family:' + SANS + ';font-size:12px;letter-spacing:.2em;' +
        'text-transform:uppercase;color:' + C.paper + ';">New inquiry</div>' +
    '</td></tr>' +
    '<tr><td style="padding:24px 32px 0;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0">' + rows + '</table>' +
    '</td></tr>' +
    rule() +
    '<tr><td style="padding:20px 32px 0;">' +
      '<div style="font-family:' + SANS + ';font-size:11px;letter-spacing:.16em;' +
        'text-transform:uppercase;color:' + C.muted + ';padding-bottom:8px;">Message</div>' +
      textToParagraphs(orNoneMultiline(i.message),
        'margin:0 0 14px;font-family:' + SANS + ';font-size:15px;line-height:1.8;color:' + C.ink + ';') +
    '</td></tr>' +
    '<tr><td style="padding:6px 32px 30px;">' +
      '<div style="font-family:' + SANS + ';font-size:13px;line-height:1.7;color:' + C.muted + ';">' +
        'Reply to this email to answer them directly.</div>' +
    '</td></tr>'
  );
}

export function ownerEmail(i) {
  const name = oneLine(i.name).trim();
  const partner = oneLine(i.partnerName).trim();
  const who = partner ? name + ' & ' + partner : name;
  const text = [
    'New inquiry from the CaptureWithKi contact form.',
    '',
    'Name:       ' + orNone(i.name),
    'Partner:    ' + orNone(i.partnerName),
    'Email:      ' + orNone(i.email),
    'Phone:      ' + orNone(i.phone),
    'Date:       ' + orNone(i.eventDate),
    'Session:    ' + orNone(i.sessionType),
    '',
    'Message:',
    orNoneMultiline(i.message),
    '',
    'Reply to this email to answer them directly.'
  ].join('\n');
  return { subject: 'New inquiry — ' + who, text: text };
}

const DEFAULT_CLIENT_SUBJECT = 'Thank you for reaching out — CaptureWithKi';
const DEFAULT_CLIENT_BODY = [
  'Hi {first_name},',
  '',
  'Thank you so much for reaching out — your inquiry came through and I have it.',
  '',
  'I will get back to you within 48 hours.',
  '',
  'Talk soon,',
  'Khiara',
  'CaptureWithKi'
].join('\n');

export function clientEmail(i, template) {
  const first = oneLine(i.name).trim().split(' ')[0] || 'there';

  // A saved template is optional. Anything that is not a plain object, or
  // whose fields are blank, falls back to the wording above — a couple must
  // always receive something sensible.
  const t = (template && typeof template === 'object' && !Array.isArray(template)) ? template : {};
  const rawSubject = typeof t.clientSubject === 'string' ? t.clientSubject.trim() : '';
  const rawBody = typeof t.clientBody === 'string' ? t.clientBody.trim() : '';

  // The subject is a mail header, so it must never carry a line break.
  // The body is free text and keeps hers.
  const subject = oneLine(rawSubject || DEFAULT_CLIENT_SUBJECT).trim();
  const text = (rawBody || DEFAULT_CLIENT_BODY).split('{first_name}').join(first);

  return { subject: subject, text: text };
}

export async function sendEmail(opts) {
  const body = {
    // Defaults to the CaptureWithKi sender. lib/kea.js passes its own so the
    // Kea Web Creations form does not mail web-design prospects from the
    // photography brand — every existing caller omits it and is unaffected.
    from: opts.from || FROM,
    // A single address stays a single address; the alarm in lib/escalate.js
    // needs several, and Resend takes an array either way. Wrapping an array
    // that arrived already-wrapped would nest it and Resend would reject the
    // whole send.
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    text: opts.text
  };
  // Sent alongside the text, never instead of it: HTML-only mail is penalised
  // by spam filters, and some people read everything as plain text.
  if (opts.html) body.html = opts.html;
  if (opts.replyTo) body.reply_to = [opts.replyTo];

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + opts.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    // Without a timeout, a hung Resend request would stall this Cloud
    // Function until its own platform timeout, burning billed time while
    // the visitor waits on a response that never comes.
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    // Resend explains refusals in the response body. Include it — but never
    // the API key and never the request we sent.
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (e) {
      detail = '(no body)';
    }
    throw new Error('Resend responded ' + res.status + ': ' + detail);
  }
}
