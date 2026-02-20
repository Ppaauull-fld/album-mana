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
   Safe DOM getters
   ========================= */
const canvas = document.getElementById("guestCanvas");
if (!canvas) console.error("[livre-dor] canvas #guestCanvas introuvable");
const ctx = canvas?.getContext?.("2d");

const toolCursorBtn = document.getElementById("toolCursor");
const toolMoveBtn = document.getElementById("toolMove");
const toolTextBtn = document.getElementById("toolText");
const toolDrawBtn = document.getElementById("toolDraw");
const toolTabsGroup = document.getElementById("toolTabsGroup");
const toolPickerBtn = document.getElementById("toolPickerBtn");
const toolPickerMenu = document.getElementById("toolPickerMenu");
const toolPickerCurrentIcon = document.getElementById("toolPickerCurrentIcon");
const toolPickerCurrentLabel = document.getElementById("toolPickerCurrentLabel");

const textControls = document.getElementById("textControls");
const drawControls = document.getElementById("drawControls");

const fontSel = document.getElementById("font");
const sizeInput = document.getElementById("size");
const colorInput = document.getElementById("color");
const boldBtn = document.getElementById("boldBtn");
const italicBtn = document.getElementById("italicBtn");
const underlineBtn = document.getElementById("underlineBtn");

// Align buttons
const alignLeftBtn = document.getElementById("alignLeftBtn");
const alignCenterBtn = document.getElementById("alignCenterBtn");
const alignRightBtn = document.getElementById("alignRightBtn");
const alignJustifyBtn = document.getElementById("alignJustifyBtn");

const penSizeInput = document.getElementById("penSize");
const penColorInput = document.getElementById("penColor");
const publishBtn = document.getElementById("publish");

const undoBtn = document.getElementById("undo");
const redoBtn = document.getElementById("redo");
const deleteBtn = document.getElementById("deleteSelected");

const exportMenuBtn = document.getElementById("exportCanvasBtn");
const exportFormatSel = document.getElementById("exportFormat");

const hint = document.getElementById("hint");

// editor
const editorShell = document.getElementById("editorShell");
const floatingEditor = document.getElementById("floatingEditor");
const editorOk = document.getElementById("editorOk");
const editorCancel = document.getElementById("editorCancel");
const minimapToggleBtn = document.getElementById("minimapToggle");
const minimapPanel = document.getElementById("minimapPanel");
const minimapCanvas = document.getElementById("minimapCanvas");
const minimapCtx = minimapCanvas?.getContext?.("2d");

/* =========================
   State
   ========================= */
let mode = "cursor"; // cursor | move | text | draw
let items = [];
const imageCache = new Map();
const TOOL_META = {
  cursor: { label: "Curseur", icon: "../assets/img/icons/cursor.svg" },
  move: { label: "Deplacement", icon: "../assets/img/icons/move.svg" },
  text: { label: "Texte", icon: "../assets/img/icons/text.svg" },
  draw: { label: "Dessin", icon: "../assets/img/icons/pencil.svg" },
};

let selectedId = null;
let drag = null;

const HANDLE_RADIUS = 14;
const MIN_W = 60;
const MIN_H = 40;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_MAX_DIST = 22;
let lastTextTap = { time: 0, x: 0, y: 0, id: null };

// drawing local (non publié)
let isDrawing = false;
let currentStroke = null;
let strokes = [];
let redoStrokes = [];

// global undo/redo (Firestore)
const undoStack = [];
const redoStack = [];

// editor state: { mode:"create"|"edit", id?, x,y }  (x,y = monde)
let editorState = null;

/* =========================
   Camera (pan)
   ========================= */
let camX = 0;
let camY = 0;

let isPanning = false;
let panStart = null;

let minimapCollapsed = false;
let minimapDrag = null;
let minimapFrame = null;
let minimapViewportRect = null;

function screenToWorld(p) {
  return { x: p.x + camX, y: p.y + camY };
}
function worldToScreen(p) {
  return { x: p.x - camX, y: p.y - camY };
}

function getViewportWorldRect() {
  const rect = getCanvasCssRect();
  return {
    x: camX,
    y: camY,
    w: Math.max(1, rect.width),
    h: Math.max(1, rect.height),
  };
}

function worldToMinimapPoint(x, y, frame) {
  return {
    x: frame.offsetX + (x - frame.minX) * frame.scale,
    y: frame.offsetY + (y - frame.minY) * frame.scale,
  };
}

function minimapToWorldPoint(x, y, frame) {
  const clampedX = clamp(x, frame.offsetX, frame.offsetX + frame.drawW);
  const clampedY = clamp(y, frame.offsetY, frame.offsetY + frame.drawH);
  return {
    x: frame.minX + (clampedX - frame.offsetX) / frame.scale,
    y: frame.minY + (clampedY - frame.offsetY) / frame.scale,
  };
}

function worldRectToMinimapRect(x, y, w, h, frame) {
  const p0 = worldToMinimapPoint(x, y, frame);
  const p1 = worldToMinimapPoint(x + w, y + h, frame);
  return {
    x: p0.x,
    y: p0.y,
    w: Math.max(1, p1.x - p0.x),
    h: Math.max(1, p1.y - p0.y),
  };
}

