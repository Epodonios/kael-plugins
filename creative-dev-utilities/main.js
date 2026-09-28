/**
 * creative-dev-utilities — a 7-in-1 KAEL plugin.
 *
 * One plugin, one internal tab strip, seven tools:
 *   01 sketchboard    — freehand pen, shapes, text, eraser, undo/redo, pan/zoom, PNG export
 *   02 flowchart      — draggable nodes, edges, palette, SVG + PNG export
 *   03 font-id        — LOCAL heuristic font matcher (shape/stroke/serif traits vs candidates)
 *   04 compressor     — real image compression through KAEL's sharp engine (fs.imageBatch)
 *   05 converter      — honest image/pdf conversion scoped to what the bridge really supports
 *   06 code-to-image  — syntax-highlighted code rendered as a rounded-chrome PNG
 *   07 package size   — real npm bundle-size lookup (the ONLY network tool: net.fetch)
 *
 * Plain DOM + canvas + SVG. No framework, no build step, no imports.
 * Theme-reactive through the app's CSS variables (see style.css).
 *
 * Contract (PLUGIN-AUTHORING.md at the KAEL repo root):
 *   export async function mount(container, kaelApi)
 *   export function unmount(container)
 *
 * Declared permissions (manifest.json) — that is ALL this plugin can call:
 *   fs.dialog  → fs.pick / fs.pathForFile   (user-chosen file paths; low risk)
 *   fs.write   → fs.imageBatch / fs.pdfInfo / fs.pdfMerge / fs.pdfSplit
 *                (writes NEW files next to the picked ones — never deletes/overwrites)
 *   net.fetch  → net.fetchJson              (https GET, 1 MB cap — used by tool 07 only)
 * Anything else on kaelApi throws a permission error naming this plugin.
 */

/* ============================== helpers ============================== */

const PLUGIN_ID = "creative-dev-utilities";
const PLUGIN_VERSION = "1.0.0";

/** Create an element. `attrs` sets attributes, `props` sets properties. */
function el(tag, attrs, props) {
  const n = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
  if (props) for (const k of Object.keys(props)) n[k] = props[k];
  return n;
}

function div(cls, txt) {
  const n = el("div", cls ? { class: cls } : null);
  if (txt !== undefined) n.textContent = txt;
  return n;
}

function btn(label, attrs, props) {
  const b = el("button", Object.assign({ type: "button", class: "cdu-btn" }, attrs || {}), props);
  b.textContent = label;
  return b;
}

/** Element factory that keeps textContent safe — children are nodes only. */
function add(parent, ...nodes) {
  for (const n of nodes) {
    if (n) parent.appendChild(n);
  }
  return nodes[0];
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

/** Small deterministic PRNG so sketchy rendering is stable across redraws. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Read a theme CSS variable (trimmed). Returns fallback when absent. */
function themeVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback || "#888";
}

/** Disposer list — every tool registers cleanups (listeners, URLs, observers). */
function makeDisposers() {
  const fns = [];
  return {
    add(fn) {
      if (typeof fn === "function") fns.push(fn);
    },
    /** document/window-level listener that must be removed on unmount. */
    listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      fns.push(() => target.removeEventListener(type, fn, opts));
    },
    /** Object URL that must be revoked on unmount. */
    url(objectUrl) {
      fns.push(() => URL.revokeObjectURL(objectUrl));
    },
    runAll() {
      for (let i = fns.length - 1; i >= 0; i--) {
        try {
          fns[i]();
        } catch {
          /* a tool's cleanup must never break the deck */
        }
      }
      fns.length = 0;
    },
  };
}

/** Status line with honest tone styling. */
function makeStatus(host) {
  const line = div("cdu-status", "");
  add(host, line);
  return {
    el: line,
    set(msg, tone) {
      line.textContent = msg;
      line.className = "cdu-status" + (tone ? " cdu-status-" + tone : "");
    },
  };
}

/** Standard download helper (same a[download] pattern the deck's own tools use). */
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function safeName(s, fallback) {
  const t = String(s || "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60);
  return t || fallback;
}

/** Wrap a bridge call so a permission refusal surfaces as an honest status. */
async function bridge(status, what, fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = (err && err.message) || String(err);
    status.set(what + " refused → " + msg, "bad");
    return null;
  }
}

/* ============================== tab strip ============================== */

/**
 * Lazy-built tool tabs. Each definition builds its DOM into a fresh <section>
 * the first time it is activated, then stays alive for the mount session.
 */
