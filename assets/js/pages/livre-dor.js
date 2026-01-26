import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy,
  doc, updateDoc, deleteDoc, getDoc
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

// editor robust
const editorShell = document.getElementById("editorShell");
const floatingEditor = document.getElementById("floatingEditor");
const editorOk = document.getElementById("editorOk");
const editorCancel = document.getElementById("editorCancel");

let mode = "text";
let items = [];
const imageCache = new Map();

let selectedId = null;
let drag = null;
const HANDLE_RADIUS = 14;     // plus grand => resize plus facile
const MIN_W = 60;
const MIN_H = 40;

// draw local
let isDrawing = false;
let currentStroke = null;
let strokes = [];
let redoStrokes = [];

// undo/redo global
const undoStack = [];
const redoStack = [];

// editor state
let editorState = null; // {mode:"create"|"edit", x,y, id?}

function setHint(t){ hint.textContent = t; }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function applySegActive(btn, on){ btn.classList.toggle("active", !!on); }
function getTextStyle(){
  return {
    font: fontSel.value,
    size: Number(sizeInput.value || 32),
    color: colorInput.value,
    bold: boldBtn.classList.contains("active"),
    italic: italicBtn.classList.contains("active"),
    underline: underlineBtn.classList.contains("active")
  };
}

function buildFontCss(it){
  const parts = [];
  if (it.italic) parts.push("italic");
  if (it.bold) parts.push("700");
  parts.push(`${Number(it.size || 32)}px`);
  parts.push(it.font || "Georgia");
  return parts.join(" ");
}

function measureTextBox(it){
  // mesure approximative fiable (Safari/Chrome)
  ctx.save();
  ctx.font = buildFontCss(it);
  const metrics = ctx.measureText(it.text || "");
  const w = Math.max(MIN_W, Math.ceil(metrics.width) + 24);
  const h = Math.max(MIN_H, Math.ceil((it.size || 32) * 1.2) + 18);
  ctx.restore();
  return { w, h };
}

function dprResize(){
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  redraw();
}

function posFromEvent(e){
  const rect = canvas.getBoundingClientRect();
  const p = (e.touches?.[0]) || e;
  return { x: p.clientX - rect.left, y: p.clientY - rect.top };
}

function setMode(next){
  mode = next;

  toolTextBtn.classList.toggle("active", mode === "text");
  toolDrawBtn.classList.toggle("active", mode === "draw");
  toolTextBtn.setAttribute("aria-selected", mode === "text" ? "true" : "false");
  toolDrawBtn.setAttribute("aria-selected", mode === "draw" ? "true" : "false");

  textControls.style.display = mode === "text" ? "" : "none";
  drawControls.style.display = mode === "draw" ? "" : "none";

  hideEditor();

  setHint(mode === "text"
    ? "Texte : clique pour ajouter • Double clic pour éditer"
    : "Dessin : dessine • Publier pour ajouter"
  );

  updateButtons();
  redraw();
}

function updateButtons(){
  // Global undo/redo
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;

  // Local drawing undo/redo (optionnel): on garde, mais pas sur les boutons globaux
  publishBtn.disabled = mode !== "draw" || strokes.length === 0;

  deleteBtn.disabled = !selectedId;
}

function drawBackground(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0,0,canvas.width,canvas.height);
}