function pointInRect(p, r) {
  if (!r) return false;
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function getMinimapPointerPos(e) {
  if (!minimapCanvas) return null;
  const rect = minimapCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function computeMinimapWorldBounds() {
  const view = getViewportWorldRect();
  let minX = view.x;
  let minY = view.y;
  let maxX = view.x + view.w;
  let maxY = view.y + view.h;

  const includeRect = (x, y, w, h) => {
    if (![x, y, w, h].every((n) => typeof n === "number" && isFinite(n))) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };

  const includeStroke = (stroke) => {
    if (!stroke?.points?.length) return;
    const strokeW = Number(stroke.width || 6);
    for (const p of stroke.points) {
      minX = Math.min(minX, p.x - strokeW);
      minY = Math.min(minY, p.y - strokeW);
      maxX = Math.max(maxX, p.x + strokeW);
      maxY = Math.max(maxY, p.y + strokeW);
    }
  };

  includeRect(view.x, view.y, view.w, view.h);
  for (const it of items) includeRect(it.x, it.y, it.w, it.h);
  for (const s of strokes) includeStroke(s);
  if (currentStroke) includeStroke(currentStroke);

  const span = Math.max(maxX - minX, maxY - minY, 1);
  const pad = Math.max(80, span * 0.08);

  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

function drawMinimapStroke(stroke, frame, color) {
  if (!minimapCtx || !stroke?.points?.length) return;
  const first = worldToMinimapPoint(stroke.points[0].x, stroke.points[0].y, frame);

  minimapCtx.save();
  minimapCtx.strokeStyle = color;
  minimapCtx.lineCap = "round";
  minimapCtx.lineJoin = "round";
  minimapCtx.lineWidth = clamp(Number(stroke.width || 1) * frame.scale, 0.6, 2.8);
  minimapCtx.beginPath();
  minimapCtx.moveTo(first.x, first.y);

  for (let i = 1; i < stroke.points.length; i++) {
    const p = worldToMinimapPoint(stroke.points[i].x, stroke.points[i].y, frame);
    minimapCtx.lineTo(p.x, p.y);
  }

  minimapCtx.stroke();
  minimapCtx.restore();
}

function updateMinimapToggleUi() {
  if (!minimapToggleBtn || !minimapPanel) return;
  const expanded = !minimapCollapsed;
  const label = expanded ? "Masquer la mini-carte" : "Afficher la mini-carte";

  minimapPanel.hidden = !expanded;
  minimapToggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
  minimapToggleBtn.setAttribute("aria-label", label);
  minimapToggleBtn.title = label;
}

function setMinimapCollapsed(nextCollapsed) {
  minimapCollapsed = !!nextCollapsed;
  if (minimapCollapsed) {
    minimapDrag = null;
    minimapFrame = null;
    minimapViewportRect = null;
    minimapCanvas?.classList.remove("is-dragging");
  }
  updateMinimapToggleUi();
  if (!minimapCollapsed) drawMinimap();
}

function drawMinimap() {
  if (!minimapCanvas || !minimapCtx || !minimapPanel || minimapCollapsed || minimapPanel.hidden) return;

  const rect = minimapCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.round(rect.width * dpr));
  const targetH = Math.max(1, Math.round(rect.height * dpr));
  if (minimapCanvas.width !== targetW || minimapCanvas.height !== targetH) {
    minimapCanvas.width = targetW;
    minimapCanvas.height = targetH;
  }
  minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const bounds = computeMinimapWorldBounds();
  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);

  const inset = 6;
  const usableW = Math.max(1, rect.width - inset * 2);
  const usableH = Math.max(1, rect.height - inset * 2);
  const scale = Math.min(usableW / worldW, usableH / worldH);
  const drawW = worldW * scale;
  const drawH = worldH * scale;
  const offsetX = Math.round((rect.width - drawW) / 2) + 0.5;
  const offsetY = Math.round((rect.height - drawH) / 2) + 0.5;

  minimapFrame = {
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    scale,
    drawW,
    drawH,
    offsetX,
    offsetY,
  };

  const dark = document.documentElement?.getAttribute("data-theme") === "dark";
  const mapBg = dark ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.04)";
  const worldBg = "#ffffff";
  const frameColor = dark ? "rgba(255,255,255,.25)" : "rgba(0,0,0,.22)";
  const textColor = "rgba(0,0,0,.38)";
  const drawingColor = "rgba(0,0,0,.28)";
  const strokeColor = "rgba(0,0,0,.46)";
  const selectedColor = dark ? "rgba(255,146,70,.95)" : "rgba(186,88,0,.95)";
  const viewportFill = dark ? "rgba(94,162,255,.25)" : "rgba(23,92,211,.18)";
  const viewportStroke = dark ? "rgba(156,200,255,.95)" : "rgba(23,92,211,.9)";

  minimapCtx.clearRect(0, 0, rect.width, rect.height);
  minimapCtx.fillStyle = mapBg;
  minimapCtx.fillRect(0, 0, rect.width, rect.height);

  minimapCtx.fillStyle = worldBg;
  minimapCtx.fillRect(offsetX, offsetY, drawW, drawH);

  minimapCtx.save();
  minimapCtx.beginPath();
  minimapCtx.rect(offsetX, offsetY, drawW, drawH);
  minimapCtx.clip();

  for (const it of items) {
    if (!isFinite(it.x) || !isFinite(it.y) || !isFinite(it.w) || !isFinite(it.h)) continue;
    const r = worldRectToMinimapRect(it.x, it.y, it.w, it.h, minimapFrame);
    minimapCtx.fillStyle = it.kind === "drawing" ? drawingColor : textColor;
    minimapCtx.fillRect(r.x, r.y, r.w, r.h);

    if (selectedId && it.id === selectedId) {
      minimapCtx.strokeStyle = selectedColor;
      minimapCtx.lineWidth = 1.2;
      minimapCtx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
    }
  }

  for (const s of strokes) drawMinimapStroke(s, minimapFrame, strokeColor);
  if (currentStroke) drawMinimapStroke(currentStroke, minimapFrame, strokeColor);
  minimapCtx.restore();

  minimapCtx.strokeStyle = frameColor;
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(offsetX, offsetY, drawW, drawH);

  const view = getViewportWorldRect();
  minimapViewportRect = worldRectToMinimapRect(view.x, view.y, view.w, view.h, minimapFrame);

  minimapCtx.fillStyle = viewportFill;
  minimapCtx.fillRect(
    minimapViewportRect.x,
    minimapViewportRect.y,
    minimapViewportRect.w,
    minimapViewportRect.h
  );
  minimapCtx.strokeStyle = viewportStroke;
  minimapCtx.lineWidth = 1.3;
  minimapCtx.strokeRect(
    minimapViewportRect.x + 0.5,
    minimapViewportRect.y + 0.5,
    Math.max(0, minimapViewportRect.w - 1),
    Math.max(0, minimapViewportRect.h - 1)
  );
}

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
function getCanvasCssRect() {
  return canvas?.getBoundingClientRect?.() || { width: 0, height: 0, left: 0, top: 0 };
}