function makeTabs(root, defs, helpHost) {
  const tablist = div("cdu-tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "creative & dev utilities tools");
  const panels = div("cdu-panels");
  const built = new Array(defs.length).fill(null);
  let active = -1;

  const tabs = defs.map((d, i) => {
    const t = el("button", {
      type: "button",
      class: "cdu-tab",
      role: "tab",
      id: "cdu-tab-" + d.id,
      "aria-selected": "false",
      "aria-controls": "cdu-panel-" + d.id,
    });
    const no = el("span", { class: "cdu-tabno", "aria-hidden": "true" });
    no.textContent = String(i + 1).padStart(2, "0");
    t.appendChild(no);
    t.appendChild(document.createTextNode(d.label));
    t.addEventListener("click", () => activate(i));
    add(tablist, t);
    return t;
  });

  function activate(i) {
    if (i === active) return;
    if (!built[i]) {
      const sec = el("section", {
        class: "cdu-panel",
        role: "tabpanel",
        id: "cdu-panel-" + defs[i].id,
        "aria-labelledby": "cdu-tab-" + defs[i].id,
      });
      const help = div("cdu-help");
      help.textContent = defs[i].help;
      add(sec, help);
      defs[i].build(sec);
      built[i] = sec;
      add(panels, sec);
    }
    for (let k = 0; k < tabs.length; k++) {
      tabs[k].setAttribute("aria-selected", k === i ? "true" : "false");
      if (built[k]) built[k].hidden = k !== i;
    }
    if (helpHost) helpHost.textContent = defs[i].help;
    active = i;
  }

  root.appendChild(tablist);
  root.appendChild(panels);
  activate(0);
  return { activate };
}

/* ==================================================================== */
/* TOOL 01 — SKETCHBOARD                                                */
/* ==================================================================== */

function buildSketchboard(section) {
  const d = makeDisposers();
  section.__cduDispose = d.runAll.bind(d);

  const bar1 = div("cdu-bar");
  const bar2 = div("cdu-bar");
  add(section, bar1);
  add(section, bar2);
  const status = makeStatus(section);

  const frame = div("cdu-frame");
  frame.style.position = "relative";
  const canvas = el("canvas", { class: "cdu-sb-canvas", "aria-label": "sketchboard canvas" });
  add(frame, canvas);
  add(section, frame);

  /* ---- state ---- */
  const TOOLS = ["pen", "line", "arrow", "rect", "ellipse", "text", "eraser", "pan"];
  const TOOL_LABEL = { pen: "✎ pen", line: "╱ line", arrow: "→ arrow", rect: "▭ rect", ellipse: "◯ ellipse", text: "T text", eraser: "⌫ eraser", pan: "✥ pan" };
  let tool = "pen";
  let color = themeVar("--accent", "#3dd68c");
  let width = 3;
  let view = { x: 0, y: 0, k: 1 };
  let shapes = [];
  let undoStack = [];
  let redoStack = [];
  let cur = null; // shape being drawn
  let panning = null;
  let spaceHeld = false;
  let idSeq = 1;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

  function snapshot() {
    undoStack.push(JSON.stringify(shapes));
    if (undoStack.length > 60) undoStack.shift();
    redoStack.length = 0;
  }

  function undo() {
    if (!undoStack.length) return status.set("nothing to undo", "warn");
    redoStack.push(JSON.stringify(shapes));
    shapes = JSON.parse(undoStack.pop());
    redraw();
    status.set("undo · " + shapes.length + " object(s) on board");
  }
  function redo() {
    if (!redoStack.length) return status.set("nothing to redo", "warn");
    undoStack.push(JSON.stringify(shapes));
    shapes = JSON.parse(redoStack.pop());
    redraw();
    status.set("redo · " + shapes.length + " object(s) on board");
  }

  /* ---- coordinate transforms ---- */
  function toWorld(evt) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (evt.clientX - r.left - view.x) / view.k,
      y: (evt.clientY - r.top - view.y) / view.k,
    };
  }

  function zoomAt(sx, sy, factor) {
    const k2 = clamp(view.k * factor, 0.2, 8);
    const r = canvas.getBoundingClientRect();
    const px = sx - r.left;
    const py = sy - r.top;
    view.x = px - ((px - view.x) * k2) / view.k;
    view.y = py - ((py - view.y) * k2) / view.k;
    view.k = k2;
    redraw();
  }

  /* ---- sketchy geometry (stable per shape via seeded jitter) ---- */
  function roughPts(a, b, seed, passes) {
    const rng = mulberry32(seed);
    const segs = 5;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const lines = [];
    for (let p = 0; p < passes; p++) {
      const pts = [];
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const j = (rng() - 0.5) * 2.4;
        pts.push({ x: a.x + dx * t + nx * j, y: a.y + dy * t + ny * j });
      }
      lines.push(pts);
    }
    return lines;
  }

  function strokeRoughLine(ctx, a, b, seed, widthPx) {
    ctx.lineWidth = widthPx;
    for (const pts of roughPts(a, b, seed, 2)) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  }

  function rectEdges(s) {
    return [
      [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y }],
      [{ x: s.x + s.w, y: s.y }, { x: s.x + s.w, y: s.y + s.h }],
      [{ x: s.x + s.w, y: s.y + s.h }, { x: s.x, y: s.y + s.h }],
      [{ x: s.x, y: s.y + s.h }, { x: s.x, y: s.y }],
    ];
  }

  function drawShape(ctx, s) {
    ctx.strokeStyle = s.stroke;
    ctx.fillStyle = s.stroke;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.tool === "pen") {
      ctx.lineWidth = s.width;
      const p = s.pts;
      if (p.length === 1) {
        ctx.beginPath();
        ctx.arc(p[0].x, p[0].y, s.width / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i].x + p[i + 1].x) / 2;
        const my = (p[i].y + p[i + 1].y) / 2;
        ctx.quadraticCurveTo(p[i].x, p[i].y, mx, my);
      }
      ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
      ctx.stroke();
      return;
    }
    if (s.tool === "line" || s.tool === "arrow") {
      strokeRoughLine(ctx, { x: s.x, y: s.y }, { x: s.x2, y: s.y2 }, s.seed, s.width);
      if (s.tool === "arrow") {
        const ang = Math.atan2(s.y2 - s.y, s.x2 - s.x);
        const hl = clamp(8 + s.width * 2.2, 8, 22);
        for (const off of [Math.PI * 0.82, -Math.PI * 0.82]) {
          strokeRoughLine(ctx, { x: s.x2, y: s.y2 }, { x: s.x2 + Math.cos(ang + off) * hl, y: s.y2 + Math.sin(ang + off) * hl }, s.seed + 7, s.width);
        }
      }
      return;
    }
    if (s.tool === "rect") {
      let seed = s.seed;
      for (const [a, b] of rectEdges(s)) strokeRoughLine(ctx, a, b, (seed += 13), s.width);
      return;
    }
    if (s.tool === "ellipse") {
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const rx = Math.abs(s.w / 2) || 1;
      const ry = Math.abs(s.h / 2) || 1;
      ctx.lineWidth = s.width;
      for (let pass = 0; pass < 2; pass++) {
        const rng = mulberry32(s.seed + pass * 31);
        ctx.beginPath();
        const N = 26;
        for (let i = 0; i <= N; i++) {
          const t = (i / N) * Math.PI * 2;
          const jr = 1 + (rng() - 0.5) * 0.05;
          const px = cx + Math.cos(t) * rx * jr;
          const py = cy + Math.sin(t) * ry * jr;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      return;
    }
    if (s.tool === "text") {
      ctx.font = s.size + "px ui-monospace, 'Cascadia Code', Consolas, monospace";
      ctx.textBaseline = "top";
      ctx.fillText(s.text, s.x, s.y);
      return;
    }
  }

  /* ---- hit testing (eraser) ---- */
  function distToSeg(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }

  function hitShape(p, s) {
    const pad = 8 / view.k + s.width;
    if (s.tool === "pen") {
      for (let i = 0; i < s.pts.length - 1; i++) if (distToSeg(p, s.pts[i], s.pts[i + 1]) <= pad) return true;
      if (s.pts.length === 1) return Math.hypot(p.x - s.pts[0].x, p.y - s.pts[0].y) <= pad;
      return false;
    }
    if (s.tool === "line" || s.tool === "arrow") return distToSeg(p, { x: s.x, y: s.y }, { x: s.x2, y: s.y2 }) <= pad;
    if (s.tool === "rect" || s.tool === "ellipse") {
      const x1 = Math.min(s.x, s.x + s.w) - pad;
      const x2 = Math.max(s.x, s.x + s.w) + pad;
      const y1 = Math.min(s.y, s.y + s.h) - pad;
      const y2 = Math.max(s.y, s.y + s.h) + pad;
      return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
    }
    if (s.tool === "text") {
      const w = measureText(s);
      return p.x >= s.x - pad && p.x <= s.x + w + pad && p.y >= s.y - pad && p.y <= s.y + s.size * 1.3 + pad;
    }
    return false;
  }

  function measureText(s) {
    const c = measureText._ctx || (measureText._ctx = document.createElement("canvas").getContext("2d"));
    c.font = s.size + "px ui-monospace, Consolas, monospace";
    return c.measureText(s.text).width;
  }

  /* ---- rendering ---- */
  function redraw() {
    const ctx = canvas.getContext("2d");
    const ratio = dpr();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

    /* dotted world grid */
    const grid = 26;
    ctx.fillStyle = themeVar("--line", "#222");
    const wx0 = Math.floor(-view.x / view.k / grid) * grid;
    const wy0 = Math.floor(-view.y / view.k / grid) * grid;
    const wx1 = wx0 + w / view.k + grid * 2;
    const wy1 = wy0 + h / view.k + grid * 2;
    for (let gx = wx0; gx < wx1; gx += grid) {
      for (let gy = wy0; gy < wy1; gy += grid) {
        const sx = gx * view.k + view.x;
        const sy = gy * view.k + view.y;
        if (sx < 0 || sy < 0 || sx > w || sy > h) continue;
        ctx.fillRect(sx, sy, 1, 1);
      }
    }

    ctx.setTransform(ratio * view.k, 0, 0, ratio * view.k, ratio * view.x, ratio * view.y);
    const all = cur ? shapes.concat([cur]) : shapes;
    for (const s of all) drawShape(ctx, s);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ResizeObserver keeps the canvas backing store honest */
  const ro = new ResizeObserver(() => redraw());
  ro.observe(canvas);
  d.add(() => ro.disconnect());

  /* ---- text overlay ---- */
  let textEdit = null;
  function openTextInput(worldPt) {
    closeTextInput(false);
    const inp = el("input", { class: "cdu-sb-textinput", "aria-label": "text to place" });
    inp.value = "";
    const r = frame.getBoundingClientRect();
    const scr = { x: worldPt.x * view.k + view.x, y: worldPt.y * view.k + view.y };
    inp.style.left = scr.x + "px";
    inp.style.top = scr.y + "px";
    inp.style.fontSize = clamp(13 * view.k, 9, 40) + "px";
    add(frame, inp);
    /* defer focus: the browser's default mousedown focus lands AFTER this handler,
     * and an immediate focus() here would be immediately stolen (blur → commit) */
    setTimeout(() => inp.focus(), 0);
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const val = inp.value.trim();
      inp.remove();
      textEdit = null;
      if (!val) return;
      snapshot();
      shapes.push({
        id: idSeq++,
        tool: "text",
        x: worldPt.x,
        y: worldPt.y,
        text: val,
        size: 16,
        stroke: color,
        width,
        seed: 0,
      });
      redraw();
      status.set("text placed · " + shapes.length + " object(s)");
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") {
        done = true;
        inp.remove();
        textEdit = null;
      }
      e.stopPropagation();
    });
    inp.addEventListener("blur", commit);
    textEdit = { inp, commit };
  }
  function closeTextInput(commitIt) {
    if (textEdit) {
      if (commitIt) textEdit.commit();
      else {
        textEdit.inp.remove();
        textEdit = null;
      }
    }
  }

  /* ---- pointer interaction ---- */
  function dragTarget(evt) {
    if (evt.button === 1 || spaceHeld || tool === "pan") return "pan";
    return tool;
  }

  canvas.addEventListener("pointerdown", (evt) => {
    canvas.setPointerCapture(evt.pointerId);
    const w = toWorld(evt);
    const kind = dragTarget(evt);
    if (kind === "pan") {
      panning = { sx: evt.clientX, sy: evt.clientY, ox: view.x, oy: view.y };
      canvas.dataset.tool = "pan";
      return;
    }
    if (kind === "text") {
      evt.preventDefault(); /* stop the canvas's default mousedown focus from blurring the new input */
      openTextInput(w);
      return;
    }
    if (kind === "eraser") {
      let removed = 0;
      const before = JSON.stringify(shapes);
      const eraseAt = (pt) => {
        for (let i = shapes.length - 1; i >= 0; i--) {
          if (hitShape(pt, shapes[i])) {
            shapes.splice(i, 1);
            removed++;
            break;
          }
        }
      };
      eraseAt(w);
      const move = (e2) => eraseAt(toWorld(e2));
      const up = () => {
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        if (JSON.stringify(shapes) !== before) {
          snapshot();
          undoStack[undoStack.length - 1] = before; // restore exact pre-drag board
          redoStack.length = 0;
          status.set("erased " + removed + " object(s)");
        }
        redraw();
      };
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      redraw();
      return;
    }
    /* drawing tools */
    const base = { id: idSeq, tool: kind, stroke: color, width, seed: hashStr(String(idSeq) + Date.now()) };
    if (kind === "pen") cur = Object.assign(base, { pts: [w] });
    else if (kind === "text") return;
    else cur = Object.assign(base, { x: w.x, y: w.y, x2: w.x, y2: w.y, w: 0, h: 0 });
    redraw();
  });

  canvas.addEventListener("pointermove", (evt) => {
    if (panning) {
      view.x = panning.ox + (evt.clientX - panning.sx);
      view.y = panning.oy + (evt.clientY - panning.sy);
      redraw();
      return;
    }
    if (!cur) return;
    const w = toWorld(evt);
    if (cur.tool === "pen") {
      const last = cur.pts[cur.pts.length - 1];
      if (Math.hypot(w.x - last.x, w.y - last.y) > 1.5 / view.k) cur.pts.push(w);
    } else {
      cur.x2 = w.x;
      cur.y2 = w.y;
      cur.w = w.x - cur.x;
      cur.h = w.y - cur.y;
    }
    redraw();
  });

  canvas.addEventListener("pointerup", () => {
    if (panning) {
      panning = null;
      canvas.dataset.tool = tool;
      return;
    }
    if (!cur) return;
    const s = cur;
    cur = null;
    const tiny =
      s.tool === "pen"
        ? false /* a single tap is a real dot */
        : Math.hypot(s.x2 - s.x, s.y2 - s.y) < 3 / view.k;
    if (!tiny) {
      snapshot();
      s.id = shapes.length ? Math.max(...shapes.map((q) => q.id)) + 1 : 1;
      shapes.push(s);
      status.set(s.tool + " committed · " + shapes.length + " object(s)");
    }
    redraw();
  });

  d.listen(canvas, "wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  d.listen(window, "keydown", (e) => {
    if (e.code === "Space" && document.activeElement === document.body) spaceHeld = true;
  });
  d.listen(window, "keyup", (e) => {
    if (e.code === "Space") spaceHeld = false;
  });
  d.listen(canvas, "keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
      e.preventDefault();
      undo();
    } else if (((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "Z")))) {
      e.preventDefault();
      redo();
    }
  });
  canvas.tabIndex = 0;

  /* ---- toolbar ---- */
  const toolBtns = [];
  for (const t of TOOLS) {
    const b = btn(TOOL_LABEL[t], {
      "aria-pressed": t === tool ? "true" : "false",
      title: t === "pan" ? "pan (or hold space / middle-drag)" : t,
    });
    b.addEventListener("click", () => {
      tool = t;
      canvas.dataset.tool = t;
      for (const [bt, name] of toolBtns) bt.setAttribute("aria-pressed", name === t ? "true" : "false");
      status.set("tool: " + t);
    });
    toolBtns.push([b, t]);
    add(bar1, b);
  }
  canvas.dataset.tool = tool;

  add(bar1, div("cdu-spacer"));
  const undoBtn = btn("↶ undo", { title: "ctrl+z" });
  const redoBtn = btn("↷ redo", { title: "ctrl+y" });
  const clearBtn = btn("clear", { class: "cdu-btn cdu-btn-danger" });
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  clearBtn.addEventListener("click", () => {
    if (!shapes.length) return status.set("board already empty", "warn");
    snapshot();
    shapes = [];
    redraw();
    status.set("board cleared (undo restores)");
  });
  add(bar1, undoBtn, redoBtn, clearBtn);

  /* width */
  const widthLabel = div("cdu-label", "width " + width);
  const widthRange = el("input", { class: "cdu-range", type: "range", min: "1", max: "14", value: String(width), "aria-label": "stroke width" });
  widthRange.addEventListener("input", () => {
    width = Number(widthRange.value);
    widthLabel.textContent = "width " + width;
  });
  add(bar2, widthLabel, widthRange, div("cdu-spacer"));

  /* colors */
  add(bar2, div("cdu-label", "ink"));
  const swatches = [];
  for (const v of ["--accent", "--text", "--warn", "--bad", "--ok", "--muted"]) {
    const c = themeVar(v, "#999");
    const s = el("button", {
      type: "button",
      class: "cdu-swatch",
      "aria-pressed": v === "--accent" ? "true" : "false",
      "aria-label": "ink color " + v,
      title: v,
    });
    s.style.background = c;
    s.addEventListener("click", () => {
      color = c;
      for (const sw of swatches) sw.setAttribute("aria-pressed", sw === s ? "true" : "false");
      status.set("ink: " + v);
    });
    swatches.push(s);
    add(bar2, s);
  }
  add(bar2, div("cdu-spacer"));

  /* zoom + export */
  const zoomOut = btn("−");
  const zoomReset = btn("100%");
  const zoomIn = btn("+");
  zoomOut.addEventListener("click", () => {
    const r = canvas.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25);
  });
  zoomIn.addEventListener("click", () => {
    const r = canvas.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  });
  zoomReset.addEventListener("click", () => {
    view = { x: 0, y: 0, k: 1 };
    redraw();
    status.set("view reset");
  });
  add(bar2, div("cdu-label", "zoom"), zoomOut, zoomReset, zoomIn, div("cdu-spacer"));

  const exportBtn = btn("⭳ export png", { class: "cdu-btn cdu-on" });
  exportBtn.addEventListener("click", () => {
    if (!shapes.length) return status.set("nothing to export — draw something first", "warn");
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const acc = (x, y) => {
      x1 = Math.min(x1, x); y1 = Math.min(y1, y);
      x2 = Math.max(x2, x); y2 = Math.max(y2, y);
    };
    for (const s of shapes) {
      if (s.tool === "pen") for (const p of s.pts) acc(p.x, p.y);
      else if (s.tool === "text") { acc(s.x, s.y); acc(s.x + measureText(s), s.y + s.size * 1.35); }
      else { acc(s.x, s.y); acc(s.x2, s.y2); }
    }
    const pad = 24;
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    const ww = Math.max(x2 - x1, 120);
    const wh = Math.max(y2 - y1, 120);
    const scale = clamp(3200 / Math.max(ww, wh), 1, 4);
    const off = document.createElement("canvas");
    off.width = Math.round(ww * scale);
    off.height = Math.round(wh * scale);
    const octx = off.getContext("2d");
    octx.fillStyle = themeVar("--bg", "#0a0c0e");
    octx.fillRect(0, 0, off.width, off.height);
    octx.setTransform(scale, 0, 0, scale, -x1 * scale, -y1 * scale);
    for (const s of shapes) drawShape(octx, s);
    off.toBlob((blob) => {
      if (!blob) return status.set("png encode failed", "bad");
      saveBlob(blob, "kael-sketchboard.png");
      status.set("exported kael-sketchboard.png · " + off.width + "×" + off.height + " px · " + fmtBytes(blob.size) + " — real file downloaded", "ok");
    }, "image/png");
  });
  add(bar2, exportBtn);

  status.set("board ready · pen selected · wheel = zoom, space/middle-drag = pan · everything local");
}

/* ==================================================================== */
/* TOOL 02 — FLOWCHART BUILDER                                          */
/* ==================================================================== */

