import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";

import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  doc,
  updateDoc,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const canvas = document.getElementById("guestCanvas");
const ctx = canvas.getContext("2d");

const toolTextBtn = document.getElementById("toolText");
const toolDrawBtn = document.getElementById("toolDraw");

const textControls = document.getElementById("textControls");
const drawControls = document.getElementById("drawControls");

const fontSel = document.getElementById("font");
const sizeInput = document.getElementById("size");
const colorInput = document.getElementById("color");

const penSizeInput = document.getElementById("penSize");
const penColorInput = document.getElementById("penColor");
const publishBtn = document.getElementById("publish");

const undoBtn = document.getElementById("undo");
const redoBtn = document.getElementById("redo");
const deleteBtn = document.getElementById("deleteSelected");
const exportBtn = document.getElementById("exportCanvasPng");

const hint = document.getElementById("hint");
const floatingEditor = document.getElementById("floatingEditor");

let mode = "text"; // "text" | "draw"

// Firestore items
let items = []; // {id, kind, x,y,w,h, ...}
const imageCache = new Map();

// Selection / transform
let selectedId = null;
let drag = null; // {type:"move"|"resize", handle, startX,startY, orig}
const HANDLE = 10;
const MIN_W = 40;
const MIN_H = 28;

// Drawing (local, before publish)
let isDrawing = false;
let currentStroke = null;
let strokes = [];       // undo stack
let redoStrokes = [];   // redo stack

/* --------------------------
   Utils
-------------------------- */

function setHint(text) { hint.textContent = text; }

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function dprResize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

function posFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const p = (e.touches?.[0]) || e;
  return { x: p.clientX - rect.left, y: p.clientY - rect.top };
}

function setMode(next) {
  mode = next;

  toolTextBtn.classList.toggle("active", mode === "text");
  toolDrawBtn.classList.toggle("active", mode === "draw");
  toolTextBtn.setAttribute("aria-selected", mode === "text" ? "true" : "false");
  toolDrawBtn.setAttribute("aria-selected", mode === "draw" ? "true" : "false");

  textControls.style.display = mode === "text" ? "" : "none";
  drawControls.style.display = mode === "draw" ? "" : "none";

  hideEditor();

  if (mode === "text") {
    setHint("Texte : clique pour ajouter • Sélection : clique sur un élément");
  } else {
    setHint("Dessin : dessine • Publier pour ajouter • Sélection : clique sur un élément");
  }

  updateButtons();
  redraw();
}

function updateButtons() {
  // undo/redo = soit strokes locaux (draw), soit déplacement/resize non géré en undo (pour l’instant)
  undoBtn.disabled = mode === "draw" ? strokes.length === 0 : true;
  redoBtn.disabled = mode === "draw" ? redoStrokes.length === 0 : true;

  deleteBtn.disabled = !selectedId;
  publishBtn.disabled = mode !== "draw" || strokes.length === 0;
}

/* --------------------------
   Rendering
-------------------------- */

function drawBackground() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawText(it) {
  ctx.fillStyle = it.color || "#111";
  const font = it.font || "Georgia";
  const sz = Number(it.size || 32);
  ctx.font = `${sz}px ${font}`;
  ctx.textBaseline = "top";

  // rendu simple (pas de wrapping). La boîte sert surtout à resize/selection.
  ctx.fillText(it.text || "", it.x, it.y);
}

async function getImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const img = new Image();
  img.crossOrigin = "anonymous";
  const p = new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = reject;
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
  } catch {
    // ignore
  }
}

function drawStroke(s) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.beginPath();
  const pts = s.points;
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function getSelectedItem() {
  return items.find(i => i.id === selectedId) || null;
}

