import { normalizeNextPath, getCurrentUser, signInWithFamilyPin } from "./firebase.js";

const authForm = document.getElementById("authForm");
const singleInput = document.getElementById("authSingleInput");
const submitBtn = document.getElementById("authSubmitBtn");
const feedback = document.getElementById("authFeedback");
const backBtn = document.getElementById("authBackBtn");
const pinToggleBtn = document.getElementById("authTogglePinBtn");
const pinToggleIcon = document.getElementById("authTogglePinIcon");

const params = new URLSearchParams(window.location.search);
const nextPath = normalizeNextPath(params.get("next"));

const STEP_NAME = "name";
const STEP_PIN = "pin";
const EYE_ICON = "assets/img/icons/Eye.svg";
const EYE_OFF_ICON = "assets/img/icons/Eye off.svg";
const SUCCESS_ICON = "assets/img/icons/Check circle green.svg";
const ERROR_ICON = "assets/img/icons/Slash.svg";
const BIOMETRIC_STORAGE_KEY = "albumMana.biometric.credentials.v1";
const WEBAUTHN_TIMEOUT_MS = 60000;
const WEBAUTHN_RP_NAME = "album-mana";

let currentStep = STEP_NAME;
let firstName = "";
let pinVisible = false;
let submitting = false;
let biometricSupported = false;
let isAutoSigningIn = false;
let hasAttemptedAutoSignIn = false;

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 50);
}

function onlyPinDigits(value) {
  return String(value || "").replace(/\D+/g, "").slice(0, 2);
}

function isBiometricCapableEnvironment() {
  return Boolean(
    window.isSecureContext &&
      window.crypto?.getRandomValues &&
      window.PublicKeyCredential &&
      navigator.credentials
  );
}

