// Contact-form backend for Kea Web Creations (laakeasalvani.github.io/kea-web-creations).
//
// Kea is a static single-file site on GitHub Pages, so it has nowhere to keep
// a Resend API key — anyone could read it out of index.html. The key lives in
// this project's RESEND_API_KEY secret instead, and the site posts to the
// keaInquiry function in index.js.
//
// This file rides along inside the CaptureWithKi Firebase project purely
// because that project already has Blaze billing and the Resend secret. Kea
// and CaptureWithKi share NOTHING else: separate Firestore collection,
// separate owner inbox, separate templates, separate rate-limit buckets.

import { escapeHtml, sendEmail } from './email.js';

export const KEA_OWNER_EMAIL = 'keawebcreations@gmail.com';

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE LINE TO CHANGE WHEN THE KEA DOMAIN IS BOUGHT AND VERIFIED
//
// Resend will only send from a domain it has verified, and the free plan
// allows three of them. Right now capturewithki.com is the only verified
// domain on the account, so Kea borrows it: the display name reads correctly
// ("Kea Web Creations"), but the underlying address is a CaptureWithKi one,
// which a sharp-eyed prospect can see in the auto-reply.
//
// Once keawebcreations.com (or whatever domain gets bought) is added under
// Resend → Domains and its DNS records verify, change this to
//   'Kea Web Creations <hello@keawebcreations.com>'
// and redeploy. Nothing else in the codebase needs to move.
// ─────────────────────────────────────────────────────────────────────────────
export const KEA_FROM = 'Kea Web Creations <hello@capturewithki.com>';

const MAX = { name: 200, email: 320, phone: 50, website: 300, interest: 200, message: 5000 };

// These strings are shown to real visitors, so they read as words rather than
// as field names.
const LABEL = {
  name: 'name',
  email: 'email',
  phone: 'phone number',
  website: 'website',
  interest: 'selection',
  message: 'message'
};

// Returns a trimmed string, or null if the value is not a usable scalar.
// Deliberately does NOT call String() on objects or arrays: the payload
// arrives as parsed JSON from the open internet, and String() on a deeply
// nested array overflows the stack. Same guard as lib/validate.js.
function str(v) {
  if (v === undefined || v === null) return '';
  const t = typeof v;
  if (t === 'string') return v.trim();
  if (t === 'number' || t === 'boolean') return String(v).trim();
  return null;
}

export function validateKeaInquiry(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, error: 'That submission did not look right. Please try again.' };
  }

  const value = {};
  for (const key of Object.keys(MAX)) {
    const s = str(data[key]);
    if (s === null) {
      return { valid: false, error: 'That ' + LABEL[key] + ' did not look right. Please try again.' };
    }
    value[key] = s;
  }

  for (const key of Object.keys(MAX)) {
    if (value[key].length > MAX[key]) {
      return { valid: false, error: 'That ' + LABEL[key] + ' is too long.' };
    }
  }

  if (!value.name) return { valid: false, error: 'Please add your name.' };
  if (!value.email) return { valid: false, error: 'Please add your email.' };
  // Deliberately permissive: one @, no spaces, a dot in the domain. Anything
  // stricter rejects real addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { valid: false, error: 'That email address does not look right.' };
  }
  // Phone, website, interest and message are all optional: the form on the
  // site only marks name and email required, and a backend that demands more
  // than the form does produces an error the visitor cannot act on.

  return { valid: true, value: value };
}

// Strip CR/LF from single-line fields so a crafted value cannot forge extra
// labelled lines in the owner's email, or smuggle a newline into a Subject.
// The message body is deliberately NOT stripped: real people write
// paragraphs, and it is the last section, so it cannot fake a field above it.
function oneLine(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\r\n]+/g, ' ');
}

function orNone(v) {
  const s = oneLine(v).trim();
  return s ? s : 'Not given';
}

// ─── Plain text ──────────────────────────────────────────────────────────────
// Sent alongside every HTML email, never instead of it: HTML-only mail is
// penalised by spam filters and unreadable to anyone reading in plain text.

export function keaOwnerEmail(i) {
  return {
    subject: 'New enquiry — ' + oneLine(i.name).trim(),
    text: [
      'New enquiry from the Kea Web Creations contact form.',
      '',
      'Name:      ' + orNone(i.name),
      'Email:     ' + orNone(i.email),
      'Phone:     ' + orNone(i.phone),
      'Website:   ' + orNone(i.website),
      'Interest:  ' + orNone(i.interest),
      '',
      'Message:',
      String(i.message || '').trim() || 'Not given',
      '',
      '---',
      'Hit reply to answer them directly.'
    ].join('\n')
  };
}

export function keaClientEmail(i) {
  const first = oneLine(i.name).trim().split(' ')[0] || 'there';
  return {
    subject: 'Thanks for getting in touch — Kea Web Creations',
    text: [
      'Hi ' + first + ',',
      '',
      'Thanks for reaching out. Your message came through and I have read it.',
      '',
      'I reply to every enquiry personally, usually within one business day.',
      'When I do, I will ask a couple of questions about what you are trying',
      'to build and by when, so I can give you a straight answer on scope,',
      'timeline and cost.',
      '',
      'If anything is urgent in the meantime, call or text (808) 306-8792.',
      '',
      'Talk soon,',
      'Laakea',
      'Kea Web Creations'
    ].join('\n')
  };
}

// ─── HTML ────────────────────────────────────────────────────────────────────
// Constraints, none of them negotiable:
//   - Custom fonts are stripped by Gmail, Outlook and Apple Mail. The stacks
//     below are the Kea site's OWN fallbacks from index.html's :root, so this
//     is what a visitor already sees when the webfonts fail — not a guess.
//   - No <style> block and no classes: Gmail strips the head. Everything is
//     inline, and layout is tables, because Outlook renders with Word.
//   - No images at all, so nothing breaks when a client blocks them.

