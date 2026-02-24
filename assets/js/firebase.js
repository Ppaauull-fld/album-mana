// assets/js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDHnzmQvbNVObRH8YI8nayAXLPvxqPiAqw",
  authDomain: "album-mana.firebaseapp.com",
  projectId: "album-mana",
  storageBucket: "album-mana.firebasestorage.app",
  messagingSenderId: "1029814542522",
  appId: "1:1029814542522:web:8474784c3dc774ac4a6283",
  measurementId: "G-Z544K88S23",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

const USERS_COL = "users";
const AUTH_PAGE_URL = new URL("../../auth.html", import.meta.url);
const HOME_PAGE_URL = new URL("../../index.html", import.meta.url);

// Mode "famille": identifiants derives a partir du prenom + PIN 2 chiffres
// Ce schema est volontairement simple selon ton besoin (pas securite forte).
const FAMILY_EMAIL_DOMAIN = "album-mana.family";
const FAMILY_PASSWORD_PREFIX = "am-family-";

let persistenceReadyPromise = null;

function asPath(urlObj) {
  return `${urlObj.pathname}${urlObj.search}${urlObj.hash}`;
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 50);
}

function normalizeLoginName(value) {
  const src = cleanName(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const normalized = src.replace(/[^a-z0-9]/g, "");
  return normalized.slice(0, 24);
}

function normalizePin(value) {
  return String(value || "").trim();
}

function ensureTwoDigitPin(pin) {
  return /^\d{2}$/.test(pin);
}

function familyEmailFromFirstName(firstName) {
  const login = normalizeLoginName(firstName);
  if (!login) throw new Error("Prenom invalide.");
  return `${login}@${FAMILY_EMAIL_DOMAIN}`;
}

function familyPasswordFromPin(pin) {
  const normalized = normalizePin(pin);
  if (!ensureTwoDigitPin(normalized)) {
    throw new Error("Le code PIN doit contenir exactement 2 chiffres.");
  }
  return `${FAMILY_PASSWORD_PREFIX}${normalized}`;
}

export function getUserInitials(seed) {
  const src = cleanName(seed);
  if (!src) return "U";

  const parts = src.split(" ").filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function ensurePersistence() {
  if (!persistenceReadyPromise) {
    persistenceReadyPromise = setPersistence(auth, browserLocalPersistence).catch((err) => {
      console.warn("[auth] persistence locale indisponible", err);
    });
  }
  return persistenceReadyPromise;
}

function waitForAuthState() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (user) => {
      off();
      resolve(user || null);
    });
  });
}

export function getAuthPageUrl(nextPath = "") {
  const url = new URL(AUTH_PAGE_URL.href);
  if (nextPath) url.searchParams.set("next", nextPath);
  return url.href;
}

export function normalizeNextPath(rawNext) {
  const fallback = asPath(HOME_PAGE_URL);
  const raw = String(rawNext || "").trim();
  if (!raw) return fallback;

  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin !== window.location.origin) return fallback;

    const authPath = AUTH_PAGE_URL.pathname.replace(/\/+$/, "");
    const parsedPath = parsed.pathname.replace(/\/+$/, "");
    if (parsedPath === authPath) return fallback;

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export async function getCurrentUser() {
  await ensurePersistence();
  if (auth.currentUser) return auth.currentUser;
  return waitForAuthState();
}

export async function requireAuth(options = {}) {
  const { redirect = true, nextPath = "" } = options;
  const user = await getCurrentUser();
  if (user) return user;

  if (redirect && typeof window !== "undefined") {
    const next =
      nextPath ||
      `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(getAuthPageUrl(next));
  }

  return null;
}

// Compatibilite avec les pages existantes
export async function ensureAnonAuth() {
  return requireAuth({ redirect: true });
}

export async function getUserProfile(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, USERS_COL, uid));
  return snap.exists() ? snap.data() : null;
}

export async function upsertUserProfile(uid, payload = {}) {
  if (!uid) return;
  await setDoc(
    doc(db, USERS_COL, uid),
    {
      ...payload,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function signInWithFamilyPin({ firstName, pin }) {
  await ensurePersistence();

  const displayName = cleanName(firstName);
  if (!displayName) throw new Error("Merci de renseigner ton prenom.");

  const email = familyEmailFromFirstName(displayName);
  const password = familyPasswordFromPin(pin);

  const cred = await signInWithEmailAndPassword(auth, email, password);
  const user = cred.user;

  try {
    if (user.displayName !== displayName) {
      await updateProfile(user, { displayName });
    }
  } catch (err) {
    console.warn("[auth] updateProfile skip", err);
  }

  try {
    const profile = await getUserProfile(user.uid);
    if (!profile) {
      await upsertUserProfile(user.uid, {
        firstName: displayName,
        email: user.email || email,
        createdAt: serverTimestamp(),
      });
    } else if (profile.firstName !== displayName) {
      await upsertUserProfile(user.uid, {
        firstName: displayName,
        email: user.email || email,
      });
    }
  } catch (err) {
    console.warn("[auth] profile sync skip", err);
  }

  return user;
}

export async function signOutCurrentUser() {
  await signOut(auth);
}

export async function updateCurrentUserFamilyName({ newFirstName }) {
  const user = auth.currentUser || (await getCurrentUser());
  if (!user?.email) throw new Error("Session invalide.");

  const displayName = cleanName(newFirstName);
  if (!displayName) throw new Error("Prenom invalide.");

  await updateProfile(user, { displayName });
  await upsertUserProfile(user.uid, {
    firstName: displayName,
    email: user.email,
  });

  return displayName;
}

export async function updateCurrentUserFamilyPin({ currentPin, newPin }) {
  const user = auth.currentUser || (await getCurrentUser());
  if (!user?.email) throw new Error("Session invalide.");

  const oldPassword = familyPasswordFromPin(currentPin);
  const nextPassword = familyPasswordFromPin(newPin);

  const credential = EmailAuthProvider.credential(user.email, oldPassword);
  await reauthenticateWithCredential(user, credential);
  await updatePassword(user, nextPassword);
}

void ensurePersistence();
