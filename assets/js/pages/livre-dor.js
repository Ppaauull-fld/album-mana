import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";
import { setBtnLoading } from "../ui.js";

import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* =========================
   DOM
   ========================= */
const canvas = document.getElementById("guestCanvas");
const ctx = canvas.getContext("2d");

const toolTextBtn = document.getElementById("toolText");
const toolDrawBtn = document.getElementById("toolDraw");

const textControls = document.getElementById("textControls");
const drawControls = document.getElementById("drawControls");

const fontSel = document.getElementById("font");
const sizeInput = document.getElementById("size");
const colorInput = document.getElementById("color");
const boldBtn = document.getElementById("boldBtn");
const italicBtn = document.getElementById("italicBtn");
const underlineBtn = document.getElementById("underlineBtn");

const penSizeInput = document.getElementById("penSize");
const penColorInput = document.getElementById("penColor");
const publishBtn = document.getElementById("publish");

const undoBtn = document.getElementById("undo");
const redoBtn = document.getElementById("redo");
const deleteBtn = document.getElementById("deleteSelected");
const exportBtn = document.getElementById("exportCanvasPng");

const hint = document.getElementById("hint");

// editor
const editorShell = document.getElementById("editorShell");
const floatingEditor = document.getElementById("floatingEditor");
const editorOk = document.getElementById("editorOk");
const editorCancel = document.getElementById("editorCancel");

/* =========================
   State
   ========================= */
let mode = "text";
let items = [];
const imageCache = new Map();

let selectedId = null;
let drag = null;

const HANDLE_RADIUS = 14;
const MIN_W = 60;
const MIN_H = 40;

// drawing local (non publié)
let isDrawing = false;
let currentStroke = null;
let strokes = [];
let redoStrokes = [];

// global undo/redo (Firestore)
const undoStack = [];
const redoStack = [];

// editor state: { mode:"create"|"edit", id?, x,y }
let editorState = null;

/* =========================
   Utils
   ========================= */
