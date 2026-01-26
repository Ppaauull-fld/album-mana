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
   DOM (match ton HTML)
   ========================= */
const canvas = document.getElementById("guestCanvas");
const ctx = canvas?.getContext?.("2d");

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

const alignLeftBtn = document.getElementById("alignLeft");
const alignCenterBtn = document.getElementById("alignCenter");
const alignRightBtn = document.getElementById("alignRight");
const alignJustifyBtn = document.getElementById("alignJustify");

const penSizeInput = document.getElementById("penSize");
const penColorInput = document.getElementById("penColor");
const publishBtn = document.getElementById("publish");

const undoBtn = document.getElementById("undo");
const redoBtn = document.getElementById("redo");
const deleteBtn = document.getElementById("deleteSelected");

const exportMenuBtn = document.getElementById("exportMenuBtn");
const exportMenu = document.getElementById("exportMenu");
const exportPngBtn = document.getElementById("exportPng");
const exportPdfBtn = document.getElementById("exportPdf");

const hint = document.getElementById("hint");

const editorShell = document.getElementById("editorShell");
const floatingEditor = document.getElementById("floatingEditor");
const editorOk = document.getElementById("editorOk");
const editorCancel = document.getElementById("editorCancel");

/* =========================
   Guard
   ========================= */
if (!canvas || !ctx) {
  console.error("[livre-dor] canvas introuvable");
}

/* =========================
   State
   ========================= */
let mode = "text";
let items = [];
const imageCache = new Map();

let selectedId = null;
let drag = null; // {type, ...}
let editorState = null;

const HANDLE_RADIUS = 14;
const MIN_W = 60;
const MIN_H = 40;

// Drawing local (non publié)
let isDrawing = false;
let currentStroke = null;
let strokes = [];
let redoStrokes = [];

// Undo/redo Firestore
const undoStack = [];
const redoStack = [];

/* =========================
   Pan/Zoom camera
   ========================= */
const camera = {
  x: 0,
  y: 0,
  z: 1, // zoom
  minZ: 0.35,
  maxZ: 3.0,
};

let isPanning = false;
let panStart = null;
let spaceDown = false;

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
function setCanvasCursor(cur) {
  if (!canvas) return;
  canvas.style.cursor = cur;
}

function getAlign() {
  if (alignCenterBtn?.classList.contains("active")) return "center";
  if (alignRightBtn?.classList.contains("active")) return "right";
  if (alignJustifyBtn?.classList.contains("active")) return "justify";
  return "left";
}

function setAlignUI(align) {
  const a = align || "left";
  applyActive(alignLeftBtn, a === "left");
  applyActive(alignCenterBtn, a === "center");
  applyActive(alignRightBtn, a === "right");
  applyActive(alignJustifyBtn, a === "justify");
}

function getTextStyle() {
  return {
    font: fontSel?.value || "Georgia",
    size: Number(sizeInput?.value || 32),
    color: colorInput?.value || "#111111",
    bold: !!boldBtn?.classList.contains("active"),
    italic: !!italicBtn?.classList.contains("active"),
    underline: !!underlineBtn?.classList.contains("active"),
    align: getAlign(), // NEW
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

function applyCameraTransform() {
  // transform “world -> screen”
  ctx.setTransform(camera.z, 0, 0, camera.z, camera.x, camera.y);
}

function screenToWorld(sx, sy) {
  // world = (screen - translate) / zoom
  return {
    x: (sx - camera.x) / camera.z,
    y: (sy - camera.y) / camera.z,
  };
}

function worldToScreen(wx, wy) {
  return {
    x: wx * camera.z + camera.x,
    y: wy * camera.z + camera.y,
  };
}

function posFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  return { sx, sy, ...screenToWorld(sx, sy) };
}

/* =========================
   Measure + wrapping + justify
   ========================= */
function wrapTextLines(text, it, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  if (!words.length) return lines;

  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const test = line + " " + w;
    const mw = ctx.measureText(test).width;
    if (mw <= maxWidth) line = test;
    else {
      lines.push(line);
      line = w;
    }
  }
  lines.push(line);
  return lines;
}

