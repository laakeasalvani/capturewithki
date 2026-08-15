import { test } from 'node:test';
import assert from 'node:assert';
import { ownerEmail, clientEmail, ownerEmailHtml, clientEmailHtml, safeImageUrl } from '../lib/email.js';

const full = {
  name: 'Sarah', partnerName: 'Michael', email: 'sarah@example.com',
  phone: '8085550123', eventDate: '2026-09-12',
  sessionType: 'Engagement — $175', message: 'We met hiking.'
};

test('owner subject names both people when a partner is given', () => {
  assert.equal(ownerEmail(full).subject, 'New inquiry — Sarah & Michael');
});

test('owner subject names one person when no partner', () => {
  const one = Object.assign({}, full, { partnerName: '' });
  assert.equal(ownerEmail(one).subject, 'New inquiry — Sarah');
});

test('owner body contains every submitted field', () => {
  const t = ownerEmail(full).text;
  for (const v of ['Sarah', 'Michael', 'sarah@example.com', '8085550123',
                   '2026-09-12', 'Engagement — $175', 'We met hiking.']) {
    assert.ok(t.includes(v), 'missing ' + v);
  }
});

test('owner body marks empty optional fields rather than leaving a blank', () => {
  const sparse = { name: 'Sarah', partnerName: '', email: 'a@b.com',
                   phone: '1', eventDate: '', sessionType: 'Not sure yet', message: '' };
  const t = ownerEmail(sparse).text;
  assert.ok(t.includes('Not given'));
});

test('client email greets by first name and promises 48 hours', () => {
  const e = clientEmail(full);
  assert.ok(e.text.includes('Sarah'));
  assert.match(e.text, /48 hours/);
  assert.ok(e.text.includes('Khiara'));
});

test('client subject is the fixed thank-you line', () => {
  assert.equal(clientEmail(full).subject, 'Thank you for reaching out — CaptureWithKi');
});

test('a newline in the name cannot forge extra fields in the owner email', () => {
  const evil = { name: 'Sarah\nPhone:      555-000-9999', email: 'a@b.com',
                 phone: '8085550123', sessionType: 'x', partnerName: '', eventDate: '', message: '' };
  const t = ownerEmail(evil).text;
  const phoneLines = t.split('\n').filter(l => l.startsWith('Phone:'));
  assert.equal(phoneLines.length, 1, 'exactly one Phone line, got:\n' + t);
  assert.ok(phoneLines[0].includes('8085550123'));
});

test('a newline in the name cannot reach the subject', () => {
  const s = ownerEmail({ name: 'Sarah\nBcc: someone@evil.com', partnerName: '' }).subject;
  assert.ok(!s.includes('\n'), 'subject contains a newline: ' + JSON.stringify(s));
});

test("the couple's message keeps its line breaks", () => {
  const t = ownerEmail({ name: 'S', partnerName: '', email: 'a@b.com', phone: '1',
                         eventDate: '', sessionType: 'x',
                         message: 'Line one.\nLine two.' }).text;
  assert.ok(t.includes('Line one.\nLine two.'), 'message line breaks were stripped');
});

test('a leading space in the name still greets them properly', () => {
  assert.ok(clientEmail({ name: ' Sarah Connor' }).text.includes('Hi Sarah,'));
});

test('an empty or whitespace-only name falls back to a friendly greeting', () => {
  assert.ok(clientEmail({ name: '' }).text.includes('Hi there,'));
  assert.ok(clientEmail({ name: '   ' }).text.includes('Hi there,'));
});

test('clientEmail uses a saved template and substitutes the first name', () => {
  const e = clientEmail({ name: 'Sarah Chen' }, {
    clientSubject: 'Got your note!',
    clientBody: 'Hey {first_name},\n\nSpeak soon.\nK'
  });
  assert.equal(e.subject, 'Got your note!');
  assert.ok(e.text.includes('Hey Sarah,'));
  assert.ok(!e.text.includes('{first_name}'));
});

test('clientEmail falls back when the template is missing or empty', () => {
  const def = clientEmail({ name: 'Sarah Chen' });
  assert.match(def.text, /48 hours/);
  const empty = clientEmail({ name: 'Sarah Chen' }, { clientSubject: '', clientBody: '   ' });
  assert.equal(empty.subject, def.subject);
  assert.equal(empty.text, def.text);
});

test('a saved subject cannot smuggle a newline', () => {
  const e = clientEmail({ name: 'Sarah' }, {
    clientSubject: 'Hello\nBcc: someone@evil.com',
    clientBody: 'Hi {first_name}'
  });
  assert.ok(!e.subject.includes('\n'));
});

test('a saved body keeps its line breaks', () => {
  const e = clientEmail({ name: 'Sarah' }, { clientBody: 'One\n\nTwo' });
  assert.ok(e.text.includes('One\n\nTwo'));
});

test('every occurrence of the token is replaced', () => {
  const e = clientEmail({ name: 'Sarah' }, { clientBody: '{first_name} {first_name}' });
  assert.equal(e.text, 'Sarah Sarah');
});

test('a non-object template is ignored rather than throwing', () => {
  for (const bad of [null, 'x', 42, [], undefined]) {
    const e = clientEmail({ name: 'Sarah' }, bad);
    assert.match(e.text, /48 hours/);
  }
});

// --- HTML versions -------------------------------------------------------

test('both emails carry the site palette and its own font fallbacks', () => {
  for (const html of [ownerEmailHtml(full), clientEmailHtml(full, null, '')]) {
    assert.ok(html.includes('#F2ECE0'), 'cream background missing');
    assert.ok(html.includes('#6E7C5C'), 'khaki missing');
    assert.ok(html.includes('#FAF6EE'), 'paper missing');
    assert.match(html, /Georgia|Helvetica/, 'site font fallbacks missing');
  }
});

