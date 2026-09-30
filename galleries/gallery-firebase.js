// The gallery's own Firebase app, separate from the site's default one in
// cms/firebase.js, for two reasons:
//
//   1. Its login lives in memory only. A client types the password every
//      visit, so there is nothing worth saving — and nothing saved means no
//      browser database to wait on (see cms/no-indexeddb.js).
//   2. It cannot clobber Khiara's own dashboard login. The default app keeps
//      ONE saved user per browser, so opening a client's gallery in the same
//      browser as the dashboard used to swap her admin login for the
//      gallery's, silently signing her out.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { initializeAuth, inMemoryPersistence } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { firebaseConfig } from '../cms/firebase-config.js';

export const app = initializeApp(firebaseConfig, 'gallery');
export const auth = initializeAuth(app, { persistence: inMemoryPersistence });
export const db = getFirestore(app);
