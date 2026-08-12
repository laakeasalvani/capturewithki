import { initAuth, login, logout, isAdmin, onAdminChange } from '../cms/auth.js';
import { initInquiries } from './inquiries.js';
import { initSettings } from './settings.js';

const loading = document.getElementById('dashLoading');
const loginView = document.getElementById('dashLogin');
const denied = document.getElementById('dashDenied');
const app = document.getElementById('dashApp');

const form = document.getElementById('dashLoginForm');
const errorEl = document.getElementById('dashLoginError');
const submitBtn = form.querySelector('button[type="submit"]');

const screens = {
  inquiries: document.getElementById('screenInquiries'),
  settings: document.getElementById('screenSettings')
};
const tabs = {
  inquiries: document.getElementById('tabInquiries'),
  settings: document.getElementById('tabSettings')
};

function show(which) {
  loading.hidden = which !== 'loading';
  loginView.hidden = which !== 'login';
  denied.hidden = which !== 'denied';
  app.hidden = which !== 'app';
}

function selectTab(name) {
  Object.keys(screens).forEach(function (k) {
    screens[k].hidden = k !== name;
    tabs[k].classList.toggle('on', k === name);
  });
}

tabs.inquiries.addEventListener('click', function () { selectTab('inquiries'); });
tabs.settings.addEventListener('click', function () { selectTab('settings'); });

form.addEventListener('submit', function (e) {
  e.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;
  login(
    document.getElementById('dashEmail').value.trim(),
    document.getElementById('dashPassword').value
  ).catch(function () {
    errorEl.textContent = 'Wrong email or password.';
  }).then(function () {
    submitBtn.disabled = false;
  });
});

document.getElementById('dashLogout').addEventListener('click', function () { logout(); });
document.getElementById('dashDeniedLogout').addEventListener('click', function () { logout(); });

let started = false;

initAuth();

onAdminChange(function (active) {
  if (active) {
    show('app');
    if (!started) {
      started = true;
      initInquiries(screens.inquiries);
      initSettings(screens.settings);
    }
    return;
  }
  // Not an admin. Distinguish "signed in but not permitted" from "signed
  // out" — a blank page for the former is exactly the bug that cost an
  // evening on the CMS.
  import('https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js').then(function (m) {
    const user = m.getAuth().currentUser;
    show(user ? 'denied' : 'login');
  });
});
