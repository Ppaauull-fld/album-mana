import {
  getCurrentUser,
  getUserProfile,
  getUserInitials,
  getAuthPageUrl,
  updateCurrentUserFamilyName,
  updateCurrentUserFamilyPin,
  signOutCurrentUser,
} from "./firebase.js";
import { setBtnLoading } from "./ui.js";

function buildMarkup() {
  return `
    <button id="profileChipBtn" class="profile-chip" type="button" aria-label="Ouvrir le menu profil" aria-haspopup="menu" aria-expanded="false">
      <div id="profileChipAvatar" class="profile-chip__avatar">U</div>
    </button>

    <div id="profilePopover" class="profile-popover" role="menu" hidden>
      <div class="profile-popover__head">
        <div id="profileMenuName" class="profile-popover__name">Profil</div>
        <div class="profile-popover__email">Compte famille</div>
      </div>

      <div class="profile-popover__actions">
        <button type="button" class="profile-action-btn" data-action="rename">Changer le nom utilisateur</button>
        <button type="button" class="profile-action-btn" data-action="pin">Changer le code PIN</button>
        <button type="button" class="profile-action-btn" data-action="logout">Se deconnecter</button>
      </div>
    </div>
  `;
}

function buildActionModalMarkup() {
  return `
    <div id="profileActionModal" class="profile-action-modal" aria-hidden="true" hidden>
      <div class="profile-action-modal__backdrop" data-modal-close="1"></div>
      <div class="profile-action-modal__panel" role="dialog" aria-modal="true" aria-labelledby="profileActionTitle">
        <div class="profile-action-modal__head">
          <div id="profileActionTitle" class="profile-action-modal__title">Action</div>
          <button id="profileActionCloseBtn" class="iconbtn profile-action-modal__close" type="button" aria-label="Fermer" data-modal-close="1">
            <img
              class="icon-img"
              src="../assets/img/icons/X.svg"
              alt=""
              aria-hidden="true"
              decoding="async"
            />
          </button>
        </div>

        <div id="profileActionBody" class="profile-action-modal__body"></div>
        <div id="profileActionFeedback" class="profile-action-modal__feedback" aria-live="polite"></div>

        <div class="profile-action-modal__actions">
          <button id="profileActionCancelBtn" class="btn" type="button" data-modal-close="1">Annuler</button>
          <button id="profileActionOkBtn" class="btn primary" type="button">Valider</button>
        </div>
      </div>
    </div>
  `;
}

function readValue(scope, id) {
  return String(scope.querySelector(`#${id}`)?.value || "").trim();
}

function setModalFeedback(modalEl, message = "", type = "") {
  const box = modalEl.querySelector("#profileActionFeedback");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("is-error", "is-success");
  if (type === "error") box.classList.add("is-error");
  if (type === "success") box.classList.add("is-success");
}

function mapErr(err) {
  const code = err?.code || "";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password") {
    return "Code PIN actuel incorrect.";
  }
  if (code === "auth/weak-password") return "Code PIN invalide.";
  if (code === "auth/requires-recent-login") return "Reconnecte-toi puis recommence.";
  if (code === "auth/email-already-in-use") return "Ce prenom est deja utilise.";
  if (code === "permission-denied") return "Action refusee par les regles Firestore.";
  return err?.message || "Erreur inattendue.";
}

function setModalOpen(modalEl, open) {
  if (!modalEl) return;
  modalEl.hidden = !open;
  modalEl.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("profile-action-open", open);
}

function renderModalForAction(modalEl, action) {
  const title = modalEl.querySelector("#profileActionTitle");
  const body = modalEl.querySelector("#profileActionBody");
  const okBtn = modalEl.querySelector("#profileActionOkBtn");
  if (!title || !body || !okBtn) return;

  okBtn.classList.remove("danger");
  setModalFeedback(modalEl, "");

  if (action === "rename") {
    title.textContent = "Changer le nom utilisateur";
    okBtn.textContent = "Enregistrer";
    body.innerHTML = `
      <label class="profile-field-label" for="profileActionRenameInput">Nouveau nom utilisateur</label>
      <input id="profileActionRenameInput" class="profile-field-input" type="text" maxlength="50" />
    `;
    return;
  }

  if (action === "pin") {
    title.textContent = "Changer le code PIN";
    okBtn.textContent = "Valider";
    body.innerHTML = `
      <label class="profile-field-label" for="profileActionCurrentPin">Code PIN actuel</label>
      <input id="profileActionCurrentPin" class="profile-field-input" type="password" inputmode="numeric" maxlength="2" autocomplete="current-password" />

      <label class="profile-field-label" for="profileActionNewPin">Nouveau code PIN</label>
      <input id="profileActionNewPin" class="profile-field-input" type="password" inputmode="numeric" maxlength="2" autocomplete="new-password" />

      <label class="profile-field-label" for="profileActionConfirmPin">Confirmation du nouveau code PIN</label>
      <input id="profileActionConfirmPin" class="profile-field-input" type="password" inputmode="numeric" maxlength="2" autocomplete="new-password" />
    `;
    return;
  }
}

function ensureActionModal() {
  let modal = document.getElementById("profileActionModal");
  if (modal) return modal;

  const host = document.createElement("div");
  host.innerHTML = buildActionModalMarkup().trim();
  modal = host.firstElementChild;
  if (!modal) return null;
  document.body.appendChild(modal);
  return modal;
}