function setHint(t) {
  if (hint) hint.textContent = t;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
function applyActive(btn, on) {
  btn?.classList.toggle("active", !!on);
}

function editorOpen() {
  return editorShell && editorShell.style.display === "block";
}

function getSelectedItem() {
  return items.find((i) => i.id === selectedId) || null;
}

function getTextStyle() {
  return {
    font: fontSel?.value || "Georgia",
    size: Number(sizeInput?.value || 32),
    color: colorInput?.value || "#111111",
    bold: !!boldBtn?.classList.contains("active"),
    italic: !!italicBtn?.classList.contains("active"),
    underline: !!underlineBtn?.classList.contains("active"),
  };
}

function buildFontCss(it) {
  const parts = [];
  if (it.italic) parts.push("italic");
  if (it.bold) parts.push("700");
  parts.push(`${Number(it.size || 32)}px`);
  parts.push(it.font || "Georgia");
  return parts.join(" ");
}

function measureTextBox(it) {
  ctx.save();
  ctx.font = buildFontCss(it);
  const m = ctx.measureText(it.text || "");
  const w = Math.max(MIN_W, Math.ceil(m.width) + 24);
  const h = Math.max(MIN_H, Math.ceil((it.size || 32) * 1.25) + 18);
  ctx.restore();
  return { w, h };
}

/* =========================
   Canvas sizing (DPR safe)
   ========================= */
function dprResize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  // draw in CSS pixels
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

function posFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/* =========================
   Mode UI
   ========================= */
function setMode(next) {
  mode = next;

  toolTextBtn?.classList.toggle("active", mode === "text");
  toolDrawBtn?.classList.toggle("active", mode === "draw");
  toolTextBtn?.setAttribute("aria-selected", mode === "text" ? "true" : "false");
  toolDrawBtn?.setAttribute("aria-selected", mode === "draw" ? "true" : "false");

  if (textControls) textControls.style.display = mode === "text" ? "" : "none";
  if (drawControls) drawControls.style.display = mode === "draw" ? "" : "none";

  hideEditor();

  setHint(
    mode === "text"
      ? "Texte : clique pour ajouter • Double clic pour éditer"
      : "Dessin : dessine • Annuler/Rétablir = traits • Publier pour ajouter"
  );

  updateButtons();
  redraw();
}

function updateButtons() {
  if (mode === "draw") {
    const canUndoLocal = strokes.length > 0;
    const canRedoLocal = redoStrokes.length > 0;

    undoBtn.disabled = !(canUndoLocal || undoStack.length > 0);
    redoBtn.disabled = !(canRedoLocal || redoStack.length > 0);

    publishBtn.disabled = strokes.length === 0;
  } else {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;

    publishBtn.disabled = true;
  }

  deleteBtn.disabled = !selectedId;
}

/* =========================
   Drawing (canvas)
   ========================= */
function drawBackground() {
  // reset transform safe (dprResize sets it)
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawStroke(s) {
  if (!s?.points?.length) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
  ctx.stroke();
}

function drawText(it) {
  ctx.save();
  ctx.fillStyle = it.color || "#111";
  ctx.font = buildFontCss(it);
  ctx.textBaseline = "top";
  ctx.fillText(it.text || "", it.x, it.y);

  if (it.underline) {
    const m = ctx.measureText(it.text || "");
    const yLine = it.y + Number(it.size || 32) * 1.08;
    ctx.strokeStyle = it.color || "#111";
    ctx.lineWidth = Math.max(1, Math.round(Number(it.size || 32) / 18));
    ctx.beginPath();
    ctx.moveTo(it.x, yLine);
    ctx.lineTo(it.x + m.width, yLine);
    ctx.stroke();
  }
  ctx.restore();
}

async function getImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const img = new Image();
  img.crossOrigin = "anonymous";
  const p = new Promise((res, rej) => {
    img.onload = () => res(img);
    img.onerror = rej;
  });
  img.src = url;
  imageCache.set(url, p);
  return p;
}

async function drawDrawing(it) {
  if (!it.imageUrl) return;
  try {
    const img = await getImage(it.imageUrl);
    ctx.drawImage(img, it.x, it.y, it.w, it.h);
  } catch {}
}

function drawSelectionBox(it) {
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(it.x, it.y, it.w, it.h);
  ctx.setLineDash([]);

  const hs = [
    ["nw", it.x, it.y],
    ["ne", it.x + it.w, it.y],
    ["se", it.x + it.w, it.y + it.h],
    ["sw", it.x, it.y + it.h],
  ];

  for (const [, x, y] of hs) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

async function redraw() {
  drawBackground();

  for (const it of items) {
    if (it.kind === "text") drawText(it);
    if (it.kind === "drawing") await drawDrawing(it);
  }

  for (const s of strokes) drawStroke(s);
  if (currentStroke) drawStroke(currentStroke);

  const sel = getSelectedItem();
  if (sel) drawSelectionBox(sel);

  updateButtons();
}

/* =========================
   Hit testing
   ========================= */
function handleHit(it, x, y) {
  const corners = [
    ["nw", it.x, it.y],
    ["ne", it.x + it.w, it.y],
    ["se", it.x + it.w, it.y + it.h],
    ["sw", it.x, it.y + it.h],
  ];
  for (const [k, cx, cy] of corners) {
    const dx = x - cx;
    const dy = y - cy;
    if (Math.sqrt(dx * dx + dy * dy) <= HANDLE_RADIUS) return k;
  }
  return null;
}

function itemHit(x, y) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
  }
  return null;
}

/* =========================
   Editor (texte)
   ========================= */
function showEditor(x, y, initial, state) {
  editorState = { ...state, x, y };

  editorShell.style.display = "block";
  editorShell.style.left = `${x}px`;
  editorShell.style.top = `${y}px`;

  floatingEditor.value = initial || "";

  requestAnimationFrame(() => {
    floatingEditor.focus({ preventScroll: true });
    floatingEditor.setSelectionRange(floatingEditor.value.length, floatingEditor.value.length);
  });

  canvas.classList.add("canvas-disabled");
}

function hideEditor() {
  editorShell.style.display = "none";
  editorState = null;
  canvas.classList.remove("canvas-disabled");
}

editorCancel.addEventListener("click", hideEditor);

["pointerdown", "pointermove", "pointerup"].forEach((evt) => {
  editorShell.addEventListener(evt, (e) => e.stopPropagation());
});

/* =========================
   Undo/Redo Firestore (solide)
   ========================= */