function buildFlowchart(section) {
  const d = makeDisposers();
  section.__cduDispose = d.runAll.bind(d);

  const bar = div("cdu-bar");
  add(section, bar);
  const status = makeStatus(section);
  const wrap = div("cdu-fc-wrap");
  wrap.tabIndex = 0;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "cdu-fc-svg");
  svg.setAttribute("role", "application");
  svg.setAttribute("aria-label", "flowchart canvas");
  add(wrap, svg);
  add(section, wrap);

  const SVGNS = "http://www.w3.org/2000/svg";
  let mode = "select"; // select | connect | add:rect | add:diamond | add:round
  let nodes = [];
  let edges = [];
  let selected = null; // {kind:"node"|"edge", id}
  let view = { x: 0, y: 0, k: 1 };
  let seq = 1;
  let drag = null;
  let ghost = null;

  const COL = () => ({
    bg: themeVar("--panel-2", "#101418"),
    fill: themeVar("--panel-3", "#161b21"),
    stroke: themeVar("--line-strong", "#2e3a44"),
    text: themeVar("--text", "#d7e2da"),
    dim: themeVar("--muted", "#6f7f77"),
    accent: themeVar("--accent", "#3dd68c"),
    warn: themeVar("--warn", "#e2b93b"),
  });

  const nodeById = (id) => nodes.find((n) => n.id === id) || null;

  function defaultSize(shape) {
    if (shape === "diamond") return { w: 150, h: 84 };
    if (shape === "round") return { w: 124, h: 46 };
    return { w: 142, h: 58 };
  }

  /* ---- geometry: clip a center→center line to a node's border ---- */
  function borderPoint(n, towards) {
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    const dx = towards.x - cx;
    const dy = towards.y - cy;
    if (n.shape === "diamond") {
      const hw = n.w / 2 || 1;
      const hh = n.h / 2 || 1;
      const t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh || 1);
      return { x: cx + dx * t, y: cy + dy * t };
    }
    const hw = n.w / 2 || 1;
    const hh = n.h / 2 || 1;
    const tx = Math.abs(dx) < 1e-9 ? Infinity : hw / Math.abs(dx);
    const ty = Math.abs(dy) < 1e-9 ? Infinity : hh / Math.abs(dy);
    const t = Math.min(tx, ty);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  /* ---- DOM builders ---- */
  function svgEl(tag, attrs) {
    const n = document.createElementNS(SVGNS, tag);
    for (const k of Object.keys(attrs || {})) n.setAttribute(k, attrs[k]);
    return n;
  }

  function render() {
    const c = COL();
    svg.setAttribute("data-mode", mode.startsWith("add") ? "add" : mode);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const defs = svgEl("defs");
    const marker = svgEl("marker", { id: "cdu-fc-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
    marker.appendChild(svgEl("path", { d: "M 0 1 L 9 5 L 0 9 z", fill: c.accent }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    const bg = svgEl("rect", { class: "cdu-fc-bg", x: "-20000", y: "-20000", width: "40000", height: "40000", fill: c.bg });
    svg.appendChild(bg);

    const root = svgEl("g", { transform: `translate(${view.x} ${view.y}) scale(${view.k})` });
    svg.appendChild(root);

    /* grid dots */
    const gridG = svgEl("g", { opacity: "0.5" });
    const step = 28;
    const x0 = Math.floor(-view.x / view.k / step) * step;
    const y0 = Math.floor(-view.y / view.k / step) * step;
    for (let gx = x0; gx < x0 + wrap.clientWidth / view.k + step * 2; gx += step) {
      for (let gy = y0; gy < y0 + wrap.clientHeight / view.k + step * 2; gy += step) {
        gridG.appendChild(svgEl("circle", { cx: gx, cy: gy, r: 0.8, fill: c.stroke }));
      }
    }
    root.appendChild(gridG);

    /* edges */
    for (const e of edges) {
      const a = nodeById(e.from);
      const b = nodeById(e.to);
      if (!a || !b) continue;
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const p1 = borderPoint(a, cb);
      const p2 = borderPoint(b, ca);
      const isSel = selected && selected.kind === "edge" && selected.id === e.id;
      const line = svgEl("line", {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
        stroke: isSel ? c.warn : c.accent,
        "stroke-width": isSel ? "2.5" : "1.6",
        "marker-end": "url(#cdu-fc-arrow)",
      });
      line.dataset.edgeId = e.id;
      line.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        selected = { kind: "edge", id: e.id };
        render();
      });
      root.appendChild(line);
    }

    /* ghost connect line */
    if (ghost) {
      root.appendChild(svgEl("line", { x1: ghost.x1, y1: ghost.y1, x2: ghost.x2, y2: ghost.y2, stroke: c.warn, "stroke-width": "1.4", "stroke-dasharray": "5 4" }));
    }

    /* nodes */
    for (const n of nodes) {
      const g = svgEl("g", { class: "cdu-fc-node", transform: `translate(${n.x} ${n.y})` });
      const isSel = selected && selected.kind === "node" && selected.id === n.id;
      const stroke = isSel ? c.warn : c.stroke;
      let shapeEl;
      if (n.shape === "diamond") {
        shapeEl = svgEl("polygon", { points: `${n.w / 2},0 ${n.w},${n.h / 2} ${n.w / 2},${n.h} 0,${n.h / 2}`, fill: c.fill, stroke, "stroke-width": "1.5" });
      } else {
        shapeEl = svgEl("rect", { width: n.w, height: n.h, rx: n.shape === "round" ? n.h / 2 : 2, fill: c.fill, stroke, "stroke-width": "1.5" });
      }
      g.appendChild(shapeEl);
      const t = svgEl("text", {
        x: n.w / 2, y: n.h / 2, fill: c.text, "text-anchor": "middle", "dominant-baseline": "middle",
        "font-family": "ui-monospace, Consolas, monospace", "font-size": "12.5", "paint-order": "stroke",
      });
      t.textContent = n.text;
      g.appendChild(t);
      if (mode === "connect") {
        /* whole node acts as a connect target/source */
      }
      g.addEventListener("pointerdown", (ev) => onNodePointerDown(ev, n));
      g.addEventListener("dblclick", () => editNode(n));
      root.appendChild(g);
    }
  }

  /* ---- interactions ---- */
  function toWorld(evt) {
    const r = svg.getBoundingClientRect();
    return { x: (evt.clientX - r.left - view.x) / view.k, y: (evt.clientY - r.top - view.y) / view.k };
  }

  function nodeAt(p) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h) return n;
    }
    return null;
  }

  function onNodePointerDown(ev, n) {
    ev.stopPropagation();
    svg.setPointerCapture(ev.pointerId);
    const p = toWorld(ev);
    if (mode === "connect") {
      drag = { kind: "connect", from: n.id };
      ghost = { x1: n.x + n.w / 2, y1: n.y + n.h / 2, x2: p.x, y2: p.y };
      render();
      return;
    }
    if (mode !== "select") return;
    selected = { kind: "node", id: n.id };
    drag = { kind: "node", id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false };
    render();
  }

  svg.addEventListener("pointerdown", (ev) => {
    const t = ev.target;
    const onBackground = t === svg || (t.classList && (t.classList.contains("cdu-fc-bg") || t.tagName === "circle"));
    if (onBackground) {
      svg.setPointerCapture(ev.pointerId);
      const p = toWorld(ev);
      if (mode.startsWith("add:")) {
        const shape = mode.slice(4);
        const size = defaultSize(shape);
        const snap = (v) => Math.round(v / 8) * 8;
        const node = {
          id: "n" + seq++,
          shape,
          x: snap(p.x - size.w / 2),
          y: snap(p.y - size.h / 2),
          w: size.w,
          h: size.h,
          text: shape === "diamond" ? "decision?" : shape === "round" ? "start / end" : "step",
        };
        nodes.push(node);
        selected = { kind: "node", id: node.id };
        status.set("node added · " + nodes.length + " node(s) · drag to move, double-click to rename");
        setMode("select");
        render();
        return;
      }
      selected = null;
      drag = { kind: "pan", sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
      render();
    }
  });

  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const p = toWorld(ev);
    if (drag.kind === "pan") {
      view.x = drag.ox + (ev.clientX - drag.sx);
      view.y = drag.oy + (ev.clientY - drag.sy);
      render();
    } else if (drag.kind === "node") {
      const n = nodeById(drag.id);
      if (!n) return;
      const snap = (v) => Math.round(v / 8) * 8;
      n.x = snap(p.x - drag.dx);
      n.y = snap(p.y - drag.dy);
      drag.moved = true;
      render();
    } else if (drag.kind === "connect") {
      const from = nodeById(drag.from);
      if (!from) return;
      ghost.x2 = p.x;
      ghost.y2 = p.y;
      render();
    }
  });

  svg.addEventListener("pointerup", (ev) => {
    if (!drag) return;
    if (drag.kind === "connect") {
      const p = toWorld(ev);
      const target = nodeAt(p);
      const from = nodeById(drag.from);
      ghost = null;
      if (target && from && target.id !== from.id) {
        const dup = edges.some((e) => (e.from === from.id && e.to === target.id) || (e.from === target.id && e.to === from.id));
        if (dup) status.set("those nodes are already connected", "warn");
        else {
          edges.push({ id: "e" + seq++, from: from.id, to: target.id });
          status.set("connected " + from.text + " → " + target.text + " · " + edges.length + " edge(s)", "ok");
        }
      } else {
        status.set("connect dropped — release on another node", "warn");
      }
      render();
    } else if (drag.kind === "node" && drag.moved) {
      status.set("node moved");
    }
    drag = null;
  });

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const k2 = clamp(view.k * factor, 0.25, 4);
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    view.x = px - ((px - view.x) * k2) / view.k;
    view.y = py - ((py - view.y) * k2) / view.k;
    view.k = k2;
    render();
  }, { passive: false });

  /* text editing via an HTML overlay (no foreignObject → PNG export stays taint-free) */
  function editNode(n) {
    if (wrap.querySelector(".cdu-fc-input")) return;
    const inp = el("input", { class: "cdu-fc-input", "aria-label": "node text" });
    inp.value = n.text;
    positionInput(inp, n);
    add(wrap, inp);
    inp.focus();
    inp.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = inp.value.trim() || n.text;
      inp.remove();
      n.text = v;
      const min = defaultSize(n.shape);
      const meas = document.createElement("canvas").getContext("2d");
      meas.font = "12.5px ui-monospace, Consolas, monospace";
      const tw = meas.measureText(v).width + 24;
      n.w = Math.max(min.w, Math.ceil(tw));
      n.h = Math.max(min.h, v.split("\n").length * 18 + 22);
      render();
      status.set("renamed → " + v);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") {
        done = true;
        inp.remove();
      }
      e.stopPropagation();
    });
    inp.addEventListener("blur", commit);
  }

  function positionInput(inp, n) {
    const r = svg.getBoundingClientRect();
    inp.style.left = n.x * view.k + view.x + r.left - wrap.getBoundingClientRect().left + "px";
    inp.style.top = n.y * view.k + view.y + r.top - wrap.getBoundingClientRect().top + "px";
    inp.style.width = Math.max(90, n.w * view.k) + "px";
    inp.style.height = Math.max(28, n.h * view.k) + "px";
  }

  function deleteSelected() {
    if (!selected) return status.set("nothing selected", "warn");
    if (selected.kind === "node") {
      nodes = nodes.filter((n) => n.id !== selected.id);
      edges = edges.filter((e) => e.from !== selected.id && e.to !== selected.id);
      status.set("node deleted (with its edges)");
    } else {
      edges = edges.filter((e) => e.id !== selected.id);
      status.set("edge deleted");
    }
    selected = null;
    render();
  }

  d.listen(wrap, "keydown", (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelected();
    }
  });

  /* ---- toolbar ---- */
  function setMode(m) {
    mode = m;
    for (const [b, mm] of modeBtns) b.setAttribute("aria-pressed", mm === m ? "true" : "false");
    render();
  }

  const modeBtns = [];
  const MODE_DEFS = [
    ["select", "✥ select"],
    ["connect", "⇢ connect"],
    ["add:rect", "▭ add rect"],
    ["add:diamond", "◇ add decision"],
    ["add:round", "◯ add terminal"],
  ];
  for (const [m, label] of MODE_DEFS) {
    const b = btn(label, { "aria-pressed": m === mode ? "true" : "false", title: m });
    b.addEventListener("click", () => setMode(m));
    modeBtns.push([b, m]);
    add(bar, b);
  }
  const delBtn = btn("⌫ delete", { title: "or press Delete with a node/edge selected" });
  delBtn.addEventListener("click", deleteSelected);
  add(bar, delBtn, div("cdu-spacer"));

  const fitBtn = btn("fit");
  fitBtn.addEventListener("click", () => {
    if (!nodes.length) {
      view = { x: 0, y: 0, k: 1 };
    } else {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const n of nodes) {
        x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
        x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + n.h);
      }
      const pad = 40;
      const k = clamp(Math.min(wrap.clientWidth / (x2 - x1 + pad * 2), wrap.clientHeight / (y2 - y1 + pad * 2)), 0.25, 2);
      view.k = k;
      view.x = (wrap.clientWidth - (x2 - x1) * k) / 2 - (x1 - pad) * k;
      view.y = (wrap.clientHeight - (y2 - y1) * k) / 2 - (y1 - pad) * k;
    }
    render();
    status.set("view fitted to " + nodes.length + " node(s)");
  });
  const resetBtn = btn("100%");
  resetBtn.addEventListener("click", () => {
    view = { x: 0, y: 0, k: 1 };
    render();
  });
  add(bar, fitBtn, resetBtn, div("cdu-spacer"));

  /* ---- exports ---- */
  function serialize() {
    const c = COL();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    if (!nodes.length) return null;
    for (const n of nodes) {
      x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
      x2 = Math.max(x2, n.x + n.w); y2 = Math.max(y2, n.y + n.h);
    }
    const pad = 30;
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
    const w = Math.round(x2 - x1);
    const h = Math.round(y2 - y1);
    const out = [];
    out.push(`<svg xmlns="${SVGNS}" width="${w}" height="${h}" viewBox="${x1} ${y1} ${w} ${h}">`);
    out.push(`<rect x="${x1}" y="${y1}" width="${w}" height="${h}" fill="${c.bg}"/>`);
    out.push(`<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="${c.accent}"/></marker></defs>`);
    for (const e of edges) {
      const a = nodeById(e.from);
      const b = nodeById(e.to);
      if (!a || !b) continue;
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const p1 = borderPoint(a, cb);
      const p2 = borderPoint(b, ca);
      out.push(`<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="${c.accent}" stroke-width="1.6" marker-end="url(#a)"/>`);
    }
    for (const n of nodes) {
      if (n.shape === "diamond") {
        out.push(`<polygon points="${n.x + n.w / 2},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${n.x + n.w / 2},${n.y + n.h} ${n.x},${n.y + n.h / 2}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>`);
      } else {
        const rx = n.shape === "round" ? n.h / 2 : 2;
        out.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>`);
      }
      out.push(`<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2}" fill="${c.text}" text-anchor="middle" dominant-baseline="middle" font-family="ui-monospace, Consolas, monospace" font-size="12.5">${n.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`);
    }
    out.push("</svg>");
    return { xml: out.join("\n"), w, h };
  }

  const svgBtn = btn("⭳ svg", { title: "export as standalone SVG" });
  svgBtn.addEventListener("click", () => {
    const s = serialize();
    if (!s) return status.set("no nodes to export", "warn");
    saveBlob(new Blob([s.xml], { type: "image/svg+xml" }), "kael-flowchart.svg");
    status.set("exported kael-flowchart.svg · " + s.w + "×" + s.h + " · standalone file", "ok");
  });
  const pngBtn = btn("⭳ png", { title: "rasterize the same SVG at 2×" });
  pngBtn.addEventListener("click", () => {
    const s = serialize();
    if (!s) return status.set("no nodes to export", "warn");
    const url = URL.createObjectURL(new Blob([s.xml], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      const off = document.createElement("canvas");
      off.width = s.w * 2;
      off.height = s.h * 2;
      const ctx = off.getContext("2d");
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      off.toBlob((blob) => {
        if (!blob) return status.set("png encode failed", "bad");
        saveBlob(blob, "kael-flowchart.png");
        status.set("exported kael-flowchart.png · " + off.width + "×" + off.height + " px · " + fmtBytes(blob.size), "ok");
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      status.set("png rasterization failed — try the svg export", "bad");
    };
    img.src = url;
  });
  add(bar, svgBtn, pngBtn);

  /* keep the overlay input glued to its node while panning/zooming */
  const ro = new ResizeObserver(() => render());
  ro.observe(wrap);
  d.add(() => ro.disconnect());

  render();
  status.set("canvas ready · pick a shape, click to place · drag = move · double-click = rename · connect mode drags edges");
}

/* ==================================================================== */
/* TOOL 03 — FONT IDENTIFIER (local heuristic, honest by design)         */
/* ==================================================================== */

/* Feature vector (all derived from ink-pixel statistics, no network):
 *   0 weightRatio  — median ink-run width / x-height          (light ↔ bold)
 *   1 serifScore   — stem end-flare ratio                      (sans ↔ serif)
 *   2 contrast     — stroke width variance (thin/thick modulation)
 *   3 aspect       — mean glyph width / height
 *   4 monoScore    — regularity of glyph advance pitch         (proportional ↔ mono) */

const FONT_CANDIDATES = [
  "Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Segoe UI",
  "Georgia", "Times New Roman", "Garamond", "Palatino Linotype",
  "Courier New", "Consolas", "Lucida Console", "Impact", "Comic Sans MS",
  "Roboto", "Open Sans", "Lato", "Montserrat", "Fira Code", "monospace",
];

function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  return thr;
}

/** Extract the trait vector from an ImageData of a text sample. */
function imageTraits(imgData) {
  const { data, width: w, height: h } = imgData;
  const gray = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const g = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    gray[i] = g;
    hist[g | 0]++;
  }
  const thr = otsuThreshold(hist, gray.length);
  /* polarity: sample the outer border — background is whatever dominates there */
  let borderSum = 0, borderN = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      borderSum += gray[y * w + x];
      borderN++;
    }
  }
  for (let y = 0; y < h; y++) {
    for (const x of [0, w - 1]) {
      borderSum += gray[y * w + x];
      borderN++;
    }
  }
  const borderMean = borderSum / Math.max(borderN, 1);
  const inkIsDark = borderMean >= thr;
  const isInk = (v) => (inkIsDark ? v < thr : v > thr);

  /* row projection → text bands */
  const rowProj = new Uint32Array(h);
  let totalInk = 0;
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) if (isInk(gray[y * w + x])) c++;
    rowProj[y] = c;
    totalInk += c;
  }
  const inkFrac = totalInk / (w * h);
  if (inkFrac < 0.004 || inkFrac > 0.5) return { error: "no text-like ink found (ink coverage " + (inkFrac * 100).toFixed(1) + "%)" };

  const rowCut = Math.max(2, Math.floor(w * 0.01));
  const bands = [];
  let start = -1;
  for (let y = 0; y < h; y++) {
    const on = rowProj[y] >= rowCut;
    if (on && start < 0) start = y;
    if ((!on || y === h - 1) && start >= 0) {
      const end = on ? y : y - 1;
      if (end - start >= 4) bands.push([start, end]);
      start = -1;
    }
  }
  if (!bands.length) return { error: "could not isolate text rows — try a cleaner image" };
  bands.sort((a, b) => {
    const sa = a[1] - a[0], sb = b[1] - b[0];
    return sb - sa;
  });
  const [by0, by1] = bands[0];

  /* column projection within the band → glyph boxes */
  const colProj = new Uint32Array(w);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = by0; y <= by1; y++) if (isInk(gray[y * w + x])) c++;
    colProj[x] = c;
  }
  const glyphs = [];
  let gs = -1;
  const colCut = 1;
  for (let x = 0; x < w; x++) {
    const on = colProj[x] > colCut;
    if (on && gs < 0) gs = x;
    if ((!on || x === w - 1) && gs >= 0) {
      const ge = on ? x : x - 1;
      if (ge - gs >= 2) glyphs.push([gs, ge]);
      gs = -1;
    }
  }
  if (glyphs.length < 2) return { error: "found fewer than 2 glyph groups — need a fuller text line" };

  /* per-glyph vertical extent */
  const boxes = glyphs.map(([gx0, gx1]) => {
    let ty = by1, byy = by0;
    for (let y = by0; y <= by1; y++) {
      for (let x = gx0; x <= gx1; x++) {
        if (isInk(gray[y * w + x])) {
          ty = Math.min(ty, y);
          byy = Math.max(byy, y);
          break;
        }
      }
    }
    return { x0: gx0, x1: gx1, y0: ty, y1: byy, w: gx1 - gx0 + 1, h: byy - ty + 1 };
  });

  /* stroke width: horizontal ink runs at each glyph's mid row */
  const runs = [];
  for (const b of boxes) {
    const my = b.y0 + (b.h >> 1);
    let run = 0;
    for (let x = b.x0; x <= b.x1 + 1; x++) {
      const ink = x <= b.x1 && isInk(gray[my * w + x]);
      if (ink) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
  }
  if (!runs.length) return { error: "stroke measurement failed on this image" };
  runs.sort((a, b) => a - b);
  const median = (arr) => arr[Math.floor(arr.length / 2)];
  const sw = median(runs);
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
  const variance = runs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / runs.length;
  const contrast = Math.sqrt(variance) / Math.max(mean, 1);

  /* x-height proxy: median glyph height; weightRatio = stroke / xHeight */
  const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
  const xh = Math.max(median(heights), 3);
  const weightRatio = sw / xh;

  /* serif score: stem columns — flare of ink width at the very top vs middle */
  const midYOf = (b) => b.y0 + (b.h >> 1);
  const flares = [];
  for (const b of boxes) {
    for (let x = b.x0; x <= b.x1; x++) {
      let vrun = 0;
      for (let y = b.y0; y <= b.y1; y++) {
        if (isInk(gray[y * w + x])) vrun++;
        else break;
      }
      if (vrun < b.h * 0.55) continue; /* not a stem */
      const topRun = (function () {
        let r = 0;
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          if (xx >= b.x0 && xx <= b.x1 && isInk(gray[(b.y0 + 1) * w + xx])) r++;
        }
        return r;
      })();
      const midRun = (function () {
        let r = 0;
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          if (xx >= b.x0 && xx <= b.x1 && isInk(gray[midYOf(b) * w + xx])) r++;
        }
        return r;
      })();
      if (midRun > 0) flares.push(topRun / midRun);
    }
  }
  const serifScore = flares.length ? Math.max(0, flares.reduce((a, b) => a + b, 0) / flares.length - 1) : 0;

  /* monospace pitch regularity */
  const pitches = [];
  for (let i = 1; i < boxes.length; i++) pitches.push(boxes[i].x0 - boxes[i - 1].x0);
  const pMean = pitches.length ? pitches.reduce((a, b) => a + b, 0) / pitches.length : 0;
  const pVar = pitches.length ? pitches.reduce((a, b) => a + (b - pMean) * (b - pMean), 0) / pitches.length : 0;
  const monoScore = pMean > 0 ? Math.sqrt(pVar) / pMean : 1;

  const aspect = boxes.reduce((a, b) => a + b.w / Math.max(b.h, 1), 0) / boxes.length;

  return {
    vector: [weightRatio, serifScore, contrast, aspect, monoScore],
    glyphCount: boxes.length,
    bandHeight: by1 - by0,
    traits: {
      serif: serifScore > 0.14 ? "serif" : serifScore < 0.06 ? "sans" : "weak serif cues",
      mono: monoScore < 0.09 && boxes.length >= 6 ? "monospace pitch" : "proportional pitch",
      weight: weightRatio < 0.09 ? "light" : weightRatio > 0.16 ? "bold" : "regular",
      contrast: contrast > 0.55 ? "high stroke contrast" : contrast > 0.3 ? "moderate contrast" : "low contrast (even strokes)",
    },
  };
}

