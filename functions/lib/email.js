// Resend's shared "onboarding" sandbox sender is test-only: it can deliver
// ONLY to the email address on the Resend account, and any other recipient
// gets a 403. The client thank-you email must reach real couples, so this
// uses the owner's own domain instead. Sending will only work once
// capturewithki.com is added and verified in the Resend dashboard.
const FROM = 'CaptureWithKi <hello@capturewithki.com>';

function orNone(v) {
  return v && String(v).trim() ? String(v) : 'Not given';
}

export function ownerEmail(i) {
  const who = i.partnerName ? i.name + ' & ' + i.partnerName : i.name;
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
    orNone(i.message),
    '',
    'Reply to this email to answer them directly.'
  ].join('\n');
  return { subject: 'New inquiry — ' + who, text: text };
}

export function clientEmail(i) {
  const first = String(i.name || '').split(' ')[0] || 'there';
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
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    // Deliberately does NOT include the request body or key in the message.
    throw new Error('Resend responded ' + res.status);
  }
}
