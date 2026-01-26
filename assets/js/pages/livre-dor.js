import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const canvas = document.getElementById("guestCanvas");
const ctx = canvas.getContext("2d");

const tool = document.getElementById("tool");
const fontSel = document.getElementById("font");
const textValue = document.getElementById("textValue");
const color = document.getElementById("color");
const size = document.getElementById("size");
const penSize = document.getElementById("penSize");

const publishBtn = document.getElementById("publish");
const undoBtn = document.getElementById("undo");
const clearBtn = document.getElementById("clear");
const exportBtn = document.getElementById("exportCanvasPng");

const canvasHint = document.getElementById("canvasHint");

const textFields = [...document.querySelectorAll(".field-text")];
const drawFields = [...document.querySelectorAll(".field-draw")];

let localStrokes = [];
let isDown = false;
let currentStroke = null;

let sharedItems = [];
const imageCache = new Map();

function setHint(msg) {
  canvasHint.textContent = msg || "";
}

function updateUI() {
  const mode = tool.value;

  const isText = mode === "text";
  for (const el of textFields) el.style.display = isText ? "" : "none";
  for (const el of drawFields) el.style.display = isText ? "none" : "";

  publishBtn.style.display = isText ? "none" : "";
  undoBtn.disabled = isText ? true : localStrokes.length === 0;
  clearBtn.disabled = isText ? true : localStrokes.length === 0;

  if (isText) {
    setHint("✍️ Mode Texte : écris ton message, puis clique dans la zone blanche pour le placer.");
    textValue.focus({ preventScroll: true });
  } else {
    setHint("✏️ Mode Dessin : dessine dans la zone blanche, puis clique sur “Publier dessin” pour l’ajouter.");
  }
}

function resizeCanvas() {
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

function drawStroke(stroke) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  const pts = stroke.points;
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawTextItem(it) {
  ctx.fillStyle = it.color || "#111";
  const font = it.font || "Georgia";
  const sz = Number(it.size || 28);
  ctx.font = `${sz}px ${font}`;
  ctx.textBaseline = "top";
  ctx.fillText(it.text || "", it.x || 0, it.y || 0);
}

async function getCachedImage(url) {
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

async function drawImageItem(it) {
  try {
    const img = await getCachedImage(it.imageUrl);
    const x = it.x ?? 0;
    const y = it.y ?? 0;
    const w = it.w ?? img.width;
    const h = it.h ?? img.height;
    ctx.drawImage(img, x, y, w, h);
  } catch {
    // ignore
  }
}

async function redraw() {
  // fond
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // éléments partagés
  for (const it of sharedItems) {
    if (it.kind === "text") drawTextItem(it);
    if (it.kind === "drawing") await drawImageItem(it);
  }

  // traits locaux (non publiés)
  for (const s of localStrokes) drawStroke(s);

  // maj boutons
  updateUI();
}

/* ---------------------------
   Interactions Canvas
---------------------------- */

function onDown(e) {
  if (tool.value !== "draw") return;
  e.preventDefault();

  isDown = true;
  const { x, y } = posFromEvent(e);
  currentStroke = {
    color: color.value,
    width: Number(penSize.value || 6),
    points: [{ x, y }],
  };
}

function onMove(e) {
  if (tool.value !== "draw") return;
  if (!isDown || !currentStroke) return;
  e.preventDefault();

  const { x, y } = posFromEvent(e);
  currentStroke.points.push({ x, y });

  // redraw rapide local
  redraw();
  drawStroke(currentStroke);
}

function onUp(e) {
  if (tool.value !== "draw") return;
  if (!isDown || !currentStroke) return;
  e.preventDefault();

  isDown = false;
  localStrokes.push(currentStroke);
  currentStroke = null;
  redraw();
}

async function onClick(e) {
  if (tool.value !== "text") return;
  const txt = (textValue.value || "").trim();
  if (!txt) {
    setHint("✍️ Écris un message dans le champ “Texte”, puis clique pour le placer.");
    return;
  }

  const { x, y } = posFromEvent(e);

  await addDoc(collection(db, "guestbook"), {
    kind: "text",
    createdAt: Date.now(),
    text: txt,
    x, y,
    font: fontSel.value,
    size: Number(size.value || 28),
    color: color.value,
  });

  // comportement sympa : vider le champ après placement
  textValue.value = "";
  setHint("✅ Message ajouté ! Tu peux en écrire un autre et cliquer pour le placer.");
}

canvas.addEventListener("mousedown", onDown);
canvas.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onUp);

canvas.addEventListener("touchstart", onDown, { passive: false });
canvas.addEventListener("touchmove", onMove, { passive: false });
window.addEventListener("touchend", onUp, { passive: false });

canvas.addEventListener("click", onClick);

/* ---------------------------
   Actions
---------------------------- */

undoBtn.addEventListener("click", () => {
  if (tool.value !== "draw") return;
  localStrokes.pop();
  redraw();
});

clearBtn.addEventListener("click", () => {
  if (tool.value !== "draw") return;
  localStrokes = [];
  redraw();
});

publishBtn.addEventListener("click", async () => {
  if (tool.value !== "draw") return;
  if (!localStrokes.length) return;

  publishBtn.disabled = true;
  publishBtn.textContent = "⏳ Publication…";

  try {
    // Render strokes to offscreen canvas
    const rect = canvas.getBoundingClientRect();
    const off = document.createElement("canvas");
    off.width = Math.round(rect.width);
    off.height = Math.round(rect.height);
    const octx = off.getContext("2d");

    // fond blanc
    octx.fillStyle = "#fff";
    octx.fillRect(0, 0, off.width, off.height);

    // uniquement les strokes locaux
    for (const s of localStrokes) {
      octx.lineCap = "round";
      octx.lineJoin = "round";
      octx.strokeStyle = s.color;
      octx.lineWidth = s.width;
      octx.beginPath();
      const pts = s.points;
      if (!pts.length) continue;
      octx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) octx.lineTo(pts[i].x, pts[i].y);
      octx.stroke();
    }

    const blob = await new Promise((resolve) => off.toBlob(resolve, "image/png"));
    const file = new File([blob], `dessin-${Date.now()}.png`, { type: "image/png" });

    const up = await uploadImage(file);

    await addDoc(collection(db, "guestbook"), {
      kind: "drawing",
      createdAt: Date.now(),
      imageUrl: up.secure_url,
      x: 0,
      y: 0,
      w: off.width,
      h: off.height,
    });

    localStrokes = [];
    setHint("✅ Dessin publié ! Merci 💛");
    redraw();
  } catch (e) {
    alert("Erreur publication : " + (e?.message || e));
  } finally {
    publishBtn.disabled = false;
    publishBtn.textContent = "Publier dessin";
  }
});

exportBtn.addEventListener("click", async () => {
  // on exporte l'état actuel (shared + local)
  await redraw();
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `livre-dor-${Date.now()}.png`;
  a.click();
});

/* ---------------------------
   Firestore realtime
---------------------------- */

tool.addEventListener("change", updateUI);
textValue.addEventListener("input", () => {
  if (tool.value === "text" && (textValue.value || "").trim()) {
    setHint("✍️ Clique dans la zone blanche pour placer ton message.");
  }
});

async function main() {
  await ensureAnonAuth();
  updateUI();

  const q = query(collection(db, "guestbook"), orderBy("createdAt", "asc"));
  onSnapshot(q, (snap) => {
    sharedItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    redraw();
  });

  // resize
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
}

main();