/** Render a candidate font to a canvas and extract the same trait vector. */
function measureCandidate(family) {
  const cw = 760, ch = 140;
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = "#000000";
  ctx.font = "58px \"" + family + "\"";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("Hamburgefonstiv 123", 24, 96);
  return imageTraits(ctx.getImageData(0, 0, cw, ch));
}

function buildFontId(section) {
  const d = makeDisposers();
  section.__cduDispose = d.runAll.bind(d);

  const bar = div("cdu-bar");
  add(section, bar);
  const status = makeStatus(section);

  const drop = div("cdu-drop", "⇪ drop an image with text here — or click to pick");
  drop.tabIndex = 0;
  const input = el("input", { type: "file", accept: "image/*", "aria-label": "text image" });
  input.style.display = "none";
  add(section, input);
  const preview = el("img", { class: "cdu-preview-img", alt: "uploaded text sample" });
  preview.style.display = "none";
  add(section, preview);
  const traitsRow = div("cdu-rows");
  add(section, traitsRow);
  const results = div("cdu-rows cdu-scroll");
  add(section, results);

  let measured = null; // cached candidate vectors (deduped)
  let collapsedCount = 0; // candidates that rendered identically to another
  let objectUrl = null;

  async function ensureCandidates() {
    if (measured) return measured;
    status.set("measuring " + FONT_CANDIDATES.length + " candidate fonts locally…");
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    } catch {
      /* font readiness is best-effort */
    }
    const list = [];
    for (const family of FONT_CANDIDATES) {
      try {
        const t = measureCandidate(family);
        if (!t.error) list.push({ family, vector: t.vector, traits: t.traits });
      } catch {
        /* a candidate that cannot render is simply not suggested */
      }
    }
    if (list.length < 4) {
      status.set("candidate measurement failed in this environment", "bad");
      return null;
    }
    /* collapse candidates that rendered IDENTICALLY (missing fonts → the same
     * system fallback for several family names). Ties cannot discriminate, and
     * pretending otherwise would inflate the suggestion list. */
    const sig = (v) => v.map((x) => Math.round(x * 200) / 200).join("|");
    const bySig = new Map();
    for (const c of list) {
      const k = sig(c.vector);
      if (bySig.has(k)) bySig.get(k).also.push(c.family);
      else bySig.set(k, { family: c.family, vector: c.vector, traits: c.traits, also: [] });
    }
    const distinct = Array.from(bySig.values());
    collapsedCount = list.length - distinct.length;
    measured = distinct;
    return distinct;
  }

  async function analyze(imgData, imgW, imgH) {
    const cands = await ensureCandidates();
    if (!cands) return;
    const q = imageTraits(imgData);
    traitsRow.innerHTML = "";
    results.innerHTML = "";
    if (q.error) {
      status.set(q.error, "warn");
      return;
    }
    status.set("analyzed " + imgW + "×" + imgH + " · " + q.glyphCount + " glyph group(s) · matching against " + cands.length + " locally measured candidates…");

    const chip = (label, val, cls) => {
      const s = el("span", { class: "cdu-chip " + (cls || "") });
      s.textContent = label + ": " + val;
      return s;
    };
    const tr = div("cdu-row");
    add(tr, chip("detected", q.traits.serif, "cdu-chip-accent"));
    add(tr, chip("pitch", q.traits.mono));
    add(tr, chip("weight", q.traits.weight));
    add(tr, chip("strokes", q.traits.contrast));
    add(tr, chip("glyphs", String(q.glyphCount)));
    add(traitsRow, tr);

    /* normalize dims across query + candidates, then weighted euclidean */
    const all = cands.map((c) => c.vector).concat([q.vector]);
    const dimW = [];
    for (let i = 0; i < 5; i++) {
      let mn = Infinity, mx = -Infinity;
      for (const v of all) {
        mn = Math.min(mn, v[i]);
        mx = Math.max(mx, v[i]);
      }
      dimW[i] = mx - mn > 1e-6 ? 1 : 0;
    }
    const dists = cands.map((c) => {
      let s = 0;
      for (let i = 0; i < 5; i++) {
        if (!dimW[i]) continue;
        const range = (() => {
          let mn = Infinity, mx = -Infinity;
          for (const v of all) {
            mn = Math.min(mn, v[i]);
            mx = Math.max(mx, v[i]);
          }
          return mx - mn;
        })();
        s += Math.pow((q.vector[i] - c.vector[i]) / range, 2);
      }
      return Math.sqrt(s);
    });
    const dMin = Math.min.apply(null, dists);
    const dMax = Math.max.apply(null, dists);
    const spread = Math.max(dMax - dMin, 0.05);
    /* confidence relative to the best fit: clearly-ahead matches score high,
     * genuine ties score equal — that honesty beats a fake bell curve */
    const scores = dists.map((x) => Math.exp((-1.8 * (x - dMin)) / spread));
    const ranked = cands
      .map((c, i) => ({
        family: c.family,
        also: c.also,
        traits: c.traits,
        dist: dists[i],
        conf: Math.min(99, Math.round((100 * scores[i]) / Math.max(1, cands.length / 6))),
      }))
      .sort((a, b) => b.conf - a.conf)
      .slice(0, 5);

    const note = div("cdu-row", "approximate best-effort match — a local shape/stroke/serif heuristic against fonts measured in THIS environment, not a commercial font-database lookup. confidence is relative to the best fit; judge the live samples below with your own eyes." + (collapsedCount ? " NOTE: " + collapsedCount + " of " + (cands.length + collapsedCount) + " candidate families rendered identically here (missing fonts fell back to the same system face) — the distinct set is what you see ranked." : ""));
    note.style.color = "var(--warn)";
    add(results, note);

    for (const r of ranked) {
      const row = div("cdu-row");
      const left = div("cdu-grow");
      const nameLine = div();
      nameLine.style.color = "var(--text)";
      nameLine.textContent = r.family;
      const meta = div("cdu-dim");
      meta.style.fontSize = "10px";
      meta.textContent = "traits: " + r.traits.serif + " · " + r.traits.mono + " · " + r.traits.weight + " · distance " + r.dist.toFixed(3) + (r.also && r.also.length ? " (same rendering as: " + r.also.join(", ") + ")" : "");
      add(left, nameLine, meta);
      const bar2 = div("cdu-confbar");
      bar2.setAttribute("role", "img");
      bar2.setAttribute("aria-label", "confidence " + r.conf + " percent");
      const fill = el("i");
      fill.style.width = clamp(r.conf, 3, 100) + "%";
      add(bar2, fill);
      const conf = div("cdu-num");
      conf.style.minWidth = "44px";
      conf.textContent = r.conf + "%";
      const sample = div("cdu-sample");
      sample.textContent = "Handgloves 123";
      sample.style.fontFamily = "\"" + r.family + "\", monospace";
      add(row, left, bar2, conf, sample);
      add(results, row);
    }
    status.set("top suggestion: " + ranked[0].family + " (" + ranked[0].conf + "%) — visual comparison is the real test", "ok");
  }

  function handleFile(file) {
    if (!file || !/^image\//.test(file.type || "")) {
      status.set("that is not an image file", "warn");
      return;
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    preview.src = objectUrl;
    preview.style.display = "block";
    const img = new Image();
    img.onload = () => {
      const maxW = 900;
      const scale = Math.min(1, maxW / img.naturalWidth);
      const w = Math.max(2, Math.round(img.naturalWidth * scale));
      const h = Math.max(2, Math.round(img.naturalHeight * scale));
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      analyze(ctx.getImageData(0, 0, w, h), img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => status.set("could not decode that image", "bad");
    img.src = objectUrl;
  }

  input.addEventListener("change", () => {
    handleFile(input.files && input.files[0]);
    input.value = "";
  });
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("cdu-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("cdu-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("cdu-over");
    handleFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  d.add(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  status.set("everything runs locally — the image never leaves this window. works best on clean, dark-on-light, single-font text.");
}

/* ==================================================================== */
/* shared file pool — used by the compressor and the converter          */
/* ==================================================================== */

function makeFilePool(d, api, status, opts) {
  const entries = []; // {name, size, file?, path, previewUrl?}
  const wrap = div();
  const rows = div("cdu-rows cdu-scroll");
  const drop = div("cdu-drop", "⇪ drop " + opts.kind + " here — or click to pick" + (opts.hint ? " (" + opts.hint + ")" : ""));
  drop.tabIndex = 0;
  const input = el("input", { type: "file", multiple: "", accept: opts.accept, "aria-label": opts.kind });
  input.style.display = "none";

  function pathFor(file) {
    try {
      if (api && api.fs && typeof api.fs.pathForFile === "function") return api.fs.pathForFile(file) || "";
    } catch {
      /* proxy refusal / browser build — handled honestly below */
    }
    return "";
  }

  function addFiles(files) {
    let n = 0;
    for (const f of Array.from(files || [])) {
      if (opts.test && !opts.test(f)) continue;
      const url = URL.createObjectURL(f);
      d.url(url);
      entries.push({ name: f.name, size: f.size, file: f, path: pathFor(f), previewUrl: url });
      n++;
    }
    if (!n) status.set("no acceptable file in that drop", "warn");
    render();
  }

  function addPaths(paths) {
    for (const p of paths || []) {
      entries.push({ name: p.split(/[\\/]/).pop() || p, size: null, file: null, path: p, previewUrl: null });
    }
    render();
  }

  function render() {
    rows.innerHTML = "";
    if (!entries.length) {
      const e = div("cdu-row cdu-dim", "no files queued yet");
      add(rows, e);
      return;
    }
    entries.forEach((en, idx) => {
      const r = div("cdu-row");
      if (en.previewUrl) {
        const th = el("img", { class: "cdu-preview-img", src: en.previewUrl, alt: "preview of " + en.name });
        th.style.maxHeight = "44px";
        th.style.maxWidth = "70px";
        add(r, th);
      } else {
        const ph = div("cdu-chip", en.path ? "path" : "no-preview");
        add(r, ph);
      }
      const nameCol = div("cdu-grow");
      const nm = div();
      nm.textContent = en.name;
      const meta = div("cdu-dim");
      meta.style.fontSize = "10px";
      meta.textContent =
        (en.size !== null ? fmtBytes(en.size) + " · " : "") +
        (en.path ? "real path ✓" : "no real path (browser preview only)") +
        (opts.entryMeta ? " · " + opts.entryMeta(en) : "");
      add(nameCol, nm, meta);
      const resMeta = resultMetaRow(en);
      if (resMeta) add(nameCol, resMeta);
      const rm = btn("✕", { "aria-label": "remove " + en.name, title: "remove from queue" });
      rm.addEventListener("click", () => {
        entries.splice(idx, 1);
        render();
      });
      add(r, nameCol);
      if (opts.reorder && entries.length > 1) {
        const up = btn("↑", { "aria-label": "move " + en.name + " up", title: "earlier in order" });
        const dn = btn("↓", { "aria-label": "move " + en.name + " down", title: "later in order" });
        up.disabled = idx === 0;
        dn.disabled = idx === entries.length - 1;
        up.addEventListener("click", () => {
          const t = entries[idx - 1];
          entries[idx - 1] = entries[idx];
          entries[idx] = t;
          render();
        });
        dn.addEventListener("click", () => {
          const t = entries[idx + 1];
          entries[idx + 1] = entries[idx];
          entries[idx] = t;
          render();
        });
        add(r, up, dn);
      }
      add(r, rm);
      add(rows, r);
    });
  }

  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    addFiles(input.files);
    input.value = "";
  });
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("cdu-over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("cdu-over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("cdu-over");
    addFiles(e.dataTransfer && e.dataTransfer.files);
  });

  wrap.append(drop, input, rows);

  return { el: wrap, entries, addFiles, addPaths, render, clear: () => { entries.length = 0; render(); } };
}

/** Shared runner for fs.imageBatch with honest per-row results. */
async function runImageBatch(api, status, entries, o) {
  const withPath = entries.filter((e) => e.path);
  const noPath = entries.length - withPath.length;
  if (noPath) {
    status.set(noPath + " file(s) have no real path (browser preview only) — real compression needs the desktop bridge", "warn");
  }
  if (!withPath.length) {
    status.set("nothing to process — pick files inside the KAEL desktop app (real fs bridge required)", "bad");
    return null;
  }
  /* group by target format */
  const groups = new Map();
  for (const e of withPath) {
    let fmt = o.format;
    if (fmt === "original") {
      const t = (e.file && e.file.type) || "";
      fmt = t === "image/jpeg" ? "jpeg" : t === "image/png" ? "png" : t === "image/webp" ? "webp" : "";
      if (!fmt) {
        e.lastError = "unknown source format — choose an explicit target format";
        continue;
      }
    }
    if (!groups.has(fmt)) groups.set(fmt, []);
    groups.get(fmt).push(e);
  }
  if (!groups.size) {
    status.set("no processable files (see per-row reasons)", "warn");
    return null;
  }
  status.set("running KAEL's real sharp engine on " + withPath.length + " file(s)…");
  let okCount = 0, failCount = 0, fromTotal = 0, toTotal = 0;
  const failures = [];
  for (const [fmt, items] of groups) {
    const res = await bridge(status, "fs.imageBatch (" + fmt + ")", () =>
      api.fs.imageBatch(
        items.map((e) => ({ src: e.path })),
        { format: fmt, quality: o.quality, maxWidth: o.maxWidth || undefined },
      ));
    if (!res) return null;
    const per = res.perItem || [];
    per.forEach((p, i) => {
      const e = items[i];
      if (p.ok) {
        e.lastResult = { out: p.out, fromBytes: p.fromBytes, toBytes: p.toBytes };
        e.lastError = null;
        okCount++;
        fromTotal += p.fromBytes || 0;
        toTotal += p.toBytes || 0;
      } else {
        e.lastResult = null;
        e.lastError = p.error || "failed";
        failCount++;
        failures.push(e.name + ": " + (p.error || "failed"));
      }
    });
  }
  if (okCount) {
    const saved = fromTotal ? Math.round((1 - toTotal / fromTotal) * 100) : 0;
    status.set(
      "done — " + okCount + " file(s) written · " + fmtBytes(fromTotal) + " → " + fmtBytes(toTotal) +
      (saved > 0 ? " (" + saved + "% smaller)" : saved < 0 ? " (" + -saved + "% LARGER — that format/quality gained nothing)" : "") +
      (failCount ? " · " + failCount + " failed" : ""),
      failCount ? "warn" : "ok",
    );
  } else {
    status.set("all " + failCount + " file(s) failed — " + failures.slice(0, 2).join(" | "), "bad");
  }
  return { okCount, failCount, fromTotal, toTotal };
}

function resultMetaRow(en) {
  if (en.lastError) {
    const s = div("cdu-bad");
    s.style.fontSize = "10px";
    s.textContent = "error: " + en.lastError;
    return s;
  }
  if (!en.lastResult) return null;
  const r = en.lastResult;
  const delta = r.fromBytes ? Math.round((1 - r.toBytes / r.fromBytes) * 100) : 0;
  const s = div(delta >= 0 ? "cdu-ok" : "cdu-warn");
  s.style.fontSize = "10px";
  s.textContent =
    fmtBytes(r.fromBytes) + " → " + fmtBytes(r.toBytes) + " (" + (delta >= 0 ? "-" : "+") + Math.abs(delta) + "%) · written → " +
    (r.out || "?").split(/[\\/]/).pop() + " (next to the original, original untouched)";
  return s;
}

/* ==================================================================== */
/* TOOL 04 — IMAGE COMPRESSOR (real sharp via fs.imageBatch)             */
/* ==================================================================== */

function buildCompressor(section, api) {
  const d = makeDisposers();
  section.__cduDispose = d.runAll.bind(d);

  const bar1 = div("cdu-bar");
  add(section, bar1);
  const status = makeStatus(section);

  const pool = makeFilePool(d, api, status, {
    kind: "images",
    accept: "image/jpeg,image/png,image/webp,image/gif,image/tiff,image/avif",
    hint: "jpeg · png · webp · gif · tiff · avif",
    test: (f) => /^image\//.test(f.type || ""),
    entryMeta: (en) => (en.file && en.file.type ? en.file.type.replace("image/", "") : "?"),
  });
  add(section, pool.el);

  const bar2 = div("cdu-bar");
  add(section, bar2);

  const fmtSel = el("select", { class: "cdu-select", "aria-label": "output format" });
  for (const [v, label] of [["original", "keep each original format"], ["jpeg", "→ jpeg"], ["png", "→ png"], ["webp", "→ webp"]]) {
    const o = el("option", { value: v });
    o.textContent = label;
    fmtSel.appendChild(o);
  }
  const qLabel = div("cdu-label", "quality 78");
  const qRange = el("input", { class: "cdu-range", type: "range", min: "30", max: "100", value: "78", "aria-label": "compression quality" });
  qRange.addEventListener("input", () => {
    qLabel.textContent = "quality " + qRange.value;
  });
  const maxW = el("input", { class: "cdu-input", type: "number", min: "16", max: "12000", placeholder: "max width (orig)", style: "width:130px", "aria-label": "maximum output width in pixels" });

  const pickBtn = btn("＋ via OS dialog", { title: "native file picker — gets real paths, no inline preview" });
  pickBtn.addEventListener("click", async () => {
    const res = await bridge(status, "fs.pick", () =>
      api.fs.pick({ mode: "multi", extensions: ["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "avif"], title: "images to compress" }));
    if (!res) return;
    if (res.canceled || !res.paths || !res.paths.length) {
      status.set("dialog canceled — nothing added", "warn");
      return;
    }
    pool.addPaths(res.paths);
    status.set(res.paths.length + " file(s) added from the OS dialog (no inline preview for dialog picks — paths are real)", "ok");
  });

  const runBtn = btn("⚙ compress", { class: "cdu-btn cdu-on" });
  runBtn.addEventListener("click", async () => {
    if (!pool.entries.length) return status.set("queue some images first", "warn");
    runBtn.disabled = true;
    try {
      const r = await runImageBatch(api, status, pool.entries, {
        format: fmtSel.value,
        quality: Number(qRange.value),
        maxWidth: Number(maxW.value) || 0,
      });
      pool.render();
      void r;
    } finally {
      runBtn.disabled = false;
    }
  });
  const clearBtn = btn("clear queue");
  clearBtn.addEventListener("click", () => {
    pool.clear();
    status.set("queue cleared");
  });

  add(bar1, fmtSel, qLabel, qRange, maxW, div("cdu-spacer"));
  add(bar2, runBtn, pickBtn, clearBtn, div("cdu-spacer"));

  const note = div("cdu-dim");
  note.style.fontSize = "10px";
  note.textContent = "output = <name>-kael.<fmt> written next to each original by KAEL's sharp engine — never overwrites. png has no quality knob (lossless): the slider only applies to jpeg/webp. inline previews come from the local File objects; byte counts are real.";
  add(section, note);

  pool.render();
  status.set("drop images or pick them — compression runs on the desktop's real sharp pipeline");
}

/* ==================================================================== */
/* TOOL 05 — UNIVERSAL FILE CONVERTER (honest scope)                    */
/* ==================================================================== */

const CONVERT_MATRIX = [
  ["jpeg / png / webp / gif / tiff / avif  →  jpeg", true],
  ["jpeg / png / webp / gif / tiff / avif  →  png", true],
  ["jpeg / png / webp / gif / tiff / avif  →  webp", true],
  ["resize while converting (max width)", true],
  ["pdf → page count / metadata check", true],
  ["several pdfs → one merged pdf", true],
  ["one pdf → page-range split files", true],
  ["png / jpeg → pdf (pdf embedding)", false],
  ["pdf → png / jpeg (page rasterization)", false],
  ["docx / xlsx / odt / pptx  →  anything", false],
  ["svg → png (vector rasterization)", false],
  ["heic / raw camera formats", false],
  ["video / audio of any kind", false],
];

function buildConverter(section, api) {
  const d = makeDisposers();
  section.__cduDispose = d.runAll.bind(d);

  const seg = div("cdu-bar");
  add(section, seg);
  const status = makeStatus(section);

  /* ---------- images sub-mode ---------- */
  const imgMode = div();
  imgMode.style.display = "flex";
  imgMode.style.flexDirection = "column";
  imgMode.style.gap = "8px";

  const imgPool = makeFilePool(d, api, status, {
    kind: "images",
    accept: "image/jpeg,image/png,image/webp,image/gif,image/tiff,image/avif",
    hint: "anything sharp reads → jpeg / png / webp",
    test: (f) => /^image\//.test(f.type || ""),
    entryMeta: (en) => (en.file && en.file.type ? en.file.type.replace("image/", "") : "?"),
  });
  add(imgMode, imgPool.el);

  const imgBar = div("cdu-bar");
  const fmtSel = el("select", { class: "cdu-select", "aria-label": "target format" });
  for (const v of ["jpeg", "png", "webp"]) {
    const o = el("option", { value: v });
    o.textContent = "→ " + v;
    fmtSel.appendChild(o);
  }
  const qLabel = div("cdu-label", "quality 85");
  const qRange = el("input", { class: "cdu-range", type: "range", min: "30", max: "100", value: "85", "aria-label": "conversion quality" });
  qRange.addEventListener("input", () => {
    qLabel.textContent = "quality " + qRange.value;
  });
  const maxW = el("input", { class: "cdu-input", type: "number", min: "16", max: "12000", placeholder: "max width (orig)", style: "width:130px", "aria-label": "maximum output width" });
  const runBtn = btn("⇄ convert", { class: "cdu-btn cdu-on" });
  runBtn.addEventListener("click", async () => {
    if (!imgPool.entries.length) return status.set("queue some images first", "warn");
    runBtn.disabled = true;
    try {
      await runImageBatch(api, status, imgPool.entries, {
        format: fmtSel.value,
        quality: Number(qRange.value),
        maxWidth: Number(maxW.value) || 0,
      });
      imgPool.render();
    } finally {
      runBtn.disabled = false;
    }
  });
  const pickBtn = btn("＋ via OS dialog");
  pickBtn.addEventListener("click", async () => {
    const res = await bridge(status, "fs.pick", () =>
      api.fs.pick({ mode: "multi", extensions: ["jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "avif"], title: "images to convert" }));
    if (!res) return;
    if (res.canceled || !res.paths || !res.paths.length) return status.set("dialog canceled", "warn");
    imgPool.addPaths(res.paths);
    status.set(res.paths.length + " file(s) added (real paths, no inline preview)", "ok");
  });
  add(imgBar, fmtSel, qLabel, qRange, maxW, div("cdu-spacer"));
  const imgBar2 = div("cdu-bar");
  add(imgBar2, runBtn, pickBtn);
  add(imgMode, imgBar, imgBar2);

  /* ---------- pdf sub-mode ---------- */
  const pdfMode = div();
  pdfMode.style.display = "none";
  pdfMode.style.flexDirection = "column";
  pdfMode.style.gap = "8px";

  const pdfPool = makeFilePool(d, api, status, {
    kind: "pdfs",
    accept: "application/pdf,.pdf",
    hint: "info · merge (queue order) · split (first file)",
    test: (f) => (f.type || "") === "application/pdf" || /\.pdf$/i.test(f.name || ""),
    reorder: true,
  });
  add(pdfMode, pdfPool.el);

  const pdfBar = div("cdu-bar");
  const infoBtn = btn("ℹ page counts", { title: "fs.pdfInfo on every queued pdf" });
  infoBtn.addEventListener("click", async () => {
    const paths = pdfPool.entries.filter((e) => e.path).map((e) => e.path);
    if (!paths.length) return status.set("queue pdfs with real paths first (desktop bridge)", "warn");
    const res = await bridge(status, "fs.pdfInfo", () => api.fs.pdfInfo(paths));
    if (!res) return;
    const out = [];
    let bad = 0;
    for (const info of res) {
      if (info.pages >= 0) {
        out.push((info.path || "").split(/[\\/]/).pop() + " · " + info.pages + " page(s)");
        const en = pdfPool.entries.find((e) => e.path === info.path);
        if (en) en.lastError = null;
      } else {
        bad++;
        out.push((info.path || "?").split(/[\\/]/).pop() + " · UNREADABLE: " + (info.error || "?"));
      }
    }
    pdfPool.render();
    status.set(out.join("  |  ") + (bad ? " (" + bad + " unreadable — encrypted or corrupt)" : ""), bad ? "warn" : "ok");
  });

  const outName = el("input", { class: "cdu-input", type: "text", value: "merged-kael.pdf", "aria-label": "merge output file name", style: "width:170px" });
  let outDir = "";
  const dirBtn = btn("📁 out dir…", { title: "choose the output folder (fs.pick) — default: the first queued pdf's folder" });
  const dirLabel = div("cdu-dim");
  dirLabel.style.fontSize = "10px";
  dirLabel.textContent = "out: <first pdf's folder>";
  dirBtn.addEventListener("click", async () => {
    const res = await bridge(status, "fs.pick (folder)", () => api.fs.pick({ mode: "folder", title: "output folder" }));
    if (!res) return;
    if (res.canceled || !res.paths || !res.paths.length) return status.set("folder pick canceled", "warn");
    outDir = res.paths[0];
    dirLabel.textContent = "out: " + outDir.split(/[\\/]/).pop();
    status.set("merge output folder: " + outDir, "ok");
  });
  const mergeBtn = btn("⧉ merge → one pdf", { title: "merges the queue in its current order" });
  mergeBtn.addEventListener("click", async () => {
    const paths = pdfPool.entries.filter((e) => e.path).map((e) => e.path);
    if (paths.length < 2) return status.set("merge needs ≥ 2 pdfs with real paths (queue order = merge order)", "warn");
    const dir = outDir || paths[0].replace(/[\\/][^\\/]+$/, "");
    const dest = dir + (dir.endsWith("/") || dir.endsWith("\\") ? "" : require_pathSep()) + safeName(outName.value, "merged-kael.pdf").replace(/\.pdf$/i, "") + ".pdf";
    const res = await bridge(status, "fs.pdfMerge", () => api.fs.pdfMerge(paths, dest));
    if (!res) return;
    if (res.ok === false) return status.set("merge refused: " + (res.error || res.message || "?"), "bad");
    status.set("merged " + paths.length + " pdfs → " + (res.outPath || dest) + " · " + (res.pages ?? "?") + " pages (write verified by re-read)", "ok");
  });

  const rangesIn = el("input", { class: "cdu-input", type: "text", placeholder: "ranges e.g. 1-3,5,8-9", "aria-label": "split ranges", style: "width:170px" });
  const splitBtn = btn("✂ split first pdf", { title: "writes <stem>.p<a>-<b>.pdf files next to the source" });
  splitBtn.addEventListener("click", async () => {
    const first = pdfPool.entries.find((e) => e.path);
    if (!first) return status.set("queue one pdf with a real path first", "warn");
    const ranges = parseRanges(rangesIn.value);
    if (!ranges.length) return status.set("ranges syntax: 1-3,5 — 1-based, inclusive", "warn");
    const dir = first.path.replace(/[\\/][^\\/]+$/, "");
    const res = await bridge(status, "fs.pdfSplit", () => api.fs.pdfSplit(first.path, ranges, dir));
    if (!res) return;
    if (res.ok === false) return status.set("split refused: " + (res.error || res.message || "?"), "bad");
    const written = Array.isArray(res.files) ? res.files.map((p) => p.split(/[\\/]/).pop()).join(", ") : res.message || "done";
    status.set("split ok → " + written, "ok");
  });
  const pdfPickBtn = btn("＋ via OS dialog", { title: "native file picker for pdfs — queue order = merge order" });
  pdfPickBtn.addEventListener("click", async () => {
    const res = await bridge(status, "fs.pick (pdfs)", () =>
      api.fs.pick({ mode: "multi", extensions: ["pdf"], title: "pdfs to inspect / merge / split" }));
    if (!res) return;
    if (res.canceled || !res.paths || !res.paths.length) return status.set("dialog canceled", "warn");
    pdfPool.addPaths(res.paths);
    status.set(res.paths.length + " pdf(s) queued from the OS dialog", "ok");
  });

  add(pdfBar, pdfPickBtn, infoBtn, div("cdu-spacer"));
  const pdfBar2 = div("cdu-bar");
  add(pdfBar2, div("cdu-label", "merge"), outName, dirBtn, mergeBtn, dirLabel);
  const pdfBar3 = div("cdu-bar");
  add(pdfBar3, div("cdu-label", "split"), rangesIn, splitBtn);
  add(pdfMode, pdfBar, pdfBar2, pdfBar3);

  /* ---------- mode switching ---------- */
  const modeImgs = btn("🖼 images", { "aria-pressed": "true" });
  const modePdf = btn("📄 pdf", { "aria-pressed": "false" });
  modeImgs.addEventListener("click", () => setMode("img"));
  modePdf.addEventListener("click", () => setMode("pdf"));
  add(seg, modeImgs, modePdf, div("cdu-spacer"));
  function setMode(m) {
    imgMode.style.display = m === "img" ? "flex" : "none";
    pdfMode.style.display = m === "pdf" ? "flex" : "none";
    modeImgs.setAttribute("aria-pressed", m === "img" ? "true" : "false");
    modePdf.setAttribute("aria-pressed", m === "pdf" ? "true" : "false");
    status.set(m === "img" ? "image mode — sharp converts, output lands next to the originals" : "pdf mode — pdf-lib does structural operations only (info / merge / split)");
  }

  /* ---------- honest scope matrix ---------- */
  const matrixTitle = div("cdu-label", "what this converter can and cannot do — real scope, no pretending");
  const table = el("table", { class: "cdu-matrix" });
  const tbody = el("tbody");
  for (const [what, supported] of CONVERT_MATRIX) {
    const tr = el("tr");
    const td1 = el("td");
    td1.textContent = what;
    const td2 = el("td", null);
    td2.className = supported ? "cdu-ok" : "cdu-bad";
    td2.textContent = supported ? "✓ real" : "✗ unsupported";
    add(tr, td1, td2);
    add(tbody, tr);
  }
  add(table, tbody);
  const matrixNote = div("cdu-dim");
  matrixNote.style.fontSize = "10px";
  matrixNote.textContent = "why: KAEL's bridge exposes sharp (raster images) and pdf-lib (structural pdf ops) — that is the entire genuine surface. anything else would require external services, so this tool refuses it instead of faking it.";
  add(section, imgMode, pdfMode, div("cdu-spacer"), matrixTitle, table, matrixNote);

  imgPool.render();
  pdfPool.render();
  setMode("img");
}

/* helper: platform path separator guess for joining output paths */
function require_pathSep() {
  return navigator.userAgent.includes("Windows") ? "\\" : "/";
}

/* helper: "1-3,5" → [[1,3],[5,5]] with validation */
function parseRanges(s) {
  const out = [];
  for (const part of String(s || "").split(/[,;]+/)) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(t);
    if (!m) return [];
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) return [];
    out.push([a, b]);
  }
  return out;
}

/* ==================================================================== */
/* TOOL 06 — CODE-TO-IMAGE                                              */
/* ==================================================================== */

const C2I_LANGS = {
  plain: { label: "plain text" },
  js: {
    label: "javascript",
    keywords: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "new", "this", "typeof", "import", "export", "from", "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break", "continue", "default", "delete", "instanceof", "void", "yield", "static", "get", "set", "of", "in", "null", "undefined", "true", "false"],
    line: "//", strings: ["\"", "'", "`"],
  },
  ts: {
    label: "typescript",
    keywords: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "extends", "implements", "interface", "type", "enum", "new", "this", "typeof", "import", "export", "from", "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break", "continue", "default", "readonly", "private", "public", "protected", "as", "satisfies", "keyof", "void", "never", "unknown", "any", "string", "number", "boolean", "null", "undefined", "true", "false"],
    line: "//", strings: ["\"", "'", "`"],
  },
  py: {
    label: "python",
    keywords: ["def", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "class", "try", "except", "finally", "with", "lambda", "yield", "pass", "raise", "and", "or", "not", "in", "is", "None", "True", "False", "global", "nonlocal", "assert", "del", "async", "await", "match", "case", "self"],
    line: "#", strings: ["\"", "'"],
  },
  json: {
    label: "json",
    keywords: ["true", "false", "null"],
    line: null, strings: ["\""],
  },
  css: {
    label: "css",
    keywords: ["@media", "@import", "@keyframes", "@supports", "important", "from", "to"],
    line: null, strings: ["\"", "'"], block: ["/*", "*/"],
  },
  html: { label: "html", html: true },
  bash: {
    label: "bash",
    keywords: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "echo", "export", "local", "return", "in", "exit", "cd", "sudo", "npm", "bun", "git"],
    line: "#", strings: ["\"", "'"],
  },
  sql: {
    label: "sql",
    keywords: ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "AS", "AND", "OR", "NOT", "NULL", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "DISTINCT", "COUNT", "SUM", "AVG", "MIN", "MAX", "DESC", "ASC"],
    line: "--", strings: ["'", "\""],
  },
};

const C2I_THEMES = {
  "kael-terminal": {
    label: "KAEL terminal (live theme)",
    live: true,
    bg: "#0a0c0e", chrome: "#14181d", title: "#8fa5a0", dot: ["#e35b5b", "#e2b93b", "#3dd68c"],
    text: "#d7e2da", comment: "#5d6f68", string: "#3dd68c", keyword: "#e2b93b", number: "#6fc3df",
    punct: "#7d8f88", lineno: "#44524d", gutter: "#0d1114", border: "#2e3a44",
  },
  phosphor: {
    label: "phosphor crt",
    bg: "#040704", chrome: "#081208", title: "#3f7f3f", dot: ["#1f5f1f", "#3f9f3f", "#7fdf5f"],
    text: "#4fe34f", comment: "#1f6f1f", string: "#a8ff60", keyword: "#7fff00", number: "#c8ffc8",
    punct: "#2f8f2f", lineno: "#1c4f1c", gutter: "#061006", border: "#1a3a1a",
  },
  dracula: {
    label: "dracula-ish",
    bg: "#282a36", chrome: "#21222c", title: "#6272a4", dot: ["#ff5555", "#f1fa8c", "#50fa7b"],
    text: "#f8f8f2", comment: "#6272a4", string: "#50fa7b", keyword: "#ff79c6", number: "#bd93f9",
    punct: "#8be9fd", lineno: "#44475a", gutter: "#232530", border: "#191a21",
  },
  paper: {
    label: "paper (light)",
    bg: "#f6f2e7", chrome: "#eae4d3", title: "#8a8271", dot: ["#e35b5b", "#e2b93b", "#57a35b"],
    text: "#2f2a24", comment: "#9a927f", string: "#4a7a3a", keyword: "#a03e3e", number: "#8a6d1a",
    punct: "#6f6a60", lineno: "#b9b1a0", gutter: "#efe9db", border: "#d6cfbc",
  },
  mono: {
    label: "graphite mono",
    bg: "#0d0d0d", chrome: "#131313", title: "#8a8a8a", dot: ["#5a5a5a", "#7a7a7a", "#9a9a9a"],
    text: "#d8d8d8", comment: "#5a5a5a", string: "#b8b8b8", keyword: "#f0f0f0", number: "#a8a8a8",
    punct: "#787878", lineno: "#3a3a3a", gutter: "#101010", border: "#262626",
  },
};

/** Line scanner → token array. Honest simplifications: no cross-line strings
 * (a backtick/template string ends at end of line), no regex literals. */
function tokenizeLine(line, lang) {
  const cfg = C2I_LANGS[lang] || C2I_LANGS.plain;
  const out = [];
  if (cfg.html) return tokenizeHtmlLine(line);
  if (!cfg.line && !cfg.strings) {
    out.push({ t: "text", v: line });
    return out;
  }
  let i = 0;
  const isWord = (ch) => /[A-Za-z0-9_$@]/.test(ch);
  while (i < line.length) {
    /* block comment start */
    if (cfg.block && line.startsWith(cfg.block[0], i)) {
      const end = line.indexOf(cfg.block[1], i + cfg.block[0].length);
      const stop = end === -1 ? line.length : end + cfg.block[1].length;
      out.push({ t: "comment", v: line.slice(i, stop) });
      i = stop;
      continue;
    }
    /* line comment */
    if (cfg.line && line.startsWith(cfg.line, i)) {
      out.push({ t: "comment", v: line.slice(i) });
      break;
    }
    const ch = line[i];
    /* strings */
    if (cfg.strings && cfg.strings.includes(ch)) {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === ch) {
          j++;
          break;
        } else j++;
      }
      out.push({ t: "string", v: line.slice(i, j) });
      i = j;
      continue;
    }
    /* numbers */
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] || ""))) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX._]/.test(line[j])) j++;
      out.push({ t: "number", v: line.slice(i, j) });
      i = j;
      continue;
    }
    /* words */
    if (isWord(ch)) {
      let j = i;
      while (j < line.length && isWord(line[j])) j++;
      const w = line.slice(i, j);
      out.push({ t: cfg.keywords && cfg.keywords.includes(w) ? "keyword" : "text", v: w });
      i = j;
      continue;
    }
    /* punctuation / whitespace runs */
    let j = i;
    while (j < line.length && !isWord(line[j]) && !(cfg.strings && cfg.strings.includes(line[j])) && !(cfg.line && line.startsWith(cfg.line, j)) && !(cfg.block && line.startsWith(cfg.block[0], j)) && !/[0-9]/.test(line[j])) j++;
    if (j === i) j = i + 1;
    out.push({ t: "punct", v: line.slice(i, j) });
    i = j;
  }
  return out;
}

