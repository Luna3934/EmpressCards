import React, { useEffect, useMemo, useRef, useState } from "react";
import localforage from "localforage";
import { v4 as uuidv4 } from "uuid";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

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
/** @typedef {{ id: string; name: string; pages: number; tags: string[]; collection?: string; thumbnailDataUrl: string; createdAt: number; updatedAt: number; tier?: string; favorite?: boolean; }} CardMeta */

async function renderPdfPageToDataUrl(arrayBuffer, pageNumber = 1, scale = 0.9) {
  const pdf = await getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const renderContext = { canvasContext: ctx, viewport };
  await page.render(renderContext).promise;
  const dataUrl = canvas.toDataURL("image/png");
  return { dataUrl, numPages: pdf.numPages };
}

async function arrayBufferFromFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function useLocalMeta() {
  const [metas, setMetas] = useState(/** @type {CardMeta[]} */([]));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const keys = await metaStore.keys();
      const all = await Promise.all(keys.map((k) => metaStore.getItem(k)));
      const list = /** @type {CardMeta[]} */ (all.filter(Boolean));
      list.sort((a, b) => a.createdAt - b.createdAt); // ← or remove this line to keep store order
      setMetas(list);
      setLoading(false);
    })();
  }, []);


  async function upsert(meta) {
    await metaStore.setItem(meta.id, meta);
    setMetas((prev) => {
      const idx = prev.findIndex((m) => m.id === meta.id);
      if (idx === -1) return [...prev, meta]; // append new card at the end
      const copy = prev.slice();
      copy[idx] = meta;                        // replace in place
      return copy;                             // ← no sort
    });
  }

  async function remove(id) {
    await metaStore.removeItem(id);
    await fileStore.removeItem(id);
    setMetas((prev) => prev.filter((m) => m.id !== id));
  }

  return { metas, loading, upsert, remove };
}

function Tag({ label, onClick, active = false }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-1 rounded-full border text-xs mr-2 mb-2 ${
        active ? "bg-gray-800 text-white" : "hover:bg-gray-100"
      }`}
    >
      #{label}
    </button>
  );
}

function DropZone({ onFiles }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  return (
    <div
      className={`w-full border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer ${over ? "bg-gray-50" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setOver(false);
        const files = Array.from(e.dataTransfer.files).filter((f) => {
          const nameOk = f.name?.toLowerCase().endsWith(".pdf");
          const typeOk = (f.type || "").toLowerCase().includes("pdf");
          return nameOk || typeOk; // IMPORTANT: type can be empty on Windows
        });
        if (files.length) onFiles(files);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <p className="font-medium">Drop PDF cards here or click to select</p>
      <p className="text-xs text-gray-500 mt-1">We generate thumbnails and store everything locally in your browser.</p>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);      // don't re-filter here
          e.target.value = "";                   // allow picking same file twice
        }}
      />
    </div>
  );
}


