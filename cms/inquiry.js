import { app } from './firebase.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const functions = getFunctions(app, 'us-west1');
const callable = httpsCallable(functions, 'submitInquiry');

// The contact form lives in index.html's classic (non-module) script, which
// cannot import the SDK, so the callable is handed over on window.
window.cmsSubmitInquiry = function (payload) {
  return callable(payload).then(function (res) { return res.data; });
};