function tokenizeHtmlLine(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i);
      const stop = end === -1 ? line.length : end + 3;
      out.push({ t: "comment", v: line.slice(i, stop) });
      i = stop;
      continue;
    }
    if (line[i] === "<") {
      const end = line.indexOf(">", i);
      const stop = end === -1 ? line.length : end + 1;
      const tag = line.slice(i, stop);
      out.push({ t: "keyword", v: tag });
      i = stop;
      continue;
    }
    if (line[i] === "\"" || line[i] === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== line[i]) j++;
      j = Math.min(j + 1, line.length);
      out.push({ t: "string", v: line.slice(i, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== "<" && line[j] !== "\"" && line[j] !== "'") j++;
    if (j === i) j = i + 1;
    out.push({ t: "text", v: line.slice(i, j) });
    i = j;
  }
  return out;
}

const C2I_SAMPLE = `// kael · code-to-image sample
import { createHash } from "node:crypto";

export function fingerprint(input, opts = {}) {
  const rounds = opts.rounds ?? 3;
  let acc = Buffer.from(input, "utf8");
  for (let i = 0; i < rounds; i++) {
    acc = createHash("sha256").update(acc).digest();
  }
  return acc.toString("hex").slice(0, 32);
}

/* render me → png */
console.log(fingerprint("creative-dev-utilities"));`;

