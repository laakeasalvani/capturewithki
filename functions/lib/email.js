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

export function clientEmail(i) {
  const first = oneLine(i.name).trim().split(' ')[0] || 'there';
  const text = [
    'Hi ' + first + ',',
    '',
    'Thank you so much for reaching out — your inquiry came through and I have it.',
    '',
    'I will get back to you within 48 hours.',
    '',
    'Talk soon,',
    'Khiara',
    'CaptureWithKi'
  ].join('\n');
  return { subject: 'Thank you for reaching out — CaptureWithKi', text: text };
}

export async function sendEmail(opts) {
  const body = {
    from: FROM,
    to: [opts.to],
    subject: opts.subject,
    text: opts.text
  };
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
