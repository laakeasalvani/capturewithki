import { getField, setField } from './content-store.js';
import { onAdminChange } from './auth.js';

function applyContent(el) {
  const id = el.getAttribute('data-cms-id');
  const value = getField(id, el.__cmsFallback);
  el.innerHTML = value;
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

export function initTextEditing() {
  const fields = document.querySelectorAll('[data-cms-type="text"]');

  fields.forEach(function (el) {
    el.__cmsFallback = el.innerHTML;
    applyContent(el);
  });

  onAdminChange(function (active) {
    fields.forEach(function (el) {
      el.classList.toggle('cms-editable', active);
      if (!active) {
        el.contentEditable = 'false';
        el.classList.remove('cms-editing');
      }
    });
  });

  document.addEventListener('click', function (e) {
    const el = e.target.closest('.cms-editable');
    if (!el || el.contentEditable === 'true') return;
    el.contentEditable = 'true';
    el.classList.add('cms-editing');
    el.focus();
  });

  document.addEventListener(
    'focusout',
    function (e) {
      const el = e.target.closest && e.target.closest('[data-cms-type="text"]');
      if (!el || el.contentEditable !== 'true') return;
      el.contentEditable = 'false';
      el.classList.remove('cms-editing');
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