function drawSelectionBox(it) {
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(it.x, it.y, it.w, it.h);
  ctx.setLineDash([]);

  // handles (4 coins)
  const hs = [
    { k: "nw", x: it.x, y: it.y },
    { k: "ne", x: it.x + it.w, y: it.y },
    { k: "se", x: it.x + it.w, y: it.y + it.h },
    { k: "sw", x: it.x, y: it.y + it.h },
  ];

  for (const h of hs) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

async function redraw() {
  drawBackground();

  // éléments partagés
  for (const it of items) {
    if (it.kind === "text") drawText(it);
    if (it.kind === "drawing") await drawDrawing(it);
  }

  // strokes locaux (non publiés)
  for (const s of strokes) drawStroke(s);
  if (currentStroke) drawStroke(currentStroke);

  // sélection au-dessus
  const sel = getSelectedItem();
  if (sel) drawSelectionBox(sel);

  updateButtons();
}

/* --------------------------
   Hit testing (select/move/resize)
-------------------------- */

function handleHit(it, x, y) {
  const corners = [
    ["nw", it.x, it.y],
    ["ne", it.x + it.w, it.y],
    ["se", it.x + it.w, it.y + it.h],
    ["sw", it.x, it.y + it.h],
  ];
  for (const [k, cx, cy] of corners) {
    const dx = x - cx, dy = y - cy;
    if (Math.sqrt(dx*dx + dy*dy) <= HANDLE) return k;
  }
  return null;
}

function itemHit(x, y) {
  // top-most first
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) {
      return it;
    }
  }
  return null;
}

/* --------------------------
   Floating editor (text edit/add)
-------------------------- */

function showEditor(x, y, initial = "", onCommit) {
  floatingEditor.value = initial;
  floatingEditor.style.display = "block";
  floatingEditor.style.left = `${x}px`;
  floatingEditor.style.top = `${y}px`;
  floatingEditor.style.width = `260px`;

  floatingEditor.focus({ preventScroll: true });
  floatingEditor.setSelectionRange(floatingEditor.value.length, floatingEditor.value.length);

  floatingEditor.onkeydown = (e) => {
    if (e.key === "Escape") {
      hideEditor();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEditor(onCommit);
    }
  };

  floatingEditor.onblur = () => {
    // blur -> commit si non vide
    commitEditor(onCommit);
  };
}

function commitEditor(onCommit) {
  if (!floatingEditor || floatingEditor.style.display === "none") return;
  const v = (floatingEditor.value || "").trim();
  const left = parseFloat(floatingEditor.style.left || "0");
  const top = parseFloat(floatingEditor.style.top || "0");
  hideEditor();
  if (v && typeof onCommit === "function") onCommit(v, left, top);
}

function hideEditor() {
  floatingEditor.style.display = "none";
  floatingEditor.onkeydown = null;
  floatingEditor.onblur = null;
}

/* --------------------------
   Pointer interactions
-------------------------- */

async function onPointerDown(e) {
  const { x, y } = posFromEvent(e);

  // click sur élément ?
  const hit = itemHit(x, y);

  if (hit) {
    selectedId = hit.id;

    // resize handle ?
    const h = handleHit(hit, x, y);
    if (h) {
      drag = {
        type: "resize",
        handle: h,
        startX: x,
        startY: y,
        orig: { ...hit }
      };
    } else {
      drag = {
        type: "move",
        startX: x,
        startY: y,
        orig: { ...hit }
      };
    }

    hideEditor();
    await redraw();
    return;
  }

  // click sur vide -> clear selection
  selectedId = null;
  hideEditor();
  await redraw();

  // ajouter texte
  if (mode === "text") {
    showEditor(x, y, "", async (text, ex, ey) => {
      // mesure grossière pour la boîte
      const w = Math.max(120, Math.min(520, text.length * (Number(sizeInput.value || 32) * 0.6)));
      const h = Math.max(40, Number(sizeInput.value || 32) + 16);

      await addDoc(collection(db, "guestbook"), {
        kind: "text",
        createdAt: Date.now(),
        text,
        x: ex,
        y: ey,
        w,
        h,
        font: fontSel.value,
        size: Number(sizeInput.value || 32),
        color: colorInput.value
      });
    });
    return;
  }

  // dessin
  if (mode === "draw") {
    e.preventDefault();
    isDrawing = true;
    redoStrokes = [];

    currentStroke = {
      color: penColorInput.value,
      width: Number(penSizeInput.value || 6),
      points: [{ x, y }]
    };
    await redraw();
  }
}