function toBase64Url(bytes) {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(src) {
  const normalized = String(src || "").replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) return null;
  const padLen = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  const padded = normalized + "=".repeat(padLen);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(size = 32) {
  const out = new Uint8Array(size);
  window.crypto.getRandomValues(out);
  return out;
}

function readBiometricStore() {
  try {
    const raw = localStorage.getItem(BIOMETRIC_STORAGE_KEY);
    if (!raw) return { version: 1, credentials: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: 1, credentials: [] };
    const list = Array.isArray(parsed.credentials) ? parsed.credentials : [];
    return { version: 1, credentials: list };
  } catch {
    return { version: 1, credentials: [] };
  }
}

function writeBiometricStore(credentials) {
  const safe = (Array.isArray(credentials) ? credentials : [])
    .filter((item) => item && typeof item === "object")
    .filter((item) => typeof item.credentialId === "string" && item.credentialId.trim())
    .slice(0, 12);

  try {
    localStorage.setItem(
      BIOMETRIC_STORAGE_KEY,
      JSON.stringify({ version: 1, credentials: safe })
    );
  } catch {}
}

function getStoredBiometricCredentials() {
  const store = readBiometricStore();
  return store.credentials
    .map((item) => ({
      credentialId: String(item.credentialId || "").trim(),
      firstName: cleanName(item.firstName || ""),
      pin: onlyPinDigits(item.pin || ""),
      createdAt: Number(item.createdAt || 0),
      lastUsedAt: Number(item.lastUsedAt || 0),
    }))
    .filter((item) => item.credentialId && item.firstName && /^\d{2}$/.test(item.pin));
}

function upsertStoredBiometricCredential(entry) {
  const current = getStoredBiometricCredentials();
  const next = [entry, ...current.filter((item) => item.credentialId !== entry.credentialId)];
  writeBiometricStore(next);
}

function touchStoredBiometricCredential(credentialId) {
  const current = getStoredBiometricCredentials();
  const next = current.map((item) =>
    item.credentialId === credentialId ? { ...item, lastUsedAt: Date.now() } : item
  );
  writeBiometricStore(next);
}

function isPasswordCredentialSupported() {
  return Boolean(
    window.PasswordCredential &&
      navigator.credentials &&
      typeof navigator.credentials.get === "function" &&
      typeof navigator.credentials.store === "function"
  );
}

async function storeBrowserCredential({ firstName, pin }) {
  if (!isPasswordCredentialSupported()) return;

  const normalizedName = cleanName(firstName);
  const normalizedPin = onlyPinDigits(pin);
  if (!normalizedName || !/^\d{2}$/.test(normalizedPin)) return;

  try {
    const credential = new PasswordCredential({
      id: normalizedName,
      name: normalizedName,
      password: normalizedPin,
    });
    await navigator.credentials.store(credential);
  } catch {}
}

async function trySignInWithBrowserCredential() {
  if (!isPasswordCredentialSupported()) return false;

  let credential = null;
  try {
    credential = await navigator.credentials.get({
      password: true,
      mediation: "optional",
    });
  } catch {
    return false;
  }

  if (!(credential instanceof PasswordCredential)) return false;

  const resolvedName = cleanName(credential.id || credential.name || "");
  const resolvedPin = onlyPinDigits(credential.password || "");
  if (!resolvedName || !/^\d{2}$/.test(resolvedPin)) return false;

  try {
    await signInWithFamilyPin({ firstName: resolvedName, pin: resolvedPin });
    await maybeOfferBiometricEnrollment({ firstName: resolvedName, pin: resolvedPin });
    await wait(500);
    window.location.replace(nextPath);
    return true;
  } catch {
    return false;
  }
}

function setFeedback(message = "", type = "", iconSrc = "") {
  if (!feedback) return;
  feedback.textContent = "";
  feedback.classList.remove("is-error", "is-success");
  if (type === "error") feedback.classList.add("is-error");
  if (type === "success") feedback.classList.add("is-success");
  if (!message) return;

  const row = document.createElement("div");
  row.className = "auth-feedback__row";

  if (iconSrc) {
    const icon = document.createElement("img");
    icon.className = "auth-feedback__icon";
    icon.src = iconSrc;
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");
    row.appendChild(icon);
  }

  const text = document.createElement("span");
  text.className = "auth-feedback__text";
  text.textContent = message;
  row.appendChild(text);

  feedback.appendChild(row);
}

function mapAuthError(err) {
  const code = err?.code || "";
  if (code === "auth/invalid-credential") return "Nom d'utilisateur ou code incorrect.";
  if (code === "auth/user-not-found") return "Nom d'utilisateur ou code incorrect.";
  if (code === "auth/wrong-password") return "Nom d'utilisateur ou code incorrect.";
  if (code === "auth/too-many-requests") return "Trop de tentatives, reessaie plus tard.";
  if (code === "auth/network-request-failed") return "Probleme reseau, verifie ta connexion.";
  return err?.message || "Erreur de connexion.";
}

function mapBiometricError(err) {
  const name = String(err?.name || "");
  if (name === "NotAllowedError") return "Verification biométrique annulée ou refusée.";
  if (name === "InvalidStateError") return "Aucun profil biométrique valide sur cet appareil.";
  if (name === "NotSupportedError") return "Biométrie non disponible sur cet appareil.";
  if (name === "SecurityError") return "Biométrie indisponible hors contexte sécurisé (HTTPS).";
  return err?.message || "Connexion biométrique impossible.";
}

async function detectBiometricSupport() {
  if (!isBiometricCapableEnvironment()) return false;

  const checker = window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
  if (typeof checker !== "function") return true;

  try {
    return Boolean(await checker.call(window.PublicKeyCredential));
  } catch {
    return false;
  }
}

async function registerBiometricCredential({ firstName, pin }) {
  const normalizedName = cleanName(firstName);
  const normalizedPin = onlyPinDigits(pin);
  if (!normalizedName || !/^\d{2}$/.test(normalizedPin)) return false;
  if (!biometricSupported) return false;

  const publicKey = {
    challenge: randomBytes(32),
    rp: { name: WEBAUTHN_RP_NAME },
    user: {
      id: randomBytes(16),
      name: `album-mana-${Date.now()}`,
      displayName: normalizedName,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 }, // ES256
      { type: "public-key", alg: -257 }, // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "required",
    },
    timeout: WEBAUTHN_TIMEOUT_MS,
    attestation: "none",
  };

  const credential = await navigator.credentials.create({ publicKey });
  if (!(credential instanceof PublicKeyCredential) || !credential.rawId) {
    throw new Error("Enrolement biométrique invalide.");
  }

  const credentialId = toBase64Url(new Uint8Array(credential.rawId));
  upsertStoredBiometricCredential({
    credentialId,
    firstName: normalizedName,
    pin: normalizedPin,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });
  return true;
}

