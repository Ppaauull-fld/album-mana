import { db, getCurrentUser, getUserProfile } from "./firebase.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const INTERACTIONS_COL = "interactions";
const QUICK_REACTION_EMOJIS = ["❤️", "😍", "😂", "😭", "😡", "🔥"];
const MAX_COMMENT_LENGTH = 280;
const REACTION_ICON_URL = new URL("../img/icons/Add reaction.svg", import.meta.url).href;
const SEND_ICON_URL = new URL("../img/icons/Send.svg", import.meta.url).href;
const COMMENT_TOPBAR_ICON_URL = new URL("../img/icons/Message square.svg", import.meta.url).href;
const PLUS_ICON_URL = new URL("../img/icons/Plus.svg", import.meta.url).href;
const CLOSE_ICON_URL = new URL("../img/icons/X.svg", import.meta.url).href;
const DELETE_ICON_URL = new URL("../img/icons/delete.svg", import.meta.url).href;
const IS_COARSE_POINTER =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;

function safeString(value) {
  return String(value || "").trim();
}

function normalizeReactionEmoji(value) {
  return safeString(value).normalize("NFKC").replace(/\uFE0F/g, "");
}

function isSameReactionEmoji(a, b) {
  const na = normalizeReactionEmoji(a);
  const nb = normalizeReactionEmoji(b);
  return !!na && !!nb && na === nb;
}

function isQuickReactionEmoji(emoji) {
  return QUICK_REACTION_EMOJIS.some((item) => isSameReactionEmoji(item, emoji));
}

function buildMediaKey(mediaType, mediaId) {
  const type = safeString(mediaType).toLowerCase();
  const id = safeString(mediaId).replace(/[\/\s]+/g, "_");
  return `${type}__${id}`;
}

function toEpochMs(data) {
  const ts = data?.createdAt;
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  const num = Number(data?.createdAtMs || 0);
  return Number.isFinite(num) ? num : 0;
}

function formatCommentTime(ms) {
  if (!ms) return "A l'instant";

  const delta = Date.now() - ms;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (delta < minute) return "A l'instant";
  if (delta < hour) return `${Math.max(1, Math.floor(delta / minute))} min`;
  if (delta < day) return `${Math.max(1, Math.floor(delta / hour))} h`;

  const d = new Date(ms);
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function normalizeDisplayName(user, profile) {
  const fromProfile = safeString(profile?.firstName);
  if (fromProfile) return fromProfile;

  const fromDisplay = safeString(user?.displayName);
  if (fromDisplay) return fromDisplay;

  const fromEmail = safeString(user?.email).split("@")[0];
  if (fromEmail) return fromEmail;

  return "Membre";
}

function emptyController() {
  return {
    async openForMedia() {},
    close() {},
  };
}

function isEmojiLike(value) {
  const text = safeString(value);
  if (!text) return false;
  if (text.length > 8) return false;
  return /\p{Extended_Pictographic}/u.test(text);
}

function extractFirstEmoji(value) {
  const text = safeString(value);
  if (!text) return "";
  const match = text.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u);
  return safeString(match?.[0]);
}