async function onPointerMove(e) {
  const { x, y } = posFromEvent(e);

  // drawing
  if (mode === "draw" && isDrawing && currentStroke) {
    e.preventDefault();
    currentStroke.points.push({ x, y });
    await redraw();
    return;
  }

  // dragging selection
  if (!drag) return;

  const it = getSelectedItem();
  if (!it) return;

  const dx = x - drag.startX;
  const dy = y - drag.startY;

  if (drag.type === "move") {
    it.x = drag.orig.x + dx;
    it.y = drag.orig.y + dy;
  } else if (drag.type === "resize") {
    // resize from handle
    let nx = drag.orig.x;
    let ny = drag.orig.y;
    let nw = drag.orig.w;
    let nh = drag.orig.h;

    if (drag.handle.includes("e")) nw = drag.orig.w + dx;
    if (drag.handle.includes("s")) nh = drag.orig.h + dy;
    if (drag.handle.includes("w")) { nw = drag.orig.w - dx; nx = drag.orig.x + dx; }
    if (drag.handle.includes("n")) { nh = drag.orig.h - dy; ny = drag.orig.y + dy; }

    nw = clamp(nw, MIN_W, 5000);
    nh = clamp(nh, MIN_H, 5000);

    it.x = nx;
    it.y = ny;
    it.w = nw;
    it.h = nh;
  }

  await redraw();
}

async function onPointerUp(e) {
  // finish drawing
  if (mode === "draw" && isDrawing) {
    isDrawing = false;
    if (currentStroke) {
      strokes.push(currentStroke);
      currentStroke = null;
      await redraw();
    }
    return;
  }

  // commit drag to firestore
  if (!drag) return;

  const it = getSelectedItem();
  const orig = drag.orig;
  drag = null;

  if (!it) return;

  const changed =
    it.x !== orig.x || it.y !== orig.y || it.w !== orig.w || it.h !== orig.h;

  if (!changed) return;

  try {
    await updateDoc(doc(db, "guestbook", it.id), {
      x: it.x, y: it.y, w: it.w, h: it.h
    });
  } catch (err) {
    alert("Impossible de déplacer/redimensionner (règles Firestore ?).");
  }
}

/* --------------------------
   Double click = edit text
-------------------------- */

canvas.addEventListener("dblclick", async (e) => {
  const { x, y } = posFromEvent(e);
  const hit = itemHit(x, y);
  if (!hit || hit.kind !== "text") return;

  selectedId = hit.id;
  await redraw();

  showEditor(hit.x, hit.y, hit.text || "", async (newText) => {
    const w = Math.max(120, Math.min(900, newText.length * (Number(hit.size || 32) * 0.6)));
    const h = Math.max(40, Number(hit.size || 32) + 16);

    try {
      await updateDoc(doc(db, "guestbook", hit.id), {
        text: newText,
        w, h
      });
    } catch {
      alert("Impossible d’éditer le texte (règles Firestore ?).");
    }
  });
});

/* --------------------------
   Actions toolbar
-------------------------- */

undoBtn.addEventListener("click", async () => {
  if (mode !== "draw") return;
  const s = strokes.pop();
  if (s) redoStrokes.push(s);
  await redraw();
});

redoBtn.addEventListener("click", async () => {
  if (mode !== "draw") return;
  const s = redoStrokes.pop();
  if (s) strokes.push(s);
  await redraw();
});

deleteBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  if (!confirm("Supprimer cet élément ?")) return;

  try {
    await deleteDoc(doc(db, "guestbook", selectedId));
    selectedId = null;
    await redraw();
  } catch {
    alert("Suppression impossible (règles Firestore ?).");
  }
});