function isMobileToolPickerLayout() {
  if (typeof window === "undefined") return false;
  const mqPortraitMobile = window.matchMedia?.("(max-width: 860px) and (orientation: portrait)")?.matches;
  if (mqPortraitMobile) return true;
  const w = window.innerWidth || document.documentElement?.clientWidth || 0;
  const h = window.innerHeight || document.documentElement?.clientHeight || 0;
  return w <= 700 && h >= w;
}

function syncToolPickerLayout() {
  const mobile = isMobileToolPickerLayout();
  document.body?.classList.toggle("guest-mobile-picker-layout", mobile);
  if (toolTabsGroup) {
    toolTabsGroup.hidden = mobile;
    toolTabsGroup.style.display = mobile ? "none" : "inline-flex";
  }
  if (toolPickerBtn?.parentElement) {
    toolPickerBtn.parentElement.style.display = mobile ? "inline-flex" : "none";
  }
  if (!mobile) closeToolPicker();
}

function closeToolPicker() {
  if (!toolPickerMenu || !toolPickerBtn) return;
  toolPickerMenu.hidden = true;
  toolPickerBtn.setAttribute("aria-expanded", "false");
}

function toggleToolPicker() {
  if (!toolPickerMenu || !toolPickerBtn) return;
  const willOpen = !!toolPickerMenu.hidden;
  toolPickerMenu.hidden = !willOpen;
  toolPickerBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function updateToolPickerUi(nextMode) {
  if (!toolPickerMenu) return;
  const meta = TOOL_META[nextMode] || TOOL_META.cursor;
  if (toolPickerCurrentIcon) toolPickerCurrentIcon.src = meta.icon;
  if (toolPickerCurrentLabel) toolPickerCurrentLabel.textContent = meta.label;

  const options = [...toolPickerMenu.querySelectorAll(".tool-picker-option[data-mode]")];
  for (const option of options) {
    const isActive = option.getAttribute("data-mode") === nextMode;
    option.classList.toggle("active", isActive);
    option.setAttribute("aria-checked", isActive ? "true" : "false");
  }
}

/* =========================
   Text style / Align
   ========================= */
let currentAlign = "left";
function setAlignUI(val) {
  currentAlign = val;
  applyActive(alignLeftBtn, val === "left");
  applyActive(alignCenterBtn, val === "center");
  applyActive(alignRightBtn, val === "right");
  applyActive(alignJustifyBtn, val === "justify");
}

function getTextStyle() {
  return {
    font: fontSel?.value || "Georgia",
    size: Number(sizeInput?.value || 32),
    color: colorInput?.value || "#111111",
    bold: !!boldBtn?.classList.contains("active"),
    italic: !!italicBtn?.classList.contains("active"),
    underline: !!underlineBtn?.classList.contains("active"),
    align: currentAlign || "left",
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
  if (!ctx) return { w: 240, h: 120 };

  ctx.save();
  ctx.font = buildFontCss(it);

  const lines = String(it.text || "").split("\n");
  const size = Number(it.size || 32);
  const lineH = Math.round(size * 1.25);

  let maxW = 0;
  for (const line of lines) {
    const m = ctx.measureText(line);
    maxW = Math.max(maxW, m.width);
  }

  const w = Math.max(MIN_W, Math.ceil(maxW) + 24);
  const h = Math.max(MIN_H, Math.ceil(lines.length * lineH) + 18);

  ctx.restore();
  return { w, h };
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

  toolCursorBtn?.classList.toggle("active", mode === "cursor");
  toolMoveBtn?.classList.toggle("active", mode === "move");
  toolTextBtn?.classList.toggle("active", mode === "text");
  toolDrawBtn?.classList.toggle("active", mode === "draw");

  toolCursorBtn?.setAttribute("aria-selected", mode === "cursor" ? "true" : "false");
  toolMoveBtn?.setAttribute("aria-selected", mode === "move" ? "true" : "false");
  toolTextBtn?.setAttribute("aria-selected", mode === "text" ? "true" : "false");
  toolDrawBtn?.setAttribute("aria-selected", mode === "draw" ? "true" : "false");
  updateToolPickerUi(mode);
  closeToolPicker();

  if (textControls) textControls.style.display = mode === "text" ? "" : "none";
  if (drawControls) drawControls.style.display = mode === "draw" ? "" : "none";

  hideEditor();

  // nettoyage des états transitoires
  isPanning = false;
  panStart = null;

  if (mode !== "draw") {
    isDrawing = false;
    currentStroke = null;
  }

  setHint(
    mode === "cursor"
      ? "Curseur : Sélectionner, déplacer, redimensionner"
      : mode === "move"
      ? "Déplacement : Glisse pour te déplacer dans la page"
      : mode === "text"
      ? "Texte : Clique pour ajouter, double clic pour éditer"
      : "Dessin : Dessine. Publier pour ajouter"
  );

  updateButtons();
  redraw();
}

function updateButtons() {
  if (!undoBtn || !redoBtn || !deleteBtn || !publishBtn) return;

  publishBtn.disabled = !(mode === "draw" && strokes.length > 0);

  if (mode === "draw") {
    const canUndoLocal = strokes.length > 0;
    const canRedoLocal = redoStrokes.length > 0;
    undoBtn.disabled = !(canUndoLocal || undoStack.length > 0);
    redoBtn.disabled = !(canRedoLocal || redoStack.length > 0);
  } else {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  deleteBtn.disabled = !selectedId;
}

/* =========================
   Drawing (canvas)
   ========================= */
function drawBackground() {
  if (!ctx || !canvas) return;
  const rect = getCanvasCssRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, rect.width, rect.height);
}

function drawStroke(s, camOffX = camX, camOffY = camY) {
  if (!ctx || !s?.points?.length) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;

  const p0 = { x: s.points[0].x - camOffX, y: s.points[0].y - camOffY };
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);

  for (let i = 1; i < s.points.length; i++) {
    const p = s.points[i];
    ctx.lineTo(p.x - camOffX, p.y - camOffY);
  }
  ctx.stroke();
  ctx.restore();
}

function drawText(it, camOffX = camX, camOffY = camY) {
  if (!ctx) return;

  const sx = it.x - camOffX;
  const sy = it.y - camOffY;

  const lines = String(it.text || "").split("\n");
  const size = Number(it.size || 32);
  const lineH = Math.round(size * 1.25);

  const align = it.align || "left";

  ctx.save();
  ctx.fillStyle = it.color || "#111";
  ctx.font = buildFontCss(it);
  ctx.textBaseline = "top";

  if (align === "center") ctx.textAlign = "center";
  else if (align === "right") ctx.textAlign = "right";
  else ctx.textAlign = "left";

  const boxW = Number(it.w || 0);

  const rx =
    align === "center" ? sx + boxW / 2 :
    align === "right" ? sx + boxW :
    sx;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const y = sy + i * lineH;

    if (align === "justify" && i < lines.length - 1) {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length <= 1) {
        ctx.textAlign = "left";
        ctx.fillText(line, sx, y);
      } else {
        const spaceWidth = ctx.measureText(" ").width;
        const wordsWidth = words.reduce((acc, w) => acc + ctx.measureText(w).width, 0);
        const target = Math.max(0, boxW - 12);
        const gaps = words.length - 1;
        const base = spaceWidth;
        const extra = clamp((target - wordsWidth - base * gaps) / gaps, 0, 40);

        let x = sx;
        ctx.textAlign = "left";
        for (let wi = 0; wi < words.length; wi++) {
          ctx.fillText(words[wi], x, y);
          x += ctx.measureText(words[wi]).width;
          if (wi < words.length - 1) x += base + extra;
        }
      }
    } else {
      ctx.fillText(line, rx, y);
    }

    if (it.underline) {
      const m = ctx.measureText(line);
      const yLine = y + size * 1.08;

      let ux0 = rx;
      let ux1 = rx + m.width;

      if (align === "center") {
        ux0 = rx - m.width / 2;
        ux1 = rx + m.width / 2;
      } else if (align === "right") {
        ux0 = rx - m.width;
        ux1 = rx;
      } else if (align === "justify") {
        ux0 = sx;
        ux1 = sx + Math.max(0, boxW - 12);
      }

      ctx.strokeStyle = it.color || "#111";
      ctx.lineWidth = Math.max(1, Math.round(size / 18));
      ctx.beginPath();
      ctx.moveTo(ux0, yLine);
      ctx.lineTo(ux1, yLine);
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

async function drawDrawing(it, camOffX = camX, camOffY = camY) {
  if (!ctx || !it.imageUrl) return;
  try {
    const img = await getImage(it.imageUrl);
    ctx.drawImage(img, it.x - camOffX, it.y - camOffY, it.w, it.h);
  } catch {}
}

function drawSelectionBox(it) {
  if (!ctx) return;

  const p = worldToScreen({ x: it.x, y: it.y });
  const x = p.x;
  const y = p.y;

  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(x, y, it.w, it.h);
  ctx.setLineDash([]);

  const hs = [
    ["nw", x, y],
    ["ne", x + it.w, y],
    ["se", x + it.w, y + it.h],
    ["sw", x, y + it.h],
  ];

  for (const [, hx, hy] of hs) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.beginPath();
    ctx.arc(hx, hy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

async function redraw() {
  if (!ctx) return;
  drawBackground();

  for (const it of items) {
    if (it.kind === "text") drawText(it, camX, camY);
    if (it.kind === "drawing") await drawDrawing(it, camX, camY);
  }

  for (const s of strokes) drawStroke(s, camX, camY);
  if (currentStroke) drawStroke(currentStroke, camX, camY);

  const sel = getSelectedItem();
  if (sel) drawSelectionBox(sel);

  drawMinimap();
  updateButtons();
}

/* =========================
   Hit testing (coords monde)
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
function showEditor(screenX, screenY, initial, state) {
  if (!editorShell || !floatingEditor || !canvas) return;

  const wx = typeof state.worldX === "number" ? state.worldX : screenX + camX;
  const wy = typeof state.worldY === "number" ? state.worldY : screenY + camY;

  editorState = { ...state, x: wx, y: wy };

  editorShell.style.display = "block";
  const compactLayout = window.matchMedia?.("(max-width: 900px)")?.matches ?? false;
  const targetX = compactLayout ? 8 : screenX;
  const targetY = compactLayout ? 8 : screenY;
  editorShell.style.left = `${targetX}px`;
  editorShell.style.top = `${targetY}px`;

  floatingEditor.value = initial || "";

  requestAnimationFrame(() => {
    const rect = getCanvasCssRect();
    const margin = 8;
    const boxW = editorShell.offsetWidth || 320;
    const boxH = editorShell.offsetHeight || 180;

    const maxLeft = Math.max(margin, rect.width - boxW - margin);
    const maxTop = Math.max(margin, rect.height - boxH - margin);
    const left = clamp(targetX, margin, maxLeft);
    const top = clamp(targetY, margin, maxTop);
    editorShell.style.left = `${left}px`;
    editorShell.style.top = `${top}px`;

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
    align: beforeDoc.align || "left",
    w: beforeDoc.w,
    h: beforeDoc.h,
  };
  const after = { ...style, w, h };

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

fontSel?.addEventListener("change", updateSelectedTextStyle);
sizeInput?.addEventListener("change", updateSelectedTextStyle);
colorInput?.addEventListener("change", updateSelectedTextStyle);

/* =========================
   Pointer interactions
   ========================= */
async function onPointerDown(e) {
  if (!canvas) return;
  if (editorOpen()) return;
  if (e.button != null && e.button !== 0) return;

  if ((e.pointerType || "") === "touch") {
    const rect = getCanvasCssRect();
    const localX = e.clientX - rect.left;
    const gutter = 18;
    const allowPageScroll = mode === "move";
    if (allowPageScroll && (localX <= gutter || localX >= rect.width - gutter)) {
      // Laisse le geste à la page pour faciliter le scroll vertical mobile.
      return;
    }
  }

  // MOVE tool => pan uniquement
  if (mode === "move") {
    isPanning = true;
    const sp0 = posFromEvent(e);
    panStart = { sx: sp0.x, sy: sp0.y, camX, camY };
    canvas.setPointerCapture?.(e.pointerId);
    redraw();
    return;
  }

  canvas.setPointerCapture?.(e.pointerId);

  const sp = posFromEvent(e);
  const wp = screenToWorld(sp);
  const x = wp.x;
  const y = wp.y;

  // hit test toujours actif (même en text/draw)
  const hit = itemHit(x, y);
  if (hit) {
    if (mode === "text" && hit.kind !== "text") {
      selectedId = null;
      redraw();
      showEditor(sp.x, sp.y, "", { mode: "create", worldX: x, worldY: y });
      return;
    }

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

  // CURSOR => pas de création
  if (mode === "cursor") return;

  if (mode === "text") {
    showEditor(sp.x, sp.y, "", { mode: "create", worldX: x, worldY: y });
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

  const sp = posFromEvent(e);

  if (isPanning && panStart) {
    camX = panStart.camX + (panStart.sx - sp.x);
    camY = panStart.camY + (panStart.sy - sp.y);
    redraw();
    return;
  }

  const wp = screenToWorld(sp);
  const x = wp.x;
  const y = wp.y;

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
  // RESIZE
  const orig = drag.orig;

  let nx = orig.x,
    ny = orig.y,
    nw = orig.w,
    nh = orig.h;

  if (drag.handle.includes("e")) nw = orig.w + dx;
  if (drag.handle.includes("s")) nh = orig.h + dy;

  if (drag.handle.includes("w")) {
    nw = orig.w - dx;
    nx = orig.x + dx;
  }
  if (drag.handle.includes("n")) {
    nh = orig.h - dy;
    ny = orig.y + dy;
  }

  nw = clamp(nw, MIN_W, 5000);
  nh = clamp(nh, MIN_H, 5000);

  // CAS DESSIN : on garde le resize w/h classique
  if (it.kind === "drawing") {
    it.x = nx;
    it.y = ny;
    it.w = nw;
    it.h = nh;
    redraw();
    return;
  }

  // CAS TEXTE : on scale la police (sinon "ça ne fait rien" visuellement)
  if (it.kind === "text") {
    const ow = Math.max(1, orig.w);
    const oh = Math.max(1, orig.h);

    // scale "au ressenti" (le plus grand des 2)
    const scale = Math.max(nw / ow, nh / oh);

    const newSize = clamp(Math.round((Number(orig.size || 32) * scale)), 10, 220);
    it.size = newSize;

    // on recalcule la vraie boîte selon le texte + police
    const box = measureTextBox(it);

    // On fixe l'ancrage selon le coin manipulé (opposé reste "fixe")
    const handle = drag.handle; // "nw" | "ne" | "se" | "sw"
    if (handle === "se") {
      it.x = orig.x;
      it.y = orig.y;
    } else if (handle === "nw") {
      it.x = orig.x + orig.w - box.w;
      it.y = orig.y + orig.h - box.h;
    } else if (handle === "ne") {
      it.x = orig.x;
      it.y = orig.y + orig.h - box.h;
    } else if (handle === "sw") {
      it.x = orig.x + orig.w - box.w;
      it.y = orig.y;
    } else {
      // fallback
      it.x = nx;
      it.y = ny;
    }

    it.w = box.w;
    it.h = box.h;

    redraw();
    return;
  }

  // fallback générique
  it.x = nx;
  it.y = ny;
  it.w = nw;
  it.h = nh;
}


  redraw();
}

function openTextEditorForItem(it) {
  if (!it || it.kind !== "text") return;
  selectedId = it.id;
  redraw();

  const hp = worldToScreen({ x: it.x, y: it.y });
  showEditor(hp.x, hp.y, it.text || "", {
    mode: "edit",
    id: it.id,
    worldX: it.x,
    worldY: it.y,
  });
}

function tryOpenTextEditorOnTouchDoubleTap(it, e) {
  if (!it || it.kind !== "text") return;

  const now = Date.now();
  const sp = posFromEvent(e);
  const dt = now - Number(lastTextTap.time || 0);
  const dx = sp.x - Number(lastTextTap.x || 0);
  const dy = sp.y - Number(lastTextTap.y || 0);
  const sameItem = lastTextTap.id === it.id;

  if (sameItem && dt <= DOUBLE_TAP_MS && Math.hypot(dx, dy) <= DOUBLE_TAP_MAX_DIST) {
    lastTextTap = { time: 0, x: 0, y: 0, id: null };
    openTextEditorForItem(it);
    return;
  }

  lastTextTap = { time: now, x: sp.x, y: sp.y, id: it.id };
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
    redraw();
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
  if (!changed) {
    if ((e.pointerType || "") === "touch") {
      tryOpenTextEditorOnTouchDoubleTap(it, e);
    }
    return;
  }

  try {
    const ref = doc(db, "guestbook", it.id);
const before = { x: orig.x, y: orig.y, w: orig.w, h: orig.h };
const after = { x: it.x, y: it.y, w: it.w, h: it.h };

// Si texte : on sauvegarde aussi la taille de police si elle a changé
if (it.kind === "text") {
  before.size = Number(orig.size || 32);
  after.size = Number(it.size || 32);
}

await updateDoc(ref, after);

undoStack.push({ type: "update", id: it.id, before, after });
redoStack.length = 0;
  } catch (e2) {
    alert("Impossible de déplacer/redimensionner : " + (e2?.message || e2));
  }

  redraw();
}

function moveCameraFromMinimap(localPos, offset) {
  if (!minimapFrame) return;
  const world = minimapToWorldPoint(localPos.x, localPos.y, minimapFrame);
  camX = world.x - offset.x;
  camY = world.y - offset.y;
  redraw();
}

function onMinimapPointerDown(e) {
  if (!minimapCanvas || minimapCollapsed) return;
  if (e.button != null && e.button !== 0) return;
  if (!minimapFrame) drawMinimap();
  if (!minimapFrame) return;

  const localPos = getMinimapPointerPos(e);
  if (!localPos) return;

  const pointerWorld = minimapToWorldPoint(localPos.x, localPos.y, minimapFrame);
  const view = getViewportWorldRect();
  const insideViewport = pointInRect(localPos, minimapViewportRect);

  const offset = insideViewport
    ? { x: pointerWorld.x - camX, y: pointerWorld.y - camY }
    : { x: view.w / 2, y: view.h / 2 };

  minimapDrag = { pointerId: e.pointerId, offset };
  minimapCanvas.classList.add("is-dragging");

  e.preventDefault();
  e.stopPropagation();
  minimapCanvas.setPointerCapture?.(e.pointerId);
  moveCameraFromMinimap(localPos, offset);
}

function onMinimapPointerMove(e) {
  if (!minimapDrag || e.pointerId !== minimapDrag.pointerId) return;
  const localPos = getMinimapPointerPos(e);
  if (!localPos) return;
  e.preventDefault();
  e.stopPropagation();
  moveCameraFromMinimap(localPos, minimapDrag.offset);
}

function onMinimapPointerUp(e) {
  if (!minimapDrag || e.pointerId !== minimapDrag.pointerId) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    minimapCanvas?.releasePointerCapture?.(e.pointerId);
  } catch {}
  minimapDrag = null;
  minimapCanvas?.classList.remove("is-dragging");
}

canvas?.addEventListener("pointerdown", onPointerDown);
canvas?.addEventListener("pointermove", onPointerMove);
canvas?.addEventListener("pointerup", onPointerUp);
canvas?.addEventListener("pointercancel", onPointerUp);

minimapToggleBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setMinimapCollapsed(!minimapCollapsed);
});

minimapCanvas?.addEventListener("pointerdown", onMinimapPointerDown);
minimapCanvas?.addEventListener("pointermove", onMinimapPointerMove);
minimapCanvas?.addEventListener("pointerup", onMinimapPointerUp);
minimapCanvas?.addEventListener("pointercancel", onMinimapPointerUp);

canvas?.addEventListener("dblclick", (e) => {
  if (editorOpen()) return;

  const sp = posFromEvent(e);
  const wp = screenToWorld(sp);

  const hit = itemHit(wp.x, wp.y);
  if (!hit || hit.kind !== "text") return;
  openTextEditorForItem(hit);
});

// Pan au scroll (trackpad / molette) => seulement en mode move
canvas?.addEventListener(
  "wheel",
  (e) => {
    if (mode !== "move") return;
    camX += e.deltaX;
    camY += e.deltaY;
    e.preventDefault();
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
   Publish drawing (monde, sans restriction au viewport)
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
      const w = Number(s.width || 6);
      for (const p of s.points) {
        minX = Math.min(minX, p.x - w);
        minY = Math.min(minY, p.y - w);
        maxX = Math.max(maxX, p.x + w);
        maxY = Math.max(maxY, p.y + w);
      }
    }

    if (!isFinite(minX) || !isFinite(minY)) throw new Error("Dessin vide.");

    const pad = 18;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;

    const w = Math.max(80, Math.ceil(maxX - minX));
    const h = Math.max(80, Math.ceil(maxY - minY));

    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;

    const octx = off.getContext("2d");
    octx.clearRect(0, 0, off.width, off.height);

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
  }
});

