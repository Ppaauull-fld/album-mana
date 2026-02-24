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

let currentStep = STEP_NAME;
let firstName = "";
let pinVisible = false;
let submitting = false;

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 50);
}

function onlyPinDigits(value) {
  return String(value || "").replace(/\D+/g, "").slice(0, 2);
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
  submitBtn.disabled = !enabled || submitting;
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
    singleInput.autocomplete = "nickname";
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
  if (!singleInput || submitting) return;

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

  authForm?.addEventListener("submit", handleSubmit);
  singleInput?.addEventListener("input", handleInput);
  singleInput?.addEventListener("keydown", handleKeyDown);
  backBtn?.addEventListener("click", () => renderStep(STEP_NAME));
  pinToggleBtn?.addEventListener("click", handleTogglePin);

  renderStep(STEP_NAME);
}

init();
