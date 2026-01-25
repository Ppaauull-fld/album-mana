// assets/js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// ✅ Ta config (inchangée)
const firebaseConfig = {
  apiKey: "AIzaSyDHnzmQvbNVObRH8YI8nayAXLPvxqPiAqw",
  authDomain: "album-mana.firebaseapp.com",
  projectId: "album-mana",
  storageBucket: "album-mana.firebasestorage.app",
  messagingSenderId: "1029814542522",
  appId: "1:1029814542522:web:8474784c3dc774ac4a6283",
  measurementId: "G-Z544K88S23"
};

const app = initializeApp(firebaseConfig);

// Exports utilisés par tes pages
export const auth = getAuth(app);
export const db = getFirestore(app);

// ✅ Connexion anonyme (obligatoire vu tes règles Firestore)
export async function ensureAnonAuth() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}