/* =========================
   Export helpers (inclure tous les textes/dessins)
   ========================= */
function computeContentBounds() {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  const takeRect = (x, y, w, h) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };

  for (const it of items) {
    if (
      typeof it.x === "number" &&
      typeof it.y === "number" &&
      typeof it.w === "number" &&
      typeof it.h === "number"
    ) {
      takeRect(it.x, it.y, it.w, it.h);
    }
  }

  const takeStroke = (s) => {
    if (!s?.points?.length) return;
    const w = Number(s.width || 6);
    for (const p of s.points) {
      minX = Math.min(minX, p.x - w);
      minY = Math.min(minY, p.y - w);
      maxX = Math.max(maxX, p.x + w);
      maxY = Math.max(maxY, p.y + w);
    }
  };

  for (const s of strokes) takeStroke(s);
  if (currentStroke) takeStroke(currentStroke);

  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;

  const PAD = 40;
  minX -= PAD;
  minY -= PAD;
  maxX += PAD;
  maxY += PAD;

  const w = Math.max(1, Math.ceil(maxX - minX));
  const h = Math.max(1, Math.ceil(maxY - minY));

  return { minX, minY, maxX, maxY, w, h };
}

async function renderAllContentToCanvas() {
  const bounds = computeContentBounds();

  if (!bounds || !ctx || !canvas) {
    await redraw();
    const off = document.createElement("canvas");
    const rect = getCanvasCssRect();
    off.width = Math.round(rect.width);
    off.height = Math.round(rect.height);
    const octx = off.getContext("2d");
    octx.clearRect(0, 0, off.width, off.height);
    octx.drawImage(canvas, 0, 0, off.width, off.height);
    return { canvas: off, w: off.width, h: off.height };
  }

  const off = document.createElement("canvas");
  off.width = bounds.w;
  off.height = bounds.h;

  const octx = off.getContext("2d");
  octx.clearRect(0, 0, off.width, off.height);

  const drawStrokeTo = (s) => {
    if (!s?.points?.length) return;
    octx.save();
    octx.lineCap = "round";
    octx.lineJoin = "round";
    octx.strokeStyle = s.color;
    octx.lineWidth = s.width;

    octx.beginPath();
    octx.moveTo(s.points[0].x - bounds.minX, s.points[0].y - bounds.minY);
    for (let i = 1; i < s.points.length; i++) {
      const p = s.points[i];
      octx.lineTo(p.x - bounds.minX, p.y - bounds.minY);
    }
    octx.stroke();
    octx.restore();
  };

  const drawTextTo = (it) => {
    const sx = it.x - bounds.minX;
    const sy = it.y - bounds.minY;

    const lines = String(it.text || "").split("\n");
    const size = Number(it.size || 32);
    const lineH = Math.round(size * 1.25);
    const align = it.align || "left";
    const boxW = Number(it.w || 0);

    octx.save();
    octx.fillStyle = it.color || "#111";
    octx.font = buildFontCss(it);
    octx.textBaseline = "top";

    if (align === "center") octx.textAlign = "center";
    else if (align === "right") octx.textAlign = "right";
    else octx.textAlign = "left";

    const rx =
      align === "center" ? sx + boxW / 2 :
      align === "right" ? sx + boxW :
      sx;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const y = sy + i * lineH;

      if (align === "justify" && i < lines.length - 1) {
        const words = line.trim().split(/\s+/).filter(Boolean);
        if (words.length <= 1) {
          octx.textAlign = "left";
          octx.fillText(line, sx, y);
        } else {
          const spaceWidth = octx.measureText(" ").width;
          const wordsWidth = words.reduce((acc, w) => acc + octx.measureText(w).width, 0);
          const target = Math.max(0, boxW - 12);
          const gaps = words.length - 1;
          const base = spaceWidth;
          const extra = clamp((target - wordsWidth - base * gaps) / gaps, 0, 40);

          let x = sx;
          octx.textAlign = "left";
          for (let wi = 0; wi < words.length; wi++) {
            octx.fillText(words[wi], x, y);
            x += octx.measureText(words[wi]).width;
            if (wi < words.length - 1) x += base + extra;
          }
        }
      } else {
        octx.fillText(line, rx, y);
      }

      if (it.underline) {
        const m = octx.measureText(line);
        const yLine = y + size * 1.08;

        let ux0 = rx;
        let ux1 = rx + m.width;

        if (align === "center") {
          ux0 = rx - m.width / 2;
          ux1 = rx + m.width / 2;
        } else if (align === "right") {
          ux0 = rx - m.width;
          ux1 = rx;
        } else if (align === "justify") {
          ux0 = sx;
          ux1 = sx + Math.max(0, boxW - 12);
        }

        octx.strokeStyle = it.color || "#111";
        octx.lineWidth = Math.max(1, Math.round(size / 18));
        octx.beginPath();
        octx.moveTo(ux0, yLine);
        octx.lineTo(ux1, yLine);
        octx.stroke();
      }
    }

    octx.restore();
  };

  const drawDrawingTo = async (it) => {
    if (!it.imageUrl) return;
    try {
      const img = await getImage(it.imageUrl);
      octx.drawImage(img, it.x - bounds.minX, it.y - bounds.minY, it.w, it.h);
    } catch {}
  };

  for (const it of items) {
    if (it.kind === "drawing") await drawDrawingTo(it);
    if (it.kind === "text") drawTextTo(it);
  }
  for (const s of strokes) drawStrokeTo(s);
  if (currentStroke) drawStrokeTo(currentStroke);

  return { canvas: off, w: off.width, h: off.height };
}