test('client html greets by first name and keeps her wording', () => {
  const html = clientEmailHtml(full, null, '');
  assert.ok(html.includes('Sarah'));
  assert.match(html, /48 hours/);
  assert.ok(html.includes('CaptureWithKi'));
});

test('client html uses the saved template when there is one', () => {
  const html = clientEmailHtml(full, { clientBody: 'Aloha {first_name}, so glad you wrote.' }, '');
  assert.ok(html.includes('Aloha Sarah, so glad you wrote.'));
  assert.ok(!html.includes('48 hours'), 'fell back to the default body');
});

test('a client cannot inject markup through their name or message', () => {
  const nasty = Object.assign({}, full, {
    name: '<script>alert(1)</script>Mallory',
    message: '</td></tr></table><img src=x onerror=alert(2)>'
  });
  for (const html of [ownerEmailHtml(nasty), clientEmailHtml(nasty, null, '')]) {
    assert.ok(!/<script/i.test(html), 'raw script tag survived');
    assert.ok(!/<img/i.test(html), 'raw img tag survived');
    // The characters "onerror=" may well appear as visible text — that is
    // correct, it is what the sender typed and the owner should see it
    // verbatim. What must never happen is it becoming a real attribute on a
    // real tag.
    assert.ok(!/<[^>]*\son\w+\s*=/i.test(html), 'an event handler attribute survived');
    assert.ok(html.includes('&lt;script&gt;'), 'escaped rather than silently dropped');
  }
});

test('banner is included only for a Storage url on this project', () => {
  const ours = 'https://firebasestorage.googleapis.com/v0/b/capturewithki-69dd3.firebasestorage.app/o/uploads%2Fx.jpg?alt=media&token=abc';
  assert.ok(clientEmailHtml(full, null, ours).includes('<img src="' + ours + '"'));

  for (const bad of ['https://evil.example.com/tracker.gif', 'http://firebasestorage.googleapis.com/v0/b/capturewithki-69dd3.x/o/a.jpg',
                     'https://firebasestorage.googleapis.com/v0/b/someone-else/o/a.jpg', '', null, undefined, 42]) {
    assert.ok(!clientEmailHtml(full, null, bad).includes('<img'), 'embedded ' + bad);
  }
});

test('a url carrying a quote cannot break out of the src attribute', () => {
  const sneaky = 'https://firebasestorage.googleapis.com/v0/b/capturewithki-69dd3."onload="alert(1)';
  assert.equal(safeImageUrl(sneaky), '');
  assert.ok(!clientEmailHtml(full, null, sneaky).includes('<img'));
});

test('no photo set leaves no broken image frame', () => {
  const html = clientEmailHtml(full, null, '');
  assert.ok(!html.includes('<img'), 'rendered an image tag with no photo');
  assert.ok(html.includes('CaptureWithKi'), 'email still complete without a photo');
});

test('her paragraph breaks survive into html', () => {
  const html = clientEmailHtml(full, { clientBody: 'One.\n\nTwo.\n\nThree.' }, '');
  assert.equal((html.match(/<p style=/g) || []).length, 3);
});

test('owner html lists every field and marks the empty ones', () => {
  const sparse = { name: 'Sarah', partnerName: '', email: 'a@b.com', phone: '1',
                   eventDate: '', sessionType: 'Not sure yet', message: '' };
  const html = ownerEmailHtml(sparse);
  for (const label of ['Name', 'Partner', 'Email', 'Phone', 'Date', 'Session']) {
    assert.ok(html.includes(label), 'missing ' + label);
  }
  assert.ok(html.includes('Not given'));
});

test('owner html carries no photo, by design', () => {
  assert.ok(!ownerEmailHtml(full).includes('<img'));
});

test('plain text is still produced for both emails', () => {
  assert.ok(ownerEmail(full).text.length > 0);
  assert.ok(clientEmail(full).text.length > 0);
});

test('html declares utf-8 so em dashes and apostrophes are not mangled', () => {
  for (const html of [ownerEmailHtml(full), clientEmailHtml(full, null, '')]) {
    assert.match(html, /<meta charset="utf-8">/i);
  }
});

test('curly punctuation survives into the html body', () => {
  const html = clientEmailHtml(full, { clientBody: 'Hi {first_name} — it’s lovely to hear from you.' }, '');
  assert.ok(html.includes('—'), 'em dash lost');
  assert.ok(html.includes('’'), 'curly apostrophe lost');
});

test('the card shrinks to a phone instead of forcing sideways scroll', () => {
  for (const html of [ownerEmailHtml(full), clientEmailHtml(full, null, '')]) {
    // width:600px would push the layout viewport past a 375px screen; the
    // cap has to be max-width. width="600" stays for Outlook, which ignores CSS.
    assert.ok(html.includes('style="width:100%;max-width:600px'), 'card is not responsive');
    assert.ok(!html.includes('width:600px;max-width:100%'), 'the fixed-width form came back');
    assert.ok(html.includes('width="600"'), 'Outlook fallback width missing');
  }
});

test('the banner scales down with the card', () => {
  const ours = 'https://firebasestorage.googleapis.com/v0/b/capturewithki-69dd3.firebasestorage.app/o/uploads%2Fx.jpg?alt=media&token=abc';
  const html = clientEmailHtml(full, null, ours);
  assert.match(html, /width:100%;max-width:600px;height:auto/);
});

test('the banner carries alt text for readers who block images', () => {
  const ours = 'https://firebasestorage.googleapis.com/v0/b/capturewithki-69dd3.firebasestorage.app/o/uploads%2Fx.jpg?alt=media&token=abc';
  assert.match(clientEmailHtml(full, null, ours), /alt="A photograph by Khiara Salvani"/);
});