export function createMediaInteractionPanel({ modalEl, mediaType }) {
  if (!modalEl || !mediaType) return emptyController();

  const viewerBox = modalEl.querySelector(".box.viewer-box");
  const viewerWrap = viewerBox?.querySelector(".viewer-wrap");
  const topControls = viewerBox?.querySelector(".top .controls");
  if (!viewerBox || !viewerWrap || !topControls) return emptyController();

  viewerBox.classList.add("viewer-box--social");
  viewerBox.style.setProperty("--media-keyboard-offset", "0px");

  // Layout wrapper: media zone + optional comments drawer.
  const layout = document.createElement("div");
  layout.className = "media-social-layout";
  viewerWrap.insertAdjacentElement("beforebegin", layout);
  layout.appendChild(viewerWrap);

  // Comments drawer (right panel).
  const commentsPanel = document.createElement("aside");
  commentsPanel.className = "media-comments-panel";
  commentsPanel.hidden = true;
  commentsPanel.innerHTML = `
    <div class="media-comments-panel__head">
      <div class="media-comments-panel__title">Commentaires</div>
      <button
        class="iconbtn media-comments-panel__close"
        type="button"
        aria-label="Fermer les commentaires"
        title="Fermer les commentaires"
      >
        <img class="icon-img" src="${CLOSE_ICON_URL}" alt="" aria-hidden="true" decoding="async" />
      </button>
    </div>
    <div class="media-social-comments">
      <div class="media-social-comments__list" aria-live="polite"></div>
      <form class="media-social-comments__form" novalidate>
        <input
          class="media-social-comments__input"
          type="text"
          maxlength="${MAX_COMMENT_LENGTH}"
          placeholder="Ajouter un commentaire..."
          aria-label="Ajouter un commentaire"
        />
        <button
          class="media-social-comments__send iconbtn"
          type="submit"
          aria-label="Envoyer le commentaire"
          title="Envoyer"
        >
          <img class="icon-img" src="${SEND_ICON_URL}" alt="" aria-hidden="true" decoding="async" />
        </button>
      </form>
    </div>
    <div class="media-social-status" aria-live="polite"></div>
  `;
  layout.appendChild(commentsPanel);

  // Reactions summary (top-left of media) + details popover.
  const reactionSummaryWrap = document.createElement("div");
  reactionSummaryWrap.className = "media-reaction-summary-wrap";
  reactionSummaryWrap.hidden = true;
  reactionSummaryWrap.innerHTML = `
    <button
      class="media-reaction-summary-btn"
      type="button"
      aria-label="Voir le detail des reactions"
      title="Voir le detail des reactions"
    >
      <span class="media-reaction-summary-btn__emojis"></span>
      <span class="media-reaction-summary-btn__count"></span>
    </button>
    <div class="media-reaction-summary-popover" hidden></div>
  `;
  viewerWrap.appendChild(reactionSummaryWrap);

  // Reaction tray opened from top icon.
  const reactionTray = document.createElement("div");
  reactionTray.className = "media-reaction-tray";
  reactionTray.hidden = true;
  reactionTray.innerHTML = `
    ${QUICK_REACTION_EMOJIS.map(
      (emoji) =>
        `<button class="media-reaction-tray__btn" type="button" data-emoji="${emoji}" data-default-emoji="${emoji}" aria-label="Reagir ${emoji}" title="Reagir ${emoji}">${emoji}</button>`
    ).join("")}
    <button class="media-reaction-tray__btn media-reaction-tray__btn--plus iconbtn" type="button" data-action="custom" aria-label="Ajouter une reaction" title="Ajouter une reaction">
      <img class="icon-img" src="${PLUS_ICON_URL}" alt="" aria-hidden="true" decoding="async" />
    </button>
    <input
      class="media-reaction-tray__emoji-capture"
      type="text"
      inputmode="text"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      maxlength="16"
      enterkeyhint="done"
      aria-label="Emoji personnalise"
    />
  `;
  topControls.appendChild(reactionTray);

  // Top controls (new icons).
  const commentToggleBtn = document.createElement("button");
  commentToggleBtn.type = "button";
  commentToggleBtn.className = "iconbtn media-social-toggle-btn media-social-toggle-btn--comments";
  commentToggleBtn.title = "Commentaires";
  commentToggleBtn.setAttribute("aria-label", "Commentaires");
  commentToggleBtn.setAttribute("aria-pressed", "false");
  commentToggleBtn.innerHTML = `
    <img class="icon-img" src="${COMMENT_TOPBAR_ICON_URL}" alt="" aria-hidden="true" decoding="async" />
  `;

  const reactionToggleBtn = document.createElement("button");
  reactionToggleBtn.type = "button";
  reactionToggleBtn.className = "iconbtn media-social-toggle-btn media-social-toggle-btn--reactions";
  reactionToggleBtn.title = "Reactions";
  reactionToggleBtn.setAttribute("aria-label", "Reactions");
  reactionToggleBtn.setAttribute("aria-pressed", "false");
  reactionToggleBtn.innerHTML = `
    <img class="icon-img" src="${REACTION_ICON_URL}" alt="" aria-hidden="true" decoding="async" />
  `;

  topControls.prepend(reactionToggleBtn);
  topControls.prepend(commentToggleBtn);

  const commentsCloseBtn = commentsPanel.querySelector(".media-comments-panel__close");
  const commentsList = commentsPanel.querySelector(".media-social-comments__list");
  const commentForm = commentsPanel.querySelector(".media-social-comments__form");
  const commentInput = commentsPanel.querySelector(".media-social-comments__input");
  const statusEl = commentsPanel.querySelector(".media-social-status");

  const reactionSummaryBtn = reactionSummaryWrap.querySelector(".media-reaction-summary-btn");
  const reactionSummaryEmojis = reactionSummaryWrap.querySelector(".media-reaction-summary-btn__emojis");
  const reactionSummaryCount = reactionSummaryWrap.querySelector(".media-reaction-summary-btn__count");
  const reactionSummaryPopover = reactionSummaryWrap.querySelector(".media-reaction-summary-popover");
  const customPlusBtn = reactionTray.querySelector('[data-action="custom"]');
  const customReactionInput = reactionTray.querySelector(".media-reaction-tray__emoji-capture");
  const visualViewportApi = window.visualViewport || null;
  const IOS_BROWSER_UI_MAX_OFFSET = 96;
  let keyboardSyncRaf = 0;
  let lastKeyboardOffset = -1;

  let currentMediaId = "";
  let currentMediaKey = "";
  let currentUser = null;
  let currentUserName = "Membre";
  let reactions = [];
  let comments = [];
  let pendingReaction = false;
  let pendingComment = false;
  let unSubReactions = null;
  let unSubComments = null;
  let commentsOpen = false;
  let reactionTrayOpen = false;
  let summaryPopoverOpen = false;
  let customReactionOpen = false;
  let nativeEmojiPicker = null;

  function setKeyboardOffset(px = 0, options = {}) {
    const { force = false } = options;
    const value = Math.max(0, Math.round(Number(px) || 0));
    if (!force && lastKeyboardOffset >= 0 && Math.abs(value - lastKeyboardOffset) < 2) return;
    lastKeyboardOffset = value;
    viewerBox.style.setProperty("--media-keyboard-offset", `${value}px`);
  }

  function readViewportObstruction() {
    if (!visualViewportApi) return 0;
    const layoutHeight = Math.max(
      0,
      window.innerHeight || 0,
      document.documentElement?.clientHeight || 0
    );
    const visibleBottom = (visualViewportApi.height || 0) + (visualViewportApi.offsetTop || 0);
    return Math.max(0, Math.round(layoutHeight - visibleBottom));
  }

  function computePanelOffset() {
    const active = document.activeElement;
    const keyboardContextOpen =
      customReactionOpen ||
      active === commentInput ||
      active === customReactionInput;
    const panelVisible = commentsOpen || keyboardContextOpen;

    if (!panelVisible) return 0;

    const obstruction = readViewportObstruction();
    if (keyboardContextOpen) return obstruction;
    return Math.min(obstruction, IOS_BROWSER_UI_MAX_OFFSET);
  }

  function syncKeyboardOffsetNow() {
    setKeyboardOffset(computePanelOffset());
  }

  function syncKeyboardOffset() {
    if (keyboardSyncRaf) return;
    keyboardSyncRaf = window.requestAnimationFrame(() => {
      keyboardSyncRaf = 0;
      syncKeyboardOffsetNow();
    });
  }

  function resetKeyboardOffset() {
    if (keyboardSyncRaf) {
      window.cancelAnimationFrame(keyboardSyncRaf);
      keyboardSyncRaf = 0;
    }
    setKeyboardOffset(0, { force: true });
  }

  function setButtonCountBadge(btn, count) {
    if (!btn) return;
    if (count > 0) {
      btn.classList.add("has-count");
      btn.setAttribute("data-count", String(count > 99 ? "99+" : count));
      return;
    }
    btn.classList.remove("has-count");
    btn.removeAttribute("data-count");
  }

  function clearStatus() {
    if (!statusEl) return;
    statusEl.textContent = "";
    statusEl.classList.remove("is-error", "is-success");
  }

  function setStatus(message, type = "") {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.classList.remove("is-error", "is-success");
    if (type) statusEl.classList.add(type === "error" ? "is-error" : "is-success");
  }

  async function pickDesktopCustomEmoji() {
    const EmojiPickerCtor =
      typeof window !== "undefined" ? window.EmojiPicker : null;

    if (typeof EmojiPickerCtor !== "function") {
      return { supported: false, emoji: "" };
    }

    try {
      if (!nativeEmojiPicker) nativeEmojiPicker = new EmojiPickerCtor();
      const picked = await nativeEmojiPicker.pick();
      const fromPicker = safeString(picked?.unicode || picked?.emoji);
      return { supported: true, emoji: fromPicker };
    } catch {
      // User cancellation or unsupported environment.
      return { supported: true, emoji: "" };
    }
  }

  function setCommentsOpen(open, options = {}) {
    const { focusInput = false } = options;
    commentsOpen = !!open;
    commentsPanel.hidden = !commentsOpen;
    viewerBox.classList.toggle("viewer-box--comments-open", commentsOpen);
    commentToggleBtn.classList.toggle("is-active", commentsOpen);
    commentToggleBtn.setAttribute("aria-pressed", commentsOpen ? "true" : "false");
    if (commentsOpen) {
      setReactionTrayOpen(false);
      setSummaryPopoverOpen(false);
    }

    if (commentsOpen && focusInput) {
      setTimeout(() => commentInput?.focus({ preventScroll: true }), 0);
    }
    syncKeyboardOffset();
    if (commentsOpen) setTimeout(syncKeyboardOffset, 140);
  }

  function setReactionTrayOpen(open) {
    reactionTrayOpen = !!open;
    reactionTray.hidden = !reactionTrayOpen;
    reactionToggleBtn.classList.toggle("is-active", reactionTrayOpen);
    reactionToggleBtn.setAttribute("aria-pressed", reactionTrayOpen ? "true" : "false");
    if (reactionTrayOpen) {
      setCommentsOpen(false);
      setSummaryPopoverOpen(false);
    } else {
      setCustomReactionOpen(false);
    }
    syncKeyboardOffset();
  }

  function setSummaryPopoverOpen(open) {
    summaryPopoverOpen = !!open;
    reactionSummaryPopover.hidden = !summaryPopoverOpen;
    reactionSummaryBtn.classList.toggle("is-active", summaryPopoverOpen);
  }

  function setCustomReactionOpen(open, options = {}) {
    const { focusInput = false } = options;
    customReactionOpen = !!open;
    customPlusBtn?.classList.toggle("is-active", customReactionOpen);

    if (!customReactionOpen) {
      if (customReactionInput) customReactionInput.value = "";
      syncKeyboardOffset();
      return;
    }

    if (focusInput) {
      try {
        customReactionInput?.focus({ preventScroll: true });
      } catch {
        customReactionInput?.focus();
      }
    }
    syncKeyboardOffset();
    setTimeout(syncKeyboardOffset, 140);
  }

  function stopRealtime() {
    if (typeof unSubReactions === "function") {
      unSubReactions();
      unSubReactions = null;
    }
    if (typeof unSubComments === "function") {
      unSubComments();
      unSubComments = null;
    }
  }

  async function ensureUser() {
    if (currentUser) return currentUser;

    const user = await getCurrentUser();
    if (!user) throw new Error("Session utilisateur introuvable.");

    let profile = null;
    try {
      profile = await getUserProfile(user.uid);
    } catch {
      profile = null;
    }

    currentUser = user;
    currentUserName = normalizeDisplayName(user, profile);
    return user;
  }

  function isOwnComment(comment) {
    const commentUserId = safeString(comment?.userId);
    const myUserId = safeString(currentUser?.uid);
    return !!commentUserId && !!myUserId && commentUserId === myUserId;
  }

  async function hydrateCurrentUserContext(expectedMediaKey = "") {
    try {
      await ensureUser();
    } catch {
      currentUser = null;
      currentUserName = "Membre";
    } finally {
      if (expectedMediaKey && expectedMediaKey !== currentMediaKey) return;
      renderReactions();
      renderComments();
    }
  }

  function currentUserReaction() {
    if (!currentUser?.uid) return "";
    const mine = reactions.find((r) => r.userId === currentUser.uid);
    return safeString(mine?.emoji);
  }

  function renderReactionSummary() {
    const total = reactions.length;
    setButtonCountBadge(reactionToggleBtn, total);

    if (!total) {
      reactionSummaryWrap.hidden = true;
      setSummaryPopoverOpen(false);
      if (reactionSummaryPopover) reactionSummaryPopover.innerHTML = "";
      return;
    }

    const byEmoji = new Map();
    for (const r of reactions) {
      const emojiRaw = safeString(r?.emoji);
      if (!emojiRaw) continue;
      const key = normalizeReactionEmoji(emojiRaw) || emojiRaw;
      const current = byEmoji.get(key);
      if (current) {
        current.count += 1;
      } else {
        byEmoji.set(key, { emoji: emojiRaw, count: 1 });
      }
    }

    const ordered = [...byEmoji.values()].sort((a, b) => b.count - a.count);
    const topEmojis = ordered.slice(0, 2).map((it) => it.emoji).join(" ");
    reactionSummaryWrap.hidden = false;
    if (reactionSummaryEmojis) reactionSummaryEmojis.textContent = topEmojis;
    if (reactionSummaryCount) reactionSummaryCount.textContent = String(total);

    if (reactionSummaryPopover) {
      reactionSummaryPopover.innerHTML = "";

      const header = document.createElement("div");
      header.className = "media-reaction-summary-popover__head";
      header.textContent = `${total} reaction${total > 1 ? "s" : ""}`;
      reactionSummaryPopover.appendChild(header);

      const rows = [...reactions].sort((a, b) =>
        safeString(a.userName).localeCompare(safeString(b.userName), "fr", { sensitivity: "base" })
      );

      for (const row of rows) {
        const item = document.createElement("div");
        item.className = "media-reaction-summary-popover__row";

        const name = document.createElement("span");
        name.className = "media-reaction-summary-popover__name";
        name.textContent = safeString(row.userName) || "Membre";

        const emoji = document.createElement("span");
        emoji.className = "media-reaction-summary-popover__emoji";
        emoji.textContent = safeString(row.emoji) || "•";

        item.appendChild(name);
        item.appendChild(emoji);
        reactionSummaryPopover.appendChild(item);
      }
    }
  }

  function renderReactionTrayState() {
    const mine = currentUserReaction();
    const quickButtons = [...reactionTray.querySelectorAll("[data-default-emoji]")];
    for (const btn of quickButtons) {
      const defaultEmoji = safeString(btn.getAttribute("data-default-emoji"));
      btn.dataset.emoji = defaultEmoji;
      btn.textContent = defaultEmoji;
      btn.classList.remove("is-active", "media-reaction-tray__btn--custom-slot");
      btn.setAttribute("aria-label", `Reagir ${defaultEmoji}`);
      btn.setAttribute("title", `Reagir ${defaultEmoji}`);
    }

    if (!mine) return;

    if (isQuickReactionEmoji(mine)) {
      for (const btn of quickButtons) {
        const emoji = safeString(btn.getAttribute("data-emoji"));
        if (!!emoji && isSameReactionEmoji(emoji, mine)) {
          btn.classList.add("is-active");
          return;
        }
      }
      return;
    }

    const customSlotBtn = quickButtons[quickButtons.length - 1];
    if (customSlotBtn) {
      customSlotBtn.dataset.emoji = mine;
      customSlotBtn.textContent = mine;
      customSlotBtn.classList.add("is-active", "media-reaction-tray__btn--custom-slot");
      customSlotBtn.setAttribute("aria-label", `Retirer ta reaction ${mine}`);
      customSlotBtn.setAttribute("title", "Retirer ta reaction");
    }
  }

  function renderComments() {
    if (!commentsList) return;
    commentsList.innerHTML = "";
    setButtonCountBadge(commentToggleBtn, comments.length);

    if (!comments.length) {
      const empty = document.createElement("div");
      empty.className = "media-social-comments__empty";
      empty.textContent = "Aucun commentaire pour l'instant.";
      commentsList.appendChild(empty);
      return;
    }

    for (const c of comments) {
      const row = document.createElement("article");
      row.className = "media-social-comment";
      row.dataset.commentId = c.id;

      const canDelete = isOwnComment(c);
      row.innerHTML = `
        <div class="media-social-comment__head">
          <strong class="media-social-comment__name">${safeString(c.userName) || "Membre"}</strong>
          <span class="media-social-comment__time">${formatCommentTime(c.createdAtMs)}</span>
          ${
            canDelete
              ? `<button class="media-social-comment__delete iconbtn" type="button" title="Supprimer" aria-label="Supprimer ce commentaire">
                  <img class="icon-img" src="${DELETE_ICON_URL}" alt="" aria-hidden="true" decoding="async" />
                </button>`
              : ""
          }
        </div>
        <div class="media-social-comment__text"></div>
      `;

      const textEl = row.querySelector(".media-social-comment__text");
      if (textEl) textEl.textContent = safeString(c.text);
      commentsList.appendChild(row);
    }

    commentsList.scrollTop = commentsList.scrollHeight;
  }

  function renderReactions() {
    renderReactionTrayState();
    renderReactionSummary();
  }

  function bindRealtime() {
    if (!currentMediaKey) return;

    const reactionsRef = collection(db, INTERACTIONS_COL, currentMediaKey, "reactions");
    const commentsRef = query(
      collection(db, INTERACTIONS_COL, currentMediaKey, "comments"),
      orderBy("createdAtMs", "asc")
    );

    unSubReactions = onSnapshot(
      reactionsRef,
      (snap) => {
        reactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderReactions();
      },
      (err) => setStatus(`Reactions indisponibles: ${err?.message || err}`, "error")
    );

    unSubComments = onSnapshot(
      commentsRef,
      (snap) => {
        comments = snap.docs.map((d) => {
          const data = d.data() || {};
          return {
            id: d.id,
            userId: safeString(data.userId),
            userName: safeString(data.userName),
            text: safeString(data.text),
            createdAtMs: toEpochMs(data),
          };
        });
        renderComments();
      },
      (err) => setStatus(`Commentaires indisponibles: ${err?.message || err}`, "error")
    );
  }

  async function toggleReaction(emoji) {
    if (!emoji || !currentMediaKey || pendingReaction) return;
    try {
      await ensureUser();
    } catch (err) {
      setStatus(err?.message || "Utilisateur non connecte.", "error");
      return;
    }

    pendingReaction = true;
    clearStatus();

    const mine = currentUserReaction();
    const reactionRef = doc(db, INTERACTIONS_COL, currentMediaKey, "reactions", currentUser.uid);

    try {
      if (isSameReactionEmoji(mine, emoji)) {
        await deleteDoc(reactionRef);
      } else {
        await setDoc(
          reactionRef,
          {
            userId: currentUser.uid,
            userName: currentUserName,
            emoji,
            updatedAt: serverTimestamp(),
            updatedAtMs: Date.now(),
          },
          { merge: true }
        );
      }
    } catch (err) {
      setStatus(err?.message || "Impossible d'enregistrer la reaction.", "error");
    } finally {
      pendingReaction = false;
    }
  }

  async function submitComment() {
    if (!commentInput || !currentMediaKey || pendingComment) return;
    const text = safeString(commentInput.value).slice(0, MAX_COMMENT_LENGTH);
    if (!text) return;

    try {
      await ensureUser();
    } catch (err) {
      setStatus(err?.message || "Utilisateur non connecte.", "error");
      return;
    }

    pendingComment = true;
    clearStatus();

    try {
      await addDoc(collection(db, INTERACTIONS_COL, currentMediaKey, "comments"), {
        userId: currentUser.uid,
        userName: currentUserName,
        text,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
      });
      commentInput.value = "";
    } catch (err) {
      setStatus(err?.message || "Impossible d'ajouter le commentaire.", "error");
    } finally {
      pendingComment = false;
    }
  }

  async function deleteComment(commentId) {
    if (!commentId || !currentMediaKey) return;

    if (!currentUser?.uid) {
      try {
        await ensureUser();
      } catch (err) {
        setStatus(err?.message || "Utilisateur non connecte.", "error");
        return;
      }
    }

    const targetComment = comments.find((c) => safeString(c?.id) === safeString(commentId));
    if (!isOwnComment(targetComment)) {
      setStatus("Seul l'auteur peut supprimer ce commentaire.", "error");
      return;
    }

    try {
      await deleteDoc(doc(db, INTERACTIONS_COL, currentMediaKey, "comments", commentId));
    } catch (err) {
      setStatus(err?.message || "Suppression impossible.", "error");
    }
  }

  reactions = [];
  comments = [];
  renderReactions();
  renderComments();

  reactionTray?.addEventListener("click", (e) => {
    const btn = e.target?.closest?.("button");
    if (!btn) return;

    const customAction = safeString(btn.dataset.action);
    if (customAction === "custom") {
      if (!IS_COARSE_POINTER) {
        void (async () => {
          const result = await pickDesktopCustomEmoji();
          const emoji = safeString(result?.emoji);
          if (!result?.supported) {
            setCustomReactionOpen(true, { focusInput: true });
            setStatus(
              "Astuce: Win + . (Windows) ou Ctrl + Cmd + Espace (Mac) pour choisir un emoji."
            );
            return;
          }

          if (!emoji) return;

          if (!isEmojiLike(emoji)) {
            setStatus("Emoji personnalise invalide.", "error");
            return;
          }

          void toggleReaction(emoji);
          setCustomReactionOpen(false);
          setReactionTrayOpen(false);
        })();
        return;
      }

      setCustomReactionOpen(true, { focusInput: true });
      return;
    }

    const emoji = safeString(btn.dataset.emoji);
    if (!emoji) return;
    void toggleReaction(emoji);
    setCustomReactionOpen(false);
    setReactionTrayOpen(false);
  });

  customReactionInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setCustomReactionOpen(false);
    }
  });

  customReactionInput?.addEventListener("input", () => {
    const raw = safeString(customReactionInput.value);
    if (!raw) return;

    const emoji = extractFirstEmoji(raw) || raw;
    if (!isEmojiLike(emoji)) {
      setStatus("Emoji personnalisé invalide.", "error");
      customReactionInput.value = "";
      return;
    }

    void toggleReaction(emoji);
    customReactionInput.value = "";
    setCustomReactionOpen(false);
    setReactionTrayOpen(false);
  });

  customReactionInput?.addEventListener("focus", () => {
    syncKeyboardOffset();
    setTimeout(syncKeyboardOffset, 120);
  });
  customReactionInput?.addEventListener("blur", () => {
    setCustomReactionOpen(false);
    setTimeout(syncKeyboardOffset, 120);
  });

  commentInput?.addEventListener("focus", () => {
    syncKeyboardOffset();
    setTimeout(syncKeyboardOffset, 120);
  });
  commentInput?.addEventListener("blur", () => {
    setTimeout(syncKeyboardOffset, 120);
  });

  commentForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitComment();
  });

  commentsList?.addEventListener("click", (e) => {
    const delBtn = e.target?.closest?.(".media-social-comment__delete");
    if (!delBtn) return;
    const row = delBtn.closest(".media-social-comment");
    const commentId = safeString(row?.dataset?.commentId);
    if (!commentId) return;
    void deleteComment(commentId);
  });

  commentToggleBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !commentsOpen;
    setCommentsOpen(next, { focusInput: next });
    if (next) {
      void hydrateCurrentUserContext(currentMediaKey);
    }
  });

  commentsCloseBtn?.addEventListener("click", () => {
    setCommentsOpen(false);
  });

  reactionToggleBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !reactionTrayOpen;
    setReactionTrayOpen(next);
  });

  reactionSummaryBtn?.addEventListener("click", () => {
    if (reactionSummaryWrap.hidden) return;
    const next = !summaryPopoverOpen;
    setSummaryPopoverOpen(next);
    if (next) setReactionTrayOpen(false);
  });

  modalEl.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || !(target instanceof Element)) return;

    if (
      reactionTrayOpen &&
      !reactionTray.contains(target) &&
      !reactionToggleBtn.contains(target)
    ) {
      setReactionTrayOpen(false);
    }

    if (
      summaryPopoverOpen &&
      !reactionSummaryWrap.contains(target)
    ) {
      setSummaryPopoverOpen(false);
    }
  });

  if (visualViewportApi) {
    visualViewportApi.addEventListener("resize", syncKeyboardOffset);
    visualViewportApi.addEventListener("scroll", syncKeyboardOffset);
  }

  return {
    async openForMedia(item) {
      const mediaId = safeString(item?.id);
      if (!mediaId) {
        this.close();
        return;
      }

      clearStatus();
      currentMediaId = mediaId;
      currentMediaKey = buildMediaKey(mediaType, currentMediaId);
      document.documentElement.classList.add("viewer-social-open");
      document.body.classList.add("viewer-social-open");

      setCommentsOpen(false);
      setReactionTrayOpen(false);
      setSummaryPopoverOpen(false);
      resetKeyboardOffset();

      reactions = [];
      comments = [];
      renderReactions();
      renderComments();

      stopRealtime();
      bindRealtime();
      void hydrateCurrentUserContext(currentMediaKey);
    },

    close() {
      stopRealtime();
      currentMediaId = "";
      currentMediaKey = "";
      reactions = [];
      comments = [];
      clearStatus();
      if (commentInput) commentInput.value = "";
      setButtonCountBadge(reactionToggleBtn, 0);
      setButtonCountBadge(commentToggleBtn, 0);
      setCommentsOpen(false);
      setReactionTrayOpen(false);
      setSummaryPopoverOpen(false);
      reactionSummaryWrap.hidden = true;
      resetKeyboardOffset();
      document.documentElement.classList.remove("viewer-social-open");
      document.body.classList.remove("viewer-social-open");
    },
  };
}
