import React, { useEffect, useMemo, useRef, useState } from "react";
import localforage from "localforage";
import { v4 as uuidv4 } from "uuid";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

// Desktop-safe pdf.js worker (bundled locally for Tauri/Electron)
GlobalWorkerOptions.workerPort = new Worker(workerUrl, { type: "module" });

// ---- Simple persistent stores ----
const metaStore = localforage.createInstance({ name: "pdf-card-binder-meta" });
const fileStore = localforage.createInstance({ name: "pdf-card-binder-files" });
const orderStore = localforage.createInstance({ name: "pdf-card-binder-order" });


// ---- Tiers (hardcoded) ----
const TIER_OPTIONS = [
  "Dawn","Seal","Lotus","Scribe","Eclipse","Celestial",
  "Phoenix","Transcendent","Sovereign","Ascendant","Empyreal",
  "Jade","Immortal"
];

// Hardcoded default collections (edit this list whenever you like)
const DEFAULT_COLLECTIONS = [
  "Dayseal",
  "Everflame Mandate",
  "First Light - Series I",
  "Mooncrown Eclipse - Series I",
  "Starseal Registry"
];

// Persist only user-added collections separately
const customCollectionStore = localforage.createInstance({
  name: "pdf-card-binder-custom-collections"
});

// Types
/** @typedef {{ id: string; name: string; pages: number; tags: string[]; collection?: string; thumbnailDataUrl: string; createdAt: number; updatedAt: number; tier?: string; favorite?: boolean; kind?: "pdf" | "gif"}} CardMeta */

const THEME_KEY = "pcb-theme"; // 'light' | 'dark'
const DEBUG_DND = false;
const d = (...args) => { if (DEBUG_DND) console.log("[DND]", ...args); };

const BACKUP_SCHEMA_VERSION = 2;