async function exportPng() {
  const rendered = await renderAllContentToCanvas();
  const a = document.createElement("a");
  a.href = rendered.canvas.toDataURL("image/png");
  a.download = `livre-dor-${Date.now()}.png`;
  a.click();
}

async function loadJsPdf() {
  if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;

  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });

  return window.jspdf?.jsPDF;
}

async function exportPdf() {
  const rendered = await renderAllContentToCanvas();
  const imgData = rendered.canvas.toDataURL("image/png");

  const jsPDF = await loadJsPdf();
  if (!jsPDF) {
    alert("Impossible de charger le module PDF.");
    return;
  }

  const pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();

  const imgW = rendered.w;
  const imgH = rendered.h;

  const ratio = pageW / imgW;
  const displayH = imgH * ratio;

  if (displayH <= pageH) {
    pdf.addImage(imgData, "PNG", 0, 0, pageW, displayH);
    pdf.save(`livre-dor-${Date.now()}.pdf`);
    return;
  }

  const sliceHpx = Math.floor(pageH / ratio);
  let y = 0;
  let pageIndex = 0;

  while (y < imgH) {
    const hpx = Math.min(sliceHpx, imgH - y);

    const slice = document.createElement("canvas");
    slice.width = imgW;
    slice.height = hpx;

    const sctx = slice.getContext("2d");
    sctx.fillStyle = "#fff";
    sctx.fillRect(0, 0, slice.width, slice.height);

    sctx.drawImage(rendered.canvas, 0, y, imgW, hpx, 0, 0, imgW, hpx);

    const sliceData = slice.toDataURL("image/png");
    if (pageIndex > 0) pdf.addPage();

    const sliceDisplayH = hpx * ratio;
    pdf.addImage(sliceData, "PNG", 0, 0, pageW, sliceDisplayH);

    y += hpx;
    pageIndex++;
  }

  pdf.save(`livre-dor-${Date.now()}.pdf`);
}