async function applyInverse(action) {
  if (action.type === "create") {
    await deleteDoc(doc(db, "guestbook", action.id));
    if (selectedId === action.id) selectedId = null;
    return;
  }
  if (action.type === "delete") {
    if (!action.data) return;
    await setDoc(doc(db, "guestbook", action.id), action.data);
    return;
  }
  if (action.type === "update") {
    await updateDoc(doc(db, "guestbook", action.id), action.before);
    return;
  }
}

async function applyForward(action) {
  if (action.type === "create") {
    if (!action.data) return;
    await setDoc(doc(db, "guestbook", action.id), action.data);
    selectedId = action.id;
    return;
  }
  if (action.type === "delete") {
    await deleteDoc(doc(db, "guestbook", action.id));
    if (selectedId === action.id) selectedId = null;
    return;
  }
  if (action.type === "update") {
    await updateDoc(doc(db, "guestbook", action.id), action.after);
    return;
  }
}

async function undo() {
  if (mode === "draw" && strokes.length > 0) {
    const s = strokes.pop();
    redoStrokes.push(s);
    redraw();
    return;
  }

  const a = undoStack.pop();
  if (!a) return;

  await applyInverse(a);
  redoStack.push(a);
  redraw();
}

async function redo() {
  if (mode === "draw" && redoStrokes.length > 0) {
    const s = redoStrokes.pop();
    strokes.push(s);
    redraw();
    return;
  }

  const a = redoStack.pop();
  if (!a) return;

  await applyForward(a);
  undoStack.push(a);
  redraw();
}

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

/* =========================
   Create/Edit text
   ========================= */
editorOk.addEventListener("click", async () => {
  if (!editorState) return;

  const txt = (floatingEditor.value || "").trim();
  if (!txt) {
    hideEditor();
    return;
  }

  try {
    if (editorState.mode === "create") {
      const style = getTextStyle();
      const temp = { kind: "text", text: txt, x: editorState.x, y: editorState.y, ...style };
      const { w, h } = measureTextBox(temp);

      const idRef = doc(collection(db, "guestbook"));
      const data = {
        kind: "text",
        createdAt: Date.now(),
        text: txt,
        x: editorState.x,
        y: editorState.y,
        w,
        h,
        ...style,
      };

      await setDoc(idRef, data);

      undoStack.push({ type: "create", id: idRef.id, data });
      redoStack.length = 0;
      selectedId = idRef.id;
    }

    if (editorState.mode === "edit" && editorState.id) {
      const ref = doc(db, "guestbook", editorState.id);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        hideEditor();
        return;
      }
      const beforeDoc = snap.data();
      const temp = { ...beforeDoc, text: txt };
      const { w, h } = measureTextBox(temp);

      const before = { text: beforeDoc.text, w: beforeDoc.w, h: beforeDoc.h };
      const after = { text: txt, w, h };

      await updateDoc(ref, after);

      undoStack.push({ type: "update", id: editorState.id, before, after });
      redoStack.length = 0;
    }
  } catch (e) {
    alert("Erreur texte : " + (e?.message || e));
  } finally {
    hideEditor();
    redraw();
  }
});

/* =========================
   Style buttons -> update selected text style
   ========================= */