function Lightbox({ open, onClose, fileBytes, name }) {
  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [pdf, setPdf] = useState(null);
  const [scale, setScale] = useState("fit"); // "fit" or numeric
  const canvasRef = useRef(null);
  const headerRef = useRef(null);

  // Load/replace the PDF when opened or file changes
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
        setScale("fit"); // start fitted every time
      } catch (e) {
        console.error("Failed to open PDF in lightbox", e);
      }
    })();
    return () => {
      cancelled = true;
      setPdf(null);
    };
  }, [open, fileBytes]);

  // Render helper (fits to viewport when scale === "fit")
  const render = React.useCallback(
    async (pageNo, targetScale) => {
      if (!pdf) return;
      const page = await pdf.getPage(pageNo);

      // Base viewport to know natural page size
      const base = page.getViewport({ scale: 1 });

      let s = targetScale;
      if (s === "fit") {
        const hdrH = headerRef.current?.offsetHeight || 0;
        const availW = window.innerWidth - 120;                  // side padding
        const availH = window.innerHeight - hdrH - 120;          // top/bottom padding
        s = Math.min(availW / base.width, availH / base.height); // contain
        s = Math.max(0.1, Math.min(s, 8));                       // clamp
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

  // Render when pdf/page/scale changes
  useEffect(() => {
    if (!open || !pdf) return;
    render(pageNum, scale);
  }, [open, pdf, pageNum, scale, render]);

  // Re-fit on window resize
  useEffect(() => {
    if (!open) return;
    const onResize = () => setScale("fit");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  if (!open) return null;

  // Zoom controls
  const zoomIn = () => setScale((s) => (s === "fit" ? 1.1 : Math.min(Number(s) * 1.1, 8)));
  const zoomOut = () => setScale((s) => (s === "fit" ? 0.9 : Math.max(Number(s) / 1.1, 0.1)));
  const set100 = () => setScale(1);
  const fit = () => setScale("fit");

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex flex-col" onClick={onClose}>
      {/* Header */}
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

      {/* Canvas area: centers the page; no scroll when fitted, scrolls only if zoomed in */}
      <div
        className="flex-1 flex items-center justify-center px-6 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shadow-2xl bg-white rounded">
          <canvas ref={canvasRef} />
        </div>
      </div>
    </div>
  );
}



export default function App() {
  const { metas, loading, upsert, remove } = useLocalMeta();
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

  // View vs Edit mode
  const [editMode, setEditMode] = useState(false);

  const [sortMode, setSortMode] = useState("none"); // none | name_asc | name_desc | created_new | created_old | updated_new | pages_desc | pages_asc

  // Bulk edit state
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Bulk controls
  const [bulkCollection, setBulkCollection] = useState("");
  const [bulkTier, setBulkTier] = useState("");
  const [bulkFavorite, setBulkFavorite] = useState(""); // "", "true", "false"

  const [reorderMode, setReorderMode] = useState(false);
  const [orderMap, setOrderMap] = useState({}); // { [lowercased collection or "(none)"]: string[] }



  // (optional) remember the toggle across app restarts
  useEffect(() => {
    const saved = localStorage.getItem("pcb-edit");
    if (saved) setEditMode(saved === "1");
  }, []);
  useEffect(() => {
    localStorage.setItem("pcb-edit", editMode ? "1" : "0");
  }, [editMode]);



  const allTags = useMemo(() => {
    const s = new Set();
    metas.forEach((m) => m.tags.forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [metas]);

  // Load custom collections (and migrate any existing card collections not in defaults)
  useEffect(() => {
    (async () => {
      try {
        let stored = await customCollectionStore.getItem("list");
        if (!Array.isArray(stored)) stored = [];

        // include collections already used by cards but not in defaults/custom
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
  }, [metas]); // re-check when cards change

  useEffect(() => {
    if (!editMode) return;
    const onKeyDown = (e) => e.key === "Escape" && setEditMode(false);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editMode]);

  // Use Default + Custom (no duplicates, defaults first)
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


  useEffect(() => {
    (async () => {
      const map = (await orderStore.getItem("map")) || {};
      setOrderMap(map);
    })();
  }, []);

  function persistOrder(next) {
    setOrderMap(next);
    orderStore.setItem("map", next);
  }

  const keyForCollection = (c) => (c || "(None)").toLowerCase();


  function orderItemsInGroup(groupName, items) {
    const key = keyForCollection(groupName);
    const idsOrder = orderMap[key] || [];
    const byId = new Map(items.map(m => [m.id, m]));
    const out = [];

    // pull known IDs in saved order
    idsOrder.forEach(id => {
      if (byId.has(id)) {
        out.push(byId.get(id));
        byId.delete(id);
      }
    });

    // append any new items not seen yet (keep stable by createdAt)
    out.push(...Array.from(byId.values()).sort((a,b) => (a.createdAt||0)-(b.createdAt||0)));
    return out;
  }

  function moveWithinGroup(groupName, draggedId, targetId, placeBefore=true) {
    const key = keyForCollection(groupName);
    const currentIds = orderMap[key] || [];

    // Build the full set of IDs for this group from metas (only those actually in the group)
    const groupIds = metas
      .filter(m => (m.collection || "(None)") === groupName)
      .map(m => m.id);

    // Start from existing order but scoped to this group's ids
    let ids = currentIds.filter(id => groupIds.includes(id));
    if (!ids.length) ids = groupIds.slice(); // first time: start with current visual order

    // remove dragged, then insert relative to target
    ids = ids.filter(id => id !== draggedId);
    const tIdx = ids.indexOf(targetId);
    const insertAt = tIdx < 0 ? ids.length : (placeBefore ? tIdx : tIdx + 1);
    ids.splice(insertAt, 0, draggedId);

    // keep only valid ids
    ids = ids.filter(id => groupIds.includes(id));

    persistOrder({ ...orderMap, [key]: ids });
  }





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

  // Build folders (groups) by collection for the "no sort" view
  const groupedByCollection = useMemo(() => {
    const map = new Map();
    for (const m of filtered) {
      const key = m.collection || "(None)";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }

    // Order: default collections (in your defined order), then custom (A–Z), then (None)
    const keys = [];
    const customs = [...map.keys()]
      .filter(k => k !== "(None)" && !DEFAULT_COLLECTIONS.some(d => d.toLowerCase() === k.toLowerCase()))
      .sort((a,b) => a.localeCompare(b));

    for (const c of DEFAULT_COLLECTIONS) if (map.has(c)) keys.push(c);
    for (const c of customs) keys.push(c);
    if (map.has("(None)")) keys.push("(None)");

    return keys.map(name => [name, map.get(name)]);
  }, [filtered]);

  // Cards currently visible (respect sorting vs folders)
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
  function selectAllVisible() {
    setSelectedIds(new Set(visibleList.map((m) => m.id)));
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  // Clear selection when leaving bulk mode
  useEffect(() => {
    if (!bulkMode) clearSelection();
  }, [bulkMode]);

  useEffect(() => {
    if (bulkMode) {
      setBulkCollection("");
      setBulkTier("");
      setBulkFavorite("");
    }
  }, [bulkMode]);

  async function applyBulk() {
    if (selectedIds.size === 0) return;

    const patch = {};
    // collection
    if (bulkCollection === "__clear__") patch.collection = "";
    else if (bulkCollection && bulkCollection !== "__keep__") patch.collection = bulkCollection;

    // tier
    if (bulkTier === "__clear__") patch.tier = "";
    else if (bulkTier && bulkTier !== "__keep__") patch.tier = bulkTier;

    // favorite
    if (bulkFavorite === "true") patch.favorite = true;
    if (bulkFavorite === "false") patch.favorite = false;

    if (Object.keys(patch).length === 0) return;

    await Promise.all(Array.from(selectedIds).map((id) => updateMeta(id, patch)));
  }



  async function addCustomCollection(name) {
    const n = (name || "").trim();
    if (!n) return;
    // prevent duplicates across defaults and custom
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

    // Can't delete defaults (they're hardcoded in the app)
    if (DEFAULT_COLLECTIONS.some(c => c.toLowerCase() === n.toLowerCase())) {
      alert("Default collections are built into the app and can’t be deleted here.");
      return;
    }

    // Only proceed if it exists in the custom list
    if (!customCollections.some(c => c.toLowerCase() === n.toLowerCase())) return;

    if (!window.confirm(`Delete collection "${n}"?\nCards using it will be set to (None).`)) return;

    // Remove from custom list and persist
    const next = customCollections.filter(c => c.toLowerCase() !== n.toLowerCase());
    setCustomCollections(next);
    await customCollectionStore.setItem("list", next);

    // Clear the collection on any cards that used it
    for (const m of metas) {
      if ((m.collection || "").toLowerCase() === n.toLowerCase()) {
        await updateMeta(m.id, { collection: "" });
      }
    }

    // If you were filtering by the just-deleted collection, clear the filter
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
        // Read once
        const bytes = new Uint8Array(await file.arrayBuffer());

        // 👉 IMPORTANT: make a *separate copy* for pdf.js so our original stays attached
        const renderBytes = bytes.slice(); // copies the underlying buffer

        // Try to render a thumbnail using the copy
        let dataUrl = "";
        let numPages = 1;
        try {
          const r = await renderPdfPageToDataUrl(renderBytes, 1, 0.9);
          dataUrl = r.dataUrl;
          numPages = r.numPages;
        } catch (renderErr) {
          console.error("Thumbnail render failed, using placeholder", renderErr);
          const canvas = document.createElement("canvas");
          canvas.width = 360; canvas.height = 240;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#f1f5f9"; ctx.fillRect(0,0,canvas.width,canvas.height);
          ctx.fillStyle = "#0f172a"; ctx.font = "bold 20px system-ui";
          ctx.fillText("PDF", 20, 40);
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
          favorite: false     
        };

        // Save the original (still attached) bytes
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
    const bytes = await fileStore.getItem(id);
    setLightboxBytes(bytes);
    setLightbox({ open: true, id });
  }

  async function updateMeta(id, patch) {
    const existing = /** @type {CardMeta} */ (await metaStore.getItem(id));
    const updated = { ...existing, ...patch, updatedAt: Date.now() };
    await metaStore.setItem(id, updated);
    await upsert(updated);
  }

  async function exportJson() {
    const data = { metas, files: {} };
    for (const m of metas) {
      const bytes = await fileStore.getItem(m.id);
      data.files[m.id] = Array.from(bytes || []);
    }
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pdf-card-binder-export-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    for (const m of data.metas) {
      await metaStore.setItem(m.id, m);
    }
    for (const [id, arr] of Object.entries(data.files)) {
      await fileStore.setItem(id, new Uint8Array(arr));
    }
    // Reload to refresh state (simplest path)
    window.location.reload();
  }

  // Graceful handler to prevent picking a PDF in the JSON importer
  async function safeImportJson(file) {
    try {
      if (!file.name.toLowerCase().endsWith('.json')) {
        alert('That looks like a PDF. Use "Add PDFs" or the big drop zone for PDFs. "Restore" is only for JSON backups.');
        return;
      }
      await importJson(file);
    } catch (err) {
      console.error('Import failed', err);
      alert('Import failed. Make sure you selected a JSON backup exported from this app.');
    }
  }

  const renderCard = (m) => (
    <article
      key={m.id}
      className={`relative border rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition ${reorderMode ? "cursor-move" : ""}`}
      draggable={reorderMode && sortMode === "none"}
      onDragStart={(e) => {
        if (!reorderMode || sortMode !== "none") return;
        e.dataTransfer.clearData();
        e.dataTransfer.setData("text/plain", m.id);                       // <-- required by some webviews
        e.dataTransfer.setData("application/x-pcb-id", m.id);
        e.dataTransfer.setData("application/x-pcb-group", m.collection || "(None)");
        e.dataTransfer.effectAllowed = "move";                            // <-- advertise move
      }}
      onDragEnter={(e) => {
        if (!reorderMode || sortMode !== "none") return;
        e.preventDefault();                                               // <-- allow drop here
      }}
      onDragOver={(e) => {
        if (!reorderMode || sortMode !== "none") return;
        e.preventDefault();                                               // <-- critical to avoid 🚫 cursor
        e.dataTransfer.dropEffect = "move";                               // <-- matches effectAllowed
      }}
      onDrop={(e) => {
        if (!reorderMode || sortMode !== "none") return;
        e.preventDefault();
        const draggedId =
          e.dataTransfer.getData("application/x-pcb-id") ||
          e.dataTransfer.getData("text/plain");
        const fromGroup = e.dataTransfer.getData("application/x-pcb-group") || "(None)";
        const toGroup = m.collection || "(None)";
        if (!draggedId || fromGroup !== toGroup) return;                  // no cross-group moves

        const rect = e.currentTarget.getBoundingClientRect();
        const placeBefore = e.clientY < rect.top + rect.height / 2;
        moveWithinGroup(toGroup, draggedId, m.id, placeBefore);
      }}
    >

      {bulkMode && (
        <label
          className="absolute top-2 left-2 bg-white/80 border rounded-md px-2 py-1 flex items-center gap-2 z-[5]"
          style={{ pointerEvents: reorderMode ? "none" : "auto" }}
        >
          <input
            type="checkbox"
            checked={selectedIds.has(m.id)}
            onChange={() => toggleSelected(m.id)}
          />
          <span className="text-xs">Select</span>
        </label>
      )}

      <button
        className="block w-full bg-gray-50"
        onClick={() => { if (!reorderMode) openLightbox(m.id); }}
        disabled={reorderMode}
      >
        <img
          src={m.thumbnailDataUrl}
          alt={m.name}
          className="w-full h-64 object-contain bg-white"
          draggable={false}
          style={{ WebkitUserDrag: "none" }}
        />
      </button>


      <div className="p-3">
        <div className="flex items-center justify-between">
          <div className="font-medium truncate pr-2" title={m.name}>{m.name}</div>
          <button
            className={`shrink-0 text-3xl leading-none w-9 h-9 -mr-1
                        flex items-center justify-center rounded-full
                        hover:bg-gray-100 focus:outline-none focus-visible:ring
                        ${m.favorite ? "text-yellow-500" : "text-gray-300 hover:text-gray-400"}`}
            onClick={() => updateMeta(m.id, { favorite: !m.favorite })}
            title={m.favorite ? "Unfavorite" : "Favorite"}
            aria-label={m.favorite ? "Unfavorite" : "Favorite"}
            aria-pressed={m.favorite ? "true" : "false"}
          >
            {m.favorite ? "★" : "☆"}
          </button>
        </div>

        <div className="text-xs text-gray-500 mb-2">{m.pages} page{m.pages > 1 ? "s" : ""}</div>

        {/* EDIT vs VIEW UI exactly as you already have */}
        {editMode ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <select
                className="border rounded-md px-2 py-1 text-sm w-full"
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
                className="border rounded-md px-2 py-1 text-sm w-full"
                value={m.tier || ""}
                onChange={(e) => updateMeta(m.id, { tier: e.target.value })}
              >
                <option value="">(No tier)</option>
                {TIER_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            <TagEditor value={m.tags} onChange={(tags) => updateMeta(m.id, { tags })} />

            <div className="flex items-center justify-between mt-3">
              <div className="flex gap-2">
                <button className="px-3 py-1 rounded-md border" onClick={() => openLightbox(m.id)}>
                  View
                </button>
                <button
                  className="px-3 py-1 rounded-md border"
                  onClick={() => setEditMode(false)}
                  title="Exit edit mode"
                >
                  Done
                </button>
              </div>

              <button
                className="px-3 py-1 rounded-md border text-red-600"
                onClick={() => remove(m.id)}
              >
                Delete
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 mb-2">
              <span className="inline-flex items-center rounded-full border px-2 py-1 text-xs bg-gray-50">
                {m.collection || "(None)"}
              </span>
              <span className="inline-flex items-center rounded-full border px-2 py-1 text-xs bg-gray-50">
                {m.tier || "(No tier)"}
              </span>
            </div>

            {Array.isArray(m.tags) && m.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {m.tags.map((t, i) => (
                  <span key={i} className="inline-flex items-center rounded-full bg-gray-100 border px-2 py-1 text-xs">
                    #{t}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between mt-3">
              <button className="px-3 py-1 rounded-md border" onClick={() => openLightbox(m.id)}>View</button>
              <button className="px-3 py-1 rounded-md border" onClick={() => setEditMode(true)}>Edit</button>
            </div>
          </>
        )}
      </div>
    </article>
  );


  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-40 bg-white/90 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto p-4 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">PDF Card Binder</h1>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or tag…"
            className="flex-1 min-w-[200px] border rounded-xl px-3 py-2"
          />
          <select
            className="border rounded-xl px-3 py-2"
            value={activeCollection}
            onChange={(e) => setActiveCollection(e.target.value)}
          >
            <option value="">All collections</option>
            {allCollections.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select
            className="border rounded-xl px-3 py-2"
            value={activeTier}
            onChange={(e) => setActiveTier(e.target.value)}
          >
            <option value="">All tiers</option>
            {TIER_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {/* Sort control goes here */}
          <select
            className="border rounded-xl px-3 py-2"
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
            className={`px-3 py-2 rounded-xl border cursor-pointer ${
              favoritesOnly ? "bg-yellow-50 border-yellow-300" : ""
            }`}
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
            className={`px-3 py-2 rounded-xl border cursor-pointer ${
              editMode ? "bg-blue-50 border-blue-300" : ""
            }`}
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
            className={`px-3 py-2 rounded-xl border cursor-pointer ${
              bulkMode ? "bg-purple-50 border-purple-300" : ""
            }`}
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
          
          <label
            className={`px-3 py-2 rounded-xl border cursor-pointer ${reorderMode ? "bg-amber-50 border-amber-300" : ""} ${sortMode !== "none" ? "opacity-50 cursor-not-allowed" : ""}`}
            title="Drag cards to reorder within each collection (only in Default order view)"
          >
            <input
              type="checkbox"
              className="mr-2"
              checked={reorderMode}
              disabled={sortMode !== "none"}
              onChange={(e) => setReorderMode(e.target.checked)}
            />
            Reorder
          </label>


          <button className="px-3 py-2 rounded-xl border" onClick={exportJson}>Export</button>

          {/* New: explicit PDF adder button */}
          <label className="px-3 py-2 rounded-xl border cursor-pointer">
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

          {/* Restore from JSON backup (formerly "Import") */}
          <label className="px-3 py-2 rounded-xl border cursor-pointer">
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
            className="px-3 py-2 rounded-xl border"
            onClick={() => setCollectionsOpen(true)}
          >
            Manage
          </button>
          {bulkMode && (
            <div className="w-full mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm">
                Selected: {selectedIds.size} / {visibleList.length}
              </span>
              <button className="px-2 py-1 border rounded" onClick={selectAllVisible}>
                Select all visible
              </button>
              <button className="px-2 py-1 border rounded" onClick={clearSelection}>
                Clear selection
              </button>

              {/* Bulk Collection */}
              <select
                className="border rounded-xl px-3 py-2"
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
                className="border rounded-xl px-3 py-2"
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
                className="border rounded-xl px-3 py-2"
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
          <div className="rounded-xl border bg-white px-4 py-2 text-sm">
            Importing {importingCount} file{importingCount > 1 ? "s" : ""}…
          </div>
        </div>
      )}
      {lastError && (
        <div className="max-w-6xl mx-auto mt-3 px-4">
          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">
            {lastError}
          </div>
        </div>
      )}


      <main className="max-w-6xl mx-auto p-4">
        <DropZone onFiles={importFiles} />

        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-sm text-gray-600 mr-2">Tags:</span>
            <Tag label="All" active={!activeTag} onClick={() => setActiveTag("")} />
            {allTags.map((t) => (
              <Tag key={t} label={t} active={activeTag === t} onClick={() => setActiveTag(t)} />
            ))}
          </div>

          {loading ? (
            <div className="text-gray-500">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-gray-500">No cards yet. Import PDFs above.</div>
          ) : sortMode !== "none" ? (
            // FLAT VIEW WHEN SORTING
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {sortedFlat.map(renderCard)}
            </div>
          ) : (
            // FOLDERS (GROUPED BY COLLECTION) WHEN sortMode === "none"
            <div className="space-y-8">
              {groupedByCollection.map(([name, items]) => (
                <section key={name} className="border rounded-2xl overflow-hidden">
                  <div className="px-4 py-2 bg-gray-50 border-b flex items-center justify-between">
                    <h2 className="font-semibold">{name}</h2>
                    <span className="text-xs text-gray-500">
                      {items.length} item{items.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <div className="p-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {orderItemsInGroup(name, items).map(renderCard)}
                  </div>

                </section>
              ))}
            </div>
          )}

        </div>
      </main>

      <Lightbox
        open={lightbox.open}
        onClose={() => setLightbox({ open: false, id: "" })}
        fileBytes={lightboxBytes}
        name={metas.find((m) => m.id === lightbox.id)?.name || ""}
      />

      <CollectionsManager
        open={collectionsOpen}
        onClose={() => setCollectionsOpen(false)}
        defaults={DEFAULT_COLLECTIONS}
        custom={customCollections}
        onDelete={deleteCustomCollection}
      />

    </div>
  );
}

function CollectionsManager({ open, onClose, defaults, custom, onDelete }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">Manage Collections</div>
          <button className="px-3 py-1 rounded-md border" onClick={onClose}>Close</button>
        </div>

        <div className="mb-4">
          <div className="text-xs font-semibold text-gray-600 mb-1">Default (built-in)</div>
          <div className="space-y-1">
            {DEFAULT_COLLECTIONS.map(c => (
              <div key={c} className="flex items-center justify-between text-sm">
                <span>{c}</span>
                <span className="text-gray-400">(locked)</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-gray-600 mb-1">Custom</div>
          {custom.length === 0 ? (
            <div className="text-sm text-gray-500">No custom collections yet.</div>
          ) : (
            <div className="space-y-1">
              {custom.map(c => (
                <div key={c} className="flex items-center justify-between text-sm">
                  <span>{c}</span>
                  <button
                    className="px-2 py-1 rounded-md border text-red-600"
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


function TagEditor({ value, onChange }) {
  const [text, setText] = useState("");
  const tags = value || [];

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
          <span key={i} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-gray-100 text-sm">
            #{t}
            <button className="text-gray-500 hover:text-black" onClick={() => removeTag(i)} aria-label={`remove ${t}`}>×</button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          className="border rounded-md px-2 py-1 text-sm w-full"
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
        <button className="px-3 py-1 rounded-md border" onClick={() => addTag(text)}>Add</button>
      </div>
    </div>
  );
}