/* =========================
   Export trigger (select PNG/PDF)
   ========================= */
exportMenuBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
  const fmt = exportFormatSel?.value || "png";
  if (fmt === "pdf") await exportPdf();
  else await exportPng();
});

/* =========================
   Tool buttons
   ========================= */
toolCursorBtn?.addEventListener("click", () => setMode("cursor"));
toolMoveBtn?.addEventListener("click", () => setMode("move"));
toolTextBtn?.addEventListener("click", () => setMode("text"));
toolDrawBtn?.addEventListener("click", () => setMode("draw"));
let skipToolPickerClick = false;
toolPickerBtn?.addEventListener("pointerdown", (e) => {
  if ((e.pointerType || "") !== "touch") return;
  e.preventDefault();
  e.stopPropagation();
  skipToolPickerClick = true;
  toggleToolPicker();
});
toolPickerBtn?.addEventListener("click", (e) => {
  if (skipToolPickerClick) {
    skipToolPickerClick = false;
    return;
  }
  e.stopPropagation();
  toggleToolPicker();
});

function handleToolPickerSelection(e) {
  const btn = e.target?.closest?.(".tool-picker-option[data-mode]");
  if (!btn) return;
  const picked = btn.getAttribute("data-mode");
  if (!picked) return;
  e.stopPropagation();
  setMode(picked);
}

toolPickerMenu?.addEventListener("pointerdown", (e) => {
  if ((e.pointerType || "") !== "touch") return;
  e.preventDefault();
  handleToolPickerSelection(e);
});
toolPickerMenu?.addEventListener("click", handleToolPickerSelection);

/* =========================
   Keyboard (Ctrl+Z / Ctrl+Shift+Z)
   ========================= */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeToolPicker();
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

document.addEventListener("click", (e) => {
  if (!toolPickerMenu || toolPickerMenu.hidden) return;
  if (e.target?.closest?.("#toolPickerMobile")) return;
  closeToolPicker();
});

/* =========================
   Firestore realtime
   ========================= */
async function main() {
  try {
    await ensureAnonAuth();

    syncToolPickerLayout();
    hideEditor();
    setMinimapCollapsed(false);

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
            it.align = it.align || "left";

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
    window.addEventListener("resize", syncToolPickerLayout);
    window.addEventListener("orientationchange", syncToolPickerLayout);

    setAlignUI("left");
    setMode("cursor");
  } catch (e) {
    console.error("[livre-dor] init error", e);
    alert("Erreur d'initialisation du livre d’or. Ouvre la console pour voir le détail.");
  }
}

if (canvas && ctx) main();