function measureTextBox(it) {
  if (!ctx) return { w: 240, h: 120 };

  ctx.save();
  ctx.font = buildFontCss(it);

  // largeur par défaut (si pas définie) : un bloc raisonnable
  const targetW = clamp(Number(it.w || 420), 240, 900);

  const padX = 16;
  const padY = 12;
  const maxLineW = targetW - padX * 2;

  const lines = wrapTextLines(it.text || "", it, maxLineW);
  const lineH = Math.max(18, Number(it.size || 32) * 1.25);

  // si texte très court -> ajuster w au contenu
  let widest = 0;
  for (const ln of lines.length ? lines : [it.text || ""]) {
    widest = Math.max(widest, ctx.measureText(ln).width);
  }

  const w = clamp(Math.ceil(widest + padX * 2), MIN_W, 900);
  const h = clamp(Math.ceil(lines.length * lineH + padY * 2), MIN_H, 4000);

  ctx.restore();
  return { w, h, lines, lineH, padX, padY };
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
      ? "Texte : clique pour ajouter • Double clic pour éditer • Déplacement : espace + glisser • Zoom : Ctrl/Cmd + molette"
      : "Dessin : dessine • Annuler/Rétablir = traits • Publier pour ajouter • Déplacement : espace + glisser • Zoom : Ctrl/Cmd + molette"
  );

  updateButtons();
  redraw();
}

function updateButtons() {
  if (!undoBtn || !redoBtn || !deleteBtn || !publishBtn) return;

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
   Canvas sizing (DPR safe)
   ========================= */
function dprResize() {
  if (!canvas || !ctx) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  // IMPORTANT: on dessine en pixels CSS, donc on compense DPR via scale
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  redraw();
}

/* =========================
   Rendering
   ========================= */
function clearBackground() {
  // clear en coord screen : on reset, puis clear, puis on remet camera
  const tr = ctx.getTransform();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(tr);
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

  const align = it.align || "left";
  const { w, h, lines, lineH, padX, padY } = measureTextBox(it);

  // bounding box (w/h déjà sur it normalement)
  const boxW = it.w || w;
  const boxH = it.h || h;
  const innerW = Math.max(10, boxW - padX * 2);

  const startX = it.x + padX;
  const startY = it.y + padY;

  // draw lines
  if (align === "justify") {
    // Justify all lines except last
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const y = startY + li * lineH;

      // last line -> left
      if (li === lines.length - 1) {
        ctx.fillText(line, startX, y);
        continue;
      }

      const words = line.split(" ");
      if (words.length <= 1) {
        ctx.fillText(line, startX, y);
        continue;
      }

      const totalWordsW = words.reduce((acc, w) => acc + ctx.measureText(w).width, 0);
      const gaps = words.length - 1;
      const extra = Math.max(0, innerW - totalWordsW);
      const gapW = extra / gaps;

      let x = startX;
      for (let wi = 0; wi < words.length; wi++) {
        const word = words[wi];
        ctx.fillText(word, x, y);
        x += ctx.measureText(word).width + (wi < gaps ? gapW : 0);
      }
    }
  } else {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const y = startY + li * lineH;
      const lw = ctx.measureText(line).width;

      let x = startX;
      if (align === "center") x = it.x + boxW / 2 - lw / 2;
      if (align === "right") x = it.x + boxW - padX - lw;

      ctx.fillText(line, x, y);
    }
  }

  // underline : on underline chaque ligne
  if (it.underline) {
    ctx.strokeStyle = it.color || "#111";
    ctx.lineWidth = Math.max(1, Math.round(Number(it.size || 32) / 18));
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const y = startY + li * lineH + Number(it.size || 32) * 1.08;

      let x = startX;
      let lw = ctx.measureText(line).width;

      if (align === "center") x = it.x + boxW / 2 - lw / 2;
      if (align === "right") x = it.x + boxW - padX - lw;

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + lw, y);
      ctx.stroke();
    }
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
  if (!ctx || !canvas) return;

  // reset DPR transform then camera
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  clearBackground();

  // now apply camera in CSS pixels space (so combine DPR then camera)
  // easiest: multiply camera into current transform
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.z, camera.z);

  // items are stored in WORLD coordinates
  for (const it of items) {
    if (it.kind === "text") drawText(it);
    if (it.kind === "drawing") await drawDrawing(it);
  }

  // strokes are WORLD coords too
  for (const s of strokes) drawStroke(s);
  if (currentStroke) drawStroke(currentStroke);

  const sel = getSelectedItem();
  if (sel) drawSelectionBox(sel);

  updateButtons();
}