async function signInWithBiometrics() {
  if (!biometricSupported) throw new Error("Biométrie non disponible.");

  const stored = getStoredBiometricCredentials();
  if (!stored.length) throw new Error("Aucun profil biométrique enregistré sur cet appareil.");

  const allowCredentials = stored
    .map((item) => {
      const id = fromBase64Url(item.credentialId);
      if (!id) return null;
      return { type: "public-key", id };
    })
    .filter(Boolean);

  if (!allowCredentials.length) throw new Error("Profil biométrique invalide.");

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials,
      userVerification: "required",
      timeout: WEBAUTHN_TIMEOUT_MS,
    },
  });

  if (!(assertion instanceof PublicKeyCredential) || !assertion.rawId) {
    throw new Error("Verification biométrique invalide.");
  }

  const usedCredentialId = toBase64Url(new Uint8Array(assertion.rawId));
  const matched = stored.find((item) => item.credentialId === usedCredentialId);
  if (!matched) throw new Error("Profil biométrique inconnu.");

  await signInWithFamilyPin({ firstName: matched.firstName, pin: matched.pin });
  touchStoredBiometricCredential(usedCredentialId);
}

function syncPinToggleIcon() {
  if (!pinToggleBtn || !pinToggleIcon) return;
  pinToggleIcon.src = pinVisible ? EYE_OFF_ICON : EYE_ICON;
  pinToggleBtn.setAttribute(
    "aria-label",
    pinVisible ? "Masquer le code PIN" : "Afficher le code PIN"
  );
}

function setSubmitState(enabled) {
  if (!submitBtn) return;
  submitBtn.classList.toggle("is-ready", Boolean(enabled));
  submitBtn.disabled = !enabled || submitting || isAutoSigningIn;
}

function isValidCurrentInput() {
  if (!singleInput) return false;
  if (currentStep === STEP_NAME) {
    return Boolean(cleanName(singleInput.value));
  }
  return /^\d{2}$/.test(onlyPinDigits(singleInput.value));
}

