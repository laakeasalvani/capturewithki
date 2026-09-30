// The public web config, on its own so a page can start a SEPARATE Firebase app
// from it (galleries/gallery-firebase.js) without also starting this site's
// default one. Deliberately public — see CLAUDE.md; the secret keys live in
// Functions Secrets, never here.
export const firebaseConfig = {
  apiKey: "AIzaSyCFo69Vwo7I_-XwTEM1zS5_6TyJGgXYZaQ",
  authDomain: "capturewithki-69dd3.firebaseapp.com",
  projectId: "capturewithki-69dd3",
  storageBucket: "capturewithki-69dd3.firebasestorage.app",
  messagingSenderId: "416670397460",
  appId: "1:416670397460:web:1ca701f1e068029d8e6301"
};
