// Package prices on the public page — read from, and saved to, `packages`.
//
// `packages/{id}` is the single place a price lives. Contracts already read
// `priceCents` from it; this module makes the page follow it too:
//
//   - every element with data-price-pkg="<package id>" shows that package's
//     price line (functions/lib/price-display.js decides the wording)
//   - the contact form's session dropdown (data-price-options) is rebuilt from
//     the same list, so a visitor never picks a price that no longer exists
//   - in edit mode, clicking a price opens a small editor that saves straight
//     to `packages/{id}` — the page, the form and every NEW contract change at
//     once. Contracts already sent keep the price frozen into them.
//
// If the list cannot be read (offline, rules not yet deployed) nothing is
// touched and the wording built into index.html stays — never a blank price.
// Refresh that built-in wording with bin/sync-prices.mjs.
import { db } from './firebase.js';
import {
  collection, getDocs, doc, updateDoc
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { onAdminChange, onEditingChange } from './auth.js';
import { showToast } from './toast.js';
import {
  usablePackages, sitePriceText, inquiryOptionText, isStartingFrom, parsePriceInput, shortName
} from '../functions/lib/price-display.js';
import { centsToInput } from '../functions/lib/contracts.js';

let packages = {};      // id -> package data, as last read or saved
let editing = false;
let modal = null;

async function loadPackages() {
  try {
    const snap = await getDocs(collection(db, 'packages'));
    const next = {};
    snap.forEach(function (d) { next[d.id] = Object.assign({ id: d.id }, d.data()); });
    packages = next;
    return true;
  } catch (err) {
    // Expected for visitors until the public-read rule is deployed.
    console.info('[prices] using built-in prices:', err && (err.code || err.message));
    return false;
  }
}

function renderPrices() {
  document.querySelectorAll('[data-price-pkg]').forEach(function (el) {
    const text = sitePriceText(packages[el.getAttribute('data-price-pkg')]);
    if (text) el.textContent = text;
  });
}

function optionKey(text) {
  return String(text || '').split(' — ')[0].trim();
}

function renderOptions() {
  const list = usablePackages(Object.keys(packages).map(function (k) { return packages[k]; }));
  if (!list.length) return;
  document.querySelectorAll('select[data-price-options]').forEach(function (select) {
    // The first option is the "Not sure yet" placeholder from index.html —
    // kept as the very same element so nothing about it changes.
    const first = select.options[0] || null;
    // A visitor may have picked a session before this ran. Keep their choice
    // even if its price just changed: match on the part before the price
    // ("Couples", "Wedding, The Intimate").
    const chosenIndex = select.selectedIndex;
    const chosenKey = chosenIndex > 0 ? optionKey(select.options[chosenIndex].textContent) : null;

    select.innerHTML = '';
    if (first) select.appendChild(first);
    list.forEach(function (pkg) {
      const text = inquiryOptionText(pkg);
      if (!text) return;
      const opt = document.createElement('option');
      opt.textContent = text;
      select.appendChild(opt);
    });

    let restored = 0;
    if (chosenKey) {
      for (let i = 1; i < select.options.length; i++) {
        if (optionKey(select.options[i].textContent) === chosenKey) { restored = i; break; }
      }
    }
    select.selectedIndex = restored;
  });
}

function render() {
  renderPrices();
  renderOptions();
}

// ---------------------------------------------------------------------------
// The editor. Built on the login modal's styles so it looks like part of the
// same tool.

function buildModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'cms-modal-backdrop';
  backdrop.innerHTML =
    '<div class="cms-modal" role="dialog" aria-modal="true" aria-labelledby="cmsPriceTitle">' +
      '<h3 id="cmsPriceTitle">Edit price</h3>' +
      '<form>' +
        '<label for="cmsPriceInput">Price ($)</label>' +
        '<input id="cmsPriceInput" type="text" inputmode="decimal" autocomplete="off" maxlength="12">' +
        '<label class="cms-price-check"><input type="checkbox" id="cmsPriceFrom"> Show as “Starting from”</label>' +
        '<p class="cms-price-note">Changes this price on your website, in the inquiry form and on new contracts. Contracts you have already sent keep their price.</p>' +
        '<div class="cms-modal-error" aria-live="polite"></div>' +
        '<div class="cms-modal-actions">' +
          '<button type="button" class="cms-modal-close">Cancel</button>' +
          '<button type="submit">Save</button>' +
        '</div>' +
      '</form>' +
    '</div>';
  document.body.appendChild(backdrop);

  const form = backdrop.querySelector('form');
  const input = backdrop.querySelector('#cmsPriceInput');
  const fromBox = backdrop.querySelector('#cmsPriceFrom');
  const errorEl = backdrop.querySelector('.cms-modal-error');
  const title = backdrop.querySelector('#cmsPriceTitle');
  const saveBtn = backdrop.querySelector('button[type="submit"]');
  let currentId = null;

  function close() {
    backdrop.classList.remove('open');
    currentId = null;
  }

  backdrop.querySelector('.cms-modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) close();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!currentId) return;
    const parsed = parsePriceInput(input.value);
    if (parsed.error) { errorEl.textContent = parsed.error; input.focus(); return; }

    const id = currentId;
    const update = { priceCents: parsed.cents, startingFrom: fromBox.checked };
    errorEl.textContent = '';
    saveBtn.disabled = true;
    updateDoc(doc(db, 'packages', id), update)
      .then(function () {
        packages[id] = Object.assign({}, packages[id], update);
        render();
        close();
        showToast('Saved — website, inquiry form and new contracts updated');
      })
      .catch(function (err) {
        console.warn('[prices] save failed:', err && (err.code || err.message));
        errorEl.textContent = 'Not saved — check your connection and try again.';
      })
      .then(function () { saveBtn.disabled = false; });
  });

  return {
    open: function (id) {
      const pkg = packages[id];
      if (!pkg) {
        showToast('This price could not be loaded — refresh the page and try again');
        return;
      }
      currentId = id;
      title.textContent = 'Edit price — ' + (shortName(pkg) || id);
      input.value = centsToInput(pkg.priceCents);
      fromBox.checked = isStartingFrom(pkg);
      errorEl.textContent = '';
      backdrop.classList.add('open');
      input.focus();
      input.select();
    }
  };
}

function setEditable(on) {
  editing = on;
  document.querySelectorAll('[data-price-pkg]').forEach(function (el) {
    el.classList.toggle('cms-editable-attr', on);
    if (on) el.setAttribute('title', 'Click to change this price');
    else el.removeAttribute('title');
  });
}

// Not awaited by main.js: the page must not wait on this read to reveal. The
// built-in wording is already correct in the normal case, so the swap is
// invisible; it only shows when the two have drifted apart.
export function initPrices() {
  loadPackages().then(function (ok) { if (ok) render(); });

  // Signing in can unlock a read that failed for a visitor, so try again.
  onAdminChange(function (active) {
    if (active) loadPackages().then(function (ok) { if (ok) render(); });
  });

  onEditingChange(setEditable);

  document.addEventListener('click', function (e) {
    if (!editing) return;
    const el = e.target.closest && e.target.closest('[data-price-pkg]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (!modal) modal = buildModal();
    modal.open(el.getAttribute('data-price-pkg'));
  });
}