function buildCodeImage(section) {
  const d = makeDisposers();
  section.__cduDispose = d.runAll.bind(d);

  const bar1 = div("cdu-bar");
  add(section, bar1);
  const bar2 = div("cdu-bar");
  add(section, bar2);
  const status = makeStatus(section);

  const nameIn = el("input", { class: "cdu-input", type: "text", value: "fingerprint.js", "aria-label": "file name shown in the window chrome", style: "width:170px" });
  const langSel = el("select", { class: "cdu-select", "aria-label": "language" });
  for (const k of Object.keys(C2I_LANGS)) {
    const o = el("option", { value: k });
    o.textContent = C2I_LANGS[k].label;
    langSel.appendChild(o);
  }
  langSel.value = "js";
  const themeSel = el("select", { class: "cdu-select", "aria-label": "color theme" });
  for (const k of Object.keys(C2I_THEMES)) {
    const o = el("option", { value: k });
    o.textContent = C2I_THEMES[k].label;
    themeSel.appendChild(o);
  }
  themeSel.value = "kael-terminal";
  const sizeSel = el("select", { class: "cdu-select", "aria-label": "font size" });
  for (const s of ["12", "14", "16", "18"]) {
    const o = el("option", { value: s });
    o.textContent = s + " px";
    sizeSel.appendChild(o);
  }
  sizeSel.value = "14";
  const lnChk = el("input", { type: "checkbox", id: "cdu-linenum", "aria-label": "show line numbers" });
  lnChk.checked = true;
  const lnLabel = el("label", { for: "cdu-linenum" });
  lnLabel.className = "cdu-label";
  lnLabel.textContent = "line numbers";

  const code = el("textarea", { class: "cdu-codetext", spellcheck: "false", "aria-label": "code input" });
  code.value = C2I_SAMPLE;

  const previewWrap = div("cdu-c2i-wrap");
  const canvas = el("canvas", { "aria-label": "code image preview" });
  add(previewWrap, canvas);

  add(bar1, nameIn, langSel, themeSel, sizeSel, lnLabel, lnChk, div("cdu-spacer"));
  add(bar2, div("cdu-spacer"));
  add(section, code, previewWrap);

  function resolveTheme() {
    const t = C2I_THEMES[themeSel.value] || C2I_THEMES["kael-terminal"];
    if (!t.live) return t;
    /* capture the app's live accent palette at render time */
    return Object.assign({}, t, {
      bg: themeVar("--bg", t.bg),
      chrome: themeVar("--panel-2", t.chrome),
      border: themeVar("--line-strong", t.border),
      text: themeVar("--text", t.text),
      title: themeVar("--muted", t.title),
      comment: themeVar("--muted", t.comment),
      string: themeVar("--ok", t.string),
      keyword: themeVar("--accent", t.keyword),
      number: themeVar("--warn", t.number),
      punct: themeVar("--muted", t.punct),
      lineno: themeVar("--line-strong", t.lineno),
      gutter: themeVar("--panel", t.gutter),
      dot: [themeVar("--bad", t.dot[0]), themeVar("--warn", t.dot[1]), themeVar("--ok", t.dot[2])],
    });
  }

  function draw(ctx, scale) {
    const th = resolveTheme();
    const fs = Number(sizeSel.value);
    const showLn = lnChk.checked;
    const fontPx = fs * scale;
    const lineH = Math.round(fontPx * 1.55);
    const pad = 18 * scale;
    const titleH = 34 * scale;
    const gutterW = showLn ? Math.max(44, String(code.value.split("\n").length).length * fontPx * 0.7 + 20 * scale) : 0;
    const lines = code.value.split("\n").slice(0, 400);
    let maxCols = 1;
    for (const l of lines) maxCols = Math.max(maxCols, l.length);
    maxCols = Math.min(maxCols, 400);
    ctx.font = fontPx + "px ui-monospace, 'Cascadia Code', Consolas, monospace";
    const charW = ctx.measureText("M").width || fontPx * 0.6;

    const bodyW = Math.round(maxCols * charW);
    const w = Math.min(8000, Math.round(pad * 2 + gutterW + bodyW));
    const h = Math.min(8000, Math.round(titleH + pad + lines.length * lineH + pad));
    if (w >= 8000 || h >= 8000) status.set("image capped at 8000 px — the longest lines were cut", "warn");

    const r = 10 * scale;
    ctx.clearRect(0, 0, w, h);

    /* outer chrome */
    ctx.beginPath();
    roundRect(ctx, 0.5, 0.5, w - 1, h - 1, r);
    ctx.fillStyle = th.chrome;
    ctx.fill();
    ctx.strokeStyle = th.border;
    ctx.lineWidth = scale;
    ctx.stroke();

    /* title bar */
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, 0.5, 0.5, w - 1, h - 1, r);
    ctx.clip();
    ctx.fillStyle = th.chrome;
    ctx.fillRect(0, 0, w, titleH);
    ctx.strokeStyle = th.border;
    ctx.beginPath();
    ctx.moveTo(0, titleH);
    ctx.lineTo(w, titleH);
    ctx.stroke();
    /* traffic dots */
    const dotR = 5.5 * scale;
    const dotY = titleH / 2;
    th.dot.forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(pad / 2 + dotR + i * (dotR * 2.9), dotY, dotR, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
    });
    ctx.fillStyle = th.title;
    ctx.font = Math.round(11.5 * scale) + "px ui-monospace, Consolas, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(nameIn.value || "untitled", pad / 2 + dotR * 8, dotY);
    ctx.restore();

    /* body */
    ctx.save();
    ctx.beginPath();
    roundRectBody(ctx, 0, titleH, w, h - titleH, r);
    ctx.clip();
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, titleH, w, h - titleH);
    if (showLn) {
      ctx.fillStyle = th.gutter;
      ctx.fillRect(0, titleH, gutterW, h - titleH);
    }
    ctx.font = fontPx + "px ui-monospace, 'Cascadia Code', Consolas, monospace";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const lang = langSel.value;
    lines.forEach((line, idx) => {
      const y = titleH + pad / 2 + idx * lineH;
      if (showLn) {
        ctx.fillStyle = th.lineno;
        ctx.textAlign = "right";
        ctx.fillText(String(idx + 1), gutterW - 10 * scale, y);
        ctx.textAlign = "left";
      }
      let x = gutterW + pad / 2;
      for (const tok of tokenizeLine(line, lang)) {
        ctx.fillStyle =
          tok.t === "comment" ? th.comment :
          tok.t === "string" ? th.string :
          tok.t === "keyword" ? th.keyword :
          tok.t === "number" ? th.number :
          tok.t === "punct" ? th.punct : th.text;
        ctx.fillText(tok.v, x, y);
        x += ctx.measureText(tok.v).width;
      }
    });
    ctx.restore();
    return { w, h };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function roundRectBody(ctx, x, y, w, h, r) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.closePath();
  }

  let timer = null;
  function renderPreview() {
    const scale = 1;
    const tmp = document.createElement("canvas");
    const tctx = tmp.getContext("2d");
    /* measure first pass on tmp, then draw for real on the visible canvas */
    tctx.font = Number(sizeSel.value) + "px ui-monospace, monospace";
    const dim = draw(tctx, scale); // draws onto tmp (throwaway) just to measure
    canvas.width = dim.w;
    canvas.height = dim.h;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, dim.w, dim.h);
    const real = draw(ctx, scale);
    void real;
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(renderPreview, 140);
  }
  for (const n of [code, nameIn, langSel, themeSel, sizeSel, lnChk]) n.addEventListener("input", schedule);

  const exportBtn = btn("⭳ export png (2×)", { class: "cdu-btn cdu-on" });
  exportBtn.addEventListener("click", () => {
    if (!code.value.trim()) return status.set("paste some code first", "warn");
    const off = document.createElement("canvas");
    const octx = off.getContext("2d");
    const dim = draw(octx, 2); // draw measures + renders in one pass at 2×
    off.width = dim.w;
    off.height = dim.h;
    const ctx2 = off.getContext("2d");
    ctx2.clearRect(0, 0, dim.w, dim.h);
    const real = draw(ctx2, 2);
    void real;
    off.toBlob((blob) => {
      if (!blob) return status.set("png encode failed", "bad");
      const base = safeName(nameIn.value.replace(/\.[^.]+$/, ""), "snippet");
      saveBlob(blob, "kael-code-" + base + ".png");
      status.set("exported kael-code-" + base + ".png · " + off.width + "×" + off.height + " px · " + fmtBytes(blob.size) + " — real file downloaded", "ok");
    }, "image/png");
  });
  add(bar2, div("cdu-spacer"), exportBtn);

  renderPreview();
  status.set("tokens are colored by a local scanner (comments · strings · keywords · numbers) — the KAEL theme option samples your live palette at render time");
}