function drawStroke(s){
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.beginPath();
  const pts = s.points;
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawText(it){
  ctx.save();
  ctx.fillStyle = it.color || "#111";
  ctx.font = buildFontCss(it);
  ctx.textBaseline = "top";
  ctx.fillText(it.text || "", it.x, it.y);

  // underline (zone entière)
  if (it.underline) {
    const m = ctx.measureText(it.text || "");
    const yLine = it.y + (Number(it.size||32) * 1.05);
    ctx.strokeStyle = it.color || "#111";
    ctx.lineWidth = Math.max(1, Math.round((Number(it.size||32))/18));
    ctx.beginPath();
    ctx.moveTo(it.x, yLine);
    ctx.lineTo(it.x + m.width, yLine);
    ctx.stroke();
  }
  ctx.restore();
}

async function getImage(url){
  if (imageCache.has(url)) return imageCache.get(url);
  const img = new Image();
  img.crossOrigin = "anonymous";
  const p = new Promise((resolve,reject)=>{
    img.onload = ()=>resolve(img);
    img.onerror = reject;
  });
  img.src = url;
  imageCache.set(url,p);
  return p;
}

async function drawDrawing(it){
  if (!it.imageUrl) return;
  try{
    const img = await getImage(it.imageUrl);
    ctx.drawImage(img, it.x, it.y, it.w, it.h);
  }catch{}
}

function getSelectedItem(){
  return items.find(i=>i.id===selectedId) || null;
}

function drawSelectionBox(it){
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,.35)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6,5]);
  ctx.strokeRect(it.x, it.y, it.w, it.h);
  ctx.setLineDash([]);

  const hs = [
    { k:"nw", x: it.x,       y: it.y },
    { k:"ne", x: it.x+it.w,  y: it.y },
    { k:"se", x: it.x+it.w,  y: it.y+it.h },
    { k:"sw", x: it.x,       y: it.y+it.h },
  ];
  for (const h of hs){
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.beginPath();
    ctx.arc(h.x, h.y, 7, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

async function redraw(){
  drawBackground();

  for (const it of items){
    if (it.kind === "text") drawText(it);
    if (it.kind === "drawing") await drawDrawing(it);
  }

  // strokes locaux
  for (const s of strokes) drawStroke(s);
  if (currentStroke) drawStroke(currentStroke);

  const sel = getSelectedItem();
  if (sel) drawSelectionBox(sel);

  updateButtons();
}

/* ---------- hit testing ---------- */

function handleHit(it, x, y){
  const corners = [
    ["nw", it.x, it.y],
    ["ne", it.x+it.w, it.y],
    ["se", it.x+it.w, it.y+it.h],
    ["sw", it.x, it.y+it.h],
  ];
  for (const [k,cx,cy] of corners){
    const dx=x-cx, dy=y-cy;
    if (Math.sqrt(dx*dx+dy*dy) <= HANDLE_RADIUS) return k;
  }
  return null;
}

function itemHit(x,y){
  for (let i=items.length-1;i>=0;i--){
    const it = items[i];
    if (x>=it.x && x<=it.x+it.w && y>=it.y && y<=it.y+it.h) return it;
  }
  return null;
}

/* ---------- editor (robuste Safari) ---------- */

function showEditor(x,y, initial, state){
  editorState = state; // {mode:"create"|"edit", id?}
  editorShell.style.display = "block";
  editorShell.style.left = `${x}px`;
  editorShell.style.top = `${y}px`;

  floatingEditor.value = initial || "";
  floatingEditor.focus({ preventScroll: true });
  floatingEditor.setSelectionRange(floatingEditor.value.length, floatingEditor.value.length);

  // pas d'auto-commit au blur (Safari)
}

function hideEditor(){
  editorShell.style.display = "none";
  editorState = null;
}

editorCancel.addEventListener("click", () => hideEditor());

editorOk.addEventListener("click", async () => {
  if (!editorState) return;
  const txt = (floatingEditor.value || "").trim();
  if (!txt) { hideEditor(); return; }

  const x = parseFloat(editorShell.style.left || "40");
  const y = parseFloat(editorShell.style.top || "40");

  if (editorState.mode === "create") {
    const style = getTextStyle();
    const temp = { kind:"text", text: txt, x, y, ...style };
    const { w, h } = measureTextBox(temp);

    const ref = await addDoc(collection(db,"guestbook"), {
      kind: "text",
      createdAt: Date.now(),
      text: txt,
      x, y, w, h,
      ...style
    });

    // undo action (delete created)
    undoStack.push({ type:"create", id: ref.id, collection: "guestbook" });
    redoStack.length = 0;

    selectedId = ref.id;
  }

  if (editorState.mode === "edit" && editorState.id) {
    const prevSnap = await getDoc(doc(db,"guestbook", editorState.id));
    const prev = prevSnap.data();

    const itNew = { ...prev, text: txt };
    const { w, h } = measureTextBox(itNew);

    await updateDoc(doc(db,"guestbook", editorState.id), { text: txt, w, h });

    undoStack.push({
      type:"update",
      id: editorState.id,
      before: { text: prev.text, w: prev.w, h: prev.h },
      after:  { text: txt, w, h }
    });
    redoStack.length = 0;
  }

  hideEditor();
  redraw();
});

/* ---------- global undo/redo ---------- */

async function performUndo(){
  const a = undoStack.pop();
  if (!a) return;

  if (a.type === "create") {
    // undo create => delete doc
    const snap = await getDoc(doc(db, a.collection, a.id));
    const data = snap.exists() ? snap.data() : null;
    await deleteDoc(doc(db, a.collection, a.id));
    redoStack.push({ type:"recreate", collection:a.collection, id:a.id, data });
    if (selectedId === a.id) selectedId = null;
  }

  if (a.type === "recreate") {
    // undo recreate => delete again
    await deleteDoc(doc(db, a.collection, a.id));
    redoStack.push(a);
  }

  if (a.type === "delete") {
    // undo delete => recreate
    await addDoc(collection(db,"guestbook"), a.data); // new id (simple)
    // note: pour garder le même id il faut setDoc, mais on reste simple
    redoStack.push({ type:"delete", id: null, data: a.data });
  }

  if (a.type === "update") {
    await updateDoc(doc(db,"guestbook", a.id), a.before);
    redoStack.push(a);
  }

  redraw();
}

async function performRedo(){
  const a = redoStack.pop();
  if (!a) return;

  if (a.type === "recreate") {
    if (!a.data) return;
    // on recrée (nouvel id)
    await addDoc(collection(db,"guestbook"), a.data);
    undoStack.push({ type:"delete", id:null, data:a.data });
  }

  if (a.type === "update") {
    await updateDoc(doc(db,"guestbook", a.id), a.after);
    undoStack.push(a);
  }

  redraw();
}

undoBtn.addEventListener("click", () => performUndo());
redoBtn.addEventListener("click", () => performRedo());

/* ---------- style buttons ---------- */

boldBtn.addEventListener("click", async () => {
  applySegActive(boldBtn, !boldBtn.classList.contains("active"));
  await maybeUpdateSelectedTextStyle();
});
italicBtn.addEventListener("click", async () => {
  applySegActive(italicBtn, !italicBtn.classList.contains("active"));
  await maybeUpdateSelectedTextStyle();
});
underlineBtn.addEventListener("click", async () => {
  applySegActive(underlineBtn, !underlineBtn.classList.contains("active"));
  await maybeUpdateSelectedTextStyle();
});

async function maybeUpdateSelectedTextStyle(){
  const it = getSelectedItem();
  if (!it || it.kind !== "text") return;

  const prevSnap = await getDoc(doc(db,"guestbook", it.id));
  const prev = prevSnap.data();

  const style = getTextStyle();
  const temp = { ...prev, ...style };
  const { w, h } = measureTextBox(temp);

  await updateDoc(doc(db,"guestbook", it.id), { ...style, w, h });

  undoStack.push({
    type:"update",
    id: it.id,
    before: { font: prev.font, size: prev.size, color: prev.color, bold: prev.bold, italic: prev.italic, underline: prev.underline, w: prev.w, h: prev.h },
    after:  { ...style, w, h }
  });
  redoStack.length = 0;

  redraw();
}

fontSel.addEventListener("change", maybeUpdateSelectedTextStyle);
sizeInput.addEventListener("change", maybeUpdateSelectedTextStyle);
colorInput.addEventListener("change", maybeUpdateSelectedTextStyle);

/* ---------- pointer interactions ---------- */

async function onDown(e){
  const {x,y} = posFromEvent(e);

  const hit = itemHit(x,y);
  if (hit) {
    selectedId = hit.id;

    const h = handleHit(hit, x, y);
    if (h) {
      drag = { type:"resize", handle:h, startX:x, startY:y, orig:{...hit} };
    } else {
      drag = { type:"move", startX:x, startY:y, orig:{...hit} };
    }
    hideEditor();
    redraw();
    return;
  }

  // empty
  selectedId = null;
  hideEditor();
  redraw();

  if (mode === "text") {
    showEditor(x, y, "", { mode:"create" });
    return;
  }

  if (mode === "draw") {
    e.preventDefault();
    isDrawing = true;
    currentStroke = {
      color: penColorInput.value,
      width: Number(penSizeInput.value || 6),
      points: [{x,y}]
    };
    redoStrokes = [];
  }
}

async function onMove(e){
  const {x,y} = posFromEvent(e);

  if (mode === "draw" && isDrawing && currentStroke) {
    e.preventDefault();
    currentStroke.points.push({x,y});
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
    let nx = drag.orig.x, ny = drag.orig.y, nw = drag.orig.w, nh = drag.orig.h;

    if (drag.handle.includes("e")) nw = drag.orig.w + dx;
    if (drag.handle.includes("s")) nh = drag.orig.h + dy;
    if (drag.handle.includes("w")) { nw = drag.orig.w - dx; nx = drag.orig.x + dx; }
    if (drag.handle.includes("n")) { nh = drag.orig.h - dy; ny = drag.orig.y + dy; }

    nw = clamp(nw, MIN_W, 5000);
    nh = clamp(nh, MIN_H, 5000);

    it.x = nx; it.y = ny; it.w = nw; it.h = nh;
  }

  redraw();
}

async function onUp(e){
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

  const changed = it.x!==orig.x || it.y!==orig.y || it.w!==orig.w || it.h!==orig.h;
  if (!changed) return;

  try{
    await updateDoc(doc(db,"guestbook", it.id), { x: it.x, y: it.y, w: it.w, h: it.h });
    undoStack.push({
      type:"update",
      id: it.id,
      before: { x: orig.x, y: orig.y, w: orig.w, h: orig.h },
      after:  { x: it.x, y: it.y, w: it.w, h: it.h }
    });
    redoStack.length = 0;
  }catch{
    alert("Impossible de déplacer/redimensionner (règles Firestore ?).");
  }
  redraw();
}

canvas.addEventListener("mousedown", onDown);
canvas.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onUp);

canvas.addEventListener("touchstart", onDown, { passive:false });
canvas.addEventListener("touchmove", onMove, { passive:false });
window.addEventListener("touchend", onUp, { passive:false });

// edit text
canvas.addEventListener("dblclick", (e)=>{
  const {x,y} = posFromEvent(e);
  const hit = itemHit(x,y);
  if (!hit || hit.kind !== "text") return;

  selectedId = hit.id;
  redraw();
  showEditor(hit.x, hit.y, hit.text || "", { mode:"edit", id: hit.id });
});

// delete
deleteBtn.addEventListener("click", async ()=>{
  if (!selectedId) return;
  if (!confirm("Supprimer cet élément ?")) return;

  const it = getSelectedItem();
  if (!it) return;

  try{
    const snap = await getDoc(doc(db,"guestbook", it.id));
    const data = snap.data();
    await deleteDoc(doc(db,"guestbook", it.id));

    undoStack.push({ type:"recreate", collection:"guestbook", id: it.id, data });
    redoStack.length = 0;

    selectedId = null;
    redraw();
  }catch{
    alert("Suppression impossible (règles Firestore ?).");
  }
});

/* ---------- publish drawing (bbox crop) ---------- */

publishBtn.addEventListener("click", async ()=>{
  if (mode !== "draw" || !strokes.length) return;

  publishBtn.disabled = true;
  publishBtn.textContent = "⏳";

  try{
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const s of strokes) {
      for (const p of s.points) {
        minX = Math.min(minX,p.x); minY = Math.min(minY,p.y);
        maxX = Math.max(maxX,p.x); maxY = Math.max(maxY,p.y);
      }
    }
    const pad = 18;
    minX = Math.max(0, minX-pad); minY = Math.max(0, minY-pad);

    const rect = canvas.getBoundingClientRect();
    maxX = Math.min(rect.width, maxX+pad);
    maxY = Math.min(rect.height, maxY+pad);

    const w = Math.max(80, maxX-minX);
    const h = Math.max(80, maxY-minY);

    const off = document.createElement("canvas");
    off.width = Math.round(w);
    off.height = Math.round(h);
    const octx = off.getContext("2d");

    octx.fillStyle = "#fff";
    octx.fillRect(0,0,off.width,off.height);

    for (const s of strokes) {
      octx.lineCap="round"; octx.lineJoin="round";
      octx.strokeStyle = s.color;
      octx.lineWidth = s.width;
      octx.beginPath();
      const pts = s.points;
      octx.moveTo(pts[0].x-minX, pts[0].y-minY);
      for (let i=1;i<pts.length;i++) octx.lineTo(pts[i].x-minX, pts[i].y-minY);
      octx.stroke();
    }

    const blob = await new Promise(res => off.toBlob(res, "image/png"));
    const file = new File([blob], `dessin-${Date.now()}.png`, { type:"image/png" });
    const up = await uploadImage(file);

    const ref = await addDoc(collection(db,"guestbook"), {
      kind:"drawing",
      createdAt: Date.now(),
      imageUrl: up.secure_url,
      x: minX,
      y: minY,
      w, h
    });

    undoStack.push({ type:"create", id: ref.id, collection:"guestbook" });
    redoStack.length = 0;

    strokes = [];
    redoStrokes = [];
    selectedId = ref.id;
    redraw();
  }catch(e){
    alert("Erreur publication : " + (e?.message || e));
  }finally{
    publishBtn.disabled = false;
    publishBtn.textContent = "Publier";
  }
});

