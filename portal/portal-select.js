/* Brace labelling portal — fullscreen review, drag-select for AI, per-card delete. */
(function () {
  "use strict";

  const CONFIG = {
    clipSelector: ".clipcard",
    gridSelector: null,
    idAttribute: "data-id",
    ownerAttribute: "data-owner",
    srcAttributes: ["data-src", "data-url", "data-video", "src"],
    tickSelector: ".tick, .check, .checkbox, input[type=checkbox], .select-toggle",
    queueEndpoint: "/api/clips/queue",
    deleteEndpoint: "/api/clips/reject",
    confirmOver: 50,
  };

  const OWNER_COLOURS = { eddie: "#2F6FEB", rupert: "#7E9B82" };

  const selected = new Set();
  let marquee = null, dragStart = null, dragBase = new Set(), dragMoved = false;
  let boxes = [], viewerIndex = -1;

  const clips = () => Array.from(document.querySelectorAll(CONFIG.clipSelector));
  const visible = () => clips().filter((el) => el.offsetParent !== null);
  const idOf = (el) => el.getAttribute(CONFIG.idAttribute);
  const cardFor = (id) => clips().find((el) => idOf(el) === id) || null;

  function srcOf(el) {
    for (const attr of CONFIG.srcAttributes) {
      const value = el.getAttribute(attr);
      if (value) return value;
    }
    const media = el.querySelector("video[src], video source[src]");
    return media ? media.getAttribute("src") : null;
  }

  function paint() {
    for (const el of clips()) el.classList.toggle("is-selected", selected.has(idOf(el)));
    const bar = document.getElementById("bulk-bar");
    const count = document.getElementById("bulk-count");
    if (bar) bar.classList.toggle("visible", selected.size > 0);
    if (count) count.textContent = selected.size + " clip" + (selected.size === 1 ? "" : "s") + " selected";
  }

  function select(ids, opts) {
    if (!(opts && opts.add)) selected.clear();
    for (const id of ids) selected.add(id);
    paint();
  }

  function clearSelection() { selected.clear(); paint(); }

  function intersects(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    if (document.getElementById("viewer")) return;
    if (event.target.closest("button, a, input, select, textarea, video")) return;
    const root = CONFIG.gridSelector ? document.querySelector(CONFIG.gridSelector) : document.body;
    if (!root || !root.contains(event.target)) return;

    dragStart = { x: event.pageX, y: event.pageY };
    dragBase = event.shiftKey ? new Set(selected) : new Set();
    dragMoved = false;
    boxes = visible().map((el) => {
      const r = el.getBoundingClientRect();
      return { id: idOf(el),
        left: r.left + window.scrollX, right: r.right + window.scrollX,
        top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
    });
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  function onPointerMove(event) {
    if (!dragStart) return;
    const dx = Math.abs(event.pageX - dragStart.x), dy = Math.abs(event.pageY - dragStart.y);
    if (!dragMoved && dx < 4 && dy < 4) return;
    if (!dragMoved) {
      dragMoved = true;
      // The drag sweeps across headings, captions and the page around them,
      // none of which the card's own user-select covers — without this the
      // whole grid turns blue with selected text as the marquee moves.
      document.body.classList.add("is-dragging");
      marquee = document.createElement("div");
      marquee.id = "marquee";
      document.body.appendChild(marquee);
    }
    event.preventDefault();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
    const box = {
      left: Math.min(dragStart.x, event.pageX), right: Math.max(dragStart.x, event.pageX),
      top: Math.min(dragStart.y, event.pageY), bottom: Math.max(dragStart.y, event.pageY),
    };
    marquee.style.left = box.left + "px";
    marquee.style.top = box.top + "px";
    marquee.style.width = (box.right - box.left) + "px";
    marquee.style.height = (box.bottom - box.top) + "px";
    const margin = 60;
    if (event.clientY > window.innerHeight - margin) window.scrollBy(0, 14);
    else if (event.clientY < margin) window.scrollBy(0, -14);
    const hit = new Set(dragBase);
    for (const b of boxes) if (intersects(b, box)) hit.add(b.id);
    select(hit);
  }

  function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    document.body.classList.remove("is-dragging");
    if (marquee) marquee.remove();
    if (!dragMoved) clearSelection();
    marquee = null; dragStart = null; boxes = [];
  }

  function openViewer(index) {
    const list = visible();
    if (index < 0 || index >= list.length) return;
    viewerIndex = index;
    const card = list[index];
    const src = srcOf(card);
    if (!src) { alert("No video source on this card — add data-src to the clip element."); return; }

    let viewer = document.getElementById("viewer");
    if (!viewer) {
      viewer = document.createElement("div");
      viewer.id = "viewer";
      viewer.innerHTML =
        '<video id="viewer-video" controls autoplay playsinline></video>' +
        '<div id="viewer-bar"><span id="viewer-label"></span><span id="viewer-spacer"></span>' +
        '<button id="viewer-prev" type="button">&lsaquo;</button>' +
        '<button id="viewer-next" type="button">&rsaquo;</button>' +
        '<button id="viewer-delete" type="button">Delete</button>' +
        '<button id="viewer-close" type="button">Close</button></div>';
      document.body.appendChild(viewer);
      viewer.querySelector("#viewer-prev").addEventListener("click", () => step(-1));
      viewer.querySelector("#viewer-next").addEventListener("click", () => step(1));
      viewer.querySelector("#viewer-close").addEventListener("click", closeViewer);
      viewer.querySelector("#viewer-delete").addEventListener("click", () => {
        const current = visible()[viewerIndex];
        if (current) deleteClip(idOf(current), true);
      });
      viewer.addEventListener("click", (e) => { if (e.target === viewer) closeViewer(); });
    }

    const video = viewer.querySelector("#viewer-video");
    video.src = src;
    video.play().catch(() => {});
    const owner = card.getAttribute(CONFIG.ownerAttribute);
    viewer.style.setProperty("--owner-colour", OWNER_COLOURS[owner] || "#7E9B82");
    viewer.querySelector("#viewer-label").textContent = idOf(card) + "  ·  " + (index + 1) + " of " + list.length;
    document.body.classList.add("viewer-open");
  }

  function step(delta) {
    const next = viewerIndex + delta;
    if (next < 0 || next >= visible().length) return;
    openViewer(next);
  }

  function closeViewer() {
    const viewer = document.getElementById("viewer");
    if (!viewer) return;
    const video = viewer.querySelector("#viewer-video");
    video.pause(); video.removeAttribute("src"); video.load();
    viewer.remove();
    document.body.classList.remove("viewer-open");
    viewerIndex = -1;
  }

  // portal.js owns the Supabase session, so its own queue/delete are the
  // real implementations; the HTTP endpoints below are only a fallback for
  // a page that loads this file without it.
  async function runOp(name, endpoint, ids, extra) {
    const ops = window.BraceOps;
    if (ops && typeof ops[name] === "function") return ops[name](ids);
    const res = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, ...(extra || {}) }),
    });
    if (!res.ok) throw new Error(await res.text());
    return null;
  }

  async function deleteClip(id, fromViewer) {
    const card = cardFor(id);
    if (!card) return;
    card.classList.add("is-deleting");
    try {
      await runOp("deleteClips", CONFIG.deleteEndpoint, [id], { reason: "bad clip" });
      if (fromViewer) {
        const wasLast = viewerIndex >= visible().length - 1;
        card.remove(); selected.delete(id);
        const remaining = visible();
        if (!remaining.length) closeViewer();
        else openViewer(wasLast ? remaining.length - 1 : viewerIndex);
      } else {
        card.remove(); selected.delete(id);
      }
      paint();
    } catch (err) {
      card.classList.remove("is-deleting");
      alert("Delete failed: " + err.message);
    }
  }

  async function sendToAI() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (ids.length > CONFIG.confirmOver && !confirm("Send " + ids.length + " clips to the AI?")) return;
    const button = document.getElementById("bulk-queue");
    if (button) { button.disabled = true; button.textContent = "Sending…"; }
    try {
      await runOp("queueClips", CONFIG.queueEndpoint, ids);
      for (const el of clips()) if (selected.has(idOf(el))) el.classList.add("is-queued");
      clearSelection();
    } catch (err) {
      alert("Send failed: " + err.message);
    } finally {
      if (button) { button.disabled = false; button.textContent = "Send to AI"; }
    }
  }

  async function deleteSelected() {
    const ids = Array.from(selected);
    if (!ids.length) return;
    if (!confirm("Delete " + ids.length + " clip" + (ids.length === 1 ? "" : "s") + "?")) return;
    const button = document.getElementById("bulk-delete");
    if (button) { button.disabled = true; button.textContent = "Deleting…"; }
    try {
      await runOp("deleteClips", CONFIG.deleteEndpoint, ids, { reason: "bad clip" });
      for (const el of clips()) if (selected.has(idOf(el))) el.remove();
      clearSelection();
    } catch (err) {
      alert("Delete failed: " + err.message);
    } finally {
      if (button) { button.disabled = false; button.textContent = "Delete"; }
    }
  }

  function decorate() {
    for (const el of clips()) {
      el.querySelectorAll(CONFIG.tickSelector).forEach((tick) => tick.remove());
      const owner = el.getAttribute(CONFIG.ownerAttribute);
      if (owner && OWNER_COLOURS[owner]) el.style.setProperty("--owner-colour", OWNER_COLOURS[owner]);
      if (!el.querySelector(".card-delete")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "card-delete";
        button.title = "Delete this clip";
        button.textContent = "✕";
        button.addEventListener("click", (event) => { event.stopPropagation(); deleteClip(idOf(el)); });
        el.appendChild(button);
      }
    }
  }

  function onClick(event) {
    if (dragMoved) return;
    if (document.getElementById("viewer")) return;
    const card = event.target.closest(CONFIG.clipSelector);
    if (!card) return;
    if (event.target.closest("button, a, input")) return;
    const index = visible().indexOf(card);
    if (index > -1) openViewer(index);
  }

  function onKeyDown(event) {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    const inViewer = !!document.getElementById("viewer");
    if (event.key === "Escape") { inViewer ? closeViewer() : clearSelection(); }
    else if (inViewer && event.key === "ArrowRight") { event.preventDefault(); step(1); }
    else if (inViewer && event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    else if (inViewer && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      const current = visible()[viewerIndex];
      if (current) deleteClip(idOf(current), true);
    } else if (!inViewer && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      select(visible().map(idOf));
    }
  }

  function filterTo(owner) {
    for (const el of clips()) {
      const mine = !owner || el.getAttribute(CONFIG.ownerAttribute) === owner;
      el.style.display = mine ? "" : "none";
      if (!mine) selected.delete(idOf(el));
    }
    document.querySelectorAll("[data-filter]").forEach((b) => {
      b.classList.toggle("active", (b.dataset.filter || "") === (owner || ""));
    });
    paint();
  }

  function injectStyles() {
    const style = document.createElement("style");
    // Scoped to the clip cards this file governs. Unscoped, it hid every
    // checkbox in the portal — the rejected pile's and the review queue's
    // included — so their select-and-delete could not be ticked at all.
    style.textContent =
      CONFIG.clipSelector + " :is(" + CONFIG.tickSelector + ") { display: none !important; }" +
      "#marquee { position: absolute; z-index: 9999; pointer-events: none;" +
      "  border: 1px solid #2F6FEB; background: rgba(47,111,235,.14); border-radius: 2px; }" +
      CONFIG.clipSelector + " { position: relative; user-select: none; cursor: pointer; border-radius: 6px;" +
      "  outline: 2px solid var(--owner-colour, transparent) !important; outline-offset: 3px;" +
      "  transition: box-shadow .12s ease, transform .12s ease, opacity .15s ease; }" +
      CONFIG.clipSelector + ".is-selected { box-shadow: inset 0 0 0 3px var(--owner-colour, #2F6FEB)," +
      "  0 0 0 3px #0B1B2D, 0 0 0 5px var(--owner-colour, #2F6FEB); transform: scale(.985); }" +
      CONFIG.clipSelector + ".is-queued { opacity: .45; }" +
      CONFIG.clipSelector + ".is-deleting { opacity: .3; pointer-events: none; }" +
      ".card-delete { position: absolute; top: 6px; right: 6px; z-index: 3; width: 26px; height: 26px;" +
      "  padding: 0; border: 0; border-radius: 50%; background: rgba(11,27,45,.72); color: #F4EEE1;" +
      "  font: 600 13px/1 system-ui, sans-serif; cursor: pointer; opacity: 0; transition: opacity .12s ease; }" +
      CONFIG.clipSelector + ":hover .card-delete { opacity: 1; }" +
      ".card-delete:hover { background: #8C2F2F; }" +
      "#viewer { position: fixed; inset: 0; z-index: 10001; display: flex; flex-direction: column;" +
      "  align-items: center; justify-content: center; background: rgba(11,27,45,.96); }" +
      "#viewer-video { max-width: 100vw; max-height: calc(100vh - 64px); background: #000;" +
      "  outline: 2px solid var(--owner-colour, #7E9B82); }" +
      "#viewer-bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center;" +
      "  gap: 10px; padding: 12px 18px; color: #F4EEE1; font: 500 14px/1 system-ui, sans-serif; }" +
      "#viewer-spacer { flex: 1; }" +
      "#viewer-bar button { border: 0; border-radius: 8px; padding: 9px 14px;" +
      "  background: rgba(244,238,225,.12); color: #F4EEE1; font: inherit; cursor: pointer; }" +
      "#viewer-delete { background: #8C2F2F !important; }" +
      "body.viewer-open { overflow: hidden; }" +
      "#bulk-bar { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 140%);" +
      "  display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-radius: 12px;" +
      "  background: #0B1B2D; color: #F4EEE1; font: 500 14px/1 system-ui, sans-serif;" +
      "  box-shadow: 0 12px 32px rgba(0,0,0,.35); transition: transform .18s ease; z-index: 10000; }" +
      "#bulk-bar.visible { transform: translate(-50%, 0); }" +
      "#bulk-bar button { border: 0; border-radius: 8px; padding: 9px 14px; font: inherit; cursor: pointer; }" +
      "#bulk-queue { background: #34503C; color: #F4EEE1; }" +
      "#bulk-delete { background: #8C2F2F; color: #F4EEE1; }" +
      "#bulk-clear { background: transparent; color: #7E9B82; }" +
      "body.is-dragging, body.is-dragging * { user-select: none !important;" +
      "  -webkit-user-select: none !important; }" +
      "[data-filter].active { outline: 2px solid #B8995A; }";
    document.head.appendChild(style);
  }

  function injectBar() {
    if (document.getElementById("bulk-bar")) return;
    const bar = document.createElement("div");
    bar.id = "bulk-bar";
    bar.innerHTML = '<span id="bulk-count">0 clips selected</span>' +
      '<button id="bulk-queue" type="button">Send to AI</button>' +
      '<button id="bulk-delete" type="button">Delete</button>' +
      '<button id="bulk-clear" type="button">Clear</button>';
    document.body.appendChild(bar);
    bar.querySelector("#bulk-queue").addEventListener("click", sendToAI);
    bar.querySelector("#bulk-delete").addEventListener("click", deleteSelected);
    bar.querySelector("#bulk-clear").addEventListener("click", clearSelection);
  }

  function init() {
    injectStyles(); injectBar(); decorate();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    document.querySelectorAll("[data-filter]").forEach((b) => {
      b.addEventListener("click", () => filterTo(b.dataset.filter || null));
    });
    new MutationObserver(decorate).observe(document.body, { childList: true, subtree: true });
  }

  window.BracePortal = { select, clearSelection, filterTo, sendToAI, deleteClip, openViewer, selected, CONFIG };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
