import { db } from './firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

let cache = {};
let loaded = false;

export async function loadSiteContent() {
  try {
    const snap = await getDoc(doc(db, 'content', 'site'));
    cache = snap.exists() ? snap.data() : {};
  } catch (e) {
    cache = {};
  }
  loaded = true;
  return cache;
}

export function getField(key, fallback) {
  if (!loaded) return fallback;
  return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : fallback;
}

export async function setField(key, value) {
  cache[key] = value;
  await setDoc(doc(db, 'content', 'site'), { [key]: value }, { merge: true });
}
