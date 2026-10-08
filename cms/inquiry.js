// The contact form's own Firebase app, kept apart from cms/firebase.js. The
// default app's Auth restores Khiara's saved login from IndexedDB, and every
// callable waits for Auth first — so when Safari's IndexedDB stops answering
// (see cms/no-indexeddb.js) a visitor's inquiry sat on "Sending…" forever and
// never left the phone. A visitor has no login to restore, so in-memory Auth
// costs nothing. The main page cannot load no-indexeddb.js itself: the CMS
// needs IndexedDB to keep Khiara signed in.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { initializeAuth, inMemoryPersistence } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig, 'inquiry');
// Must be claimed explicitly: Functions asks for this app's Auth, and if none
// exists yet the SDK creates one with the default IndexedDB persistence.
initializeAuth(app, { persistence: inMemoryPersistence });
const functions = getFunctions(app, 'us-west1');
const callable = httpsCallable(functions, 'submitInquiry');

// The contact form lives in index.html's classic (non-module) script, which
// cannot import the SDK, so the callable is handed over on window.
window.cmsSubmitInquiry = function (payload) {
  return callable(payload).then(function (res) { return res.data; });
};