// Design tokens, copied from ~/pacific-web-design/index.html :root.
const C = {
  bar: '#16203D',
  accent: '#58B0A8',
  ink: '#1B2233',
  soft: '#5C6577',
  paper: '#FFFFFF',
  sand: '#F6F4F0',
  line: '#E5E1DA'
};
const SERIF = "Georgia, 'Times New Roman', Times, serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// The plain-text emails can pass a stranger's name and message through
// untouched, because text cannot be markup. In HTML it can — everything
// interpolated below goes through escapeHtml first.
function shell(inner) {
  return '<!doctype html><html><body style="margin:0;padding:0;background:' + C.sand + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="background:' + C.sand + ';padding:28px 12px;">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="max-width:560px;background:' + C.paper + ';border:1px solid ' + C.line + ';">' +
    '<tr><td style="background:' + C.bar + ';padding:22px 28px;">' +
      '<div style="font-family:' + SERIF + ';font-size:23px;color:#ffffff;">Kea<span style="color:' + C.accent + ';">.</span></div>' +
      '<div style="font-family:' + SANS + ';font-size:10px;letter-spacing:2.4px;text-transform:uppercase;color:rgba(255,255,255,.72);padding-top:5px;">Web Creations</div>' +
    '</td></tr>' +
    inner +
    '<tr><td style="padding:18px 28px 24px;border-top:1px solid ' + C.line + ';">' +
      '<div style="font-family:' + SANS + ';font-size:11px;line-height:1.7;color:' + C.soft + ';">' +
        'Kea Web Creations &nbsp;&middot;&nbsp; Beaverton, Oregon<br>' +
        '(808) 306-8792' +
      '</div>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function row(label, value) {
  return '<tr>' +
    '<td style="padding:9px 0;border-bottom:1px solid ' + C.line + ';font-family:' + SANS + ';' +
      'font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:' + C.soft + ';' +
      'white-space:nowrap;vertical-align:top;width:96px;">' + escapeHtml(label) + '</td>' +
    '<td style="padding:9px 0 9px 14px;border-bottom:1px solid ' + C.line + ';font-family:' + SANS + ';' +
      'font-size:14px;line-height:1.6;color:' + C.ink + ';">' + escapeHtml(value) + '</td>' +
    '</tr>';
}

export function keaOwnerEmailHtml(i) {
  // A mailto: on the sender's address is a convenience only — the email is
  // also sent with reply_to set, so plain Reply already goes to them.
  const emailCell = orNone(i.email);
  const inner = '<tr><td style="padding:26px 28px 8px;">' +
    '<div style="font-family:' + SERIF + ';font-size:20px;color:' + C.ink + ';padding-bottom:4px;">New enquiry</div>' +
    '<div style="font-family:' + SANS + ';font-size:13px;color:' + C.soft + ';padding-bottom:16px;">From the contact form on the Kea site.</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
      row('Name', orNone(i.name)) +
      row('Email', emailCell) +
      row('Phone', orNone(i.phone)) +
      row('Website', orNone(i.website)) +
      row('Interest', orNone(i.interest)) +
    '</table>' +
    '<div style="font-family:' + SANS + ';font-size:10px;letter-spacing:1.6px;text-transform:uppercase;' +
      'color:' + C.soft + ';padding:20px 0 8px;">Message</div>' +
    '<div style="font-family:' + SANS + ';font-size:14px;line-height:1.75;color:' + C.ink + ';' +
      'background:' + C.sand + ';border-left:2px solid ' + C.accent + ';padding:14px 16px;white-space:pre-wrap;">' +
      escapeHtml(String(i.message || '').trim() || 'Not given') +
    '</div>' +
    '<div style="font-family:' + SANS + ';font-size:12px;color:' + C.soft + ';padding:16px 0 4px;">' +
      'Hit reply to answer them directly.</div>' +
    '</td></tr>';
  return shell(inner);
}

export function keaClientEmailHtml(i) {
  const first = escapeHtml(oneLine(i.name).trim().split(' ')[0] || 'there');
  const p = 'font-family:' + SANS + ';font-size:14px;line-height:1.8;color:' + C.ink + ';padding-bottom:14px;';
  const inner = '<tr><td style="padding:26px 28px 10px;">' +
    '<div style="font-family:' + SERIF + ';font-size:20px;color:' + C.ink + ';padding-bottom:16px;">Thanks for getting in touch</div>' +
    '<div style="' + p + '">Hi ' + first + ',</div>' +
    '<div style="' + p + '">Thanks for reaching out. Your message came through and I have read it.</div>' +
    '<div style="' + p + '">I reply to every enquiry personally, usually within one business day. When I do, ' +
      'I will ask a couple of questions about what you are trying to build and by when, so I can give you ' +
      'a straight answer on scope, timeline and cost.</div>' +
    '<div style="' + p + '">If anything is urgent in the meantime, call or text ' +
      '<a href="tel:+18083068792" style="color:' + C.accent + ';">(808) 306-8792</a>.</div>' +
    '<div style="' + p + 'padding-bottom:2px;">Talk soon,<br>Laakea</div>' +
    '</td></tr>';
  return shell(inner);
}

// Thin wrapper so callers never forget the Kea sender and end up mailing a
// web-design prospect from the photography brand.
export function sendKeaEmail(opts) {
  return sendEmail(Object.assign({}, opts, { from: KEA_FROM }));
}