/* ---------- export ---------- */
exportBtn.addEventListener("click", async ()=>{
  await redraw();
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `livre-dor-${Date.now()}.png`;
  a.click();
});

/* ---------- tool buttons ---------- */
toolTextBtn.addEventListener("click", ()=>setMode("text"));
toolDrawBtn.addEventListener("click", ()=>setMode("draw"));

/* ---------- keyboard shortcuts ---------- */
document.addEventListener("keydown", (e)=>{
  if (editorShell.style.display !== "none") {
    if (e.key === "Escape") hideEditor();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); editorOk.click(); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) performRedo(); else performUndo();
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (selectedId) deleteBtn.click();
  }
});

/* ---------- Firestore realtime ---------- */
async function main(){
  await ensureAnonAuth();

  const q = query(collection(db,"guestbook"), orderBy("createdAt","asc"));
  onSnapshot(q, (snap)=>{
    items = snap.docs.map(d => ({ id:d.id, ...d.data() }))
      .map(it=>{
        if (typeof it.x !== "number") it.x = 40;
        if (typeof it.y !== "number") it.y = 40;

        if (it.kind === "text") {
          // ensure style defaults
          it.bold = !!it.bold;
          it.italic = !!it.italic;
          it.underline = !!it.underline;

          // ensure bbox exists / recalculable
          if (typeof it.w !== "number" || typeof it.h !== "number") {
            const b = measureTextBox(it);
            it.w = b.w; it.h = b.h;
          }
        }

        if (it.kind === "drawing") {
          if (typeof it.w !== "number") it.w = 240;
          if (typeof it.h !== "number") it.h = 160;
        }
        return it;
      });

    if (selectedId && !items.some(i=>i.id===selectedId)) selectedId = null;
    redraw();
  });

  dprResize();
  window.addEventListener("resize", dprResize);
  setMode("text");
}
main();
