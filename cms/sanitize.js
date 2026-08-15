// Pasting from Notes, Google Docs or Word brings the source app's own styling
// along with the words — "make this black", "make this 16px", and once "make
// this white", which is how the first step of the Testimonials process ended
// up invisible against the cream background.
//
// That was never only a display glitch. edit-text.js stores innerHTML, so the
// foreign styling was saved to Firestore and served to every visitor.
//
// Three defences are built on this file, because the junk can arrive at three
// different moments:
//   1. on paste      — insert the words only, never the styling
//   2. on save       — clean whatever did get in, before it reaches Firestore
//   3. on render     — clean stored values on the way out, which repairs
//                      content already in the database without writing to it
//
// The rule is deliberately the narrowest one that fixes the problem: strip
// styling, never structure. The wedding packages' <li> bullets and the
// <span class="ll-heart">♡</span> beside "Love Letters" are legitimate stored
// markup, and a broader "strip all formatting" rule would have destroyed them.

// Elements that carry no text of their own and have no business in a content
// field. Clipboard HTML from Word and Google Docs routinely includes <style>
// and <meta> blocks.
const REMOVE_ENTIRELY = 'script,style,meta,link,base,title';

// Cheap pre-check. This runs over ~90 fields on every page load, and almost
// all of them are already clean.
const NEEDS_WORK = /\sstyle\s*=|\son\w+\s*=|<\s*(font|script|style|meta|link|base|title)\b/i;

export function sanitizeHtml(html) {
  if (typeof html !== 'string' || html.indexOf('<') === -1) return html;
  if (!NEEDS_WORK.test(html)) return html;

  // A detached document: nothing in here loads, fires or executes while we
  // work on it, unlike assigning to a live element's innerHTML.
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;

  doc.body.querySelectorAll(REMOVE_ENTIRELY).forEach(function (el) {
    el.remove();
  });

  doc.body.querySelectorAll('*').forEach(function (el) {
    // The actual bug: "color: rgb(255,255,255)" and friends.
    el.removeAttribute('style');
    // innerHTML will not run a <script>, but it will happily wire up an
    // onerror or onclick attribute. Her own writing never needs one.
    Array.prototype.slice.call(el.attributes).forEach(function (attr) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    });
  });

  // <font> is the same instruction in older clothing. Keep the words, drop
  // the wrapper. Each pass removes one element, so nesting resolves and the
  // loop always terminates.
  let font;
  while ((font = doc.body.querySelector('font'))) {
    const parent = font.parentNode;
    while (font.firstChild) parent.insertBefore(font.firstChild, font);
    parent.removeChild(font);
  }

  return doc.body.innerHTML;
}

// Runs of whitespace, including the non-breaking spaces Word likes to emit.
const WHITESPACE = /[\s ]+/g;

export function plainTextFromClipboard(e) {
  const data = e.clipboardData || window.clipboardData;
  if (!data) return '';
  const text = data.getData('text/plain') || '';
  // Words only, by choice. Line breaks collapse to single spaces so pasting
  // three paragraphs into a one-line heading cannot blow the layout apart.
  // Not trimmed: a leading or trailing space she copied on purpose survives.
  return text.replace(WHITESPACE, ' ');
}

function insertText(text) {
  // execCommand is deprecated but is still the only reliable way to insert
  // into a contenteditable while keeping the browser's own undo stack, and it
  // works on iOS Safari. edit-text.js already depends on it for the spacebar
  // fix, so this is consistent with the surrounding code rather than a new bet.
  try {
    if (document.execCommand('insertText', false, text)) return;
  } catch (err) {
    // fall through to the manual path
  }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function initPasteGuard() {
  document.addEventListener(
    'paste',
    function (e) {
      const target = e.target;
      if (!target || target.nodeType !== 1 || !target.closest) return;
      const el = target.closest('[contenteditable="true"]');
      if (!el) return;

      e.preventDefault();
      const text = plainTextFromClipboard(e);
      if (!text) return;
      insertText(text);
    },
    true
  );
}