function toUint8(raw) {
  if (!raw) return new Uint8Array();
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}
// Optional: accept future/base64 formats gracefully
function decodeFileEntry(entry) {
  if (Array.isArray(entry)) return new Uint8Array(entry);
  if (typeof entry === "string") {
    const base64 = entry.includes(",") ? entry.split(",").pop() : entry;
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array();
}

function useTauriAutoUpdate(options = {}) {
  const { promptUser = true, skipInDev = true } = options;

  useEffect(() => {
    // Only run inside the Tauri desktop app
    const isTauri = typeof window !== "undefined" && "__TAURI_IPC__" in window;
    if (!isTauri) return;

    // Optional: don't check during `tauri dev`
    if (skipInDev && import.meta?.env?.DEV) return;

    let cancelled = false;

    (async () => {
      try {
        // Lazy-load so the web build doesn't include these
        const [{ check }, { relaunch }] = await Promise.all([
          import("@tauri-apps/plugin-updater"),
          import("@tauri-apps/plugin-process"),
        ]);

        const update = await check(); // null if none
        if (!update) return;

        // Optional confirmation dialog
        if (promptUser) {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          const ok = await ask(
            `A new version (${update.version}) is available. Install now?`,
            { title: "Update available" }
          );
          if (!ok) return;
        }

        await update.downloadAndInstall(); // you can pass a progress callback here
        if (!cancelled) await relaunch();  // restarts into the new version
      } catch (err) {
        // Never crash the app if updater/config isn’t set up
        console.debug("[updater] skipped or failed:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [promptUser, skipInDev]);
}

// ---------- Theme helpers (works regardless of Tailwind darkMode) ----------
function getInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}
function applyThemeClass(theme) {
  try {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    // Optional: hint to the UA for form controls / scrollbars
    root.style.colorScheme = theme;
  } catch {}
}

function ThemeToggle({ theme, setTheme }) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(t => (t === "dark" ? "light" : "dark"))}
      className={`px-3 py-2 rounded-xl border flex items-center gap-2
        ${isDark ? "border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700" :
                   "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}
      title={`Switch to ${isDark ? "light" : "dark"} mode`}
      aria-pressed={isDark ? "true" : "false"}
    >
      <span className="text-lg" aria-hidden>{isDark ? "🌙" : "☀️"}</span>
      <span className="text-sm">{isDark ? "Dark" : "Light"}</span>
    </button>
  );
}

// ---------- Utilities ----------
async function renderPdfPageToDataUrl(arrayBuffer, pageNumber = 1, scale = 0.9) {
  const pdf = await getDocument({ data: arrayBuffer }).promise;
  const pn = Math.max(1, Math.min(pdf.numPages, Number(pageNumber) || 1));
  const page = await pdf.getPage(pn);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { dataUrl: canvas.toDataURL("image/png"), numPages: pdf.numPages };
}


async function checkForUpdates() {
  const update = await check();           // contacts latest.json
  if (update?.available) {
    await update.downloadAndInstall();    // downloads, verifies, installs
    // app will restart on Windows after install
  }
}

function useLocalMeta() {
  const [metas, setMetas] = useState(/** @type {CardMeta[]} */([]));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const keys = await metaStore.keys();
      const all = await Promise.all(keys.map((k) => metaStore.getItem(k)));
      const list = /** @type {CardMeta[]} */ (all.filter(Boolean));
      list.sort((a, b) => a.createdAt - b.createdAt);
      setMetas(list);
      setLoading(false);
    })();
  }, []);

  async function upsert(meta) {
    await metaStore.setItem(meta.id, meta);
    setMetas((prev) => {
      const idx = prev.findIndex((m) => m.id === meta.id);
      if (idx === -1) return [...prev, meta];
      const copy = prev.slice();
      copy[idx] = meta;
      return copy;
    });
  }

  async function remove(id) {
    await metaStore.removeItem(id);
    await fileStore.removeItem(id);
    setMetas((prev) => prev.filter((m) => m.id !== id));
  }

  return { metas, loading, upsert, remove };
}

function Tag({ label, onClick, active = false, theme }) {
  const isDark = theme === "dark";
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded-full border text-xs mr-2 mb-2
        ${active
          ? (isDark ? "bg-slate-200 text-slate-900 border-slate-300" : "bg-gray-800 text-white border-gray-800")
          : (isDark ? "hover:bg-slate-800 border-slate-600 text-slate-200" : "hover:bg-gray-100 border-slate-300 text-slate-700")
        }`}
    >
      #{label}
    </button>
  );
}

function DropZone({ onFiles, theme }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const isDark = theme === "dark";

  return (
    <div
      className={`w-full border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer
        ${isDark ? "border-slate-600" : "border-slate-300"}
        ${over ? (isDark ? "bg-slate-800" : "bg-gray-50") : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setOver(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => {
          const nameOk = f.name?.toLowerCase().endsWith(".pdf");
          const typeOk = (f.type || "").toLowerCase().includes("pdf");
          const name = (f.name || "").toLowerCase();
          const type = (f.type || "").toLowerCase();
          const isPdf = name.endsWith(".pdf") || type.includes("pdf");
          const isGif = name.endsWith(".gif") || type === "image/gif";
          return isPdf || isGif;
        });
        if (files.length) onFiles(files);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <p className="font-medium">Drop PDFs or GIFs cards here or click to select</p>
      <p className={`text-xs mt-1 ${isDark ? "text-gray-400" : "text-gray-500"}`}>
        We generate thumbnails and store everything locally in your browser.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf,.gif,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function Lightbox({ open, onClose, fileBytes, name, theme }) {
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [pdf, setPdf] = useState(null);
  const [scale, setScale] = useState("fit"); // "fit" or numeric
  const canvasRef = useRef(null);
  const headerRef = useRef(null);

  // Load or replace the PDF when opened or file changes
  useEffect(() => {
    if (!open || !fileBytes) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await getDocument({ data: fileBytes }).promise;
        if (cancelled) return;
        setPdf(p);
        setNumPages(p.numPages);
        setPageNum(1);
        setScale("fit");
      } catch (e) {
        console.error("Failed to open PDF in lightbox", e);
      }
    })();
    return () => {
      cancelled = true;
      setPdf(null);
    };
  }, [open, fileBytes]);

  const render = React.useCallback(
    async (pageNo, targetScale) => {
      if (!pdf) return;
      const page = await pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      let s = targetScale;

      if (s === "fit") {
        const hdrH = headerRef.current?.offsetHeight || 0;
        const availW = window.innerWidth - 120;
        const availH = window.innerHeight - hdrH - 120;
        s = Math.min(availW / base.width, availH / base.height);
        s = Math.max(0.1, Math.min(s, 8));
      }

      const viewport = page.getViewport({ scale: s });
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d", { alpha: false });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.style.height = `${Math.round(viewport.height)}px`;

      await page.render({ canvasContext: ctx, viewport }).promise;
      setScale(s);
    },
    [pdf]
  );

  useEffect(() => {
    if (!open || !pdf) return;
    render(pageNum, scale);
  }, [open, pdf, pageNum, scale, render]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setScale("fit");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  if (!open) return null;

  const zoomIn = () => setScale((s) => (s === "fit" ? 1.1 : Math.min(Number(s) * 1.1, 8)));
  const zoomOut = () => setScale((s) => (s === "fit" ? 0.9 : Math.max(Number(s) / 1.1, 0.1)));
  const set100 = () => setScale(1);
  const fit = () => setScale("fit");

  const isDark = theme === "dark";

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex flex-col" onClick={onClose}>
      <div
        ref={headerRef}
        className="px-4 pt-3 pb-2 flex items-center gap-3 text-white select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-semibold truncate">{name}</div>
        <div className="text-sm opacity-80">Page {pageNum} / {numPages}</div>
        <div className="ml-auto flex items-center gap-2">
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={() => setPageNum((n) => Math.max(1, n - 1))} disabled={pageNum <= 1}>Prev</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={() => setPageNum((n) => Math.min(numPages, n + 1))} disabled={pageNum >= numPages}>Next</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={zoomOut}>–</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={zoomIn}>+</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={fit}>Fit</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={set100}>100%</button>
          <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center px-6 pb-6" onClick={(e) => e.stopPropagation()}>
        <div className={`shadow-2xl rounded ${isDark ? "bg-slate-900" : "bg-white"}`}>
          <canvas ref={canvasRef} />
        </div>
      </div>
    </div>
  );
}



function MultiPageLightbox({ open, onClose, fileBytes, name, theme }) {
  const [pdf, setPdf] = React.useState(null);
  const [numPages, setNumPages] = React.useState(1);
  const [scale, setScale] = React.useState("fit");
  const canvasesRef = React.useRef([]);
  const containerRef = React.useRef(null);
  const headerRef = React.useRef(null);
  const isDark = theme === "dark";

  // make default view slightly larger
  const FIT_PAD_X = 30;  // was 120
  const FIT_PAD_Y = 50;  // was 120

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!open || !fileBytes) return;
      try {
        const doc = await getDocument({ data: fileBytes }).promise;
        if (cancelled) return;
        canvasesRef.current = [];
        setPdf(doc);
        setNumPages(doc.numPages);
        setScale("fit");
      } catch (e) {
        console.error("Failed to open PDF", e);
      }
    })();
    return () => { cancelled = true; setPdf(null); };
  }, [open, fileBytes]);

  const fitScale = React.useCallback(async () => {
    if (!pdf) return 1;
    const first = await pdf.getPage(1);
    const base = first.getViewport({ scale: 1 });

    const hdr  = headerRef.current?.offsetHeight || 0;
    const availW = (containerRef.current?.clientWidth ?? window.innerWidth) - FIT_PAD_X;
    const availH = (window.innerHeight - hdr) - FIT_PAD_Y;

    let s = Math.min(availW / base.width, availH / base.height);
    s = Math.max(0.1, Math.min(s, 6));
    return s;
  }, [pdf]);

  const renderOne = React.useCallback(async (pageNo) => {
    if (!pdf) return;
    const canvas = canvasesRef.current[pageNo];
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    const page = await pdf.getPage(pageNo);
    const s = scale === "fit" ? await fitScale() : Number(scale) || 1;
    const viewport = page.getViewport({ scale: s });

    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.style.width = `${Math.round(viewport.width)}px`;
    canvas.style.height = `${Math.round(viewport.height)}px`;

    await page.render({ canvasContext: ctx, viewport }).promise;
  }, [pdf, scale, fitScale]);

  React.useEffect(() => {
    if (!pdf || !open) return;
    let cancelled = false;
    (async () => {
      for (let i = 1; i <= numPages && !cancelled; i++) {
        await renderOne(i);
      }
    })();
    return () => { cancelled = true; };
  }, [pdf, numPages, open, scale, renderOne]);

  React.useEffect(() => {
    if (!open || scale !== "fit") return;
    const id = requestAnimationFrame(() => setScale("fit"));
    return () => cancelAnimationFrame(id);
  }, [open, numPages, scale]);

  React.useEffect(() => {
    if (!open) return;
    const onResize = () => { if (scale === "fit") setScale("fit"); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, scale]);

  if (!open) return null;

  const zoomIn  = () => setScale((s) => s === "fit" ? 1.1 : Math.min(Number(s) * 1.1, 6));
  const zoomOut = () => setScale((s) => s === "fit" ? 0.9 : Math.max(Number(s) / 1.1, 0.1));
  const set100  = () => setScale(1);
  const fit     = () => setScale("fit");

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex flex-col" onClick={onClose}>
      <div
        ref={headerRef}
        className="px-4 pt-3 pb-2 flex items-center gap-3 text-white select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-semibold truncate">{name}</div>
        <div className="text-sm opacity-80">{numPages} page{numPages > 1 ? "s" : ""}</div>
        <div className="ml-auto flex items-center gap-2">
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={zoomOut}>–</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={zoomIn}>+</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={fit}>Fit</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={set100}>100%</button>
          <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20" onClick={onClose}>Close</button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto px-6 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto w-max space-y-6">
          {Array.from({ length: numPages }).map((_, idx) => (
            <canvas
              key={idx}
              ref={(el) => { canvasesRef.current[idx + 1] = el; }}
              className={`block shadow-2xl rounded ${isDark ? "bg-slate-900" : "bg-white"}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}


function GifLightbox({ open, onClose, fileBytes, name, theme }) {
  const [url, setUrl] = React.useState("");
  const [scale, setScale] = React.useState("fit"); // "fit" or number
  const [fitTick, setFitTick] = React.useState(0); // bump to recompute fit after layout/load
  const containerRef = React.useRef(null);
  const headerRef = React.useRef(null);
  const imgRef = React.useRef(null);
  const isDark = theme === "dark";

  // Match MultiPageLightbox padding (so it shows smaller and avoids scrolling)
  const FIT_PAD_X = 30;
  const FIT_PAD_Y = 50;

  React.useEffect(() => {
    if (!open || !fileBytes) return;
    const blob = new Blob([fileBytes], { type: "image/gif" });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    setScale("fit");
    // nudge a refit on next frame, after DOM paints
    requestAnimationFrame(() => setFitTick((t) => t + 1));

    return () => {
      URL.revokeObjectURL(u);
      setUrl("");
    };
  }, [open, fileBytes]);

  // Refit on window resize
  React.useEffect(() => {
    if (!open) return;
    const onResize = () => {
      setScale("fit");
      setFitTick((t) => t + 1);
      // double-Raf to ensure layout is settled
      requestAnimationFrame(() => setFitTick((t) => t + 1));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // Refit if the container itself changes size (scrollbar, flex changes, etc.)
  React.useEffect(() => {
    if (!open || !containerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (scale === "fit") {
        setFitTick((t) => t + 1);
        requestAnimationFrame(() => setFitTick((t) => t + 1));
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [open, scale]);

  const applyFit = React.useCallback(() => {
    const img = imgRef.current;
    const container = containerRef.current;
    const hdr = headerRef.current?.offsetHeight || 0;
    if (!img || !container) return 1;

    const naturalW = img.naturalWidth || 0;
    const naturalH = img.naturalHeight || 0;
    if (!naturalW || !naturalH) return 1;

    const availW = (container.clientWidth ?? window.innerWidth) - FIT_PAD_X;
    const availH = (window.innerHeight - hdr) - FIT_PAD_Y;

    let s = Math.min(availW / naturalW, availH / naturalH);
    s = Math.max(0.1, Math.min(s, 6)); // same caps as MultiPageLightbox
    return s;
  }, []);

  // Ensure we recompute precisely when needed
  const computedScale = React.useMemo(() => {
    if (scale === "fit") return applyFit();
    const k = Number(scale);
    return Number.isFinite(k) && k > 0 ? Math.min(Math.max(k, 0.1), 6) : 1;
  }, [scale, applyFit, fitTick, url]); // url/fitTick ensure re-run after load/layout

  const handleImgLoad = React.useCallback(() => {
    // Fit after the image knows its natural size AND after layout stabilizes
    setScale("fit");
    setFitTick((t) => t + 1);
    requestAnimationFrame(() => setFitTick((t) => t + 1));
  }, []);

  const zoomIn  = () => setScale((v) => (v === "fit" ? 1.1 : Math.min(Number(v) * 1.1, 6)));
  const zoomOut = () => setScale((v) => (v === "fit" ? 0.9 : Math.max(Number(v) / 1.1, 0.1)));
  const set100  = () => setScale(1);
  const fit     = () => { setScale("fit"); setFitTick((t) => t + 1); };

  // Style the img to the computed width; height auto to preserve aspect
  const imgStyle = React.useMemo(() => {
    const naturalW = imgRef.current?.naturalWidth || 0;
    const w = Math.round(naturalW * (computedScale || 1));
    return naturalW ? { width: `${w}px`, height: "auto" } : {};
  }, [computedScale]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex flex-col" onClick={onClose}>
      <div
        ref={headerRef}
        className="px-4 pt-3 pb-2 flex items-center gap-3 text-white select-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-semibold truncate">{name}</div>
        <div className="ml-auto flex items-center gap-2">
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={zoomOut}>–</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={zoomIn}>+</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={fit}>Fit</button>
          <button className="px-2 py-1 rounded bg-white/10 hover:bg-white/20" onClick={set100}>100%</button>
          <button className="px-3 py-1 rounded bg-white/10 hover:bg-white/20" onClick={onClose}>Close</button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 flex items-center justify-center px-6 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`shadow-2xl rounded ${isDark ? "bg-slate-900" : "bg-white"} overflow-hidden`}>
          {url && (
            <img
              ref={imgRef}
              src={url}
              alt={name}
              onLoad={handleImgLoad}
              style={imgStyle}
              className={`${isDark ? "bg-slate-900" : "bg-white"} block`}
              draggable={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}




// =====================
//  NEW REORDER SYSTEM
//  (Pointer-based; no OS DnD)
// =====================

/** Compute a stable key for a collection group. */
const keyForCollection = (c) => (c || "(None)").toLowerCase();

/** Returns items in a group in persisted order, with any new items appended by createdAt. */
function orderItemsInGroup(orderMap, groupName, items) {
  const key = keyForCollection(groupName);
  const idsOrder = orderMap[key] || [];
  const byId = new Map(items.map(m => [m.id, m]));
  const out = [];
  idsOrder.forEach(id => {
    if (byId.has(id)) {
      out.push(byId.get(id));
      byId.delete(id);
    }
  });
  out.push(...Array.from(byId.values()).sort((a,b) => (a.createdAt||0)-(b.createdAt||0)));
  return out;
}

async function manualCheck() {
  const update = await check();
  if (update?.available) {
    if (confirm(`Update ${update.version} available. Install now?`)) {
      await update.downloadAndInstall();
      try { await relaunch(); } catch {}
    }
  } else {
    alert("You’re up to date!");
  }
}

export default function App() {
  const { metas, loading, upsert, remove } = useLocalMeta();
  const [updateProgress, setUpdateProgress] = useState(null);

  

  // THEME state & persistence
  const [theme, setTheme] = useState(getInitialTheme());
  useEffect(() => {
    applyThemeClass(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  // If user hasn't chosen, follow OS changes
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return;
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => setTheme(media.matches ? "dark" : "light");
      media.addEventListener?.("change", handler);
      media.addListener?.(handler);
      return () => {
        media.removeEventListener?.("change", handler);
        media.removeListener?.(handler);
      };
    } catch {}
  }, []);

  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("");
  const [activeCollection, setActiveCollection] = useState("");
  const [lightbox, setLightbox] = useState({ open: false, id: "" });
  const [lightboxBytes, setLightboxBytes] = useState(null);
  const [importingCount, setImportingCount] = useState(0);
  const [lastError, setLastError] = useState("");
  const [customCollections, setCustomCollections] = useState([]);
  const [collectionsOpen, setCollectionsOpen] = useState(false);
  const [activeTier, setActiveTier] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [sortMode, setSortMode] = useState("none");
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkCollection, setBulkCollection] = useState("");
  const [bulkTier, setBulkTier] = useState("");
  const [bulkFavorite, setBulkFavorite] = useState("");
  const [reorderMode, setReorderMode] = useState(false);

  // Persisted per-group order
  const [orderMap, setOrderMap] = useState({});
  const persistOrder = (next) => {
    setOrderMap(next);
    orderStore.setItem("map", next);
  };

  // DnD state
  const [dragging, setDragging] = useState({ active:false, id:"", group:"" });
  const [dropTarget, setDropTarget] = useState({ id:"", pos:null });
  const pointerIdRef = useRef(null);
  const [dropLine, setDropLine] = useState({ groupKey: "", x: 0, top: 0, height: 0, visible: false });

  const [gifState, setGifState] = useState({ open: false, id: "" });
  const [gifBytes, setGifBytes] = useState(null); 

  // remember edit toggle across restarts
  useEffect(() => {
    const saved = localStorage.getItem("pcb-edit");
    if (saved) setEditMode(saved === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("pcb-edit", editMode ? "1" : "0");
  }, [editMode]);

  // Global OS file-drop shield
  useEffect(() => {
    const allow = (e) => {
      e.preventDefault();
      try { if (e.dataTransfer) e.dataTransfer.dropEffect = "none"; } catch {}
    };
    const opts = { capture: true, passive: false };
    window.addEventListener("dragover", allow, opts);
    window.addEventListener("drop", allow, opts);
    document.addEventListener("dragover", allow, opts);
    document.addEventListener("drop", allow, opts);
    return () => {
      window.removeEventListener("dragover", allow, opts);
      window.removeEventListener("drop", allow, opts);
      document.removeEventListener("dragover", allow, opts);
      document.removeEventListener("drop", allow, opts);
    };
  }, []);

  const allTags = useMemo(() => {
    const s = new Set();
    metas.forEach((m) => m.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [metas]);

  // Load custom collections (+ migrate found ones)
  useEffect(() => {
    (async () => {
      try {
        let stored = await customCollectionStore.getItem("list");
        if (!Array.isArray(stored)) stored = [];
        const extras = Array.from(new Set(
          metas
            .map(m => m.collection)
            .filter(c =>
              c &&
              !DEFAULT_COLLECTIONS.some(d => d.toLowerCase() === c.toLowerCase()) &&
              !stored.some(s => s.toLowerCase() === c.toLowerCase())
            )
        ));
        if (extras.length) stored = stored.concat(extras);
        stored.sort((a, b) => a.localeCompare(b));
        setCustomCollections(stored);
        await customCollectionStore.setItem("list", stored);
      } catch (e) {
        console.error("Failed to load custom collections", e);
      }
    })();
  }, [metas]);

  useEffect(() => {
    if (!editMode) return;
    const onKeyDown = (e) => e.key === "Escape" && setEditMode(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editMode]);

  const allCollections = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const c of DEFAULT_COLLECTIONS) {
      const k = c.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
    for (const c of customCollections) {
      const k = c.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(c); }
    }
    return out;
  }, [customCollections]);

  // Load order map
  useEffect(() => {
    (async () => {
      const map = (await orderStore.getItem("map")) || {};
      setOrderMap(map);
    })();
  }, []);

  // Filters
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const isFav = (v) => v === true || v === "true" || v === 1;
    return metas.filter((m) => {
      const tags = Array.isArray(m?.tags) ? m.tags : [];
      const col  = m?.collection || "";
      const tier = m?.tier || "";
      const fav  = isFav(m?.favorite);

      const okQ    = !q || m?.name?.toLowerCase().includes(q) || tags.some((t) => t.toLowerCase().includes(q));
      const okTag  = !activeTag || tags.includes(activeTag);
      const okCol  = !activeCollection || col === activeCollection;
      const okTier = !activeTier || tier === activeTier;
      const okFav  = !favoritesOnly || fav;

      return okQ && okTag && okCol && okTier && okFav;
    });
  }, [metas, query, activeTag, activeCollection, activeTier, favoritesOnly]);

  // Sorting
  const sorters = {
    none: () => 0,
    name_asc: (a, b) => a.name.localeCompare(b.name),
    name_desc: (a, b) => b.name.localeCompare(a.name),
    created_new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    created_old: (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
    updated_new: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    pages_desc: (a, b) => (b.pages || 0) - (a.pages || 0),
    pages_asc: (a, b) => (a.pages || 0) - (b.pages || 0),
  };

  const sortedFlat = useMemo(() => {
    const arr = [...filtered];
    const cmp = sorters[sortMode] || sorters.none;
    if (sortMode !== "none") arr.sort(cmp);
    return arr;
  }, [filtered, sortMode]);

  // Group into collections
  const groupedByCollection = useMemo(() => {
    const map = new Map();
    for (const m of filtered) {
      const key = m.collection || "(None)";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }

    const keys = [];
    const customs = [...map.keys()]
      .filter(k => k !== "(None)" && !DEFAULT_COLLECTIONS.some(d => d.toLowerCase() === k.toLowerCase()))
      .sort((a,b) => a.localeCompare(b));

    for (const c of DEFAULT_COLLECTIONS) if (map.has(c)) keys.push(c);
    for (const c of customs) keys.push(c);
    if (map.has("(None)")) keys.push("(None)");

    return keys.map(name => [name, map.get(name)]);
  }, [filtered]);

  const visibleList = useMemo(
    () => (sortMode !== "none" ? sortedFlat : filtered),
    [sortedFlat, filtered, sortMode]
  );

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function selectAllVisible() { setSelectedIds(new Set(visibleList.map((m) => m.id))); }
  function clearSelection() { setSelectedIds(new Set()); }

  useEffect(() => { if (!bulkMode) clearSelection(); }, [bulkMode]);
  useEffect(() => {
    if (bulkMode) { setBulkCollection(""); setBulkTier(""); setBulkFavorite(""); }
  }, [bulkMode]);

  async function applyBulk() {
    if (selectedIds.size === 0) return;

    const patch = {};
    if (bulkCollection === "__clear__") patch.collection = "";
    else if (bulkCollection && bulkCollection !== "__keep__") patch.collection = bulkCollection;

    if (bulkTier === "__clear__") patch.tier = "";
    else if (bulkTier && bulkTier !== "__keep__") patch.tier = bulkTier;

    if (bulkFavorite === "true") patch.favorite = true;
    if (bulkFavorite === "false") patch.favorite = false;

    if (Object.keys(patch).length === 0) return;
    await Promise.all(Array.from(selectedIds).map((id) => updateMeta(id, patch)));
  }

  async function addCustomCollection(name) {
    const n = (name || "").trim();
    if (!n) return;
    const exists = DEFAULT_COLLECTIONS.concat(customCollections)
      .some(c => c.toLowerCase() === n.toLowerCase());
    if (exists) return;
    const next = [...customCollections, n].sort((a,b) => a.localeCompare(b));
    setCustomCollections(next);
    await customCollectionStore.setItem("list", next);
  }

  async function deleteCustomCollection(name) {
    const n = (name || "").trim();
    if (!n) return;
    if (DEFAULT_COLLECTIONS.some(c => c.toLowerCase() === n.toLowerCase())) {
      alert("Default collections are built into the app and can’t be deleted here.");
      return;
    }
    if (!customCollections.some(c => c.toLowerCase() === n.toLowerCase())) return;

    if (!window.confirm(`Delete collection "${n}"?\nCards using it will be set to (None).`)) return;

    const next = customCollections.filter(c => c.toLowerCase() !== n.toLowerCase());
    setCustomCollections(next);
    await customCollectionStore.setItem("list", next);

    for (const m of metas) {
      if ((m.collection || "").toLowerCase() === n.toLowerCase()) {
        await updateMeta(m.id, { collection: "" });
      }
    }
    if ((activeCollection || "").toLowerCase() === n.toLowerCase()) {
      setActiveCollection("");
    }
  }

  async function importFiles(files) {
    if (!files?.length) return;
    setLastError("");
    setImportingCount((n) => n + files.length);

    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const renderBytes = bytes.slice();

        const nameLower = (file.name || "").toLowerCase();
        const typeLower = (file.type || "").toLowerCase();
        const isPdf = nameLower.endsWith(".pdf") || typeLower.includes("pdf");
        const isGif = nameLower.endsWith(".gif") || typeLower === "image/gif";
        
        let kind = isGif ? "gif" : "pdf"; // default to pdf if unknown

        let dataUrl = "";
        let numPages = 1;
        try {
          if (kind === "pdf") {
            const r = await renderPdfPageToDataUrl(renderBytes, 1, 0.9);
            dataUrl = r.dataUrl;
            numPages = r.numPages;
          } else {
            // GIF: make a thumbnail from the first frame
            const blob = new Blob([renderBytes], { type: "image/gif" });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            await new Promise((res, rej) => {
              img.onload = res; img.onerror = rej; img.src = url;
            });
            const W = 360, H = Math.max(240, Math.round((img.height / img.width) * 360) || 240);
            const canvas = document.createElement("canvas");
            canvas.width = W; canvas.height = H;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#fff"; ctx.fillRect(0,0,W,H);
            // contain fit
            const s = Math.min(W / img.width, H / img.height);
            const w = Math.round(img.width * s);
            const h = Math.round(img.height * s);
            const x = Math.round((W - w) / 2);
            const y = Math.round((H - h) / 2);
            ctx.drawImage(img, x, y, w, h);
            dataUrl = canvas.toDataURL("image/png");
            URL.revokeObjectURL(url);
            numPages = 1; // not relevant for GIF
          }
        } catch (renderErr) {
          console.error("Thumbnail render failed, using placeholder", renderErr);
          const canvas = document.createElement("canvas");
          canvas.width = 360; canvas.height = 240;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#f1f5f9"; ctx.fillRect(0,0,canvas.width,canvas.height);
          ctx.fillStyle = "#0f172a"; ctx.font = "bold 20px system-ui";
          ctx.fillText(kind.toUpperCase(), 20, 40);
          ctx.font = "14px system-ui";
          ctx.fillText(file.name.slice(0, 40), 20, 70);
          dataUrl = canvas.toDataURL("image/png");
        }

        const id = uuidv4();
        const meta = {
          id,
          name: file.name.replace(/\.pdf$/i, ""),
          pages: numPages,
          tags: [],
          collection: "",
          thumbnailDataUrl: dataUrl,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          tier: "",
          favorite: false,
          kind,
        };

        await fileStore.setItem(id, bytes);
        await metaStore.setItem(id, meta);
        await upsert(meta);
      } catch (e) {
        console.error("Failed to import", file?.name, e);
        setLastError(`Failed to import ${file?.name || ""}: ${e?.message || e}`);
      } finally {
        setImportingCount((n) => Math.max(0, n - 1));
      }
    }
  }

  async function openLightbox(id) {
    const meta = /** @type {CardMeta} */ (await metaStore.getItem(id));
    const bytes = await fileStore.getItem(id);
    // decide viewer by kind
    if (meta?.kind === "gif") {
      setGifState({ open: true, id });
      setGifBytes(bytes);
    } else {
      setLightboxBytes(bytes);
      setLightbox({ open: true, id });
    }
  }

  async function updateMeta(id, patch) {
    const existing = /** @type {CardMeta} */ (await metaStore.getItem(id));
    const updated = { ...existing, ...patch, updatedAt: Date.now() };
    await metaStore.setItem(id, updated);
    await upsert(updated);
  }

  async function exportJson() {
    // Gather auxiliary stores
    const [orderMapOnDisk, customCollectionsOnDisk] = await Promise.all([
      orderStore.getItem("map").then((m) => m || {}),
      customCollectionStore.getItem("list").then((l) => (Array.isArray(l) ? l : [])),
    ]);

    // Collect files keyed by id
    const files = {};
    for (const m of metas) {
      const raw = await fileStore.getItem(m.id);
      const bytes = toUint8(raw);
      files[m.id] = Array.from(bytes); // store as number array for portability
    }

    const backup = {
      app: "empress-card-binder",
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      // core library
      metas,
      files,
      // organization
      orderMap: orderMapOnDisk,
      customCollections: customCollectionsOnDisk,
      // optional niceties: theme
      theme: theme === "dark" ? "dark" : "light",
    };

    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pdf-card-binder-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }


  async function importJson(file, { mode = "merge" } = {}) {
    const text = await file.text();
    const data = JSON.parse(text || "{}");

    if (mode === "replace") {
      // Full reset before restore
      await Promise.all([
        metaStore.clear(),
        fileStore.clear(),
        orderStore.clear(),
        customCollectionStore.clear(),
      ]);
    }

    const importedMetas = Array.isArray(data.metas) ? data.metas : [];
    for (const m of importedMetas) {
      await metaStore.setItem(m.id, m);
    }

    const importedFiles = data.files || {};
    for (const [id, entry] of Object.entries(importedFiles)) {
      await fileStore.setItem(id, decodeFileEntry(entry));
    }

    if (data.orderMap && typeof data.orderMap === "object") {
      await orderStore.setItem("map", data.orderMap);
    }

    if (Array.isArray(data.customCollections)) {
      // de-dup + sort with any built-ins
      const dedup = Array.from(
        new Set(data.customCollections.map((c) => String(c)))
      ).sort((a, b) => a.localeCompare(b));
      await customCollectionStore.setItem("list", dedup);
    }

    if (data.theme === "dark" || data.theme === "light") {
      try { localStorage.setItem(THEME_KEY, data.theme); } catch {}
    }

    // Reload to rehydrate in-memory state from stores
    window.location.reload();
  }


  async function safeImportJson(file) {
    try {
      if (!file.name.toLowerCase().endsWith(".json")) {
        alert('That looks like a PDF. Use "Add PDFs" for PDFs. "Restore" is only for JSON backups.');
        return;
      }
      const replace = window.confirm(
        'Restore backup:\n\nClick "OK" to REPLACE your current library with the backup.\nClick "Cancel" to MERGE the backup into your current library.'
      );
      await importJson(file, { mode: replace ? "replace" : "merge" });
    } catch (err) {
      console.error("Import failed", err);
      alert("Import failed. Make sure you selected a JSON backup exported from this app.");
    }
  }


  // ===== moveWithinGroup (pointer + keyboard) =====
  function moveWithinGroup(groupName, draggedId, targetId, placeBefore=true) {
    const key = keyForCollection(groupName);
    const currentIds = orderMap[key] || [];

    const groupIds = metas
      .filter(m => (m.collection || "(None)") === groupName)
      .map(m => m.id);

    let ids = currentIds.filter(id => groupIds.includes(id));
    if (!ids.length) ids = groupIds.slice();

    ids = ids.filter(id => id !== draggedId);
    const tIdx = ids.indexOf(targetId);
    const insertAt = tIdx < 0 ? ids.length : (placeBefore ? tIdx : tIdx + 1);
    ids.splice(insertAt, 0, draggedId);

    ids = ids.filter(id => groupIds.includes(id));
    persistOrder({ ...orderMap, [key]: ids });
  }

  // ===== Global pointer handlers during dragging =====
  useEffect(() => {
    if (!dragging.active) return;

    function handlePointerMove(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cardEl = el?.closest?.("[data-card-id]");
      if (!cardEl) {
        setDropTarget({ id: "", pos: null });
        setDropLine({ groupKey: "", x: 0, top: 0, height: 0, visible: false });
        return;
      }

      const targetId = cardEl.getAttribute("data-card-id") || "";
      const targetGroup = cardEl.getAttribute("data-card-group") || "(None)";

      if (!targetId || targetGroup !== dragging.group) {
        setDropTarget({ id: "", pos: null });
        setDropLine({ groupKey: "", x: 0, top: 0, height: 0, visible: false });
        return;
      }

      const rect = cardEl.getBoundingClientRect();
      const pos = e.clientX < rect.left + rect.width / 2 ? "before" : "after";
      setDropTarget({ id: targetId, pos });

      const gridEl = cardEl.closest("[data-grid-key]");
      if (!gridEl) {
        setDropLine({ groupKey: "", x: 0, top: 0, height: 0, visible: false });
        return;
      }

      const gridRect = gridEl.getBoundingClientRect();
      const styles = getComputedStyle(gridEl);
      const colGap = parseFloat(styles.columnGap) || 0;

      let x = pos === "before"
        ? rect.left - gridRect.left - colGap / 2
        : rect.right - gridRect.left + colGap / 2;

      x = Math.max(0, Math.min(gridRect.width, x));

      const groupKey = gridEl.getAttribute("data-grid-key") || "";
      const INSET = 8;
      let lineHeight = Math.max(24, rect.height - INSET * 2);
      let lineTop = (rect.top - gridRect.top) + INSET;
      if (lineTop + lineHeight > gridRect.height) {
        lineTop = Math.max(0, gridRect.height - lineHeight);
      }
      setDropLine({ groupKey, x, top: lineTop, height: lineHeight, visible: true });
    }

    function handlePointerUp() {
      if (dragging.active && dropTarget.id && dropTarget.pos && dropTarget.id !== dragging.id) {
        moveWithinGroup(dragging.group, dragging.id, dropTarget.id, dropTarget.pos === "before");
      }
      setDragging({ active:false, id:"", group:"" });
      setDropTarget({ id:"", pos:null });
      setDropLine({ groupKey: "", x: 0, top: 0, height: 0, visible: false });
      pointerIdRef.current = null;
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dragging, dropTarget, orderMap, metas]);

  // ===== Keyboard reorder (Ctrl/Cmd + ↑/↓) =====
  function handleCardKeyDown(e, m, groupItemsOrdered) {
    if (!(reorderMode && sortMode === "none")) return;
    const isCtrl = e.ctrlKey || e.metaKey;
    if (!isCtrl) return;

    const idx = groupItemsOrdered.findIndex(x => x.id === m.id);
    if (idx < 0) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const neighbor = groupItemsOrdered[Math.max(0, idx - 1)];
      if (neighbor && neighbor.id !== m.id) {
        moveWithinGroup(m.collection || "(None)", m.id, neighbor.id, true);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const neighbor = groupItemsOrdered[Math.min(groupItemsOrdered.length - 1, idx + 1)];
      if (neighbor && neighbor.id !== m.id) {
        moveWithinGroup(m.collection || "(None)", m.id, neighbor.id, false);
      }
    }
  }

  // ===== Card renderer (pointer-based drag) =====
  function renderCardFactory(groupOrderedItems) {
    const isDark = theme === "dark";
    return function renderCard(m) {
      const isDragSource = dragging.active && dragging.id === m.id;
      const isDropTarget = dropTarget.id === m.id;

      const startPointerDrag = (e) => {
        if (!(reorderMode && sortMode === "none")) return;
        if (e.button !== 0) return;
        e.preventDefault();
        pointerIdRef.current = e.pointerId ?? null;
        setDragging({ active:true, id:m.id, group: m.collection || "(None)" });
        setDropTarget({ id:m.id, pos:"before" });
      };

      return (
        <article
          key={m.id}
          data-card-id={m.id}
          data-card-group={m.collection || "(None)"}
          className={`relative border rounded-2xl shadow-sm hover:shadow-md transition
            ${reorderMode ? "cursor-default" : ""} ${isDragSource ? "opacity-80" : ""}
            ${isDark ? "border-slate-700 bg-slate-900" : "border-slate-200 bg-white"}`}
          tabIndex={0}
          onKeyDown={(e) => handleCardKeyDown(e, m, groupOrderedItems)}
        >
          {/* Drag handle */}
          {reorderMode && sortMode === "none" && (
            <button
              type="button"
              className={`absolute top-2 left-2 z-[5] rounded-md border px-2 py-1 text-xs select-none
                ${isDark ? "bg-slate-900/80 hover:bg-slate-900 border-slate-700 text-slate-100"
                         : "bg-white/80 hover:bg-white border-slate-300 text-slate-800"}`}
              onPointerDown={startPointerDrag}
              title="Drag to reorder (same collection). Tip: Ctrl/Cmd+↑/↓ also works."
            >
              ⠿ Drag
            </button>
          )}

          {bulkMode && (
            <label
              className={`absolute top-2 right-2 rounded-md px-2 py-1 flex items-center gap-2 z-[5] border
                ${isDark ? "bg-slate-900/80 border-slate-700 text-slate-100"
                         : "bg-white/80 border-slate-300 text-slate-800"}`}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(m.id)}
                onChange={() => toggleSelected(m.id)}
              />
              <span className="text-xs">Select</span>
            </label>
          )}

          <div
            onClick={() => { if (!reorderMode) openLightbox(m.id); }}
            style={reorderMode ? { pointerEvents: "none" } : undefined}
            className={`${isDark ? "bg-slate-800" : "bg-gray-50"}`}
          >
            <img
              src={m.thumbnailDataUrl}
              alt={m.name}
              className={`w-full h-64 object-contain ${isDark ? "bg-slate-900" : "bg-white"}`}
              draggable={false}
            />
          </div>

          <div className="p-3">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0 pr-2">
                {editMode ? (
                  <EditableName
                    value={m.name}
                    onSave={(next) => updateMeta(m.id, { name: next })}
                  />
                ) : (
                  <div className="font-medium truncate" title={m.name}>{m.name}</div>
                )}
              </div>
              <button
                className={`shrink-0 text-3xl leading-none w-9 h-9 -mr-1
                        flex items-center justify-center rounded-full
                        ${isDark ? "hover:bg-slate-800 text-gray-400" : "hover:bg-gray-100 text-gray-300"}
                        focus:outline-none focus-visible:ring`}
                onClick={() => updateMeta(m.id, { favorite: !m.favorite })}
                title={m.favorite ? "Unfavorite" : "Favorite"}
                aria-label={m.favorite ? "Unfavorite" : "Favorite"}
                aria-pressed={m.favorite ? "true" : "false"}
              >
                {m.favorite ? "★" : "☆"}
              </button>
            </div>

            <div className={`text-xs mb-2 ${isDark ? "text-gray-400" : "text-gray-500"}`}>
              {m.pages} page{m.pages > 1 ? "s" : ""}
            </div>

            {editMode ? (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <select
                    className={`border rounded-md px-2 py-1 text-sm w-full
                      ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
                    value={m.collection || ""}
                    onChange={async (e) => {
                      const val = e.target.value;
                      if (val === "__add_new__") {
                        const name = window.prompt("New collection name");
                        const n = (name || "").trim();
                        if (n) {
                          await addCustomCollection(n);
                          await updateMeta(m.id, { collection: n });
                        }
                        e.target.value = m.collection || "";
                      } else {
                        await updateMeta(m.id, { collection: val });
                      }
                    }}
                  >
                    <option value="">(None)</option>
                    <optgroup label="Default collections">
                      {DEFAULT_COLLECTIONS.map((c) => (
                        <option key={"def-" + c} value={c}>{c}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Custom collections">
                      {customCollections.map((c) => (
                        <option key={"cus-" + c} value={c}>{c}</option>
                      ))}
                    </optgroup>
                    <option value="__add_new__">+ Add new…</option>
                  </select>
                </div>

                <div className="flex items-center gap-2 mb-2">
                  <select
                    className={`border rounded-md px-2 py-1 text-sm w-full
                      ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
                    value={m.tier || ""}
                    onChange={(e) => updateMeta(m.id, { tier: e.target.value })}
                  >
                    <option value="">(No tier)</option>
                    {TIER_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                <TagEditor value={m.tags} onChange={(tags) => updateMeta(m.id, { tags })} theme={theme} />

                <div className="flex items-center justify-between mt-3">
                  <div className="flex gap-2">
                    <button className={`px-3 py-1 rounded-md border ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`} onClick={() => openLightbox(m.id)}>
                      View
                    </button>
                    <button
                      className={`px-3 py-1 rounded-md border ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`}
                      onClick={() => setEditMode(false)}
                      title="Exit edit mode"
                    >
                      Done
                    </button>
                  </div>

                  <button
                    className={`px-3 py-1 rounded-md border text-red-600 ${isDark ? "border-slate-700" : "border-slate-300"}`}
                    onClick={() => { 
                      const msg = `Delete "${m.name || "this card"}"?\nThis will permanently remove the card and its stored PDF.`;
                      if (window.confirm(msg)) remove(m.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 mb-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs
                    ${isDark ? "bg-slate-800 border-slate-700" : "bg-gray-50 border-slate-300"}`}>
                    {m.collection || "(None)"}
                  </span>
                  <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs
                    ${isDark ? "bg-slate-800 border-slate-700" : "bg-gray-50 border-slate-300"}`}>
                    {m.tier || "(No tier)"}
                  </span>
                  
                </div>

                {Array.isArray(m.tags) && m.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {m.tags.map((t, i) => (
                      <span key={i} className={`inline-flex items-center rounded-full border px-2 py-1 text-xs
                        ${isDark ? "bg-slate-800 border-slate-700" : "bg-gray-100 border-slate-300"}`}>
                        #{t}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between mt-3">
                  <button className={`px-3 py-1 rounded-md border ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`} onClick={() => openLightbox(m.id)}>View</button>
                  <button className={`px-3 py-1 rounded-md border ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`} onClick={() => setEditMode(true)}>Edit</button>
                </div>
              </>
            )}
          </div>
        </article>
      );
    }
  }

  const isDark = theme === "dark";

  return (
    <div className={`min-h-screen ${isDark ? "bg-slate-900 text-slate-100" : "bg-white text-slate-900"}`}>
      <header className={`sticky top-0 z-40 backdrop-blur border-b
         ${isDark ? "bg-slate-900/90 border-slate-800" : "bg-white/90 border-slate-200"}`}>
        <div className="max-w-6xl mx-auto p-4 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">Empress Card Binder</h1>

          <ThemeToggle theme={theme} setTheme={setTheme} />

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or tag…"
            className={`flex-1 min-w-[200px] border rounded-xl px-3 py-2 placeholder:text-gray-400
              ${isDark ? "bg-slate-800 border-slate-700 text-slate-100" : "bg-white border-slate-300 text-slate-900"}`}
          />
          <select
            className={`border rounded-xl px-3 py-2
              ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
            value={activeCollection}
            onChange={(e) => setActiveCollection(e.target.value)}
          >
            <option value="">All collections</option>
            {allCollections.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select
            className={`border rounded-xl px-3 py-2
              ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
            value={activeTier}
            onChange={(e) => setActiveTier(e.target.value)}
          >
            <option value="">All tiers</option>
            {TIER_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <select
            className={`border rounded-xl px-3 py-2`
              + ` ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value)}
            title="Sorting disables folder grouping"
          >
            <option value="none">Default order (folders)</option>
            <option value="name_asc">Name A→Z</option>
            <option value="name_desc">Name Z→A</option>
            <option value="created_new">Newest added</option>
            <option value="created_old">Oldest added</option>
            <option value="updated_new">Recently edited</option>
            <option value="pages_desc">Pages high→low</option>
            <option value="pages_asc">Pages low→high</option>
          </select>

          <label
            className={`px-3 py-2 rounded-xl border cursor-pointer
              ${favoritesOnly
                ? (isDark ? "bg-yellow-900/20 border-yellow-700" : "bg-yellow-50 border-yellow-300")
                : (isDark ? "border-slate-700" : "border-slate-300")}`}
            title="Show favorites only"
          >
            <input
              type="checkbox"
              className="mr-2"
              checked={favoritesOnly}
              onChange={(e) => setFavoritesOnly(e.target.checked)}
            />
            ★ Favorites
          </label>

          <label
            className={`px-3 py-2 rounded-xl border cursor-pointer
              ${editMode
                ? (isDark ? "bg-blue-900/20 border-blue-700" : "bg-blue-50 border-blue-300")
                : (isDark ? "border-slate-700" : "border-slate-300")}`}
            title="Toggle edit mode"
          >
            <input
              type="checkbox"
              className="mr-2"
              checked={editMode}
              onChange={(e) => setEditMode(e.target.checked)}
            />
            Edit mode
          </label>

          <label
            className={`px-3 py-2 rounded-xl border cursor-pointer
              ${sortMode !== "none" ? "opacity-50 cursor-not-allowed" : ""}
              ${reorderMode
                ? (isDark ? "bg-amber-900/20 border-amber-700" : "bg-amber-50 border-amber-300")
                : (isDark ? "border-slate-700" : "border-slate-300")}`}
            title="Drag cards to reorder within each collection (only in Default order view)"
          >
            <input
              type="checkbox"
              className="mr-2"
              checked={reorderMode}
              disabled={sortMode !== "none"}
              onChange={(e) => {
                setReorderMode(e.target.checked);
                setDragging({ active:false, id:"", group:"" });
                setDropTarget({ id:"", pos:null });
              }}
            />
            Reorder
          </label>

          <label
            className={`px-3 py-2 rounded-xl border cursor-pointer
              ${bulkMode
                ? (isDark ? "bg-purple-900/20 border-purple-700" : "bg-purple-50 border-purple-300")
                : (isDark ? "border-slate-700" : "border-slate-300")}`}
            title="Select multiple cards to edit at once"
          >
            <input
              type="checkbox"
              className="mr-2"
              checked={bulkMode}
              onChange={(e) => setBulkMode(e.target.checked)}
            />
            Bulk edit
          </label>

          <button className={`px-3 py-2 rounded-xl border ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`} onClick={exportJson}>Export</button>

          <label className={`px-3 py-2 rounded-xl border cursor-pointer ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`}>
            Add PDFs
            <input
              type="file"
              accept="application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) importFiles(files);
                e.target.value = '';
              }}
            />
          </label>

          <label className={`px-3 py-2 rounded-xl border cursor-pointer ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`}>
            Restore
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) safeImportJson(f);
                e.target.value = '';
              }}
            />
          </label>

          <button
            className={`px-3 py-2 rounded-xl border ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`}
            onClick={() => setCollectionsOpen(true)}
          >
            Manage
          </button>

          

          {bulkMode && (
            <div className="w-full mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm">
                Selected: {selectedIds.size} / {visibleList.length}
              </span>
              <button className={`px-2 py-1 border rounded ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`} onClick={selectAllVisible}>
                Select all visible
              </button>
              <button className={`px-2 py-1 border rounded ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`} onClick={clearSelection}>
                Clear selection
              </button>

              {/* Bulk Collection */}
              <select
                className={`border rounded-xl px-3 py-2 ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
                value={bulkCollection}
                onChange={async (e) => {
                  const v = e.target.value;
                  if (v === "__add_new__") {
                    const name = window.prompt("New collection name");
                    const n = (name || "").trim();
                    if (n) {
                      await addCustomCollection(n);
                      setBulkCollection(n);
                    } else {
                      setBulkCollection("");
                    }
                  } else {
                    setBulkCollection(v);
                  }
                }}
                title="Set or clear collection for selected"
              >
                <option value="">Collection (no change)</option>
                <option value="__clear__">— Clear collection —</option>
                <optgroup label="Default">
                  {DEFAULT_COLLECTIONS.map((c) => (
                    <option key={"bdef-" + c} value={c}>{c}</option>
                  ))}
                </optgroup>
                <optgroup label="Custom">
                  {customCollections.map((c) => (
                    <option key={"bcus-" + c} value={c}>{c}</option>
                  ))}
                </optgroup>
                <option value="__add_new__">+ Add new…</option>
              </select>

              {/* Bulk Tier */}
              <select
                className={`border rounded-xl px-3 py-2 ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
                value={bulkTier}
                onChange={(e) => setBulkTier(e.target.value)}
                title="Set or clear tier for selected"
              >
                <option value="">Tier (no change)</option>
                <option value="__clear__">— Clear tier —</option>
                {TIER_OPTIONS.map((t) => (
                  <option key={"bt-" + t} value={t}>{t}</option>
                ))}
              </select>

              {/* Bulk Favorite */}
              <select
                className={`border rounded-xl px-3 py-2 ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
                value={bulkFavorite}
                onChange={(e) => setBulkFavorite(e.target.value)}
                title="Set or unset favorite for selected"
              >
                <option value="">Favorite (no change)</option>
                <option value="true">Set favorite ★</option>
                <option value="false">Unset favorite ☆</option>
              </select>

              <button
                className="px-3 py-2 rounded-xl border bg-blue-600 text-white"
                onClick={applyBulk}
                disabled={selectedIds.size === 0}
                title="Apply selected bulk changes"
              >
                Apply to selected
              </button>
            </div>
          )}
        </div>
      </header>

      {importingCount > 0 && (
        <div className="max-w-6xl mx-auto mt-3 px-4">
          <div className={`rounded-xl border px-4 py-2 text-sm ${isDark ? "bg-slate-900 border-slate-700" : "bg-white border-slate-300"}`}>
            Importing {importingCount} file{importingCount > 1 ? "s" : ""}…
          </div>
        </div>
      )}
      {lastError && (
        <div className="max-w-6xl mx-auto mt-3 px-4">
          <div className={`rounded-xl px-4 py-2 text-sm
            ${isDark ? "border-red-800 bg-red-900/20 text-red-300" : "border-red-300 bg-red-50 text-red-700"} border`}>
            {lastError}
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto p-4">
        <DropZone onFiles={importFiles} theme={theme} />

        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className={`text-sm mr-2 ${isDark ? "text-gray-300" : "text-gray-600"}`}>Tags:</span>
            <Tag label="All" active={!activeTag} onClick={() => setActiveTag("")} theme={theme} />
            {allTags.map((t) => (
              <Tag key={t} label={t} active={activeTag === t} onClick={() => setActiveTag(t)} theme={theme} />
            ))}
          </div>

          {loading ? (
            <div className={isDark ? "text-gray-400" : "text-gray-500"}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div className={isDark ? "text-gray-400" : "text-gray-500"}>No cards yet. Import PDFs above.</div>
          ) : sortMode !== "none" ? (
            // FLAT VIEW WHEN SORTING
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {sortedFlat.map(renderCardFactory(sortedFlat))}
            </div>
          ) : (
            // FOLDERS (GROUPED BY COLLECTION) WHEN sortMode === "none"
            <div className="space-y-8">
              {groupedByCollection.map(([name, items]) => {
                const ordered = orderItemsInGroup(orderMap, name, items);
                return (
                  <section key={name} className={`border rounded-2xl overflow-hidden ${isDark ? "border-slate-700" : "border-slate-200"}`}>
                    <div className={`px-4 py-2 border-b flex items-center justify-between
                      ${isDark ? "bg-slate-800 border-slate-700" : "bg-gray-50 border-slate-200"}`}>
                      <h2 className="font-semibold">{name}</h2>
                      <span className={`text-xs ${isDark ? "text-gray-400" : "text-gray-500"}`}>
                        {items.length} item{items.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {(() => {
                      const gridKey = keyForCollection(name);
                      return (
                        <div
                          className="relative p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4"
                          data-grid-key={gridKey}
                        >
                          {ordered.map(renderCardFactory(ordered))}

                          {/* single vertical drop indicator */}
                          {reorderMode &&
                            dropLine.visible &&
                            dropLine.groupKey === gridKey && (
                              <div
                                className="pointer-events-none absolute z-20"
                                style={{
                                  left: `${dropLine.x}px`,
                                  top: `${dropLine.top}px`,
                                  height: `${dropLine.height}px`,
                                  transform: "translateX(-50%)",
                                }}
                              >
                                <div className="w-1 h-full rounded-full bg-gradient-to-b from-sky-400 via-indigo-500 to-indigo-600 shadow-[0_0_0_3px_rgba(99,102,241,0.28)]" />
                              </div>
                            )}
                        </div>
                      );
                    })()}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </main>

      <MultiPageLightbox
        open={lightbox.open}
        onClose={() => setLightbox({ open: false, id: "" })}
        fileBytes={lightboxBytes}
        name={metas.find((m) => m.id === lightbox.id)?.name || ""}
        theme={theme}
      />

      <GifLightbox
        open={gifState.open}
        onClose={() => { setGifState({ open: false, id: "" }); setGifBytes(null); }}
        fileBytes={gifBytes}
        name={metas.find((m) => m.id === gifState.id)?.name || ""}
        theme={theme}
      />

      <CollectionsManager
        open={collectionsOpen}
        onClose={() => setCollectionsOpen(false)}
        defaults={DEFAULT_COLLECTIONS}
        custom={customCollections}
        onDelete={deleteCustomCollection}
        theme={theme}
      />
    </div>
  );
}

function CollectionsManager({ open, onClose, defaults, custom, onDelete, theme }) {
  if (!open) return null;
  const isDark = theme === "dark";
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`rounded-2xl p-4 w-full max-w-lg ${isDark ? "bg-slate-900" : "bg-white"}`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">Manage Collections</div>
          <button className={`px-3 py-1 rounded-md border ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`} onClick={onClose}>Close</button>
        </div>

        <div className="mb-4">
          <div className={`text-xs font-semibold mb-1 ${isDark ? "text-gray-300" : "text-gray-600"}`}>Default (built-in)</div>
          <div className="space-y-1">
            {DEFAULT_COLLECTIONS.map(c => (
              <div key={c} className="flex items-center justify-between text-sm">
                <span>{c}</span>
                <span className={isDark ? "text-gray-500" : "text-gray-400"}>(locked)</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className={`text-xs font-semibold mb-1 ${isDark ? "text-gray-300" : "text-gray-600"}`}>Custom</div>
          {custom.length === 0 ? (
            <div className={isDark ? "text-gray-400" : "text-gray-500"}>No custom collections yet.</div>
          ) : (
            <div className="space-y-1">
              {custom.map(c => (
                <div key={c} className="flex items-center justify-between text-sm">
                  <span>{c}</span>
                  <button
                    className={`px-2 py-1 rounded-md border text-red-600 ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`}
                    onClick={() => onDelete(c)}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EditableName({ value, onSave }) {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);

  const commit = React.useCallback(() => {
    const next = text.trim();
    if (!next || next === value) return;
    onSave(next);
  }, [text, value, onSave]);

  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); e.currentTarget.blur(); }
        if (e.key === "Escape") { setText(value); e.currentTarget.blur(); }
      }}
      placeholder="Untitled card"
      spellCheck={false}
      className="w-full min-w-0 bg-transparent border border-transparent focus:border-indigo-400 focus:ring-0 rounded-md px-1 h-7 text-sm font-medium"
      aria-label="Card name"
    />
  );
}

function TagEditor({ value, onChange, theme }) {
  const [text, setText] = useState("");
  const tags = value || [];
  const isDark = theme === "dark";

  function addTag(t) {
    const tag = t.trim();
    if (!tag) return;
    const set = new Set(tags.map((x) => x.toLowerCase()));
    if (set.has(tag.toLowerCase())) return;
    onChange([...(tags || []), tag]);
    setText("");
  }

  function removeTag(idx) {
    const copy = tags.slice();
    copy.splice(idx, 1);
    onChange(copy);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2">
        {tags.map((t, i) => (
          <span key={i} className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-sm border
            ${isDark ? "bg-slate-800 border-slate-700" : "bg-gray-100 border-slate-300"}`}>
            #{t}
            <button className={`${isDark ? "text-gray-400 hover:text-white" : "text-gray-500 hover:text-black"}`} onClick={() => removeTag(i)} aria-label={`remove ${t}`}>×</button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          className={`border rounded-md px-2 py-1 text-sm w-full
            ${isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300"}`}
          placeholder="Add tag and press Enter"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag(text);
            }
          }}
        />
        <button className={`px-3 py-1 rounded-md border ${isDark ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white"}`} onClick={() => addTag(text)}>Add</button>
      </div>
    </div>
  );
}
