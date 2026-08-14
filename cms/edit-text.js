import { getField, setField } from './content-store.js';
import { updateCollectionItem } from './collection-store.js';
import { onEditingChange } from './auth.js';

// collection name -> currently displayed document id (or null while a
// collection is still showing fallback data with no real id yet).
const currentItems = {};
let adminActive = false;

export function setCurrentItem(collection, id) {
  currentItems[collection] = id || null;
  refreshItemTextClasses();
}

function applyContent(el) {
  const id = el.getAttribute('data-cms-id');
  const value = getField(id, el.__cmsFallback);
  el.innerHTML = value;
}

function applyAttr(el) {
  const id = el.getAttribute('data-cms-id');
  const attr = el.getAttribute('data-cms-attr');
  const value = getField(id, el.__cmsFallback);
  el.setAttribute(attr, value);
}

function optionsFromString(str) {
  return str
    .split('\n')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function stringFromOptions(select) {
  return Array.prototype.map
    .call(select.options, function (o) { return o.textContent; })
    .join('\n');
}

function rebuildOptions(select, str) {
  const values = optionsFromString(str);
  select.innerHTML = '';
  values.forEach(function (v) {
    const opt = document.createElement('option');
    opt.textContent = v;
    select.appendChild(opt);
  });
}

function applyOptionsField(el) {
  const id = el.getAttribute('data-cms-id');
  const value = getField(id, null);
  if (value) rebuildOptions(el, value);
}

function showToast(message) {
  let toast = document.getElementById('cmsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cmsToast';
    toast.className = 'cms-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast.__timer);
  toast.__timer = setTimeout(function () { toast.classList.remove('show'); }, 1500);
}

function refreshItemTextClasses() {
  document.querySelectorAll('[data-cms-type="item-text"]').forEach(function (el) {
    const collection = el.getAttribute('data-cms-collection');
    const hasId = !!currentItems[collection];
    el.classList.toggle('cms-editable', adminActive && hasId);
    if (!(adminActive && hasId)) {
      el.contentEditable = 'false';
      el.classList.remove('cms-editing');
    }
  });
}

export function initTextEditing() {
  const textFields = document.querySelectorAll('[data-cms-type="text"]');
  const attrFields = document.querySelectorAll('[data-cms-type="attr"]');
  const optionFields = document.querySelectorAll('[data-cms-type="options"]');

  textFields.forEach(function (el) {
    el.__cmsFallback = el.innerHTML;
    applyContent(el);
  });

  attrFields.forEach(function (el) {
    const attr = el.getAttribute('data-cms-attr');
    el.__cmsFallback = el.getAttribute(attr) || '';
    applyAttr(el);
  });

  optionFields.forEach(function (el) {
    applyOptionsField(el);
  });

  onEditingChange(function (active) {
    adminActive = active;

    textFields.forEach(function (el) {
      el.classList.toggle('cms-editable', active);
      if (!active) {
        el.contentEditable = 'false';
        el.classList.remove('cms-editing');
      }
    });

    attrFields.forEach(function (el) {
      el.classList.toggle('cms-editable-attr', active);
    });

    optionFields.forEach(function (el) {
      el.classList.toggle('cms-editable-attr', active);
    });

    refreshItemTextClasses();
  });

  document.addEventListener('click', function (e) {
    // <summary> treats a click as activation and toggles its parent <details>
    // open/closed. While the summary text is being edited, that would collapse
    // the FAQ answer every time the owner clicks in to place the caret — so
    // suppress the native toggle for the duration of the edit. Caret placement
    // itself happens on mousedown, before this click fires, so it is unaffected.
    const editingSummary = e.target.closest && e.target.closest('summary.cms-editing');
    if (editingSummary) {
      e.preventDefault();
      return;
    }

    const attrEl = e.target.closest && e.target.closest('[data-cms-type="attr"].cms-editable-attr');
    if (attrEl) {
      e.preventDefault();
      e.stopPropagation();
      const id = attrEl.getAttribute('data-cms-id');
      const attr = attrEl.getAttribute('data-cms-attr');
      const current = attrEl.getAttribute(attr) || '';
      const next = prompt('Edit ' + attr + ':', current);
      if (next === null) return;
      setField(id, next)
        .then(function () {
          attrEl.setAttribute(attr, next);
          showToast('Saved');
        })
        .catch(function (err) {
          console.warn('[cms] save failed:', err && (err.code || err.message));
          showToast('Not saved — check your connection');
        });
      return;
    }

    const optEl = e.target.closest && e.target.closest('[data-cms-type="options"].cms-editable-attr');
    if (optEl) {
      e.preventDefault();
      e.stopPropagation();
      const id = optEl.getAttribute('data-cms-id');
      const current = stringFromOptions(optEl);
      const next = prompt('One option per line:', current);
      if (next === null) return;
      setField(id, next)
        .then(function () {
          rebuildOptions(optEl, next);
          showToast('Saved');
        })
        .catch(function (err) {
          console.warn('[cms] save failed:', err && (err.code || err.message));
          showToast('Not saved — check your connection');
        });
      return;
    }

    const el = e.target.closest('.cms-editable');
    if (!el || el.contentEditable === 'true') return;
    if (el.getAttribute('data-cms-type') === 'item-text') {
      const collection = el.getAttribute('data-cms-collection');
      if (!currentItems[collection]) return;
    }
    el.contentEditable = 'true';
    el.classList.add('cms-editing');
    el.focus();
  });

  document.addEventListener('keydown', function (e) {
    // <summary> treats the spacebar as activation and toggles its parent
    // <details> instead of typing a space. While the summary is being
    // edited, insert the space ourselves and swallow the toggle.
    if (e.key !== ' ') return;
    const el = e.target.closest && e.target.closest('summary.cms-editing');
    if (!el) return;
    e.preventDefault();
    document.execCommand('insertText', false, ' ');
  });

  document.addEventListener(
    'focusout',
    function (e) {
      const el = e.target.closest && e.target.closest('[data-cms-type="text"], [data-cms-type="item-text"]');
      if (!el || el.contentEditable !== 'true') return;
      el.contentEditable = 'false';
      el.classList.remove('cms-editing');

      if (el.getAttribute('data-cms-type') === 'item-text') {
        const collection = el.getAttribute('data-cms-collection');
        const field = el.getAttribute('data-cms-field');
        const id = currentItems[collection];
        if (!id) return;
        const value = el.textContent;
        updateCollectionItem(collection, id, { [field]: value })
          .then(function () {
            showToast('Saved');
            document.dispatchEvent(new CustomEvent('cms:collection-item-saved', { detail: { collection: collection } }));
          })
          .catch(function (err) {
            console.warn('[cms] save failed:', err && (err.code || err.message));
            showToast('Not saved — check your connection');
          });
        return;
      }

      const id = el.getAttribute('data-cms-id');
      setField(id, el.innerHTML)
        .then(function () {
          showToast('Saved');
        })
        .catch(function (err) {
          console.warn('[cms] save failed:', err && (err.code || err.message));
          showToast('Not saved — check your connection');
        });
    },
    true
  );
}
