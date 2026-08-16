import { initAuth, login, logout, onAdminChange } from '../cms/auth.js';
import { auth } from '../cms/firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { initInquiries } from './inquiries.js';
import { initSettings } from './settings.js';
import { initGalleries } from './galleries.js';

const loading = document.getElementById('dashLoading');
const loginView = document.getElementById('dashLogin');
const denied = document.getElementById('dashDenied');
const app = document.getElementById('dashApp');

const form = document.getElementById('dashLoginForm');
const errorEl = document.getElementById('dashLoginError');
const submitBtn = form.querySelector('button[type="submit"]');

const screens = {
  inquiries: document.getElementById('screenInquiries'),
  galleries: document.getElementById('screenGalleries'),
  settings: document.getElementById('screenSettings')
};
const tabs = {
  inquiries: document.getElementById('tabInquiries'),
  galleries: document.getElementById('tabGalleries'),
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
tabs.galleries.addEventListener('click', function () { selectTab('galleries'); });
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

function signOut() {
  logout().then(function () { window.location.reload(); });
}
document.getElementById('dashLogout').addEventListener('click', signOut);
document.getElementById('dashDeniedLogout').addEventListener('click', signOut);

// Auth resolves in two steps: cms/auth.js notifies admin state immediately
// (with a stale default), and Firebase separately restores any saved session
// a moment later. Painting before BOTH have spoken is what flashes the login
// form at someone who is already signed in — so hold on "Loading…" until
// authResolved is true.
let authResolved = false;
let currentUser = null;
let adminActive = false;
let started = false;

function paint() {
  if (!authResolved) { show('loading'); return; }

  if (adminActive) {
    show('app');
    if (!started) {
      started = true;
      initInquiries(screens.inquiries);
      initGalleries(screens.galleries);
      initSettings(screens.settings);
    }
    return;
  }
  // Signed in but not an admin is a different situation from signed out, and
  // must say so rather than silently showing a login form.
  show(currentUser ? 'denied' : 'login');
}

onAuthStateChanged(auth, function (user) {
  authResolved = true;
  currentUser = user;
  paint();
});

onAdminChange(function (active) {
  adminActive = active;
  paint();
});

initAuth();