publishBtn.addEventListener("click", async () => {
  if (mode !== "draw") return;
  if (!strokes.length) return;

  publishBtn.disabled = true;
  publishBtn.textContent = "⏳";

  try {
    // calc bbox des strokes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) {
      for (const p of s.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }

    const pad = 16;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);

    const rect = canvas.getBoundingClientRect();
    maxX = Math.min(rect.width, maxX + pad);
    maxY = Math.min(rect.height, maxY + pad);

    const w = Math.max(60, maxX - minX);
    const h = Math.max(60, maxY - minY);

    // render cropped drawing to offscreen
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
      octx.beginPath();
      const pts = s.points;
      if (!pts.length) continue;
      octx.moveTo(pts[0].x - minX, pts[0].y - minY);
      for (let i = 1; i < pts.length; i++) octx.lineTo(pts[i].x - minX, pts[i].y - minY);
      octx.stroke();
    }

    const blob = await new Promise((resolve) => off.toBlob(resolve, "image/png"));
    const file = new File([blob], `dessin-${Date.now()}.png`, { type: "image/png" });
    const up = await uploadImage(file);

    const newDoc = await addDoc(collection(db, "guestbook"), {
      kind: "drawing",
      createdAt: Date.now(),
      imageUrl: up.secure_url,
      x: minX,
      y: minY,
      w,
      h,
    });

    // clear local strokes
    strokes = [];
    redoStrokes = [];

    // auto select new drawing
    selectedId = newDoc.id;
    await redraw();
  } catch (e) {
    alert("Erreur publication : " + (e?.message || e));
  } finally {
    publishBtn.disabled = false;
    publishBtn.textContent = "Publier";
  }
});

exportBtn.addEventListener("click", async () => {
  await redraw();
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `livre-dor-${Date.now()}.png`;
  a.click();
});

/* --------------------------
   Controls -> update selected text style if selected
-------------------------- */

async function maybeUpdateSelectedTextStyle() {
  const it = getSelectedItem();
  if (!it || it.kind !== "text") return;

  const next = {
    font: fontSel.value,
    size: Number(sizeInput.value || 32),
    color: colorInput.value
  };

  try {
    await updateDoc(doc(db, "guestbook", it.id), next);
  } catch {
    // ignore
  }
}

fontSel.addEventListener("change", maybeUpdateSelectedTextStyle);
sizeInput.addEventListener("change", maybeUpdateSelectedTextStyle);
colorInput.addEventListener("change", maybeUpdateSelectedTextStyle);

/* --------------------------
   Mode buttons
-------------------------- */

toolTextBtn.addEventListener("click", () => setMode("text"));
toolDrawBtn.addEventListener("click", () => setMode("draw"));

/* --------------------------
   Pointer wiring (mouse + touch)
-------------------------- */

canvas.addEventListener("mousedown", onPointerDown);
canvas.addEventListener("mousemove", onPointerMove);
window.addEventListener("mouseup", onPointerUp);

canvas.addEventListener("touchstart", onPointerDown, { passive: false });
canvas.addEventListener("touchmove", onPointerMove, { passive: false });
window.addEventListener("touchend", onPointerUp, { passive: false });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideEditor();
    selectedId = null;
    redraw();
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    if (selectedId) deleteBtn.click();
  }
});

/* --------------------------
   Firestore realtime
-------------------------- */

async function main() {
  await ensureAnonAuth();

  const q = query(collection(db, "guestbook"), orderBy("createdAt", "asc"));
  onSnapshot(q, (snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .map(it => {
        // defaults
        if (typeof it.x !== "number") it.x = 40;
        if (typeof it.y !== "number") it.y = 40;

        // ensure boxes exist for selection
        if (it.kind === "text") {
          if (typeof it.w !== "number") it.w = 220;
          if (typeof it.h !== "number") it.h = Math.max(40, Number(it.size || 32) + 16);
        }
        if (it.kind === "drawing") {
          if (typeof it.w !== "number") it.w = 240;
          if (typeof it.h !== "number") it.h = 160;
        }
        return it;
      });

    // si l’élément sélectionné a été supprimé
    if (selectedId && !items.some(i => i.id === selectedId)) selectedId = null;

    redraw();
  });

  dprResize();
  window.addEventListener("resize", dprResize);
  setMode("text");
}

main();
