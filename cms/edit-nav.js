import { onEditingChange } from './auth.js';

// The menu tabs are links, and a link's job is to navigate. Trying to make one
// mean "go there" and "let me type in it" depending on a mode was ambiguous in
// practice — Khiara could not reliably get a caret into one. So a tap on a tab
// ALWAYS navigates now, and editing happens through its own control.
//
// The pencil is drawn small to stay out of the way, but its tappable box is a
// full 44px, the same trick used for the CMS gear.
const PENCIL = '✎';

export function initNavEditing() {
  const labels = Array.from(
    document.querySelectorAll('[data-cms-id^="nav."][data-cms-type="text"]')
  );

  labels.forEach(function (label) {
    const pencil = document.createElement('button');
    pencil.type = 'button';
    pencil.className = 'cms-nav-pencil';
    pencil.textContent = PENCIL;
    pencil.setAttribute('aria-label', 'Rename this menu tab');
    pencil.hidden = true;

    pencil.addEventListener('click', function (e) {
      // The pencil sits inside the menu; without this the click would bubble
      // to the nav handler and navigate away from what she is editing.
      e.preventDefault();
      e.stopPropagation();

      label.contentEditable = 'true';
      label.classList.add('cms-editing');
      label.focus();

      // Select the whole name: renaming a tab is almost always replacing it,
      // not appending to it.
      const range = document.createRange();
      range.selectNodeContents(label);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Straight after the label, so it reads as belonging to it.
    if (label.parentNode) label.parentNode.insertBefore(pencil, label.nextSibling);
  });

  onEditingChange(function (active) {
    labels.forEach(function (label) {
      if (!active) {
        label.contentEditable = 'false';
        label.classList.remove('cms-editing');
      }
    });
    document.querySelectorAll('.cms-nav-pencil').forEach(function (p) {
      p.hidden = !active;
    });
  });
}