function validateAndSyncInput() {
  if (!singleInput) return false;

  if (currentStep === STEP_PIN) {
    const normalized = onlyPinDigits(singleInput.value);
    if (singleInput.value !== normalized) singleInput.value = normalized;
  }

  const valid = isValidCurrentInput();
  setSubmitState(valid);
  return valid;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderStep(step) {
  if (!singleInput) return;

  currentStep = step;
  setFeedback("");

  if (step === STEP_NAME) {
    document.body.classList.remove("auth-step-pin");
    pinVisible = false;

    singleInput.type = "text";
    singleInput.inputMode = "text";
    singleInput.maxLength = 50;
    singleInput.autocomplete = "username";
    singleInput.name = "username";
    singleInput.placeholder = "Nom d'utilisateur";
    singleInput.classList.remove("is-pin");
    singleInput.value = firstName || "";

    if (backBtn) backBtn.hidden = true;
    if (pinToggleBtn) pinToggleBtn.hidden = true;
    syncPinToggleIcon();
    validateAndSyncInput();

    queueMicrotask(() => singleInput.focus());
    return;
  }

  document.body.classList.add("auth-step-pin");
  singleInput.value = "";
  singleInput.type = pinVisible ? "text" : "password";
  singleInput.inputMode = "numeric";
  singleInput.maxLength = 2;
  singleInput.autocomplete = "current-password";
  singleInput.name = "password";
  singleInput.placeholder = "_____     _____";
  singleInput.classList.add("is-pin");

  if (backBtn) backBtn.hidden = false;
  if (pinToggleBtn) pinToggleBtn.hidden = false;
  syncPinToggleIcon();
  validateAndSyncInput();

  queueMicrotask(() => singleInput.focus());
}

async function handleSubmit(e) {
  e.preventDefault();
  if (!singleInput || submitting || isAutoSigningIn) return;

  setFeedback("");

  if (currentStep === STEP_NAME) {
    const nextName = cleanName(singleInput.value);
    if (!nextName) {
      setFeedback("Merci de renseigner ton prenom.", "error");
      validateAndSyncInput();
      return;
    }

    firstName = nextName;
    renderStep(STEP_PIN);
    return;
  }

  const pin = onlyPinDigits(singleInput.value);
  if (!/^\d{2}$/.test(pin)) {
    setFeedback("Le code PIN doit contenir exactement 2 chiffres.", "error");
    validateAndSyncInput();
    return;
  }

  let isSuccess = false;
  submitting = true;
  submitBtn?.classList.remove("is-ready");
  submitBtn?.classList.add("is-loading");
  if (submitBtn) submitBtn.disabled = true;

  try {
    await signInWithFamilyPin({ firstName, pin });
    isSuccess = true;
    submitBtn?.classList.remove("is-loading");
    setFeedback("Connexion reussie", "success", SUCCESS_ICON);
    if (singleInput) singleInput.disabled = true;
    if (pinToggleBtn) pinToggleBtn.disabled = true;
    if (backBtn) backBtn.disabled = true;
    await storeBrowserCredential({ firstName, pin });
    await maybeOfferBiometricEnrollment({ firstName, pin });
    await wait(700);
    window.location.replace(nextPath);
  } catch (err) {
    submitBtn?.classList.remove("is-loading");
    setFeedback(mapAuthError(err), "error", ERROR_ICON);
    singleInput.value = "";
    validateAndSyncInput();
    singleInput.focus();
    console.error("[auth-page]", err);
  } finally {
    submitting = false;
    submitBtn?.classList.remove("is-loading");
    if (!isSuccess) {
      validateAndSyncInput();
    }
  }
}

async function maybeOfferBiometricEnrollment({ firstName, pin }) {
  if (!biometricSupported) return;

  const normalizedName = cleanName(firstName);
  const normalizedPin = onlyPinDigits(pin);
  if (!normalizedName || !/^\d{2}$/.test(normalizedPin)) return;

  const existing = getStoredBiometricCredentials();
  const alreadyLinked = existing.some(
    (item) => item.firstName === normalizedName && item.pin === normalizedPin
  );
  if (alreadyLinked) return;

  const shouldEnroll = window.confirm(
    "Activer la connexion Face ID / empreinte sur cet appareil ?"
  );
  if (!shouldEnroll) return;

  try {
    await registerBiometricCredential({ firstName: normalizedName, pin: normalizedPin });
    setFeedback("Connexion biométrique activée sur cet appareil.", "success", SUCCESS_ICON);
    await wait(500);
  } catch (err) {
    setFeedback(mapBiometricError(err), "error", ERROR_ICON);
    await wait(1100);
    setFeedback("Connexion reussie", "success", SUCCESS_ICON);
  }
}

async function tryAutomaticSignIn() {
  if (hasAttemptedAutoSignIn || submitting || isAutoSigningIn) return;
  hasAttemptedAutoSignIn = true;
  isAutoSigningIn = true;
  submitBtn?.classList.remove("is-ready");
  if (submitBtn) submitBtn.disabled = true;

  try {
    const usedBrowserCredential = await trySignInWithBrowserCredential();
    if (usedBrowserCredential) return;

    if (biometricSupported && getStoredBiometricCredentials().length > 0) {
      try {
        await signInWithBiometrics();
        setFeedback("Connexion biométrique reussie", "success", SUCCESS_ICON);
        await wait(600);
        window.location.replace(nextPath);
        return;
      } catch (err) {
        if (String(err?.name || "") !== "NotAllowedError") {
          console.error("[auth-biometric-auto]", err);
        }
      }
    }
  } finally {
    isAutoSigningIn = false;
    validateAndSyncInput();
  }
}

function handleInput() {
  validateAndSyncInput();
  if (feedback?.textContent) setFeedback("");
}

function handleKeyDown(e) {
  if (currentStep !== STEP_PIN) return;
  if (!singleInput) return;

  if (e.key === "Escape") {
    e.preventDefault();
    renderStep(STEP_NAME);
    return;
  }

  if (e.key === "Backspace" && !singleInput.value) {
    e.preventDefault();
    renderStep(STEP_NAME);
  }
}

function handleTogglePin() {
  if (!singleInput || currentStep !== STEP_PIN) return;
  pinVisible = !pinVisible;
  singleInput.type = pinVisible ? "text" : "password";
  syncPinToggleIcon();

  const end = singleInput.value.length;
  singleInput.focus();
  singleInput.setSelectionRange(end, end);
}

async function init() {
  const user = await getCurrentUser();
  if (user) {
    window.location.replace(nextPath);
    return;
  }

  biometricSupported = await detectBiometricSupport();

  authForm?.addEventListener("submit", handleSubmit);
  singleInput?.addEventListener("input", handleInput);
  singleInput?.addEventListener("keydown", handleKeyDown);
  backBtn?.addEventListener("click", () => renderStep(STEP_NAME));
  pinToggleBtn?.addEventListener("click", handleTogglePin);

  renderStep(STEP_NAME);
  void tryAutomaticSignIn();
}

init();
