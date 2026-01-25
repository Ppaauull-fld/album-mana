// assets/js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

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

export const auth = getAuth(app);
export const db = getFirestore(app);

export async function ensureAnonAuth() {
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

// Admin helpers
export async function adminLogin(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function adminLogout() {
  await signOut(auth);
}

export function onAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function isAdmin() {
  const u = auth.currentUser;
  if (!u) return false;
  const snap = await getDoc(doc(db, "admins", u.uid));
  return snap.exists();
}