async function mountProfileMenu() {
  const user = await getCurrentUser();
  if (!user) return;

  const themeToggle = document.getElementById("themeToggle");
  const host =
    themeToggle?.parentElement ||
    document.querySelector(".auth-corner-controls") ||
    document.querySelector(".topbar .inner");
  if (!host) return;

  const root = document.createElement("div");
  root.className = "profile-menu-root";
  root.innerHTML = buildMarkup();
  host.appendChild(root);
  const modal = ensureActionModal();
  if (!modal) return;

  const chipBtn = root.querySelector("#profileChipBtn");
  const chipAvatar = root.querySelector("#profileChipAvatar");
  const popover = root.querySelector("#profilePopover");
  const menuName = root.querySelector("#profileMenuName");
  const modalOkBtn = modal.querySelector("#profileActionOkBtn");

  let currentAction = "";
  let firstName = user.displayName || "";

  try {
    const profile = await getUserProfile(user.uid);
    firstName = profile?.firstName || firstName;
  } catch {
    // no-op: profile doc can be blocked by rules during migration
  }

  if (!firstName) {
    firstName = String(user.email || "").split("@")[0] || "Membre";
  }

  function syncProfileUi() {
    const safeName = String(firstName || "Membre").trim() || "Membre";
    const initials = getUserInitials(safeName);
    if (chipAvatar) chipAvatar.textContent = initials;
    if (menuName) menuName.textContent = safeName;
  }

  function openPopover() {
    if (!popover || !chipBtn) return;
    popover.hidden = false;
    chipBtn.setAttribute("aria-expanded", "true");
  }

  function closePopover() {
    if (!popover || !chipBtn) return;
    popover.hidden = true;
    chipBtn.setAttribute("aria-expanded", "false");
  }

  function openActionModal(action) {
    currentAction = action;
    renderModalForAction(modal, action);
    setModalOpen(modal, true);
    const panel = modal.querySelector(".profile-action-modal__panel");
    if (panel) panel.scrollTop = 0;

    const firstField =
      modal.querySelector("#profileActionRenameInput") ||
      modal.querySelector("#profileActionCurrentPin");
    if (action === "rename") {
      const renameInput = modal.querySelector("#profileActionRenameInput");
      if (renameInput) renameInput.value = firstName;
    }
    firstField?.focus();
  }

  function closeActionModal() {
    currentAction = "";
    setModalFeedback(modal, "");
    setModalOpen(modal, false);
  }

  syncProfileUi();

  chipBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    if (popover?.hidden) openPopover();
    else closePopover();
  });

  document.addEventListener("click", (e) => {
    if (popover?.hidden) return;
    if (root.contains(e.target)) return;
    closePopover();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!popover?.hidden) closePopover();
      if (modal.getAttribute("aria-hidden") === "false") closeActionModal();
    }
  });

  modal.querySelectorAll("[data-modal-close='1']").forEach((el) => {
    el.addEventListener("click", () => closeActionModal());
  });

  root.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.getAttribute("data-action");
      if (!action) return;

      if (action === "logout") {
        closePopover();
        try {
          await signOutCurrentUser();
        } finally {
          window.location.replace(getAuthPageUrl(asPath(window.location)));
        }
        return;
      }

      closePopover();
      openActionModal(action);
    });
  });

  modalOkBtn?.addEventListener("click", async () => {
    if (!currentAction) return;

    if (currentAction === "rename") {
      const nextName = readValue(modal, "profileActionRenameInput");
      if (nextName.length < 2) {
        setModalFeedback(modal, "Le nom utilisateur doit contenir au moins 2 caracteres.", "error");
        return;
      }

      setBtnLoading(modalOkBtn, true, { label: "Enregistrement..." });
      try {
        const updated = await updateCurrentUserFamilyName({
          newFirstName: nextName,
        });
        firstName = updated;
        syncProfileUi();
        closeActionModal();
      } catch (err) {
        setModalFeedback(modal, mapErr(err), "error");
      } finally {
        setBtnLoading(modalOkBtn, false);
      }
      return;
    }

    if (currentAction === "pin") {
      const currentPin = readValue(modal, "profileActionCurrentPin");
      const newPin = readValue(modal, "profileActionNewPin");
      const confirmPin = readValue(modal, "profileActionConfirmPin");

      if (!/^\d{2}$/.test(currentPin) || !/^\d{2}$/.test(newPin)) {
        setModalFeedback(modal, "Le code PIN doit contenir exactement 2 chiffres.", "error");
        return;
      }
      if (newPin !== confirmPin) {
        setModalFeedback(modal, "La confirmation du nouveau code PIN ne correspond pas.", "error");
        return;
      }

      setBtnLoading(modalOkBtn, true, { label: "Validation..." });
      try {
        await updateCurrentUserFamilyPin({ currentPin, newPin });
        closeActionModal();
      } catch (err) {
        setModalFeedback(modal, mapErr(err), "error");
      } finally {
        setBtnLoading(modalOkBtn, false);
      }
      return;
    }
  });
}

function asPath(locLike) {
  return `${locLike.pathname || ""}${locLike.search || ""}${locLike.hash || ""}`;
}

mountProfileMenu();