/* ==================================================================== */
/* TOOL 07 — PACKAGE SIZE CHECKER (the one honest network tool)          */
/* ==================================================================== */

const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function buildPkgSize(section, api) {
  const d = makeDisposers();
  section.__cduDispose = d.runAll.bind(d);

  const egress = div("cdu-help");
  egress.textContent =
    "NETWORK DISCLOSURE — this is the only tool here that leaves your machine. A lookup sends one keyless GET for the package name you typed to api.bundlephobia.com (bundle size), falling back to registry.npmjs.org (registry facts). Those hosts see your IP and the package name — nothing else is sent, no cookies, no credentials. This is exactly what the net.fetch permission you consented to at install covers.";

  const bar = div("cdu-bar");
  const input = el("input", { class: "cdu-input", type: "text", placeholder: "package name e.g. react / @scope/pkg", "aria-label": "npm package name", style: "flex:1 1 200px" });
  const goBtn = btn("⌕ check size", { class: "cdu-btn cdu-on" });
  add(bar, input, goBtn);
  const body = div();
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = "8px";
  add(section, body);
  add(body, egress, bar);
  const status = makeStatus(body);
  const card = div();
  const history = div("cdu-rows");
  const histLabel = div("cdu-label", "recent lookups (in memory only — gone when this panel closes)");
  const hist = [];

  add(body, card, histLabel, history);

  function registryUrl(name) {
    const enc = name.startsWith("@") ? "@" + name.slice(1).replace("/", "%2F") : encodeURIComponent(name);
    return "https://registry.npmjs.org/" + enc + "/latest";
  }

  async function lookup() {
    const name = input.value.trim();
    card.innerHTML = "";
    if (!name || name.length > 214 || !NPM_NAME_RE.test(name)) {
      status.set("that is not a valid npm package name", "warn");
      return;
    }
    goBtn.disabled = true;
    status.set("querying api.bundlephobia.com…");
    try {
      const bp = await bridge(status, "net.fetchJson (bundlephobia)", () =>
        api.net.fetchJson({ url: "https://api.bundlephobia.com/api/size?package=" + encodeURIComponent(name), timeoutMs: 12000 }));
      if (bp && bp.ok && bp.status === 200) {
        let data = null;
        try {
          data = JSON.parse(bp.text);
        } catch {
          /* falls through to registry */
        }
        if (data && typeof data.gzip === "number" && typeof data.size === "number") {
          renderResult(name, [
            ["minified", fmtBytes(data.size)],
            ["gzipped", fmtBytes(data.gzip)],
            ["ratio", data.size ? (data.gzip / data.size * 100).toFixed(0) + "%" : "—"],
            ["deps", String(data.dependencyCount ?? "—")],
            ["version", String(data.version || "—")],
          ], "source: api.bundlephobia.com — real minified & gzip bundle size of " + name + (bp.truncated ? " (response truncated)" : ""));
          pushHist(name, fmtBytes(data.gzip) + " gzip");
          status.set("bundle size fetched — keyless, one GET, disclosed above", "ok");
          return;
        }
      }
      const why = bp ? "bundlephobia " + (bp.status ? "answered http " + bp.status : "was unreachable (" + (bp.error || "network") + ")") : "bundlephobia call refused";
      status.set(why + " — falling back to the npm registry…", "warn");

      const reg = await bridge(status, "net.fetchJson (npm registry)", () =>
        api.net.fetchJson({ url: registryUrl(name), timeoutMs: 12000 }));
      if (reg && reg.ok && reg.status === 200) {
        let data = null;
        try {
          data = JSON.parse(reg.text);
        } catch {
          /* nothing more we can do */
        }
        if (data && data.dist) {
          renderResult(name, [
            ["version", String(data.version || "—")],
            ["unpacked size", data.dist.unpackedSize ? fmtBytes(data.dist.unpackedSize) : "—"],
            ["files", String(data.dist.fileCount ?? "—")],
            ["module type", (data.type === "module" ? "esm" : "—")],
          ], "source: registry.npmjs.org — UNPACKED size on disk, not minified/gzip bundle size (" + why + ")");
          pushHist(name, data.version || "?");
          status.set("registry facts fetched — note this is unpacked size, not bundle size", "ok");
          return;
        }
      }
      status.set("both sources failed — " + (reg ? "registry " + (reg.status ? "http " + reg.status : (reg.error || "unreachable")) : "registry call refused") + ". check the name and your connection.", "bad");
    } finally {
      goBtn.disabled = false;
    }
  }

  function renderResult(name, cells, note) {
    card.innerHTML = "";
    const box = div("cdu-psize-result");
    const head = div("cdu-psize-big", name);
    const grid = div("cdu-psize-grid");
    for (const [label, val] of cells) {
      const cell = div("cdu-psize-cell");
      add(cell, div("cdu-label", label), div("cdu-num", val));
      add(grid, cell);
    }
    const n = div("cdu-dim");
    n.style.fontSize = "10px";
    n.textContent = note;
    add(box, head, grid, n);
    add(card, box);
  }

  function pushHist(name, headline) {
    hist.unshift({ name, headline });
    if (hist.length > 8) hist.pop();
    history.innerHTML = "";
    for (const h of hist) {
      const r = div("cdu-row");
      const nm = div("cdu-grow");
      nm.textContent = h.name;
      const sz = div("cdu-dim cdu-num", h.headline);
      add(r, nm, sz);
      add(history, r);
    }
  }

  goBtn.addEventListener("click", lookup);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") lookup();
  });

  status.set("try: react · lodash · left-pad · @tensorflow/tfjs — real numbers, disclosed transport");
}