/* =========================
   Hit testing (WORLD coords)
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
function showEditor(worldX, worldY, initial, state) {
  if (!editorShell || !floatingEditor || !canvas) return;

  editorState = { ...state, x: worldX, y: worldY };

  // position editor in SCREEN coords
  const scr = worldToScreen(worldX, worldY);
  editorShell.style.display = "block";
  editorShell.style.left = `${scr.x}px`;
  editorShell.style.top = `${scr.y}px`;

  floatingEditor.value = initial || "";

  requestAnimationFrame(() => {
    floatingEditor.focus({ preventScroll: true });
    floatingEditor.setSelectionRange(floatingEditor.value.length, floatingEditor.value.length);
  });

  canvas.classList.add("canvas-disabled");
}

function hideEditor() {
  if (!editorShell || !canvas) return;
  editorShell.style.display = "none";
  editorState = null;
  canvas.classList.remove("canvas-disabled");
}

editorCancel?.addEventListener("click", hideEditor);
["pointerdown", "pointermove", "pointerup"].forEach((evt) => {
  editorShell?.addEventListener(evt, (e) => e.stopPropagation());
});

/* =========================
   Undo/Redo Firestore
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

undoBtn?.addEventListener("click", undo);
redoBtn?.addEventListener("click", redo);

/* =========================
   Create/Edit text
   ========================= */
