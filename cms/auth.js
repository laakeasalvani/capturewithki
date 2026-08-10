import { auth, db } from './firebase.js';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

let adminActive = false;
const listeners = [];

function notify() {
  listeners.forEach(function (cb) { cb(adminActive); });
}

export function onAdminChange(cb) {
  listeners.push(cb);
  cb(adminActive);
}

export function isAdmin() {
  return adminActive;
}

export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function logout() {
  return signOut(auth);
}

export function initAuth() {
  setPersistence(auth, browserLocalPersistence).then(function () {
    onAuthStateChanged(auth, async function (user) {
      if (!user) {
        adminActive = false;
        notify();
        return;
      }
      const adminDoc = await getDoc(doc(db, 'admins', user.uid));
      adminActive = adminDoc.exists();
      notify();
    });
  });
}
