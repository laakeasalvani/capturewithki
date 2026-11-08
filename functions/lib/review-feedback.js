// Backend for the review page at /review/.
//
// A client who picks 1-3 stars is offered a form that reaches Khiara directly.
// (They are also offered the Google link: see review/index.html for why that
// link must stay.) Feedback is stored as an inquiry with kind 'review-feedback',
// so it appears in her dashboard and is covered by the unseen-inquiry alarm.
// An email alone can land in spam without anything noticing; see CLAUDE.md.

import { escapeHtml, C, SERIF, SANS } from './email.js';

const MAX = { name: 200, email: 320, message: 5000 };

const LABEL = { name: 'name', email: 'email', message: 'feedback' };

// Same guard as lib/validate.js: never String() an object or array from the
// open internet, because a deeply nested array overflows the stack.
function str(v) {
  if (v === undefined || v === null) return '';
  const t = typeof v;
  if (t === 'string') return v.trim();
  if (t === 'number' || t === 'boolean') return String(v).trim();
  return null;
}

export function validateReviewFeedback(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, error: 'That submission did not look right. Please try again.' };
  }

  const value = {};
  for (const key of Object.keys(MAX)) {
    const s = str(data[key]);
    if (s === null) {
      return { valid: false, error: 'That ' + LABEL[key] + ' did not look right. Please try again.' };
    }
    if (s.length > MAX[key]) {
      return { valid: false, error: 'That ' + LABEL[key] + ' is too long.' };
    }
    value[key] = s;
  }

  if (!Number.isInteger(data.rating) || data.rating < 1 || data.rating > 5) {
    return { valid: false, error: 'Please choose a star rating.' };
  }
  value.rating = data.rating;

  // Name and email are optional on the form. The dashboard and the alarm both
  // lead with the name, so a blank one still needs to read as something.
  if (!value.name) value.name = 'Anonymous';
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { valid: false, error: 'That email address does not look right.' };
  }
  if (!value.message) return { valid: false, error: 'Please add your feedback.' };

  return { valid: true, value: value };
}

// A crafted name must not be able to add a line to the Subject or the text body.
function oneLine(v) {
  return String(v).replace(/[\r\n]+/g, ' ').trim();
}

function starWord(n) {
  return n + (n === 1 ? ' star' : ' stars');
}

export function reviewFeedbackEmail(f) {
  return {
    subject: starWord(f.rating) + ' feedback — ' + oneLine(f.name),
    text: [
      'Feedback from your review page.',
      '',
      'Rating:  ' + starWord(f.rating),
      'Name:    ' + oneLine(f.name),
      'Email:   ' + (oneLine(f.email) || 'Not given'),
      '',
      'Feedback:',
      f.message,
      '',
      f.email ? 'Reply to this email to answer them directly.' : 'They did not leave an email address.'
    ].join('\n')
  };
}

export function reviewFeedbackEmailHtml(f) {
  const row = function (label, value) {
    return '<tr>' +
      '<td style="padding:7px 14px 7px 0;font-family:' + SANS + ';font-size:11px;letter-spacing:.16em;' +
        'text-transform:uppercase;color:' + C.muted + ';vertical-align:top;">' + label + '</td>' +
      '<td style="padding:7px 0;font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';">' +
        escapeHtml(value) + '</td></tr>';
  };
  return '<!doctype html><html><body style="margin:0;padding:24px 12px;background:' + C.bg + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="max-width:560px;margin:0 auto;background:' + C.paper + ';border:1px solid ' + C.line + ';">' +
    '<tr><td style="padding:18px 28px;background:' + C.khaki + ';font-family:' + SERIF + ';font-size:20px;color:' + C.paper + ';">' +
      'Feedback from your review page</td></tr>' +
    '<tr><td style="padding:20px 28px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">' +
      row('Rating', starWord(f.rating)) + row('Name', oneLine(f.name)) + row('Email', oneLine(f.email) || 'Not given') +
    '</table></td></tr>' +
    '<tr><td style="padding:18px 28px 8px;font-family:' + SANS + ';font-size:15px;line-height:1.8;color:' + C.ink + ';white-space:pre-wrap;">' +
      escapeHtml(f.message) + '</td></tr>' +
    '<tr><td style="padding:8px 28px 26px;font-family:' + SANS + ';font-size:13px;color:' + C.muted + ';">' +
      (f.email ? 'Reply to this email to answer them directly.' : 'They did not leave an email address.') + '</td></tr>' +
    '</table></body></html>';
}