editorOk?.addEventListener("click", async () => {
  if (!editorState) return;

  const txt = (floatingEditor?.value || "").trim();
  if (!txt) {
    hideEditor();
    return;
  }

  try {
    if (editorState.mode === "create") {
      const style = getTextStyle();

      // default box width
      const temp = { kind: "text", text: txt, x: editorState.x, y: editorState.y, w: 420, h: 120, ...style };
      const m = measureTextBox(temp);

      const idRef = doc(collection(db, "guestbook"));
      const data = {
        kind: "text",
        createdAt: Date.now(),
        text: txt,
        x: editorState.x,
        y: editorState.y,
        w: m.w,
        h: m.h,
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
      const style = {
        font: beforeDoc.font,
        size: beforeDoc.size,
        color: beforeDoc.color,
        bold: !!beforeDoc.bold,
        italic: !!beforeDoc.italic,
        underline: !!beforeDoc.underline,
        align: beforeDoc.align || "left",
      };

      const temp = { ...beforeDoc, ...style, text: txt };
      const m = measureTextBox(temp);

      const before = { text: beforeDoc.text, w: beforeDoc.w, h: beforeDoc.h };
      const after = { text: txt, w: m.w, h: m.h };

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
   Style / Align -> update selected text
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
  const m = measureTextBox({ ...temp, w: beforeDoc.w || 420 });

  const before = {
    font: beforeDoc.font,
    size: beforeDoc.size,
    color: beforeDoc.color,
    bold: !!beforeDoc.bold,
    italic: !!beforeDoc.italic,
    underline: !!beforeDoc.underline,
    align: beforeDoc.align || "left",
    w: beforeDoc.w,
    h: beforeDoc.h,
  };

  const after = { ...style, w: m.w, h: m.h };

  await updateDoc(ref, after);
  undoStack.push({ type: "update", id: it.id, before, after });
  redoStack.length = 0;
  redraw();
}

boldBtn?.addEventListener("click", async () => {
  applyActive(boldBtn, !boldBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});
italicBtn?.addEventListener("click", async () => {
  applyActive(italicBtn, !italicBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});
underlineBtn?.addEventListener("click", async () => {
  applyActive(underlineBtn, !underlineBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});

fontSel?.addEventListener("change", updateSelectedTextStyle);
sizeInput?.addEventListener("change", updateSelectedTextStyle);
colorInput?.addEventListener("change", updateSelectedTextStyle);

// Align buttons
alignLeftBtn?.addEventListener("click", async () => {
  setAlignUI("left");
  await updateSelectedTextStyle();
});
alignCenterBtn?.addEventListener("click", async () => {
  setAlignUI("center");
  await updateSelectedTextStyle();
});
alignRightBtn?.addEventListener("click", async () => {
  setAlignUI("right");
  await updateSelectedTextStyle();
});
alignJustifyBtn?.addEventListener("click", async () => {
  setAlignUI("justify");
  await updateSelectedTextStyle();
});

/* =========================
   Pointer interactions (pan / draw / move / resize)
   ========================= */
async function onPointerDown(e) {
  if (!canvas) return;
  if (editorOpen()) return;
  if (e.button != null && e.button !== 0) return;

  canvas.setPointerCapture?.(e.pointerId);

  const { x, y } = posFromEvent(e);

  // PAN if space pressed
  if (spaceDown) {
    isPanning = true;
    panStart = { sx: e.clientX, sy: e.clientY, cx: camera.x, cy: camera.y };
    setCanvasCursor("grabbing");
    return;
  }

  const hit = itemHit(x, y);
  if (hit) {
    selectedId = hit.id;

    // sync UI style with selected text
    if (hit.kind === "text") {
      setAlignUI(hit.align || "left");
      applyActive(boldBtn, !!hit.bold);
      applyActive(italicBtn, !!hit.italic);
      applyActive(underlineBtn, !!hit.underline);
      if (fontSel) fontSel.value = hit.font || "Georgia";
      if (sizeInput) sizeInput.value = String(hit.size || 32);
      if (colorInput) colorInput.value = hit.color || "#111111";
    }

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
      color: penColorInput?.value || "#111111",
      width: Number(penSizeInput?.value || 6),
      points: [{ x, y }],
    };
    redoStrokes = [];
    redraw();
  }
}

async function onPointerMove(e) {
  if (editorOpen()) return;

  // PAN
  if (isPanning && panStart) {
    const dx = e.clientX - panStart.sx;
    const dy = e.clientY - panStart.sy;
    camera.x = panStart.cx + dx;
    camera.y = panStart.cy + dy;
    redraw();
    return;
  }

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
  if (!canvas) return;
  if (editorOpen()) return;

  try {
    canvas.releasePointerCapture?.(e.pointerId);
  } catch {}

  if (isPanning) {
    isPanning = false;
    panStart = null;
    setCanvasCursor(spaceDown ? "grab" : "default");
    return;
  }

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

canvas?.addEventListener("pointerdown", onPointerDown);
canvas?.addEventListener("pointermove", onPointerMove);
canvas?.addEventListener("pointerup", onPointerUp);
canvas?.addEventListener("pointercancel", onPointerUp);

canvas?.addEventListener("dblclick", (e) => {
  if (editorOpen()) return;

  const { x, y } = posFromEvent(e);
  const hit = itemHit(x, y);
  if (!hit || hit.kind !== "text") return;

  selectedId = hit.id;
  redraw();
  showEditor(hit.x, hit.y, hit.text || "", { mode: "edit", id: hit.id });
});

/* =========================
   Zoom (Ctrl/Cmd + wheel)
   ========================= */
canvas?.addEventListener(
  "wheel",
  (e) => {
    const isZoom = e.ctrlKey || e.metaKey;
    if (!isZoom) return;

    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const before = screenToWorld(sx, sy);

    const delta = -e.deltaY; // up => zoom in
    const factor = delta > 0 ? 1.08 : 1 / 1.08;

    const newZ = clamp(camera.z * factor, camera.minZ, camera.maxZ);
    camera.z = newZ;

    const after = screenToWorld(sx, sy);

    // keep point under cursor stable
    camera.x += (after.x - before.x) * camera.z;
    camera.y += (after.y - before.y) * camera.z;

    redraw();
  },
  { passive: false }
);

/* =========================
   Delete selected
   ========================= */
deleteBtn?.addEventListener("click", async () => {
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
publishBtn?.addEventListener("click", async () => {
  if (mode !== "draw" || strokes.length === 0) return;

  setBtnLoading(publishBtn, true, { label: "Publication…" });

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
    minX = minX - pad;
    minY = minY - pad;
    maxX = maxX + pad;
    maxY = maxY + pad;

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
    setBtnLoading(publishBtn, false);
    publishBtn.textContent = "Publier";
  }
});

/* =========================
   Export (PNG / PDF)
   ========================= */
function closeExportMenu() {
  if (!exportMenu) return;
  exportMenu.setAttribute("aria-hidden", "true");
  exportMenu.style.display = "none";
}
function toggleExportMenu() {
  if (!exportMenu) return;
  const isHidden = exportMenu.getAttribute("aria-hidden") !== "false";
  exportMenu.setAttribute("aria-hidden", isHidden ? "false" : "true");
  exportMenu.style.display = isHidden ? "block" : "none";
}

exportMenuBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleExportMenu();
});

document.addEventListener("click", () => closeExportMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeExportMenu();
});

async function exportPng() {
  await redraw();

  // export in screen space: on remet camera neutre le temps de l’export
  const prev = { ...camera };
  camera.x = 0;
  camera.y = 0;
  camera.z = 1;
  await redraw();

  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `livre-dor-${Date.now()}.png`;
  a.click();

  Object.assign(camera, prev);
  await redraw();
}

async function exportPdf() {
  await redraw();

  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) {
    alert("jsPDF non chargé.");
    return;
  }

  const prev = { ...camera };
  camera.x = 0;
  camera.y = 0;
  camera.z = 1;
  await redraw();

  const dataUrl = canvas.toDataURL("image/png");

  const pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = dataUrl;
  });

  const ratio = Math.min(pageW / img.width, pageH / img.height);
  const w = img.width * ratio;
  const h = img.height * ratio;
  const x = (pageW - w) / 2;
  const y = (pageH - h) / 2;

  pdf.addImage(dataUrl, "PNG", x, y, w, h);
  pdf.save(`livre-dor-${Date.now()}.pdf`);

  Object.assign(camera, prev);
  await redraw();
}

exportPngBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeExportMenu();
  await exportPng();
});

exportPdfBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeExportMenu();
  await exportPdf();
});

/* =========================
   Keyboard
   ========================= */
document.addEventListener("keydown", (e) => {
  // Space pan
  if (e.code === "Space" && !editorOpen()) {
    spaceDown = true;
    setCanvasCursor(isPanning ? "grabbing" : "grab");
    // éviter page scroll sur espace
    e.preventDefault();
  }

  // Undo/Redo
  if (editorOpen()) {
    if (e.key === "Escape") hideEditor();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      editorOk?.click();
    }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }
});

document.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    spaceDown = false;
    setCanvasCursor("default");
  }
});

/* =========================
   Tool buttons
   ========================= */
toolTextBtn?.addEventListener("click", () => setMode("text"));
toolDrawBtn?.addEventListener("click", () => setMode("draw"));

/* =========================
   Firestore realtime
   ========================= */
async function main() {
  await ensureAnonAuth();
  hideEditor();

  // close export menu at start
  closeExportMenu();

  const q = query(collection(db, "guestbook"), orderBy("createdAt", "asc"));

  onSnapshot(q, (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() })).map((it) => {
      if (typeof it.x !== "number") it.x = 40;
      if (typeof it.y !== "number") it.y = 40;

      if (it.kind === "text") {
        it.bold = !!it.bold;
        it.italic = !!it.italic;
        it.underline = !!it.underline;
        it.align = it.align || "left";

        // ensure w/h exist
        if (typeof it.w !== "number" || typeof it.h !== "number") {
          const m = measureTextBox({ ...it, w: it.w || 420 });
          it.w = m.w;
          it.h = m.h;
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

  setAlignUI("left");
  setMode("text");
  setCanvasCursor("default");
}

if (canvas && ctx) main();