async function updateSelectedTextStyle() {
  const it = getSelectedItem();
  if (!it || it.kind !== "text") return;

  const ref = doc(db, "guestbook", it.id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;

  const beforeDoc = snap.data();

  const style = getTextStyle();
  const temp = { ...beforeDoc, ...style };
  const { w, h } = measureTextBox(temp);

  const before = {
    font: beforeDoc.font,
    size: beforeDoc.size,
    color: beforeDoc.color,
    bold: !!beforeDoc.bold,
    italic: !!beforeDoc.italic,
    underline: !!beforeDoc.underline,
    w: beforeDoc.w,
    h: beforeDoc.h,
  };

  const after = { ...style, w, h };

  await updateDoc(ref, after);

  undoStack.push({ type: "update", id: it.id, before, after });
  redoStack.length = 0;
  redraw();
}

boldBtn.addEventListener("click", async () => {
  applyActive(boldBtn, !boldBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});
italicBtn.addEventListener("click", async () => {
  applyActive(italicBtn, !italicBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});
underlineBtn.addEventListener("click", async () => {
  applyActive(underlineBtn, !underlineBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});

fontSel.addEventListener("change", updateSelectedTextStyle);
sizeInput.addEventListener("change", updateSelectedTextStyle);
colorInput.addEventListener("change", updateSelectedTextStyle);

/* =========================
   Pointer interactions
   ========================= */
async function onPointerDown(e) {
  if (editorOpen()) return;
  if (e.button != null && e.button !== 0) return;

  canvas.setPointerCapture?.(e.pointerId);

  const { x, y } = posFromEvent(e);

  const hit = itemHit(x, y);
  if (hit) {
    selectedId = hit.id;

    const h = handleHit(hit, x, y);
    drag = h
      ? { type: "resize", handle: h, startX: x, startY: y, orig: { ...hit } }
      : { type: "move", startX: x, startY: y, orig: { ...hit } };

    redraw();
    return;
  }

  selectedId = null;
  redraw();

  if (mode === "text") {
    showEditor(x, y, "", { mode: "create" });
    return;
  }

  if (mode === "draw") {
    isDrawing = true;
    currentStroke = {
      color: penColorInput.value,
      width: Number(penSizeInput.value || 6),
      points: [{ x, y }],
    };
    redoStrokes = [];
    redraw();
  }
}

async function onPointerMove(e) {
  if (editorOpen()) return;

  const { x, y } = posFromEvent(e);

  if (mode === "draw" && isDrawing && currentStroke) {
    currentStroke.points.push({ x, y });
    redraw();
    return;
  }

  if (!drag) return;

  const it = getSelectedItem();
  if (!it) return;

  const dx = x - drag.startX;
  const dy = y - drag.startY;

  if (drag.type === "move") {
    it.x = drag.orig.x + dx;
    it.y = drag.orig.y + dy;
  } else {
    let nx = drag.orig.x,
      ny = drag.orig.y,
      nw = drag.orig.w,
      nh = drag.orig.h;

    if (drag.handle.includes("e")) nw = drag.orig.w + dx;
    if (drag.handle.includes("s")) nh = drag.orig.h + dy;
    if (drag.handle.includes("w")) {
      nw = drag.orig.w - dx;
      nx = drag.orig.x + dx;
    }
    if (drag.handle.includes("n")) {
      nh = drag.orig.h - dy;
      ny = drag.orig.y + dy;
    }

    nw = clamp(nw, MIN_W, 5000);
    nh = clamp(nh, MIN_H, 5000);

    it.x = nx;
    it.y = ny;
    it.w = nw;
    it.h = nh;
  }

  redraw();
}

async function onPointerUp(e) {
  if (editorOpen()) return;

  try {
    canvas.releasePointerCapture?.(e.pointerId);
  } catch {}

  if (mode === "draw" && isDrawing) {
    isDrawing = false;
    if (currentStroke) {
      strokes.push(currentStroke);
      currentStroke = null;
      redraw();
    }
    return;
  }

  if (!drag) return;

  const it = getSelectedItem();
  const orig = drag.orig;
  drag = null;
  if (!it) return;

  const changed = it.x !== orig.x || it.y !== orig.y || it.w !== orig.w || it.h !== orig.h;
  if (!changed) return;

  try {
    const ref = doc(db, "guestbook", it.id);
    const before = { x: orig.x, y: orig.y, w: orig.w, h: orig.h };
    const after = { x: it.x, y: it.y, w: it.w, h: it.h };

    await updateDoc(ref, after);

    undoStack.push({ type: "update", id: it.id, before, after });
    redoStack.length = 0;
  } catch (e) {
    alert("Impossible de déplacer/redimensionner : " + (e?.message || e));
  }

  redraw();
}

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);

canvas.addEventListener("dblclick", (e) => {
  if (editorOpen()) return;

  const { x, y } = posFromEvent(e);
  const hit = itemHit(x, y);
  if (!hit || hit.kind !== "text") return;

  selectedId = hit.id;
  redraw();
  showEditor(hit.x, hit.y, hit.text || "", { mode: "edit", id: hit.id });
});

/* =========================
   Delete selected
   ========================= */
deleteBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  if (!confirm("Supprimer cet élément ?")) return;

  const it = getSelectedItem();
  if (!it) return;

  try {
    const ref = doc(db, "guestbook", it.id);
    const snap = await getDoc(ref);
    const data = snap.exists() ? snap.data() : null;

    await deleteDoc(ref);

    undoStack.push({ type: "delete", id: it.id, data });
    redoStack.length = 0;

    selectedId = null;
    redraw();
  } catch (e) {
    alert("Suppression impossible : " + (e?.message || e));
  }
});

/* =========================
   Publish drawing (strokes -> image -> Firestore item)
   ========================= */
publishBtn.addEventListener("click", async () => {
  if (mode !== "draw" || strokes.length === 0) return;

  // Loading sans emoji
  publishBtn.disabled = true;
  publishBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Publication…`;

  try {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;

    for (const s of strokes) {
      for (const p of s.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    const pad = 18;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);

    const rect = canvas.getBoundingClientRect();
    maxX = Math.min(rect.width, maxX + pad);
    maxY = Math.min(rect.height, maxY + pad);

    const w = Math.max(80, maxX - minX);
    const h = Math.max(80, maxY - minY);

    const off = document.createElement("canvas");
    off.width = Math.round(w);
    off.height = Math.round(h);

    const octx = off.getContext("2d");
    octx.fillStyle = "#fff";
    octx.fillRect(0, 0, off.width, off.height);

    for (const s of strokes) {
      octx.lineCap = "round";
      octx.lineJoin = "round";
      octx.strokeStyle = s.color;
      octx.lineWidth = s.width;

      const pts = s.points;
      if (!pts.length) continue;

      octx.beginPath();
      octx.moveTo(pts[0].x - minX, pts[0].y - minY);
      for (let i = 1; i < pts.length; i++) octx.lineTo(pts[i].x - minX, pts[i].y - minY);
      octx.stroke();
    }

    const blob = await new Promise((res) => off.toBlob(res, "image/png"));
    if (!blob) throw new Error("Impossible de générer l'image.");

    const file = new File([blob], `dessin-${Date.now()}.png`, { type: "image/png" });
    const up = await uploadImage(file);

    const idRef = doc(collection(db, "guestbook"));
    const data = {
      kind: "drawing",
      createdAt: Date.now(),
      imageUrl: up.secure_url,
      x: minX,
      y: minY,
      w,
      h,
    };

    await setDoc(idRef, data);

    undoStack.push({ type: "create", id: idRef.id, data });
    redoStack.length = 0;

    strokes = [];
    redoStrokes = [];
    selectedId = idRef.id;

    redraw();
  } catch (e) {
    alert("Erreur publication : " + (e?.message || e));
  } finally {
    // restore button
    publishBtn.disabled = false;
    publishBtn.textContent = "Publier";
  }
});

/* =========================
   Export PNG
   ========================= */
exportBtn.addEventListener("click", async () => {
  await redraw();
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `livre-dor-${Date.now()}.png`;
  a.click();
});

/* =========================
   Tool buttons
   ========================= */
toolTextBtn.addEventListener("click", () => setMode("text"));
toolDrawBtn.addEventListener("click", () => setMode("draw"));

/* =========================
   Keyboard (Ctrl+Z / Ctrl+Shift+Z)
   ========================= */
document.addEventListener("keydown", (e) => {
  if (editorOpen()) {
    if (e.key === "Escape") hideEditor();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      editorOk.click();
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }
});

/* =========================
   Firestore realtime
   ========================= */
async function main() {
  await ensureAnonAuth();

  hideEditor();

  const q = query(collection(db, "guestbook"), orderBy("createdAt", "asc"));

  onSnapshot(q, (snap) => {
    items = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .map((it) => {
        if (typeof it.x !== "number") it.x = 40;
        if (typeof it.y !== "number") it.y = 40;

        if (it.kind === "text") {
          it.bold = !!it.bold;
          it.italic = !!it.italic;
          it.underline = !!it.underline;

          if (typeof it.w !== "number" || typeof it.h !== "number") {
            const b = measureTextBox(it);
            it.w = b.w;
            it.h = b.h;
          }
        }

        if (it.kind === "drawing") {
          if (typeof it.w !== "number") it.w = 240;
          if (typeof it.h !== "number") it.h = 160;
        }

        return it;
      });

    if (selectedId && !items.some((i) => i.id === selectedId)) selectedId = null;
    redraw();
  });

  dprResize();
  window.addEventListener("resize", dprResize);

  setMode("text");
}

main();