/* ==================================================================== */
/* mount / unmount — the plugin contract                                 */
/* ==================================================================== */

export async function mount(container, kaelApi) {
  const api = kaelApi || {};
  const root = div("cdu-root");
  root.setAttribute("data-kael-plugin", PLUGIN_ID);

  const head = div("cdu-head");
  add(head, div("cdu-title", "CREATIVE & DEV UTILITIES"));
  add(head, div("cdu-sub", "7 tools · 1 plugin · vanilla DOM · theme-reactive · local-first (one disclosed exception)"));
  add(root, head);

  const defs = [
    { id: "sketchboard", label: "sketchboard", help: "freehand pen, shapes (rect · ellipse · line · arrow), text boxes, eraser, undo/redo, pan & zoom, PNG export — all local, sketchy hand-drawn strokes. space/middle-drag pans, wheel zooms.", build: (sec) => buildSketchboard(sec) },
    { id: "flowchart", label: "flowchart", help: "draggable nodes with editable text, click-drag edge connections, palette (rect · decision diamond · terminal), SVG + PNG export — all local.", build: (sec) => buildFlowchart(sec) },
    { id: "font-id", label: "font-id", help: "upload a text image → local heuristic analysis (stroke width, serif flare, pitch regularity) matched against candidate fonts measured on YOUR system. approximate by design, never uploaded.", build: (sec) => buildFontId(sec) },
    { id: "compressor", label: "compressor", help: "batch image compression through KAEL's real sharp engine — adjustable quality, live previews, honest before/after byte counts. writes new files, never touches originals.", build: (sec) => buildCompressor(sec, api) },
    { id: "converter", label: "converter", help: "format conversion scoped to what KAEL's libraries genuinely handle (sharp images, pdf-lib pdf ops) — with an explicit unsupported list instead of fake conversions.", build: (sec) => buildConverter(sec, api) },
    { id: "code-image", label: "code-image", help: "paste code, pick language + theme (including your live KAEL palette), render a rounded-window PNG — original design, local tokenizer, no uploads.", build: (sec) => buildCodeImage(sec) },
    { id: "pkg-size", label: "pkg-size", help: "type an npm package name → real bundle size from bundlephobia (fallback: npm registry facts). the ONLY network tool here — transport disclosed in-panel and consented via net.fetch.", build: (sec) => buildPkgSize(sec, api) },
  ];
  const sections = [];
  makeTabs(root, defs.map((def) => ({
    id: def.id,
    label: def.label,
    help: def.help,
    build: (sec) => {
      def.build(sec);
      sections.push(sec);
    },
  })));

  const foot = div("cdu-foot");
  foot.textContent = "";
  const perms = el("span", { class: "cdu-accent" });
  perms.textContent = "fs.dialog · fs.write · net.fetch";
  foot.append(
    document.createTextNode("cdu v" + PLUGIN_VERSION + " · granted permissions: "),
    perms,
    document.createTextNode(" — fs.write is used ONLY for imageBatch/pdfInfo/pdfMerge/pdfSplit (creates new files, never deletes). everything else runs locally."),
  );
  add(root, foot);

  root.__cduSections = sections;
  container.innerHTML = "";
  container.appendChild(root);
}

export function unmount(container) {
  const root = container && container.querySelector ? container.querySelector('[data-kael-plugin="' + PLUGIN_ID + '"]') : null;
  if (root && Array.isArray(root.__cduSections)) {
    for (const sec of root.__cduSections) {
      try {
        if (typeof sec.__cduDispose === "function") sec.__cduDispose();
      } catch {
        /* a tool's cleanup must never break the deck */
      }
    }
    root.__cduSections = null;
  }
  if (container) container.innerHTML = "";
}
