import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyCFo69Vwo7I_-XwTEM1zS5_6TyJGgXYZaQ",
  authDomain: "capturewithki-69dd3.firebaseapp.com",
  projectId: "capturewithki-69dd3",
  storageBucket: "capturewithki-69dd3.firebasestorage.app",
  messagingSenderId: "416670397460",
  appId: "1:416670397460:web:1ca701f1e068029d8e6301"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
