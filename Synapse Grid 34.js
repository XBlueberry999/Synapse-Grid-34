/*
Synapse Grid 34
No project-wide license has been designated. No claim of authorship or ownership
of the entire codebase is made here. Third-party notices remain applicable.
See README.md and THIRD_PARTY_NOTICES.md.
*/
/* 
 * QR Code generator library (TypeScript)
 * 
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */
// QR attribution retained conservatively; see LICENSE_AUDIT.md.
// ============================================================
// SYNAPSE GRID 34 — V39 (SPRINT 4: CMS & MEDIA + FULL BUG-FIX PASS)
// Base: V38 (Sprint 1-3). Runs on: Cloudflare Worker (KV / D1 + R2) and Node.js (file / disk).
// Sprint 4 : image thumbnails, strict Markdown, Notes, Custom Pages (/p/:slug SSR),
//            image upload (R2 / disk), navigation header, sitemap.xml + SEO meta.
// Also     : security + logic fixes across storage, auth, ping, backup, UI (see CHANGELOG).
// ============================================================

const APP_VERSION = "V40.1";
const DEFAULT_USER = "admin";
const DEFAULT_PASS = "admin123";
const SESSION_TTL = 86400;
const ITEMS_PER_PAGE = 100;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 60;
const PING_CACHE_TTL = 60;
const API_RATE_LIMIT_MAX = 60;
const API_RATE_LIMIT_WINDOW = 60;

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const UPLOAD_QUOTA_BYTES = 100 * 1024 * 1024;
const MAX_BODY_JSON_BYTES = 12 * 1024 * 1024;
const MAX_NOTES_CHARS = 100000;
const MAX_PAGE_CHARS = 100000;
const MAX_PAGES = 200;
const MAX_ITEMS = 5000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const UPLOAD_NAME_RE = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/i;

// Worker event listeners — wrapped so Node.js doesn't crash
if (typeof addEventListener === "function" && typeof self !== "undefined") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request, self, event));
  });
  addEventListener("scheduled", (event) => {
    event.waitUntil(Promise.all([handleScheduledUptime(event,self),
      event.cron === "*/5 * * * *" ? Promise.resolve() : handleScheduledBackup(event,self)]));
  });
}

// ============================================================
// STORAGE ADAPTERS (KV, D1, File)
// ============================================================
function createKVStore(rawKV) {
  return {
    kind: "kv",
    // A value that is not valid JSON (e.g. hand-edited in the dashboard) must read as "missing", not crash the request.
    get: async (key, opts) => {
      try { return await rawKV.get(key, opts); }
      catch (e) {
        if (e && (e.name === "SyntaxError" || /not valid JSON|JSON/i.test(String(e.message || "")))) { console.error("[KV] unreadable JSON ignored for key:", key); return null; }
        throw e;
      }
    },
    // Workers KV rejects expirationTtl < 60, so clamp instead of failing the write.
    put: (key, val, opts) => {
      const o = Object.assign({}, opts || {});
      if (o.expirationTtl) o.expirationTtl = Math.max(60, Math.floor(o.expirationTtl));
      return rawKV.put(key, val, o);
    },
    delete: (key) => rawKV.delete(key),
    list: (opts) => rawKV.list(opts),
    purgeExpired: async () => 0
  };
}

let _d1SchemaReady = false;
async function ensureD1Schema(db) {
  if (_d1SchemaReady) return;
  try {
    await db.prepare("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, exp INTEGER DEFAULT 0)").run();
    _d1SchemaReady = true;
  } catch (e) {
    console.error("[D1] Schema init failed:", e);
  }
}

function createD1Store(db) {
  return {
    kind: "d1",
    async get(key, opts) {
      await ensureD1Schema(db);
      const row = await db.prepare("SELECT value, exp FROM kv WHERE key = ?").bind(key).first();
      if (!row) return null;
      if (row.exp > 0 && row.exp < Date.now()) {
        await db.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
        return null;
      }
      if (opts && opts.type === "json") {
        try { return JSON.parse(row.value); } catch (e) { return null; }
      }
      return row.value;
    },
    async put(key, val, opts) {
      await ensureD1Schema(db);
      const exp = opts && opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0;
      await db.prepare("INSERT OR REPLACE INTO kv (key, value, exp) VALUES (?, ?, ?)").bind(key, String(val), exp).run();
    },
    async delete(key) {
      await ensureD1Schema(db);
      await db.prepare("DELETE FROM kv WHERE key = ?").bind(key).run();
    },
    async list(opts) {
      await ensureD1Schema(db);
      const prefix = (opts && opts.prefix) || "";
      const limit = Math.max(1, Math.min(1000, (opts && opts.limit) || 1000));
      // Escape LIKE wildcards: "_" in "ping_cache:" must match literally, not "any char".
      const like = prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
      const res = await db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND (exp = 0 OR exp > ?) ORDER BY key LIMIT ?")
        .bind(like, Date.now(), limit).all();
      return { keys: (res.results || []).map(r => ({ name: r.key })), list_complete: true };
    },
    async purgeExpired() {
      await ensureD1Schema(db);
      const r = await db.prepare("DELETE FROM kv WHERE exp > 0 AND exp < ?").bind(Date.now()).run();
      return (r && r.meta && r.meta.changes) || 0;
    }
  };
}

function createFileStore(baseDir) {
  const fs = require("fs");
  const path = require("path");
  const nodeCrypto = require("crypto");
  fs.mkdirSync(baseDir, { recursive: true });

  // Reversible, collision-free file naming. (V38 replaced every non-alphanumeric char with "_",
  // which made "a:b" and "a_b" collide and made list() return corrupted key names.)
  const encode = (key) => encodeURIComponent(key).replace(/\*/g, "%2A");
  const fileFor = (key) => {
    const e = encode(key);
    const name = e.length > 180 ? "@h-" + nodeCrypto.createHash("sha256").update(key).digest("hex") : e;
    return path.join(baseDir, name + ".json");
  };
  const legacyFor = (key) => path.join(baseDir, key.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json");

  function readEntry(fp) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (parsed && parsed.exp && parsed.exp < Date.now()) { try { fs.unlinkSync(fp); } catch (e) {} return null; }
      return parsed;
    } catch (e) { return null; }
  }
  function writeAtomic(fp, content) {
    const tmp = fp + ".tmp-" + process.pid + "-" + nodeCrypto.randomBytes(4).toString("hex");
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, fp);
  }

  return {
    kind: "file",
    async get(key, opts) {
      let fp = fileFor(key);
      let entry = fs.existsSync(fp) ? readEntry(fp) : null;
      if (!entry) {
        // One-time migration of V38 files (legacy naming).
        const lp = legacyFor(key);
        if (lp !== fp && fs.existsSync(lp)) {
          entry = readEntry(lp);
          if (entry) {
            try { writeAtomic(fp, JSON.stringify({ k: key, value: entry.value, exp: entry.exp || 0 })); fs.unlinkSync(lp); } catch (e) {}
          }
        }
      }
      if (!entry) return null;
      if (opts && opts.type === "json") {
        try { return JSON.parse(entry.value); } catch (e) { return null; }
      }
      return entry.value;
    },
    async put(key, val, opts) {
      const exp = opts && opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0;
      writeAtomic(fileFor(key), JSON.stringify({ k: key, value: String(val), exp }));
    },
    async delete(key) {
      try { fs.unlinkSync(fileFor(key)); } catch (e) {}
    },
    async list(opts) {
      const prefix = (opts && opts.prefix) || "";
      const limit = Math.max(1, Math.min(1000, (opts && opts.limit) || 1000));
      const names = [];
      for (const f of fs.readdirSync(baseDir)) {
        if (!f.endsWith(".json")) continue;
        const stem = f.slice(0, -5);
        let key = null;
        if (stem.startsWith("@h-")) {
          const e = readEntry(path.join(baseDir, f));
          key = e && e.k;
        } else {
          try { key = decodeURIComponent(stem); } catch (e) { key = null; }
        }
        if (key && key.startsWith(prefix)) names.push({ name: key });
        if (names.length >= limit) break;
      }
      return { keys: names, list_complete: true };
    },
    async purgeExpired() {
      let n = 0;
      for (const f of fs.readdirSync(baseDir)) {
        if (!f.endsWith(".json")) continue;
        const fp = path.join(baseDir, f);
        try {
          const p = JSON.parse(fs.readFileSync(fp, "utf8"));
          if (p && p.exp && p.exp < Date.now()) { fs.unlinkSync(fp); n++; }
        } catch (e) {}
      }
      return n;
    }
  };
}

// Never touch `process` at load time: on Cloudflare even reading it during script validation can throw
// "internal error" and the deploy is rejected. Always call this lazily, inside a request.
function isNodeRuntime() {
  try { return typeof process !== "undefined" && !!(process.versions && process.versions.node) && typeof require === "function"; }
  catch (e) { return false; }
}

// Looks up a Cloudflare binding by name without ever throwing.
function safeBinding(name, env) {
  try { if (typeof globalThis !== "undefined" && globalThis[name]) return globalThis[name]; } catch (e) {}
  try { if (env && env[name]) return env[name]; } catch (e) {}
  return null;
}

function createStore(env) {
  const d1 = safeBinding("DB", env);
  if (d1 && typeof d1.prepare === "function") return createD1Store(d1);

  const kv = safeBinding("SERVER_KV", env);
  if (kv && typeof kv.get === "function") return createKVStore(kv);

  if (isNodeRuntime()) {
    try {
      return createFileStore((env && env.DATA_DIR) || process.env.DATA_DIR || "./.data");
    } catch (e) {
      console.error("[Storage] File store unavailable:", e);
    }
  }
  return null;
}

// ============================================================
// BLOB STORE (uploaded images): R2 on Cloudflare, disk on Node
// ============================================================
function createBlobStore(env) {
  // Reading a misconfigured binding (e.g. an R2 binding while R2 is not enabled on the account) throws
  // "internal error" on Cloudflare, so every binding lookup is guarded and simply means "not available".
  const bucket = safeBinding("MEDIA_BUCKET", env) || safeBinding("BACKUP_BUCKET", env);
  if (bucket && typeof bucket.put === "function" && typeof bucket.get === "function") {
    return {
      kind: "r2",
      async put(name, bytes, type) { await bucket.put("uploads/" + name, bytes, { httpMetadata: { contentType: type } }); },
      async get(name) {
        const o = await bucket.get("uploads/" + name);
        if (!o) return null;
        return { body: o.body, size: o.size, type: (o.httpMetadata && o.httpMetadata.contentType) || null };
      },
      async delete(name) { await bucket.delete("uploads/" + name); }
    };
  }
  if (isNodeRuntime()) {
    try {
      const fs = require("fs");
      const path = require("path");
      const dir = (env && env.UPLOAD_DIR) || process.env.UPLOAD_DIR || (((env && env.DATA_DIR) || process.env.DATA_DIR || "./.data") + "/uploads");
      fs.mkdirSync(dir, { recursive: true });
      const fp = (name) => path.join(dir, name);
      return {
        kind: "disk",
        async put(name, bytes) {
          const tmp = fp(name) + ".tmp";
          fs.writeFileSync(tmp, Buffer.from(bytes));
          fs.renameSync(tmp, fp(name));
        },
        async get(name) {
          try {
            const buf = fs.readFileSync(fp(name));
            return { body: buf, size: buf.length, type: null };
          } catch (e) { return null; }
        },
        async delete(name) { try { fs.unlinkSync(fp(name)); } catch (e) {} }
      };
    } catch (e) { console.error("[Blob] disk store unavailable:", e); }
  }
  return null;
}

const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// Identify the real image type from magic bytes. The client-declared Content-Type is never trusted
// and SVG is deliberately NOT accepted (it can carry scripts).
function sniffImageType(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return "png";
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ============================================================
// UTILITIES
// ============================================================
function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};

function jsonResp(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, BASE_SECURITY_HEADERS, extra)
  });
}

// Constant-time string comparison (hashes first so length differences leak nothing).
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(a))));
  const hb = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(b))));
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// Parse a JSON request body; returns null on malformed input instead of throwing (V38 crashed with a 500).
async function readJson(request) {
  try {
    const len = parseInt(request.headers.get("content-length") || "0", 10);
    if (len > MAX_BODY_JSON_BYTES) return null;
    if (!request.body) return null;
    const reader = request.body.getReader();
    let size = 0, text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_JSON_BYTES) { try { await reader.cancel(); } catch (e) {} return null; }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const data = JSON.parse(text);
    return data && typeof data === "object" ? data : null;
  } catch (e) { return null; }
}

// Fire-and-forget work that must still finish after the response was sent (Workers cancels bare promises).
function runBackground(ctx, promise) {
  const p = Promise.resolve(promise).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  return p;
}

function getOrigin(request, url) {
  const xfProto = (request.headers.get("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
  const proto = xfProto === "http" || xfProto === "https" ? xfProto : url.protocol.replace(":", "");
  const host = (request.headers.get("x-forwarded-host") || "").split(",")[0].trim() || url.host;
  return proto + "://" + host.replace(/[^a-zA-Z0-9.:\[\]-]/g, "");
}

// Markdown links in announcements. Written as one self-contained function so the very same source
// is injected into the browser (no server/client drift). V38 double-escaped "&" in URLs ("&amp;amp;").
function parseMarkdownLinks(text) {
  function e(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function unesc(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  if (!text) return "";
  var escaped = e(text);
  return escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (match, label, escUrl) {
    var url = unesc(escUrl);
    if (!/^https?:\/\/[^\s"'<>\\]+$/i.test(url)) return match;
    var displayLabel = label;
    if (label.length > 40 && label.indexOf('http') === 0) displayLabel = label.substring(0, 35) + '...';
    return '<a href="' + e(url) + '" target="_blank" rel="noopener noreferrer" style="color:var(--border-cyan); text-decoration:underline; font-weight:700; word-break:break-all; display:inline-block;" title="' + e(url) + '">' + displayLabel + '</a>';
  });
}

// ---------- INPUT VALIDATION / NORMALISATION ----------
function str(v, max) {
  return String(v === undefined || v === null ? "" : v).trim().substring(0, max);
}

// Returns "" (no host), a clean lowercase hostname, or null when invalid.
function sanitizeHost(raw) {
  if (raw === undefined || raw === null) return "";
  let h = String(raw).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[\/?#].*$/, "").replace(/\.$/, "");
  if (!h) return "";
  if (!HOST_RE.test(h)) return null;
  if (/\.(local|localhost|internal|lan|home|corp|intranet)$/i.test(h)) return null;
  return h;
}

// Returns "" (empty), a valid absolute http(s) URL string, or null when invalid.
function normalizeHttpUrl(raw) {
  let u = str(raw, 500);
  if (!u) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && HOST_RE.test(u.replace(/[\/?#].*$/, ""))) u = "https://" + u;
  if (/[\s"'<>\\\u0000-\u001f]/.test(u)) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== "http:" && p.protocol !== "https:") return null;
    if (!p.hostname) return null;
    return u;
  } catch (e) { return null; }
}

// Image URL: absolute http(s) or an uploaded local file (/uploads/<hex>.<ext>).
function normalizeImageUrl(raw) {
  let u = str(raw, 500);
  if (!u) return "";
  if (u.startsWith("/uploads/")) return UPLOAD_NAME_RE.test(u.slice(9)) ? u : null;
  // Giphy share pages are HTML, not images: map them to the direct animated GIF.
  const gp = /^https?:\/\/(?:www\.)?giphy\.com\/(?:gifs|stickers|clips|embed)\/(?:[^\/?#]*-)?([A-Za-z0-9]{6,32})\/?(?:[?#].*)?$/i.exec(u);
  if (gp) return "https://media.giphy.com/media/" + gp[1] + "/giphy.gif";
  // Spaces and apostrophes are common in copied GIF links: encode instead of rejecting.
  u = u.replace(/ /g, "%20").replace(/'/g, "%27");
  const v = normalizeHttpUrl(u);
  if (v === null) return null;
  return /^https?:\/\//i.test(v) ? v : null;
}

function normalizeCustomFields(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 5)
    .map(cf => ({ label: str(cf && cf.label, 80), value: str(cf && cf.value, 500) }))
    .filter(cf => cf.label && cf.value);
}

const ITEM_ERRORS = {
  name:  { id: "Nama wajib diisi!", en: "Name is required!" },
  host:  { id: "Host tidak valid. Gunakan format domain, contoh: example.com", en: "Invalid host. Use a domain name, e.g. example.com" },
  link:  { id: "Custom URL harus berawalan http:// atau https://", en: "Custom URL must start with http:// or https://" },
  image: { id: "URL gambar/GIF tidak valid. Pakai link langsung ke file (https://.../x.gif atau .png/.jpg/.webp) atau hasil upload. Halaman Tenor tidak bisa dipakai: klik kanan GIF lalu salin alamat gambar.", en: "Invalid image/GIF URL. Use a direct link to the file (https://.../x.gif, .png, .jpg, .webp) or an upload. Tenor page links do not work: right-click the GIF and copy the image address." }
};
function itemError(code, lang) {
  const e = ITEM_ERRORS[code] || ITEM_ERRORS.name;
  return lang === "en" ? e.en : e.id;
}

// Single source of truth for building an item from untrusted input (add / edit / restore).
// lenient=true (restore): invalid optional fields are dropped instead of rejecting the whole item.
function buildItem(data, existing, lenient) {
  const d = data || {};
  const base = existing || {};
  const name = str(d.name || (lenient ? d.host : ""), 200) || (lenient ? "Item" : "");
  if (!name) return { error: "name" };
  let host = sanitizeHost(d.host);
  let customLink = normalizeHttpUrl(d.customLink);
  let imageUrl = normalizeImageUrl(d.imageUrl);
  let dropped = 0;
  if (host === null) { if (!lenient) return { error: "host" }; host = ""; dropped++; }
  if (customLink === null) { if (!lenient) return { error: "link" }; customLink = ""; dropped++; }
  if (imageUrl === null) { if (!lenient) return { error: "image" }; imageUrl = ""; dropped++; }
  let id = base.id;
  if (!id) id = (typeof d.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(d.id) && lenient) ? d.id : crypto.randomUUID();
  const created = Number(d.createdAt);
  const item = {
    id, name,
    category: str(d.category, 80) || base.category || "General",
    groupType: str(d.groupType, 80) || base.groupType || "Independen",
    description: str(d.description, 2000),
    host, customLink, imageUrl,
    enablePing: d.enablePing !== undefined ? !!d.enablePing : (base.enablePing !== undefined ? base.enablePing : true),
    useHostAsDisplay: !!d.useHostAsDisplay,
    clickCopyMode: !!d.clickCopyMode,
    isPublic: d.isPublic !== undefined ? !!d.isPublic : (base.isPublic !== undefined ? base.isPublic : true),
    mode: ["normal", "blur", "maintenance"].includes(d.mode) ? d.mode : (base.mode || "normal"),
    isPinned: d.isPinned !== undefined ? !!d.isPinned : !!base.isPinned,
    createdAt: base.createdAt || (Number.isFinite(created) && created > 0 ? created : Date.now()),
    customFields: normalizeCustomFields(d.customFields)
  };
  return { item, dropped };
}

// Remove ping selections whose host no longer exists on any item.
function pruneSelection(settings, servers) {
  const hosts = new Set(servers.map(s => s.host).filter(Boolean));
  settings.pingSelection = (settings.pingSelection || []).filter(h => hosts.has(h));
}

// What a non-admin visitor is allowed to receive. Restricted (blur/maintenance) items are redacted on
// the server — V38 only hid them visually, so the full data was still present in page source / API.
function publicItemView(s, publicCols) {
  const hiddenFields = (publicCols && publicCols.customFields) || {};
  if (s.mode === "blur" || s.mode === "maintenance") {
    return {
      id: s.id, name: s.name, category: s.category, groupType: s.groupType, mode: s.mode,
      isPublic: true, isPinned: !!s.isPinned, createdAt: s.createdAt,
      host: "", description: "", customLink: "", imageUrl: "", customFields: [],
      enablePing: false, useHostAsDisplay: false, clickCopyMode: false
    };
  }
  return Object.assign({}, s, {
    customFields: (Array.isArray(s.customFields) ? s.customFields : []).filter(cf => hiddenFields[cf.label] !== false)
  });
}

function viewServersFor(isAdmin, servers, settings) {
  if (isAdmin) return servers;
  return servers.filter(s => s.isPublic !== false).map(s => publicItemView(s, settings.publicColumns));
}

// ---------- WEBHOOK URL SAFETY (blocks SSRF to internal addresses) ----------
function normalizeWebhookUrl(raw) {
  const u = str(raw, 500);
  if (!u) return "";
  try {
    const p = new URL(u);
    if (p.protocol !== "https:") return null;
    const h = p.hostname.toLowerCase();
    if (h === "localhost" || /\.(local|localhost|internal|lan)$/.test(h)) return null;
    if (/^\[/.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;
    return u;
  } catch (e) { return null; }
}

// Backup notifications use the same DNS guard and bounded request lifecycle as diagnostics.
async function sendBackupWebhook(url, init) {
  const normalized = normalizeWebhookUrl(url);
  if (!normalized) throw new Error("Invalid webhook destination");
  const dest = new URL(normalized);
  if (dest.username || dest.password || await resolvesToPrivate(dest.hostname)) throw new Error("Webhook destination blocked");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await publicFetch(normalized, Object.assign({}, init, { redirect: "error", sgDiscardBody: true, signal: ctrl.signal }));
    try { if (r.body) await r.body.cancel(); } catch (e) {}
    if (!r.ok) throw new Error("Webhook HTTP " + r.status);
  } finally { clearTimeout(timer); }
}
// ---------- CMS: NOTES & PAGES ----------
function normalizePageInput(d, existing) {
  const slug = str(d && d.slug, 64).toLowerCase();
  if (!SLUG_RE.test(slug)) return { error: "slug" };
  const title = str(d.title, 200);
  if (!title) return { error: "title" };
  const content = String(d.content === undefined || d.content === null ? "" : d.content);
  const contentEn = String(d.contentEn === undefined || d.contentEn === null ? "" : d.contentEn);
  if (content.length > MAX_PAGE_CHARS || contentEn.length > MAX_PAGE_CHARS) return { error: "toolong" };
  const now = Date.now();
  return {
    page: {
      slug, title,
      titleEn: str(d.titleEn, 200),
      description: str(d.description, 300),
      descriptionEn: str(d.descriptionEn, 300),
      content, contentEn,
      isPublic: d.isPublic !== false,
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now
    }
  };
}

function pageIndexEntry(p) {
  return { slug: p.slug, title: p.title, titleEn: p.titleEn || "", isPublic: p.isPublic !== false, updatedAt: p.updatedAt || 0 };
}

async function getPagesIndex(KV) {
  const idx = await KV.get("pages_index_v1", { type: "json" });
  return Array.isArray(idx) ? idx.filter(e => e && SLUG_RE.test(e.slug)) : [];
}

async function loadCmsSnapshot(KV) {
  const nidx = await getNotesIndex(KV);
  const notes = [];
  for (const e of nidx) {
    const n = await KV.get("note:v1:" + e.id, { type: "json" });
    if (n) notes.push(n);
  }
  const idx = await getPagesIndex(KV);
  const pages = [];
  for (const e of idx) {
    const p = await KV.get("page:v1:" + e.slug, { type: "json" });
    if (p) pages.push(p);
  }
  return { notes, pages };
}

// ---------- SETTINGS BACKUP / RESTORE ----------
// Secrets (admin password, Turnstile secret, session version) never leave the system in a backup file,
// and a restore can never overwrite them (V38 exported the plaintext admin password in every backup).
function sanitizeSettingsForBackup(settings) {
  const keys = ["siteTitle", "announcementNote", "displayMode", "activeSort", "pingSelection", "pingRule34Active",
    "autoPingIntervalEnabled", "autoPingIntervalSeconds", "publicColumns", "webhookUrl", "turnstileSiteKey",
    "autoBackupEnabled", "autoBackupRetentionDays", "runtimeProfile", "pingCacheMode", "capabilities", "lockdownMode"];
  const out = {};
  keys.forEach(k => { if (settings[k] !== undefined) out[k] = settings[k]; });
  return out;
}

function mergeRestoredSettings(current, incoming) {
  if (!incoming || typeof incoming !== "object") return;
  if (typeof incoming.siteTitle === "string" && incoming.siteTitle.trim()) current.siteTitle = str(incoming.siteTitle, 200);
  if (typeof incoming.announcementNote === "string") current.announcementNote = incoming.announcementNote.substring(0, 10000);
  if (["list", "compact_grid", "comfortable_grid", "panorama"].includes(incoming.displayMode)) current.displayMode = incoming.displayMode;
  if (["recently", "oldest", "az", "za", "manual"].includes(incoming.activeSort)) current.activeSort = incoming.activeSort;
  if (typeof incoming.pingRule34Active === "boolean") current.pingRule34Active = incoming.pingRule34Active;
  if (typeof incoming.autoPingIntervalEnabled === "boolean") current.autoPingIntervalEnabled = incoming.autoPingIntervalEnabled;
  if (Number.isFinite(Number(incoming.autoPingIntervalSeconds))) current.autoPingIntervalSeconds = Math.max(10, Math.min(300, parseInt(incoming.autoPingIntervalSeconds) || 30));
  if (incoming.publicColumns && typeof incoming.publicColumns === "object") {
    const cf = {};
    const src = incoming.publicColumns.customFields;
    if (src && typeof src === "object") Object.keys(src).slice(0, 50).forEach(k => { cf[str(k, 80)] = src[k] !== false; });
    current.publicColumns = { showCustomLink: incoming.publicColumns.showCustomLink !== false, customFields: cf };
  }
  const wh = normalizeWebhookUrl(incoming.webhookUrl);
  if (wh !== null && incoming.webhookUrl !== undefined) current.webhookUrl = wh;
  if (typeof incoming.turnstileSiteKey === "string" && !incoming.turnstileSiteKey) current.turnstileSiteKey = "";
  if (typeof incoming.autoBackupEnabled === "boolean") current.autoBackupEnabled = incoming.autoBackupEnabled;
  if (Number.isFinite(Number(incoming.autoBackupRetentionDays))) current.autoBackupRetentionDays = Math.max(1, Math.min(365, parseInt(incoming.autoBackupRetentionDays) || 30));
  if (incoming.capabilities && typeof incoming.capabilities === "object") {
    current.capabilities = {
      ping: incoming.capabilities.ping !== false, archive: incoming.capabilities.archive !== false,
      cms: incoming.capabilities.cms === true, api: incoming.capabilities.api === true
    };
  }
  if (Array.isArray(incoming.pingSelection)) current.pingSelection = incoming.pingSelection.slice(0, 100).map(h => String(h).substring(0, 253));
}

// ---------- SESSIONS ----------
async function createSession(KV, user, version) {
  const token = randomHex(32);
  try {
    await KV.put('session:' + token, JSON.stringify({ user, expires: Date.now() + SESSION_TTL * 1000, v: version }), { expirationTtl: SESSION_TTL });
    return token;
  } catch (e) { return null; }
}

async function validateSession(KV, token, version) {
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return null;
  try {
    const data = await KV.get('session:' + token, { type: 'json' });
    if (data && data.expires > Date.now() && data.v === version) return data.user;
  } catch (e) {}
  return null;
}

async function destroySession(KV, token) {
  if (!token) return;
  try { await KV.delete('session:' + token); } catch (e) {}
}

function cookieAttrs(isHttps) {
  return "Path=/; HttpOnly; SameSite=Strict" + (isHttps ? "; Secure" : "");
}


async function verifyTurnstile(secretKey, token, ip) {
  if (!secretKey || !token) return false;
  try {
    const body = new URLSearchParams();
    body.append('secret', secretKey);
    body.append('response', token);
    if (ip && ip !== 'unknown') body.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body
    });
    const data = await res.json();
    return !!data.success;
  } catch (e) {
    console.error("[Turnstile] Verify error:", e);
    return false;
  }
}


function formatCustomDateTime(timestamp, locale) {
  if (!timestamp) return "-";
  const d = new Date(timestamp);
  const day = d.getDate();
  const monthsIndo = ["jan","feb","mar","apr","mei","jun","jul","agu","sep","okt","nov","des"];
  const monthsEng = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const mIndex = d.getMonth();
  const monthStr = locale === 'en' ? monthsEng[mIndex] : monthsIndo[mIndex];
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${monthStr} ${year}, ${hours}:${minutes}`;
}


// Demo additions: explicit local form fill; never submits, changes access rules or fabricates live results.
const DEMO_TOOL_INPUTS34 = {"cidr": {"cidrIn": "192.168.1.10/24", "cidrMemIn": "192.168.1.77"}, "epoch": {"epIn": "1700000000"}, "json": {"jsIn": "{\"demo\":true,\"nodes\":[\"cloudflare.com\",\"github.com\"],\"count\":2}"}, "cron": {"crIn": "*/15 * * * *"}, "regex": {"reP": "(\\d+)-(?<word>[a-z]+)", "reF": "g", "reT": "12-demo 34-synapse", "reR": "$<word>:$1"}, "curl": {"cuU": "https://example.com/api", "cuH": "Accept: application/json"}, "ssh-config": {"scH": "server.example.com", "scU": "demo", "scP": "22", "scI": "~/.ssh/id_ed25519"}, "tunnel": {"tnH": "server.example.com", "tnU": "demo", "tnP": "22"}, "export": {"exIn": "{\"servers\": [{\"name\": \"DEMO Node\", \"host\": \"cloudflare.com\", \"isPublic\": true, \"description\": \"Example only\"}], \"notes\": [], \"pages\": []}"}, "converter": {"cvIn": "Synapse Grid 34 — DEMO"}, "keygen": {"kgSize": "32"}, "modern": {"mtIn": "{\"name\": \"DEMO TLS\", \"protocol\": \"vless\", \"server\": \"server.example.com\", \"port\": 443, \"uuid\": \"00000000-0000-4000-8000-000000000001\", \"security\": \"tls\", \"serverName\": \"server.example.com\"}"}, "netdiag": {"ndHost": "cloudflare.com", "ndHdrHost": "cloudflare.com"}, "paste": {"psIn": "DEMO ONLY / CONTOH SAJA — bukan rahasia asli."}, "vault": {"vTitle": "DEMO — Hello World", "vText": "console.log(\"Synapse Grid demo\");"}, "access": {"acDays": "1"}, "uptime": {"uh": "cloudflare.com, github.com"}, "tcp": {"th": "cloudflare.com", "tp": "443"}, "provision": {"pvScript": "#!/bin/sh\n# DEMO ONLY — inspect before use\nprintf \"%s\\n\" \"Synapse Grid demo\"\n"}, "gateway": {"gwConfig": "{\n  \"enabled\": false,\n  \"secret\": \"DEMO_ONLY_REPLACE_BEFORE_USE_34\",\n  \"targets\": [],\n  \"template\": \"[DEMO] {{source}}: {{event}}\\n{{summary}}\"\n}"}};
function demoToolInit34(values, en) {
 const button=document.getElementById('demoFill34');
 if(!button)return;
 button.addEventListener('click',function(){
  if(!window.confirm(en?'Fill example inputs? Current form values listed in this example will be replaced. Nothing is saved or sent.':'Isi contoh? Nilai formulir yang dicakup contoh akan diganti. Tidak ada yang disimpan atau dikirim.'))return;
  Object.keys(values).forEach(function(id){const el=document.getElementById(id);if(el&&!el.readOnly)el.value=values[id];});
  document.getElementById('demoStatus34').textContent=en?'DEMO inputs loaded. Review, then use the existing action buttons. No action was run.':'Input DEMO dimuat. Periksa, lalu gunakan tombol aksi yang sudah ada. Belum ada aksi dijalankan.';
 });
}
function renderDemoTool34(id,lang){
 const en=lang==='en';
 return '<section class="fld"><button type="button" class="btn ghost" id="demoFill34">'+(en?'✨ Fill demo inputs':'✨ Isi input demo')+'</button><p id="demoStatus34">'+(en?'Examples only; not live results. Saving, sending, probing and key generation remain manual. Existing examples remain available.':'Contoh saja; bukan hasil live. Simpan, kirim, probe dan pembuatan kunci tetap manual. Contoh lama tetap tersedia.')+'</p></section>';
}
async function seedDemoCms34(KV) {
 const now=Date.now(); const result={notes:0,pages:0};
 // Read directly: avoid the legacy migration helper doing two index writes in one request.
 let notes=await KV.get('notes_index_v1',{type:'json'});
 const legacy=await KV.get('notes:v1',{type:'json'});
 if((!notes||(Array.isArray(notes)&&notes.length===0))&&!legacy){
  const n={id:'de0034000001',title:'DEMO — Catatan / Notes',text:'# DEMO / Example only\n\n**Markdown**, _italic_, `code`, and lists.\n\n- Edit / ubah\n- Export MD / TXT\n\nNo real secrets / Tidak ada rahasia asli.',updatedAt:now};
  if(!await KV.get('note:v1:'+n.id)){await KV.put('note:v1:'+n.id,JSON.stringify(n));await KV.put('notes_index_v1',JSON.stringify([noteIndexEntry(n)]));result.notes++;}
 }
 const idx=await getPagesIndex(KV);let changed=false;
 for(const pub of [true,false]){
  const slug=pub?'demo-synapse-public':'demo-synapse-private';
  if(idx.length>=MAX_PAGES||idx.some(x=>x.slug===slug)||await KV.get('page:v1:'+slug))continue;
  const page=normalizePageInput({slug,title:'DEMO — '+(pub?'Halaman publik':'Halaman privat'),titleEn:'DEMO — '+(pub?'Public page':'Private page'),description:'Data contoh, bukan data produksi.',descriptionEn:'Example data, not production data.',isPublic:pub,content:'# Contoh Markdown\n\n**Tebal**, _miring_, `kode`.\n\n- Contoh daftar\n- Coba editor dan ekspor\n\n[Alat](/tools) · [Panduan](/guide)',contentEn:'# Markdown example\n\n**Bold**, _italic_, `code`.\n\n- Sample list\n- Try the editor and export\n\n[Tools](/tools) · [Guide](/guide)'}).page;
  await KV.put('page:v1:'+slug,JSON.stringify(page));idx.push(pageIndexEntry(page));changed=true;result.pages++;
 }
 if(changed)await KV.put('pages_index_v1',JSON.stringify(idx));
 return result;
}

function generateDemoData() {
  const now = Date.now();
  const pubHosts = [
    "cloudflare.com","wikipedia.org","github.com","mozilla.org","kernel.org",
    "debian.org","archlinux.org","getpostman.com","gnu.org","apache.org",
    "python.org","nodejs.org","rust-lang.org","golang.org","getbootstrap.com",
    "jquery.com","nginx.org","mariadb.org","postgresql.org","redis.io",
    "sqlite.org","gentoo.org","centos.org","fedora.org","ubuntu.com"
  ];
  const categoriesList = ["Database Core","Edge Worker","Storage Archive","Cyber Security","Series"];
  const groupsList = ["Group A","Group B","Group C","Independen"];
  const demo = [];
  for (let i = 0; i < 25; i++) {
    demo.push({
      id: crypto.randomUUID(),
      name: `Public Node ${String(i + 1).padStart(2,'0')}`,
      category: "Public Ping",
      groupType: i % 2 === 0 ? "Group A" : "Group B",
      description: `Node server publik aktif untuk testing uji koneksi dan latensi jaringan ke ${pubHosts[i]}.`,
      host: pubHosts[i], customLink: `https://${pubHosts[i]}`,
      enablePing: true, useHostAsDisplay: i % 3 === 0, clickCopyMode: false,
      isPublic: true, mode: "normal", isPinned: i < 2,
      createdAt: now - i * 120000,
      customFields: [{ label: "Latency", value: "~15ms" }, { label: "Protocol", value: "HTTPS/TLS" }]
    });
  }
  for (let i = 25; i < 40; i++) {
    const mode = i % 7 === 0 ? 'blur' : (i % 11 === 0 ? 'maintenance' : 'normal');
    demo.push({
      id: crypto.randomUUID(),
      name: `System Engine ${String(i + 1).padStart(2,'0')}`,
      category: categoriesList[i % categoriesList.length],
      groupType: groupsList[i % groupsList.length],
      description: `Skenario uji fungsionalitas sistem nomor #${i + 1}. Menguji stabilitas rendering, enkripsi, dan manajemen data.`,
      host: "", customLink: i % 2 === 0 ? `https://demo.example.com/item/${i + 1}` : "",
      enablePing: false, useHostAsDisplay: false, clickCopyMode: i % 5 === 0,
      isPublic: i % 4 !== 0, mode, isPinned: false,
      createdAt: now - i * 180000,
      customFields: [
        { label: "Security Level", value: i % 2 === 0 ? "Class-A" : "Restricted" },
        { label: "Storage Node", value: `Cluster-${(i % 5) + 1}` }
      ]
    });
  }
  for (let i = 40; i < 50; i++) {
    demo.push({
      id: crypto.randomUUID(),
      name: `Matrix Item ${String(i + 1).padStart(2,'0')}`,
      category: categoriesList[i % categoriesList.length],
      groupType: groupsList[i % groupsList.length],
      description: `Item demo ${i + 1} untuk pengujian fitur grid, list, dan panorama view.`,
      host: "", customLink: `https://demo.example.com/matrix/${i + 1}`,
      enablePing: false, useHostAsDisplay: false, clickCopyMode: false,
      isPublic: true, mode: "normal", isPinned: i === 42,
      createdAt: now - i * 240000,
      customFields: [{ label: "Type", value: "Demo" }]
    });
  }
  return demo;
}

function markdownToHtml(src) {
  // Strict Markdown -> HTML. Raw HTML is never passed through: every character that
  // reaches the output is either escaped or part of a whitelisted tag generated here.
  // Allowed output tags: h2-h6 p br strong em del code pre blockquote ul ol li hr a img
  var IMG_LOCAL = /^\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
  var MAX_LEN = 200000;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cleanUrl(u) {
    u = String(u);
    if (u.length > 2000 || /[\s"'<>\\\u0000-\u001f\u007f]/.test(u)) return '';
    return u;
  }
  function safeLink(u) {
    u = cleanUrl(u);
    if (!u) return '';
    if (/^https?:\/\/[^\/\s]+/i.test(u)) return u;
    if (/^\/(?!\/)[a-zA-Z0-9\/_\-.~%?=&#]*$/.test(u)) return u;
    return '';
  }
  function safeImg(u) {
    u = cleanUrl(u);
    if (!u) return '';
    if (/^https?:\/\/[^\/\s]+/i.test(u)) return u;
    if (IMG_LOCAL.test(u)) return u;
    return '';
  }

  function inline(raw) {
    var tokens = [];
    function stash(html) { tokens.push(html); return '\u0000' + (tokens.length - 1) + '\u0000'; }
    var s = String(raw).replace(/\u0000/g, '');

    s = s.replace(/`([^`\n]+)`/g, function (m, c) { return stash('<code>' + esc(c) + '</code>'); });
    s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, function (m, alt, url) {
      var u = safeImg(url);
      if (!u) return m;
      return stash('<img src="' + esc(u) + '" alt="' + esc(alt) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">');
    });
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var u = safeLink(url);
      if (!u) return m;
      var external = /^https?:/i.test(u);
      return stash('<a href="' + esc(u) + '"' + (external ? ' target="_blank" rel="noopener noreferrer nofollow"' : '') + '>' + esc(label) + '</a>');
    });

    s = esc(s);
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
         .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
         .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
         .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
         .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');

    for (var guard = 0; guard < 6 && /\u0000\d+\u0000/.test(s); guard++) {
      s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return tokens[+i] !== undefined ? tokens[+i] : ''; });
    }
    return s.replace(/\u0000/g, '');
  }

  var text = String(src === null || src === undefined ? '' : src).slice(0, MAX_LEN).replace(/\r\n?/g, '\n');
  var lines = text.split('\n');
  var out = [];
  var i = 0;

  function isBlockStart(l) {
    return /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l) ||
           /^\s*>/.test(l) || /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l);
  }

  while (i < lines.length) {
    var line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^\s*```/.test(line)) {
      var code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
      continue;
    }

    var h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      var level = Math.min(6, h[1].length + 1); // page title is the only h1
      out.push('<h' + level + '>' + inline(h[2]) + '</h' + level + '>');
      i++;
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*>/.test(line)) {
      var q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + q.map(inline).join('<br>') + '</blockquote>');
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      var ul = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { ul.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++; }
      out.push('<ul>' + ul.join('') + '</ul>');
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      var ol = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { ol.push('<li>' + inline(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; }
      out.push('<ol>' + ol.join('') + '</ol>');
      continue;
    }

    var para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && (para.length === 0 || !isBlockStart(lines[i]))) {
      para.push(inline(lines[i].replace(/\s+$/, '')));
      i++;
    }
    out.push('<p>' + para.join('<br>') + '</p>');
  }
  return out.join('\n');
}

function makeQrSvg(text) {
  // QR Code encoder: byte mode, error correction level M, versions 1-40 (auto).
  // Returns an SVG string. Throws Error('QR_TOO_LONG') when the data does not fit.
  var ECC_PER_BLOCK = [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28];
  var NUM_BLOCKS   = [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49];

  function utf8Bytes(str) {
    var out = [];
    var s = unescape(encodeURIComponent(String(str)));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }
  function rawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  var data = utf8Bytes(text);
  var ver = 1;
  for (; ; ver++) {
    if (ver > 40) throw new Error('QR_TOO_LONG');
    var ccBits = ver <= 9 ? 8 : 16;
    var needBits = 4 + ccBits + data.length * 8;
    if (needBits <= dataCodewords(ver) * 8) break;
  }

  // ---- bit buffer ----
  var bits = [];
  function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
  put(4, 4);
  put(data.length, ver <= 9 ? 8 : 16);
  for (var i = 0; i < data.length; i++) put(data[i], 8);
  var capBits = dataCodewords(ver) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - bits.length % 8) % 8);
  for (var pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);
  var dataBytes = [];
  for (var b = 0; b < bits.length; b += 8) {
    var v = 0;
    for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
    dataBytes.push(v);
  }

  // ---- Reed-Solomon ----
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 255;
  }
  function rsDivisor(deg) {
    var res = [];
    for (var i = 0; i < deg - 1; i++) res.push(0);
    res.push(1);
    var root = 1;
    for (var i2 = 0; i2 < deg; i2++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gfMul(res[j], root);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      root = gfMul(root, 2);
    }
    return res;
  }
  function rsRemainder(dat, div) {
    var res = div.map(function () { return 0; });
    dat.forEach(function (bt) {
      var factor = bt ^ res.shift();
      res.push(0);
      div.forEach(function (coef, i) { res[i] ^= gfMul(coef, factor); });
    });
    return res;
  }

  var nBlocks = NUM_BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver];
  var rawCw = Math.floor(rawModules(ver) / 8);
  var numShort = nBlocks - rawCw % nBlocks;
  var shortLen = Math.floor(rawCw / nBlocks);
  var blocks = [], div = rsDivisor(eccLen);
  for (var bi = 0, off = 0; bi < nBlocks; bi++) {
    var dlen = shortLen - eccLen + (bi < numShort ? 0 : 1);
    var dat = dataBytes.slice(off, off + dlen);
    off += dlen;
    var ecc = rsRemainder(dat, div);
    if (bi < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  var allBytes = [];
  for (var col = 0; col < blocks[0].length; col++) {
    for (var r2 = 0; r2 < blocks.length; r2++) {
      if (col !== shortLen - eccLen || r2 >= numShort) allBytes.push(blocks[r2][col]);
    }
  }

  // ---- matrix ----
  var size = ver * 4 + 17;
  var mod = [], isFn = [];
  for (var y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); isFn.push(new Array(size).fill(false)); }
  function setFn(x, y, dark) { mod[y][x] = dark; isFn[y][x] = true; }

  for (var i3 = 0; i3 < size; i3++) { setFn(6, i3, i3 % 2 === 0); setFn(i3, 6, i3 % 2 === 0); }
  function finder(cx, cy) {
    for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
      var dist = Math.max(Math.abs(dx), Math.abs(dy));
      var xx = cx + dx, yy = cy + dy;
      if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFn(xx, yy, dist !== 2 && dist !== 4);
    }
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  var alignPos = [];
  if (ver > 1) {
    var na2 = Math.floor(ver / 7) + 2;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na2 * 2 - 2)) * 2;
    alignPos = [6];
    for (var p = size - 7; alignPos.length < na2; p -= step) alignPos.splice(1, 0, p);
  }
  for (var ai = 0; ai < alignPos.length; ai++) for (var aj = 0; aj < alignPos.length; aj++) {
    if ((ai === 0 && aj === 0) || (ai === 0 && aj === alignPos.length - 1) || (ai === alignPos.length - 1 && aj === 0)) continue;
    for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) {
      setFn(alignPos[ai] + dx2, alignPos[aj] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
    }
  }

  function drawFormat(mask) {
    var d = (0 << 3) | mask; // ECC level M has format bits 00
    var rem = d;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var fb = ((d << 10) | rem) ^ 0x5412;
    function bit(i) { return ((fb >>> i) & 1) !== 0; }
    for (var i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
    for (var i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (var i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (var i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  }
  function drawVersion() {
    if (ver < 7) return;
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var vb = (ver << 12) | rem;
    for (var i = 0; i < 18; i++) {
      var bt = ((vb >>> i) & 1) !== 0;
      var a = size - 11 + i % 3, bb = Math.floor(i / 3);
      setFn(a, bb, bt); setFn(bb, a, bt);
    }
  }
  drawFormat(0);
  drawVersion();

  // place data
  var bitIdx = 0;
  for (var right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (var vert = 0; vert < size; vert++) {
      for (var j = 0; j < 2; j++) {
        var x = right - j;
        var upward = ((right + 1) & 2) === 0;
        var yy2 = upward ? size - 1 - vert : vert;
        if (!isFn[yy2][x] && bitIdx < allBytes.length * 8) {
          mod[yy2][x] = ((allBytes[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0;
          bitIdx++;
        }
      }
    }
  }

  function applyMask(mask) {
    for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
      var inv;
      switch (mask) {
        case 0: inv = (x + y) % 2 === 0; break;
        case 1: inv = y % 2 === 0; break;
        case 2: inv = x % 3 === 0; break;
        case 3: inv = (x + y) % 3 === 0; break;
        case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: inv = x * y % 2 + x * y % 3 === 0; break;
        case 6: inv = (x * y % 2 + x * y % 3) % 2 === 0; break;
        default: inv = ((x + y) % 2 + x * y % 3) % 2 === 0;
      }
      if (!isFn[y][x] && inv) mod[y][x] = !mod[y][x];
    }
  }

  function penalty() {
    var result = 0;
    function finderPenaltyCount(h) {
      var n = h[1];
      var core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    }
    function addHistory(len, h, runLen) { if (h[0] === 0) len += size; h.pop(); h.unshift(len); }
    function terminate(color, runLen, h) {
      if (color) { addHistory(runLen, h); runLen = 0; }
      runLen += size;
      addHistory(runLen, h);
      return finderPenaltyCount(h);
    }
    for (var y = 0; y < size; y++) {
      var runColor = false, runX = 0, h = [0,0,0,0,0,0,0];
      for (var x = 0; x < size; x++) {
        if (mod[y][x] === runColor) {
          runX++;
          if (runX === 5) result += 3; else if (runX > 5) result++;
        } else {
          addHistory(runX, h);
          if (!runColor) result += finderPenaltyCount(h) * 40;
          runColor = mod[y][x]; runX = 1;
        }
      }
      result += terminate(runColor, runX, h) * 40;
    }
    for (var x2 = 0; x2 < size; x2++) {
      var runColor2 = false, runY = 0, h2 = [0,0,0,0,0,0,0];
      for (var y2 = 0; y2 < size; y2++) {
        if (mod[y2][x2] === runColor2) {
          runY++;
          if (runY === 5) result += 3; else if (runY > 5) result++;
        } else {
          addHistory(runY, h2);
          if (!runColor2) result += finderPenaltyCount(h2) * 40;
          runColor2 = mod[y2][x2]; runY = 1;
        }
      }
      result += terminate(runColor2, runY, h2) * 40;
    }
    for (var y3 = 0; y3 < size - 1; y3++) for (var x3 = 0; x3 < size - 1; x3++) {
      var c = mod[y3][x3];
      if (c === mod[y3][x3 + 1] && c === mod[y3 + 1][x3] && c === mod[y3 + 1][x3 + 1]) result += 3;
    }
    var dark = 0;
    for (var y4 = 0; y4 < size; y4++) for (var x4 = 0; x4 < size; x4++) if (mod[y4][x4]) dark++;
    var total = size * size;
    var k2 = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k2 * 10;
    return result;
  }

  var bestMask = 0, bestPen = Infinity;
  for (var m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    var pen = penalty();
    if (pen < bestPen) { bestPen = pen; bestMask = m; }
    applyMask(m); // undo
  }
  applyMask(bestMask); drawFormat(bestMask);

  var border = 4, parts = [];
  for (var yy3 = 0; yy3 < size; yy3++) for (var xx3 = 0; xx3 < size; xx3++) {
    if (mod[yy3][xx3]) parts.push('M' + (xx3 + border) + ',' + (yy3 + border) + 'h1v1h-1z');
  }
  var dim = size + border * 2;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR Code">'
    + '<rect width="100%" height="100%" fill="#ffffff"/><path d="' + parts.join('') + '" fill="#000000"/></svg>';
}

// ============================================================
// AUTO-BACKUP SCHEDULER (R2 CRON TRIGGER / NODE TIMER)
// ============================================================
async function handleScheduledBackup(event, env) {
  const KV = createStore(env);
  const R2 = safeBinding("BACKUP_BUCKET", env);
  if (!KV) { console.error("[AutoBackup] No storage backend configured"); return; }

  // Housekeeping first: expired cache / rate-limit / session rows must not pile up in D1 or on disk.
  try { if (KV.purgeExpired) await KV.purgeExpired(); } catch (e) { console.error("[Cron] purge failed:", e); }

  let settings;
  try { settings = await KV.get("sys_settings_synapse_v1", { type: "json" }); }
  catch (e) { console.error("[AutoBackup] Settings read failed:", e); return; }
  if (!settings) { console.error("[AutoBackup] Settings not initialized"); return; }
  if (settings.autoBackupEnabled === false) { console.log("[AutoBackup] Disabled by settings"); return; }

  const servers = await KV.get("servers_synapse_data_v1", { type: "json" }) || [];
  const cms = await loadCmsSnapshot(KV);
  const backup = {
    exportedAt: new Date().toISOString(),
    version: APP_VERSION + "-CRON",
    itemCount: servers.length,
    settings: sanitizeSettingsForBackup(settings),
    servers,
    notes: cms.notes,
    pages: cms.pages
  };
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `backups/synapse-backup-${dateStr}.json`;
  const payload = JSON.stringify(backup, null, 2);

  if (!R2 || typeof R2.put !== "function") {
    // Fallback for Node.js local backup
    if (KV.kind === "file") {
      try {
        const fs = require("fs");
        const dir = ((env && env.DATA_DIR) || process.env.DATA_DIR || "./.data") + "/backups";
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dir + "/synapse-backup-" + dateStr + ".json", payload);
        console.log("[AutoBackup] Written to disk:", filename);
        const retention = Math.max(1, parseInt(settings.autoBackupRetentionDays) || 30);
        const cutoff = Date.now() - retention * 86400000;
        for (const f of fs.readdirSync(dir)) {
          const fp = dir + "/" + f;
          try { if (/^synapse-backup-.*\.json$/.test(f) && fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (e) {}
        }
      } catch (e) { console.error("[AutoBackup] Disk write failed:", e); }
    } else {
      console.error("[AutoBackup] BACKUP_BUCKET (R2) binding not configured");
    }
    return;
  }

  try {
    await R2.put(filename, payload, { httpMetadata: { contentType: "application/json" } });
    console.log("[AutoBackup] Uploaded:", filename, servers.length, "items");

    const retention = Math.max(1, parseInt(settings.autoBackupRetentionDays) || 30);
    const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;
    try {
      const list = await R2.list({ prefix: "backups/" });
      for (const obj of (list.objects || [])) {
        const uploaded = obj.uploaded ? new Date(obj.uploaded).getTime() : 0;
        if (uploaded && uploaded < cutoff) {
          await R2.delete(obj.key);
          console.log("[AutoBackup] Pruned:", obj.key);
        }
      }
    } catch (e) { console.error("[AutoBackup] Prune failed:", e); }

    if (settings.webhookUrl && normalizeWebhookUrl(settings.webhookUrl)) {
      await sendBackupWebhook(settings.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `✅ **SYNAPSE AUTO-BACKUP SUCCESS**\n\`${filename}\` (${servers.length} items, ${cms.pages.length} pages, retention: ${retention}d)` })
      }).catch(() => {});
    }
  } catch (e) {
    console.error("[AutoBackup] Upload failed:", e);
    if (settings.webhookUrl && normalizeWebhookUrl(settings.webhookUrl)) {
      await sendBackupWebhook(settings.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `❌ **SYNAPSE AUTO-BACKUP FAILED**\nError: ${e.message || 'unknown'}` })
      }).catch(() => {});
    }
  }
}

// ============================================================
// SPRINT 4 — CMS: STRICT MARKDOWN, NOTES, CUSTOM PAGES, MEDIA, SEO
// ============================================================
const CMS_T = {
  id: {
    navDashboard: "Dashboard", navNotes: "Catatan", navPages: "Halaman", navTools: "Alat", langBtn: "EN",
    pagesTitle: "Halaman", noPages: "Belum ada halaman publik.", updated: "Diperbarui", privateBadge: "PRIVAT",
    editPage: "Edit halaman", notFoundTitle: "Halaman tidak ditemukan", notFoundText: "Halaman yang kamu cari tidak ada atau belum dipublikasikan.", backHome: "Kembali ke Dashboard",
    notesTitle: "Catatan Pribadi", notesHint: "Hanya terlihat oleh admin. Mendukung Markdown (tanpa HTML). Bisa membuat banyak catatan.",
    newNote: "+ Catatan Baru", noteTitleLbl: "Judul catatan", untitledNote: "Tanpa judul", noteConflict: "Catatan ini sudah diubah di tab/perangkat lain. Muat ulang halaman dulu.", saveTooFast: "Terlalu cepat. Tunggu 2 detik lalu simpan lagi (batas tulis KV).",
    managerTitle: "Kelola Halaman", newPage: "+ Halaman Baru", slugLbl: "Slug (huruf kecil, angka, strip)", titleLbl: "Judul", descLbl: "Deskripsi SEO (maks 300)",
    contentLbl: "Isi (Markdown)", publicLbl: "Publik", tabId: "Indonesia", tabEn: "English (opsional)", save: "SIMPAN", del: "HAPUS", view: "LIHAT",
    saved: "Tersimpan!", saveFailed: "Gagal menyimpan", deleted: "Halaman dihapus", confirmDelete: "Hapus halaman ini secara permanen?", unsaved: "Ada perubahan yang belum disimpan. Lanjutkan?",
    preview: "Pratinjau", uploadImg: "Unggah Gambar", media: "Media", mediaEmpty: "Belum ada gambar.", insert: "Sisipkan", close: "Tutup",
    uploadUnsupported: "Upload tidak tersedia di runtime ini. Aktifkan R2 (Cloudflare) atau jalankan di Node.js (VPS/Local).",
    uploadTooBig: "Ukuran gambar maksimal 2 MB.", uploadFailed: "Upload gagal", uploaded: "Gambar diunggah", usage: "Terpakai", noSlug: "Slug wajib diisi", empty: "Belum ada halaman. Klik “Halaman Baru”.",
    badSlug: "Slug tidak valid. Gunakan huruf kecil, angka, dan strip (2-64 karakter).", linkImg: "URL gambar:", linkUrl: "URL tautan:", draft: "Draf (privat)"
  },
  en: {
    navDashboard: "Dashboard", navNotes: "Notes", navPages: "Pages", navTools: "Tools", langBtn: "ID",
    pagesTitle: "Pages", noPages: "No public pages yet.", updated: "Updated", privateBadge: "PRIVATE",
    editPage: "Edit page", notFoundTitle: "Page not found", notFoundText: "The page you are looking for does not exist or is not published.", backHome: "Back to Dashboard",
    notesTitle: "Personal Notes", notesHint: "Visible to admin only. Markdown supported (no raw HTML). You can keep many notes.",
    newNote: "+ New note", noteTitleLbl: "Note title", untitledNote: "Untitled", noteConflict: "This note was changed in another tab/device. Reload the page first.", saveTooFast: "Too fast. Wait 2 seconds and save again (KV write limit).",
    managerTitle: "Manage Pages", newPage: "+ New Page", slugLbl: "Slug (lowercase, digits, hyphen)", titleLbl: "Title", descLbl: "SEO description (max 300)",
    contentLbl: "Content (Markdown)", publicLbl: "Public", tabId: "Indonesian", tabEn: "English (optional)", save: "SAVE", del: "DELETE", view: "VIEW",
    saved: "Saved!", saveFailed: "Failed to save", deleted: "Page deleted", confirmDelete: "Delete this page permanently?", unsaved: "You have unsaved changes. Continue?",
    preview: "Preview", uploadImg: "Upload Image", media: "Media", mediaEmpty: "No images yet.", insert: "Insert", close: "Close",
    uploadUnsupported: "Upload is not available on this runtime. Enable R2 (Cloudflare) or run on Node.js (VPS/Local).",
    uploadTooBig: "Image must be 2 MB or smaller.", uploadFailed: "Upload failed", uploaded: "Image uploaded", usage: "Used", noSlug: "Slug is required", empty: "No pages yet. Click “New Page”.",
    badSlug: "Invalid slug. Use lowercase letters, digits and hyphens (2-64 chars).", linkImg: "Image URL:", linkUrl: "Link URL:", draft: "Draft (private)"
  }
};

const UI44_CSS = `/* BATCH44 shared controls and notices */
.sg-select-trigger[hidden]{display:none!important}
small.sg-notice{display:block}
:root{color-scheme:dark}
.cms-wrap input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=range]):not([type=color]):not([type=submit]):not([type=button]),.cms-wrap select,.cms-wrap textarea,.sg-select-trigger{box-sizing:border-box;max-width:100%;min-width:0;background:var(--bg-dark);color:#e2e8f0;border:1px solid rgba(0,240,255,.3);border-radius:8px;padding:10px;font: .85rem 'JetBrains Mono',monospace;min-height:42px}
.cms-wrap .fld input:not([type=checkbox]):not([type=radio]),.cms-wrap .fld select,.sg-select-trigger{width:100%}
.cms-wrap textarea{resize:vertical;line-height:1.5}
.cms-wrap input::placeholder,.cms-wrap textarea::placeholder{color:#94a3b8;opacity:1}
.cms-wrap input:focus-visible,.cms-wrap textarea:focus-visible,.sg-select-trigger:focus-visible,.sg-option:focus-visible{outline:2px solid var(--border-cyan);outline-offset:2px}
.cms-wrap input:disabled,.cms-wrap select:disabled,.sg-select-trigger:disabled{opacity:.5;cursor:not-allowed}
.cms-wrap input[readonly],.cms-wrap textarea[readonly]{background:var(--card-bg)}
input[type=checkbox],input[type=radio]{accent-color:var(--border-cyan)}
.sg-notice{padding:10px 12px;border:1px solid rgba(0,240,255,.3);border-radius:10px;background:rgba(0,240,255,.05);color:#e2e8f0;line-height:1.5;overflow-wrap:anywhere;font-size:.9rem;margin:10px 0}
.sg-warning{border-color:var(--neon-warning);background:rgba(245,158,11,.08);color:#fbbf24}
.sg-error{border-color:var(--neon-pink);background:rgba(255,0,127,.08);color:#fda4af}
#cmsToast{background:var(--card-bg);color:var(--neon-green);border:1px solid var(--neon-green);border-radius:10px;max-width:calc(100vw - 24px);width:max-content;overflow-wrap:anywhere;box-shadow:0 8px 24px #0008;z-index:120000}
#cmsToast.bad{background:var(--card-bg);color:#fda4af;border-color:var(--neon-pink)}
.sg-select-trigger{text-align:left;cursor:pointer;display:flex;justify-content:space-between;gap:12px;align-items:center;white-space:normal;overflow-wrap:anywhere}
.sg-select-trigger::after{content:'▾';color:var(--border-cyan)}
.sg-choice{color:#e2e8f0;background:linear-gradient(145deg,#091328,#030712);border:1.5px solid var(--border-cyan);border-radius:14px;padding:18px;width:calc(100% - 24px);max-width:440px;max-height:85vh;max-height:85dvh;box-shadow:0 0 25px #00f0ff33;overflow:auto}
.sg-choice::backdrop{background:rgba(3,7,18,.88);backdrop-filter:blur(6px)}
.sg-choice h3{font-family:'Orbitron',sans-serif;font-size:.85rem;color:var(--border-cyan);margin:0 0 14px}
.sg-options{display:flex;flex-direction:column;gap:7px;margin-bottom:12px}
.sg-option{font:inherit;text-align:left;background:var(--card-bg);color:#e2e8f0;border:1px solid #00f0ff40;border-radius:8px;padding:12px;min-height:44px;cursor:pointer;overflow-wrap:anywhere}
.sg-option[aria-pressed=true]{border-color:var(--border-cyan);background:#00f0ff22;color:var(--border-cyan)}
.sg-option:disabled{opacity:.45;cursor:not-allowed}
@media(max-width:480px){.cms-wrap input:not([type=checkbox]):not([type=radio]),.cms-wrap textarea,.cms-wrap select,.sg-select-trigger{font-size:16px}}
`;
const UI44_SCRIPT = String.raw`function initToolChoices44(){
 if(typeof HTMLDialogElement==='undefined'||!HTMLDialogElement.prototype.showModal)return;
 var en=document.documentElement.lang==='en';
 document.querySelectorAll('select').forEach(function(s){
  if(s.multiple||s.size>1||s.required)return;
  var trigger=document.createElement('button');trigger.type='button';trigger.className='sg-select-trigger';trigger.setAttribute('aria-haspopup','dialog');
  var title=(s.labels&&s.labels[0]?s.labels[0].textContent:'').trim()||(en?'Select option':'Pilih opsi');
  function sync(){var o=s.options[s.selectedIndex];trigger.textContent=o?o.textContent:'—';trigger.disabled=s.disabled;trigger.hidden=s.hidden;trigger.setAttribute('aria-label',title+': '+trigger.textContent);}
  s.insertAdjacentElement('afterend',trigger);s.style.display='none';sync();
  s.addEventListener('change',sync);s.addEventListener('input',sync);
  var observer=new MutationObserver(sync);observer.observe(s,{attributes:true,childList:true,subtree:true,characterData:true});
  // Programmatic value assignment does not emit change or DOM mutations.
  var timer=setInterval(function(){if(!s.isConnected){clearInterval(timer);observer.disconnect();return;}sync();},300);
  if(s.labels)Array.from(s.labels).forEach(function(label){label.addEventListener('click',function(e){if(e.target===label){e.preventDefault();trigger.focus();}});});
  trigger.onclick=function(){
   if(s.disabled)return;
   var d=document.createElement('dialog');d.className='sg-choice';
   var h=document.createElement('h3');h.id='sg-choice-title';h.textContent=title;d.setAttribute('aria-labelledby',h.id);d.appendChild(h);
   var list=document.createElement('div');list.className='sg-options';d.appendChild(list);var selected;
   Array.from(s.options).forEach(function(o,i){
    if(o.hidden)return;var b=document.createElement('button');b.type='button';b.className='sg-option';b.textContent=o.textContent;
    b.disabled=o.disabled||(o.parentElement.tagName==='OPTGROUP'&&o.parentElement.disabled);b.setAttribute('aria-pressed',String(i===s.selectedIndex));
    if(i===s.selectedIndex)selected=b;
    b.onclick=function(){if(s.disabled||b.disabled)return;var changed=s.selectedIndex!==i;s.selectedIndex=i;if(changed){s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));}sync();d.close();};list.appendChild(b);
   });
   var cancel=document.createElement('button');cancel.type='button';cancel.className='btn ghost';cancel.textContent=en?'Cancel':'Batal';cancel.onclick=function(){d.close();};d.appendChild(cancel);
   d.addEventListener('close',function(){d.remove();trigger.focus();});
   d.addEventListener('click',function(e){if(e.target===d){var r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});
   d.addEventListener('keydown',function(e){if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Home'||e.key==='End'){var items=Array.from(list.querySelectorAll('button:not(:disabled)'));if(!items.length)return;e.preventDefault();var i=items.indexOf(document.activeElement);i=e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[i].focus();}});
   document.body.appendChild(d);d.showModal();(selected&&!selected.disabled?selected:cancel).focus();
  };
 });
}
initToolChoices44();`;
const CMS_CSS = `
:root{--bg-dark:#030712;--card-bg:#070e1b;--border-cyan:#00f0ff;--neon-pink:#ff007f;--neon-green:#00ff87;--neon-warning:#f59e0b;--text-blue:#38bdf8}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{scroll-behavior:smooth}
body{background:var(--bg-dark);color:#e2e8f0;font-family:'Rajdhani',sans-serif;font-size:1.05rem;margin:0;min-height:100vh;display:flex;flex-direction:column}
a{color:var(--border-cyan)}
.cms-nav{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px clamp(10px,3vw,24px);background:rgba(3,7,18,.92);backdrop-filter:blur(8px);border-bottom:1px solid rgba(0,240,255,.25)}
.cms-nav .brand{font-family:'Orbitron',sans-serif;font-weight:800;font-size:.8rem;color:#fff;margin-right:8px;text-decoration:none;text-shadow:0 0 8px rgba(0,240,255,.5)}
.cms-nav a.nav-link,.cms-nav button{font-family:'Orbitron',sans-serif;font-size:.65rem;font-weight:700;color:var(--border-cyan);background:rgba(0,240,255,.05);border:1px solid rgba(0,240,255,.35);border-radius:8px;padding:7px 11px;text-decoration:none;cursor:pointer}
.cms-nav a.nav-link.active{background:rgba(0,240,255,.18);border-color:var(--border-cyan);box-shadow:none}
*{-webkit-tap-highlight-color:transparent}
.cms-nav .spacer{flex:1}
.cms-wrap{width:100%;max-width:860px;margin:0 auto;padding:clamp(14px,3vw,28px) clamp(12px,3vw,24px) 40px;flex:1}
.cms-wrap.wide{max-width:1180px}
.cms-article h1{font-family:'Orbitron',sans-serif;font-size:clamp(1.3rem,4vw,1.9rem);color:#fff;margin:0 0 6px;text-shadow:0 0 12px rgba(0,240,255,.35);word-break:break-word}
.cms-meta{font-family:'JetBrains Mono',monospace;font-size:.72rem;color:#94a3b8;margin-bottom:18px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.badge{font-family:'Orbitron',sans-serif;font-size:.58rem;padding:2px 8px;border-radius:10px;border:1px solid var(--neon-pink);color:var(--neon-pink)}
.cms-md{line-height:1.7;word-break:break-word}
.cms-md h2,.cms-md h3,.cms-md h4,.cms-md h5,.cms-md h6{font-family:'Orbitron',sans-serif;color:var(--border-cyan);margin:1.4em 0 .5em;line-height:1.25}
.cms-md h2{font-size:1.25rem}.cms-md h3{font-size:1.05rem}.cms-md h4,.cms-md h5,.cms-md h6{font-size:.92rem}
.cms-md p{margin:.7em 0}
.cms-md img{max-width:100%;height:auto;border-radius:10px;border:1px solid rgba(0,240,255,.3);margin:6px 0;display:block}
.cms-md code{font-family:'JetBrains Mono',monospace;font-size:.85em;background:rgba(0,240,255,.08);padding:1px 6px;border-radius:5px;color:#7dd3fc}
.cms-md pre{background:#020617;border:1px solid rgba(0,240,255,.25);border-radius:10px;padding:12px;overflow-x:auto}
.cms-md pre code{background:none;padding:0;color:#e2e8f0}
.cms-md blockquote{margin:.8em 0;padding:6px 14px;border-left:3px solid var(--border-cyan);background:rgba(0,240,255,.04);color:#cbd5e1;border-radius:0 8px 8px 0}
.cms-md hr{border:0;border-top:1px solid rgba(0,240,255,.25);margin:1.5em 0}
.cms-md ul,.cms-md ol{padding-left:1.4em}
.cms-footer{text-align:center;color:#64748b;font-size:.75rem;padding:16px}
.page-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px}
.page-list a{display:block;padding:12px 14px;border:1px solid rgba(0,240,255,.25);border-radius:10px;background:var(--card-bg);text-decoration:none;color:#fff;font-weight:700}
@media (hover:hover){.page-list a:hover{border-color:var(--border-cyan);box-shadow:0 0 12px rgba(0,240,255,.2)}}
.page-list small{display:block;color:#94a3b8;font-family:'JetBrains Mono',monospace;font-weight:500;margin-top:3px}
.ed-grid{display:grid;grid-template-columns:260px 1fr;gap:14px;align-items:start}
@media(max-width:820px){.ed-grid{grid-template-columns:1fr}}
.ed-side,.ed-main{background:var(--card-bg);border:1px solid rgba(0,240,255,.25);border-radius:12px;padding:12px}
.ed-side h2,.ed-main h2{font-family:'Orbitron',sans-serif;font-size:.8rem;color:var(--border-cyan);margin:0 0 10px}
.btn{font-family:'Orbitron',sans-serif;font-size:.65rem;font-weight:700;color:var(--border-cyan);background:rgba(0,240,255,.06);border:1px solid var(--border-cyan);border-radius:8px;padding:8px 12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:5px}
@media (hover:hover){.btn:hover{background:rgba(0,240,255,.16)}}.btn.warn{color:var(--neon-warning);border-color:var(--neon-warning)}.btn.danger{color:var(--neon-pink);border-color:var(--neon-pink)}.btn.ghost{color:#94a3b8;border-color:#475569}
.btn:disabled{opacity:.45;cursor:not-allowed}
.fld{margin-bottom:10px}.fld label{display:block;font-family:'Orbitron',sans-serif;font-size:.6rem;color:#94a3b8;margin-bottom:4px}
.fld input[type=text],.fld textarea,#edText{width:100%;background:#030712;border:1px solid rgba(0,240,255,.3);border-radius:8px;color:#fff;padding:9px 10px;font-size:.95rem;font-family:'JetBrains Mono',monospace;outline:none}
.fld input:focus,.fld textarea:focus,#edText:focus{border-color:var(--border-cyan);box-shadow:0 0 8px rgba(0,240,255,.3)}
.ed-toolbar{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.ed-toolbar .btn{padding:6px 9px}
.ed-split{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ed-split.single{grid-template-columns:1fr}
@media(max-width:820px){.ed-split{grid-template-columns:1fr}}
#edText{min-height:340px;resize:vertical;line-height:1.5}
#edPreview{border:1px dashed rgba(0,240,255,.3);border-radius:8px;padding:10px;min-height:340px;overflow:auto;max-height:70vh}
.tabs{display:flex;gap:6px;margin-bottom:8px}.tabs button.active{background:rgba(0,240,255,.2)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.sw{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;cursor:pointer}
.pg-item{display:flex;justify-content:space-between;gap:6px;align-items:center;padding:8px 10px;border:1px solid rgba(0,240,255,.2);border-radius:8px;margin-bottom:6px;cursor:pointer;background:#030712;word-break:break-all}
.pg-item.active{border-color:var(--border-cyan);background:rgba(0,240,255,.08)}
.pg-item small{color:#94a3b8;font-family:'JetBrains Mono',monospace;font-size:.62rem}
#cmsToast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--neon-green);color:#030712;font-weight:700;padding:8px 16px;border-radius:20px;font-size:.8rem;display:none;z-index:1000}
#cmsToast.bad{background:var(--neon-pink);color:#fff}
.media-modal{position:fixed;inset:0;background:rgba(3,7,18,.85);display:none;align-items:center;justify-content:center;z-index:500;padding:14px}
.media-modal.open{display:flex}
.media-card{background:#091328;border:1.5px solid var(--border-cyan);border-radius:14px;width:100%;max-width:640px;max-height:88vh;overflow:auto;padding:14px}
.media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:10px 0}
.media-item{border:1px solid rgba(0,240,255,.25);border-radius:8px;overflow:hidden;background:#030712}
.media-item img{width:100%;aspect-ratio:1;object-fit:cover;display:block}
.media-item .row{padding:5px;justify-content:space-between}
.media-item .btn{padding:4px 7px;font-size:.58rem}
table.kv{width:100%;border-collapse:collapse;font-family:'JetBrains Mono',monospace;font-size:.82rem}
table.kv td{padding:6px 8px;border-bottom:1px solid rgba(0,240,255,.15);word-break:break-all;vertical-align:top}
table.kv td:first-child{color:#94a3b8;white-space:nowrap;word-break:normal;padding-right:14px}
.tool-out{margin-top:10px}
/* Keep locally generated QR readable on narrow screens. */
.tool-qr-image{max-width:100%;overflow:auto;margin-top:10px}
.tool-qr-image svg{display:block;max-width:100%;height:auto}
.cms-article .ed-main{min-width:0}
.cms-article .ed-main>.btn{margin:4px 4px 4px 0}
textarea.tool-ta{width:100%;min-height:140px;box-sizing:border-box;font-family:'JetBrains Mono',monospace;font-size:.82rem;background:#020617;color:#e2e8f0;border:1px solid rgba(0,240,255,.25);border-radius:8px;padding:10px;resize:vertical}
select.tool-sel,input.tool-in{box-sizing:border-box;font-family:'JetBrains Mono',monospace;font-size:.82rem;background:#020617;color:#e2e8f0;border:1px solid rgba(0,240,255,.25);border-radius:8px;padding:8px;max-width:100%}
.tool-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
/* Reuse CMS controls; prevent grid children and generated output widening mobile pages. */
.tool-grid>*{min-width:0}
.tool-grid .tool-in,.tool-grid .tool-sel{width:100%}
.tool-ta,.tool-list{max-width:100%;box-sizing:border-box}
.tool-in:focus-visible,.tool-sel:focus-visible,.tool-ta:focus-visible{outline:2px solid var(--border-cyan);outline-offset:2px}
.cms-article .ed-main{overflow-wrap:anywhere}
.cms-article .ed-main .btn{white-space:normal;max-width:100%}
@media(max-width:360px){.tool-grid{grid-template-columns:minmax(0,1fr)}}
.tool-list{white-space:pre;font-family:'JetBrains Mono',monospace;font-size:.8rem;background:#020617;border:1px solid rgba(0,240,255,.25);border-radius:8px;padding:10px;max-height:320px;overflow:auto;margin-top:6px}
${UI44_CSS}
`;

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Rajdhani:wght@500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">`;

function safeJsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function pickLang(lang, idVal, enVal) {
  return lang === "en" && enVal ? enVal : idVal;
}

function stripMarkdown(md, max) {
  let s = String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return s;
}

function renderCmsNav(active, lang, caps, isLoggedIn, siteTitle) {
  const t = CMS_T[lang];
  const link = (href, key, id) => `<a class="nav-link${active === id ? " active" : ""}" href="${href}">${esc(t[key])}</a>`;
  return `<nav class="cms-nav" aria-label="Main">
    <a class="brand" href="/">${esc(siteTitle)}</a>
    ${caps.archive || caps.ping ? link("/", "navDashboard", "dashboard") : link("/", "navDashboard", "dashboard")}
    ${caps.cms && isLoggedIn ? link("/notes", "navNotes", "notes") : ""}
    ${isLoggedIn ? link("/tools", "navTools", "tools") : ""}
    ${caps.cms ? link("/pages", "navPages", "pages") : ""}
    <a class="nav-link${active === "guide" ? " active" : ""}" href="/guide?lang=${lang}">${lang === "en" ? "Guide" : "Panduan"}</a>
    <span class="spacer"></span>
    <button type="button" id="cmsLangBtn" data-next="${lang === "en" ? "id" : "en"}">${esc(t.langBtn)}</button>
  </nav>`;
}

// Wrangler / the dashboard editor bundle with esbuild "keep names", which wraps named functions in __name(...).
// Functions we serialise with .toString() and run in the browser would then crash with "__name is not defined".
const NAME_SHIM = "var __name=function(f){return f;};";
const CMS_LANG_SCRIPT = `<script>(function(){var b=document.getElementById('cmsLangBtn');if(!b)return;b.addEventListener('click',function(){var n=b.getAttribute('data-next');document.cookie='pref_lang='+n+'; Path=/; SameSite=Lax; Max-Age=31536000';var u=new URL(location.href);u.searchParams.set('lang',n);location.href=u.toString();});})();</script>`;

function renderCmsShell(o) {
  const t = CMS_T[o.lang];
  const fullTitle = o.title ? `${o.title} — ${o.siteTitle}` : o.siteTitle;
  const desc = o.description || "";
  return `<!DOCTYPE html>
<html lang="${o.lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${o.noindex ? "noindex, nofollow" : "index, follow"}">
${o.canonical ? `<link rel="canonical" href="${esc(o.canonical)}">` : ""}
<meta property="og:site_name" content="${esc(o.siteTitle)}">
<meta property="og:title" content="${esc(o.title || o.siteTitle)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="${o.ogType || "website"}">
${o.canonical ? `<meta property="og:url" content="${esc(o.canonical)}">` : ""}
<meta property="og:locale" content="${o.lang === "en" ? "en_US" : "id_ID"}">
${o.ogImage ? `<meta property="og:image" content="${esc(o.ogImage)}"><meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`}
<meta name="twitter:title" content="${esc(o.title || o.siteTitle)}">
<meta name="twitter:description" content="${esc(desc)}">
${FONT_LINKS}
<style>${CMS_CSS}</style>
${o.jsonLd ? `<script type="application/ld+json">${safeJsonForScript(o.jsonLd)}</script>` : ""}
</head>
<body>
${o.nav}
<main class="cms-wrap${o.wide ? " wide" : ""}">${o.body}</main>
${guideFooter34(o.lang,false)}
<div id="cmsToast" role="status"></div>
${CMS_LANG_SCRIPT}
${o.scripts || ""}
<script>${UI44_SCRIPT}</script>
</body>
</html>`;
}

function renderPublicPage(page, ctx) {
  const { lang, isLoggedIn, siteTitle, origin, caps } = ctx;
  const t = CMS_T[lang];
  const title = pickLang(lang, page.title, page.titleEn);
  const content = pickLang(lang, page.content, page.contentEn);
  const description = pickLang(lang, page.description, page.descriptionEn) || stripMarkdown(content, 160);
  const firstImg = /!\[[^\]]*\]\((https?:\/\/[^)\s]+|\/uploads\/[a-f0-9]{32}\.(?:png|jpg|gif|webp))\)/.exec(content);
  const canonical = origin + "/p/" + page.slug;
  const isPublic = page.isPublic !== false;
  const body = `<article class="cms-article">
    <h1>${esc(title)}</h1>
    <div class="cms-meta"><span>${esc(t.updated)}: ${esc(formatCustomDateTime(page.updatedAt, lang))}</span>${isPublic ? "" : `<span class="badge">${esc(t.privateBadge)}</span>`}${isLoggedIn ? `<a href="/pages?edit=${encodeURIComponent(page.slug)}">${esc(t.editPage)}</a>` : ""}</div>
    <div class="cms-md">${markdownToHtml(content)}</div>
  </article>`;
  return renderCmsShell({
    lang, siteTitle, title, description, canonical, ogType: "article", noindex: !isPublic,
    ogImage: firstImg ? (firstImg[1].startsWith("/") ? origin + firstImg[1] : firstImg[1]) : "",
    jsonLd: { "@context": "https://schema.org", "@type": "Article", headline: title, description, url: canonical,
      dateModified: new Date(page.updatedAt || Date.now()).toISOString(), datePublished: new Date(page.createdAt || page.updatedAt || Date.now()).toISOString(), inLanguage: lang },
    nav: renderCmsNav("pages", lang, caps, isLoggedIn, siteTitle), body
  });
}

function renderNotFoundPage(ctx) {
  const { lang, siteTitle, caps, isLoggedIn } = ctx;
  const t = CMS_T[lang];
  return renderCmsShell({
    lang, siteTitle, title: t.notFoundTitle, description: t.notFoundText, noindex: true,
    nav: renderCmsNav("", lang, caps, isLoggedIn, siteTitle),
    body: `<article class="cms-article"><h1>404 — ${esc(t.notFoundTitle)}</h1><p>${esc(t.notFoundText)}</p><p><a class="btn" href="/">${esc(t.backHome)}</a></p></article>`
  });
}

function renderPagesIndex(index, ctx) {
  const { lang, siteTitle, origin, caps, isLoggedIn } = ctx;
  const t = CMS_T[lang];
  const list = index.filter(p => p.isPublic !== false).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const body = `<article class="cms-article"><h1>${esc(t.pagesTitle)}</h1>
    ${list.length === 0 ? `<p>${esc(t.noPages)}</p>` : `<ul class="page-list">${list.map(p =>
      `<li><a href="/p/${esc(p.slug)}">${esc(pickLang(lang, p.title, p.titleEn))}<small>/p/${esc(p.slug)} · ${esc(formatCustomDateTime(p.updatedAt, lang))}</small></a></li>`).join("")}</ul>`}
  </article>`;
  return renderCmsShell({
    lang, siteTitle, title: t.pagesTitle, description: `${t.pagesTitle} — ${siteTitle}`, canonical: origin + "/pages",
    nav: renderCmsNav("pages", lang, caps, isLoggedIn, siteTitle), body
  });
}

// ---------- shared editor markup + client logic ----------
function editorMarkup(t, uploadSupported) {
  return `
    <div class="ed-toolbar" id="edToolbar">
      <button type="button" class="btn" data-act="h" title="Heading">H</button>
      <button type="button" class="btn" data-act="b" title="Bold"><b>B</b></button>
      <button type="button" class="btn" data-act="i" title="Italic"><i>I</i></button>
      <button type="button" class="btn" data-act="code" title="Code">&lt;/&gt;</button>
      <button type="button" class="btn" data-act="ul" title="List">• List</button>
      <button type="button" class="btn" data-act="quote" title="Quote">❝</button>
      <button type="button" class="btn" data-act="link" title="Link">🔗</button>
      <button type="button" class="btn" data-act="img" title="Image URL">🖼 URL</button>
      <button type="button" class="btn warn" id="edUploadBtn" ${uploadSupported ? "" : "disabled"}>📷 ${esc(t.uploadImg)}</button>
      <button type="button" class="btn warn" id="edMediaBtn" ${uploadSupported ? "" : "disabled"}>🗂 ${esc(t.media)}</button>
      <button type="button" class="btn ghost" id="edPreviewToggle">👁 ${esc(t.preview)}</button>
      <input type="file" id="edFile" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
    </div>
    ${uploadSupported ? "" : `<div style="font-size:.7rem;color:#f59e0b;margin-bottom:8px">ℹ️ ${esc(t.uploadUnsupported)}</div>`}
    <div class="ed-split" id="edSplit">
      <textarea id="edText" spellcheck="false" aria-label="${esc(t.contentLbl)}"></textarea>
      <div id="edPreview" class="cms-md" aria-live="polite"></div>
    </div>
    <div class="media-modal" id="mediaModal" role="dialog" aria-modal="true">
      <div class="media-card">
        <div class="row" style="justify-content:space-between"><strong style="font-family:Orbitron,sans-serif;font-size:.8rem;color:var(--border-cyan)">${esc(t.media)}</strong><button type="button" class="btn ghost" id="mediaClose">✕ ${esc(t.close)}</button></div>
        <div id="mediaUsage" style="font-size:.7rem;color:#94a3b8;margin-top:6px"></div>
        <div class="media-grid" id="mediaGrid"></div>
      </div>
    </div>`;
}

// Runs in the browser (injected via Function.prototype.toString). Must stay self-contained.
function cmsEditorInit(cfg) {
  var T = cfg.T;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var toastTimer = null;
  function toast(msg, bad) {
    var el = $('cmsToast');
    if (!el) return;
    el.textContent = msg; el.className = bad ? 'bad' : ''; el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 2600);
  }
  function api(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return { success: false, message: 'HTTP ' + r.status }; }).then(function (d) { d._status = r.status; return d; });
    }).catch(function () { return { success: false, message: 'Network error' }; });
  }
  function postJson(url, body) {
    return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  var ta = $('edText'), pv = $('edPreview');
  var dirty = false;
  var previewOn = true;
  function renderPreview() { pv.innerHTML = markdownToHtml(ta.value); }
  function markDirty() { dirty = true; renderPreview(); }
  ta.addEventListener('input', markDirty);
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (cfg.mode === 'notes') saveNotes(); else savePage(); }
  });

  function insertText(text, selectInner) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    var pos = s + text.length;
    ta.focus(); ta.setSelectionRange(selectInner ? s + selectInner[0] : pos, selectInner ? s + selectInner[1] : pos);
    markDirty();
  }
  function wrapSel(before, after, placeholder) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    var sel = ta.value.slice(s, e) || placeholder;
    insertText(before + sel + after, [before.length, before.length + sel.length]);
  }
  function linePrefix(prefix) {
    var s = ta.selectionStart;
    var ls = ta.value.lastIndexOf('\n', s - 1) + 1;
    ta.value = ta.value.slice(0, ls) + prefix + ta.value.slice(ls);
    ta.focus(); ta.setSelectionRange(s + prefix.length, s + prefix.length);
    markDirty();
  }

  $('edToolbar').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'h') linePrefix('## ');
    else if (act === 'b') wrapSel('**', '**', 'bold');
    else if (act === 'i') wrapSel('*', '*', 'italic');
    else if (act === 'code') wrapSel('`', '`', 'code');
    else if (act === 'ul') linePrefix('- ');
    else if (act === 'quote') linePrefix('> ');
    else if (act === 'link') { var u = prompt(T.linkUrl, 'https://'); if (u) wrapSel('[', '](' + u + ')', 'text'); }
    else if (act === 'img') { var iu = prompt(T.linkImg, 'https://'); if (iu) insertText('![](' + iu + ')'); }
  });

  $('edPreviewToggle').addEventListener('click', function () {
    previewOn = !previewOn;
    pv.style.display = previewOn ? '' : 'none';
    $('edSplit').className = previewOn ? 'ed-split' : 'ed-split single';
  });

  // ---- upload & media ----
  var fileInput = $('edFile');
  function uploadFile(file) {
    if (!file) return;
    if (file.size > cfg.uploadMax) { toast(T.uploadTooBig, true); return; }
    fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
      .then(function (r) { return r.json().catch(function () { return { success: false }; }); })
      .then(function (d) {
        if (d && d.success) { insertText('![](' + d.url + ')'); toast(T.uploaded); }
        else toast((d && d.message) || T.uploadFailed, true);
      }).catch(function () { toast(T.uploadFailed, true); });
  }
  if ($('edUploadBtn')) $('edUploadBtn').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { uploadFile(fileInput.files[0]); fileInput.value = ''; });
  ta.addEventListener('paste', function (e) {
    if (!cfg.uploadSupported || !e.clipboardData) return;
    var items = e.clipboardData.files;
    if (items && items.length && /^image\//.test(items[0].type)) { e.preventDefault(); uploadFile(items[0]); }
  });
  ta.addEventListener('dragover', function (e) { if (cfg.uploadSupported) e.preventDefault(); });
  ta.addEventListener('drop', function (e) {
    if (!cfg.uploadSupported || !e.dataTransfer || !e.dataTransfer.files.length) return;
    if (/^image\//.test(e.dataTransfer.files[0].type)) { e.preventDefault(); uploadFile(e.dataTransfer.files[0]); }
  });

  function fmtBytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function loadMedia() {
    api('/api/uploads').then(function (d) {
      var grid = $('mediaGrid');
      if (!d.success) { grid.innerHTML = '<div>' + esc(d.message || T.uploadFailed) + '</div>'; return; }
      $('mediaUsage').textContent = T.usage + ': ' + fmtBytes(d.usedBytes) + ' / ' + fmtBytes(d.quotaBytes);
      if (!d.items.length) { grid.innerHTML = '<div style="color:#94a3b8;font-size:.8rem">' + esc(T.mediaEmpty) + '</div>'; return; }
      grid.innerHTML = d.items.map(function (it) {
        return '<div class="media-item"><img loading="lazy" src="' + esc(it.url) + '" alt=""><div class="row">' +
          '<button type="button" class="btn" data-ins="' + esc(it.url) + '">' + esc(T.insert) + '</button>' +
          '<button type="button" class="btn danger" data-del="' + esc(it.name) + '">✕</button></div></div>';
      }).join('');
    });
  }
  if ($('edMediaBtn')) $('edMediaBtn').addEventListener('click', function () { $('mediaModal').classList.add('open'); loadMedia(); });
  $('mediaClose').addEventListener('click', function () { $('mediaModal').classList.remove('open'); });
  $('mediaModal').addEventListener('click', function (ev) {
    if (ev.target === $('mediaModal')) { $('mediaModal').classList.remove('open'); return; }
    var ins = ev.target.closest('[data-ins]');
    if (ins) { $('mediaModal').classList.remove('open'); insertText('![](' + ins.getAttribute('data-ins') + ')'); return; }
    var del = ev.target.closest('[data-del]');
    if (del && confirm(T.confirmDelete)) {
      postJson('/api/delete_upload', { name: del.getAttribute('data-del') }).then(function (d) { if (d.success) loadMedia(); else toast(d.message || T.saveFailed, true); });
    }
  });

  // ================= NOTES MODE =================
  var notesIndex = cfg.notes || [], curNote = null;
  function downloadNote(format) {
    if (format !== 'md' && format !== 'txt') return;
    var name = ($('ntTitle').value || 'note').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 100) || 'note';
    var url = URL.createObjectURL(new Blob([ta.value], {type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'}));
    var a = document.createElement('a'); a.href = url; a.download = name + '.' + format;
    document.body.appendChild(a);
    try { a.click(); } finally { a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
  }
  function renderNotesList() {
    var box = $('ntList'); if (!box) return;
    if (!notesIndex.length) { box.innerHTML = '<div style="color:#94a3b8;font-size:.8rem">' + esc(T.empty) + '</div>'; return; }
    box.innerHTML = notesIndex.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).map(function (n) {
      return '<div class="pg-item' + (curNote && n.id === curNote.id ? ' active' : '') + '" data-id="' + esc(n.id) + '"><span>' + esc(n.title || T.untitledNote) + '</span></div>';
    }).join('');
  }
  function showNoteEditor(on) { $('ntEditor').style.display = on ? 'block' : 'none'; }
  function noteMeta() { $('ntUpdated').textContent = curNote && curNote.updatedAt ? T.updated + ': ' + new Date(curNote.updatedAt).toLocaleString() : ''; }
  function bindNote() { $('ntTitle').value = curNote.title || ''; ta.value = curNote.text || ''; renderPreview(); $('ntDelete').style.display = curNote.id ? '' : 'none'; noteMeta(); }
  function newNote() {
    if (!confirmLeave()) return;
    curNote = { id: '', title: '', text: '', updatedAt: 0 }; dirty = false;
    bindNote(); showNoteEditor(true); renderNotesList(); $('ntTitle').focus();
  }
  function openNote(id) {
    if (!confirmLeave()) return;
    api('/api/note?id=' + encodeURIComponent(id)).then(function (d) {
      if (!d.success) { toast(d.message || T.saveFailed, true); return; }
      curNote = d.note; dirty = false; bindNote(); showNoteEditor(true); renderNotesList();
    });
  }
  var savingNote = false;
  function saveNotes() {
    if (!curNote || savingNote) return;
    savingNote = true;
    postJson('/api/save_note', { id: curNote.id, title: $('ntTitle').value.trim(), text: ta.value, baseUpdatedAt: curNote.updatedAt || 0 }).then(function (d) {
      savingNote = false;
      if (!d.success) { toast(d.message || T.saveFailed, true); return; }
      dirty = false; curNote.id = d.note.id; curNote.title = d.note.title; curNote.updatedAt = d.note.updatedAt;
      var i = notesIndex.findIndex(function (n) { return n.id === d.note.id; });
      if (i >= 0) notesIndex[i] = d.note; else notesIndex.push(d.note);
      $('ntDelete').style.display = ''; noteMeta(); renderNotesList(); toast(T.saved);
    });
  }
  function deleteNote() {
    if (!curNote || !curNote.id || !confirm(T.confirmDelete)) return;
    postJson('/api/delete_note', { id: curNote.id }).then(function (d) {
      if (!d.success) { toast(d.message || T.saveFailed, true); return; }
      notesIndex = notesIndex.filter(function (n) { return n.id !== curNote.id; });
      curNote = null; dirty = false; showNoteEditor(false); renderNotesList(); toast(T.deleted);
    });
  }

  // ================= PAGES MODE =================
  var cur = null, tab = 'id', pagesIndex = cfg.pages || [], originalSlug = '';
  function emptyPage() { return { slug: '', title: '', titleEn: '', description: '', descriptionEn: '', content: '', contentEn: '', isPublic: true }; }
  function collect() {
    if (!cur) return;
    cur.slug = $('pgSlug').value.trim().toLowerCase();
    cur.isPublic = $('pgPublic').checked;
    if (tab === 'id') { cur.title = $('pgTitle').value; cur.description = $('pgDesc').value; cur.content = ta.value; }
    else { cur.titleEn = $('pgTitle').value; cur.descriptionEn = $('pgDesc').value; cur.contentEn = ta.value; }
  }
  function bind() {
    $('pgSlug').value = cur.slug; $('pgPublic').checked = cur.isPublic !== false;
    $('pgTitle').value = tab === 'id' ? cur.title : cur.titleEn;
    $('pgDesc').value = tab === 'id' ? cur.description : cur.descriptionEn;
    ta.value = tab === 'id' ? cur.content : cur.contentEn;
    $('tabId').classList.toggle('active', tab === 'id'); $('tabEn').classList.toggle('active', tab === 'en');
    renderPreview();
  }
  function renderList() {
    var box = $('pgList');
    if (!pagesIndex.length) { box.innerHTML = '<div style="color:#94a3b8;font-size:.8rem">' + esc(T.empty) + '</div>'; return; }
    box.innerHTML = pagesIndex.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).map(function (p) {
      return '<div class="pg-item' + (p.slug === originalSlug ? ' active' : '') + '" data-slug="' + esc(p.slug) + '"><span>' + esc(p.title) + '<br><small>/p/' + esc(p.slug) + '</small></span>' +
        (p.isPublic === false ? '<span class="badge">' + esc(T.draft) + '</span>' : '') + '</div>';
    }).join('');
  }
  function confirmLeave() { return !dirty || confirm(T.unsaved); }
  function showEditor(on) { $('pgEditor').style.display = on ? 'block' : 'none'; }
  function newPage() {
    if (!confirmLeave()) return;
    cur = emptyPage(); tab = 'id'; originalSlug = ''; dirty = false;
    bind(); showEditor(true); $('pgDelete').style.display = 'none'; $('pgView').style.display = 'none'; renderList();
  }
  function editPage(slug) {
    if (!confirmLeave()) return;
    api('/api/page?slug=' + encodeURIComponent(slug)).then(function (d) {
      if (!d.success) { toast(d.message || T.saveFailed, true); return; }
      cur = Object.assign(emptyPage(), d.page); tab = 'id'; originalSlug = d.page.slug; dirty = false;
      bind(); showEditor(true);
      $('pgDelete').style.display = ''; $('pgView').style.display = ''; $('pgView').href = '/p/' + d.page.slug;
      renderList();
    });
  }
  function savePage() {
    collect();
    if (!cur.slug) { toast(T.noSlug, true); return; }
    if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(cur.slug)) { toast(T.badSlug, true); return; }
    var body = Object.assign({}, cur, { originalSlug: originalSlug });
    postJson('/api/save_page', body).then(function (d) {
      if (!d.success) { toast(d.message || T.saveFailed, true); return; }
      dirty = false; originalSlug = d.page.slug; cur.slug = d.page.slug;
      var i = pagesIndex.findIndex(function (p) { return p.slug === d.page.slug || p.slug === body.originalSlug; });
      if (i >= 0) pagesIndex[i] = d.page; else pagesIndex.push(d.page);
      pagesIndex = pagesIndex.filter(function (p, idx, arr) { return arr.findIndex(function (q) { return q.slug === p.slug; }) === idx; });
      $('pgDelete').style.display = ''; $('pgView').style.display = ''; $('pgView').href = '/p/' + d.page.slug;
      renderList(); toast(T.saved);
    });
  }
  function deletePage() {
    if (!originalSlug || !confirm(T.confirmDelete)) return;
    postJson('/api/delete_page', { slug: originalSlug }).then(function (d) {
      if (!d.success) { toast(d.message || T.saveFailed, true); return; }
      pagesIndex = pagesIndex.filter(function (p) { return p.slug !== originalSlug; });
      originalSlug = ''; cur = null; dirty = false; showEditor(false); renderList(); toast(T.deleted);
    });
  }

  if (cfg.mode === 'notes') {
    $('ntNew').addEventListener('click', newNote);
    $('ntList').addEventListener('click', function (ev) { var it = ev.target.closest('[data-id]'); if (it) openNote(it.getAttribute('data-id')); });
    $('notesSave').addEventListener('click', saveNotes);
    $('ntExportMd').addEventListener('click', function () { downloadNote('md'); });
    $('ntExportTxt').addEventListener('click', function () { downloadNote('txt'); });
    $('ntDelete').addEventListener('click', deleteNote);
    $('ntTitle').addEventListener('input', function () { dirty = true; });
    renderNotesList(); showNoteEditor(false);
    if (notesIndex.length) {
      var first = notesIndex.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0];
      openNote(first.id);
    } else newNote();
  } else {
    $('pgNew').addEventListener('click', newPage);
    $('pgList').addEventListener('click', function (ev) { var it = ev.target.closest('[data-slug]'); if (it) editPage(it.getAttribute('data-slug')); });
    $('pgSave').addEventListener('click', savePage);
    $('pgDelete').addEventListener('click', deletePage);
    ['pgSlug', 'pgTitle', 'pgDesc'].forEach(function (id) { $(id).addEventListener('input', function () { dirty = true; }); });
    $('pgPublic').addEventListener('change', function () { dirty = true; });
    $('tabId').addEventListener('click', function () { if (tab === 'id' || !cur) return; collect(); tab = 'id'; bind(); });
    $('tabEn').addEventListener('click', function () { if (tab === 'en' || !cur) return; collect(); tab = 'en'; bind(); });
    renderList();
    showEditor(false);
    if (cfg.editSlug) editPage(cfg.editSlug);
  }
}

// ---------- NOTES (many notes; legacy single note "notes:v1" is migrated on first read) ----------
const MAX_NOTES = 200;
const NOTE_ID_RE = /^[a-f0-9]{12}$/;
function noteIndexEntry(n) { return { id: n.id, title: n.title, updatedAt: n.updatedAt }; }
async function getNotesIndex(KV) {
  let idx = await KV.get("notes_index_v1", { type: "json" });
  if (Array.isArray(idx)) return idx.filter((e) => e && NOTE_ID_RE.test(e.id));
  idx = [];
  const legacy = await KV.get("notes:v1", { type: "json" });
  if (legacy && typeof legacy.text === "string" && legacy.text.trim() !== "") {
    const n = { id: randomHex(6), title: "Catatan 1", text: legacy.text.substring(0, MAX_NOTES_CHARS), updatedAt: Number(legacy.updatedAt) || Date.now() };
    await KV.put("note:v1:" + n.id, JSON.stringify(n));
    idx = [noteIndexEntry(n)];
  }
  try { await KV.put("notes_index_v1", JSON.stringify(idx)); } catch (e) {}
  return idx;
}

function renderNotesPage(notesIndex, ctx) {
  const { lang, siteTitle, caps, uploadSupported } = ctx;
  const t = CMS_T[lang];
  const body = `<h1 style="font-family:Orbitron,sans-serif;font-size:1.2rem;color:#fff">${esc(t.notesTitle)}</h1>
    <p style="color:#94a3b8;font-size:.85rem">${esc(t.notesHint)}</p>
    <div class="ed-grid">
      <aside class="ed-side"><button type="button" class="btn" id="ntNew" style="width:100%;justify-content:center;margin-bottom:10px">${esc(t.newNote)}</button><div id="ntList"></div></aside>
      <section class="ed-main" id="ntEditor" style="display:none">
        <div class="fld"><label for="ntTitle">${esc(t.noteTitleLbl)}</label><input type="text" id="ntTitle" maxlength="120" autocomplete="off"></div>
        <div class="fld"><label>${esc(t.contentLbl)}</label>${editorMarkup(t, uploadSupported)}</div>
        <div class="row"><button type="button" class="btn" id="notesSave">💾 ${esc(t.save)}</button>
          <button type="button" class="btn danger" id="ntDelete" style="display:none">🗑 ${esc(t.del)}</button>
          <button type="button" class="btn ghost" id="ntExportMd">↓ MD</button><button type="button" class="btn ghost" id="ntExportTxt">↓ TXT</button>
          <span id="ntUpdated" style="color:#64748b;font-size:.7rem"></span></div>
      </section>
    </div>`;
  const cfg = { mode: "notes", T: t, notes: Array.isArray(notesIndex) ? notesIndex : [], uploadSupported: !!uploadSupported, uploadMax: MAX_UPLOAD_BYTES };
  return renderCmsShell({
    lang, siteTitle, title: t.notesTitle, description: t.notesHint, noindex: true, wide: true,
    nav: renderCmsNav("notes", lang, caps, true, siteTitle), body,
    scripts: `<script>${NAME_SHIM}\n${markdownToHtml.toString()}\n${cmsEditorInit.toString()}\ncmsEditorInit(${safeJsonForScript(cfg)});</script>`
  });
}

function renderPagesManager(index, ctx) {
  const { lang, siteTitle, caps, uploadSupported, editSlug } = ctx;
  const t = CMS_T[lang];
  const body = `<h1 style="font-family:Orbitron,sans-serif;font-size:1.2rem;color:#fff">${esc(t.managerTitle)}</h1>
    <div class="ed-grid">
      <aside class="ed-side"><button type="button" class="btn" id="pgNew" style="width:100%;justify-content:center;margin-bottom:10px">${esc(t.newPage)}</button><div id="pgList"></div></aside>
      <section class="ed-main" id="pgEditor" style="display:none">
        <div class="fld"><label for="pgSlug">${esc(t.slugLbl)}</label><input type="text" id="pgSlug" maxlength="64" autocomplete="off" spellcheck="false"></div>
        <div class="tabs"><button type="button" class="btn active" id="tabId">${esc(t.tabId)}</button><button type="button" class="btn" id="tabEn">${esc(t.tabEn)}</button></div>
        <div class="fld"><label for="pgTitle">${esc(t.titleLbl)}</label><input type="text" id="pgTitle" maxlength="200"></div>
        <div class="fld"><label for="pgDesc">${esc(t.descLbl)}</label><input type="text" id="pgDesc" maxlength="300"></div>
        <div class="fld"><label>${esc(t.contentLbl)}</label>${editorMarkup(t, uploadSupported)}</div>
        <div class="row"><label class="sw"><input type="checkbox" id="pgPublic" checked> ${esc(t.publicLbl)}</label>
          <button type="button" class="btn" id="pgSave">💾 ${esc(t.save)}</button>
          <a class="btn ghost" id="pgView" href="#" target="_blank" rel="noopener" style="display:none">↗ ${esc(t.view)}</a>
          <button type="button" class="btn danger" id="pgDelete" style="display:none">🗑 ${esc(t.del)}</button></div>
      </section>
    </div>`;
  const cfg = { mode: "pages", T: t, pages: index, uploadSupported: !!uploadSupported, uploadMax: MAX_UPLOAD_BYTES, editSlug: editSlug || "" };
  return renderCmsShell({
    lang, siteTitle, title: t.managerTitle, description: t.managerTitle, noindex: true, wide: true,
    nav: renderCmsNav("pages", lang, caps, true, siteTitle), body,
    scripts: `<script>${NAME_SHIM}\n${markdownToHtml.toString()}\n${cmsEditorInit.toString()}\ncmsEditorInit(${safeJsonForScript(cfg)});</script>`
  });
}

function renderSitemap(origin, caps, pagesIndex) {
  const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const urls = [{ loc: origin + "/", lastmod: null }];
  if (caps.cms) {
    urls.push({ loc: origin + "/pages", lastmod: null });
    pagesIndex.filter(p => p.isPublic !== false).forEach(p => urls.push({ loc: origin + "/p/" + p.slug, lastmod: p.updatedAt ? new Date(p.updatedAt).toISOString() : null }));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`).join("\n") + `\n</urlset>\n`;
}

// ============================================================
// REQUEST HELPERS: rate limit, cookies, auth, ping, uploads
// ============================================================
const SETTINGS_KEY = "sys_settings_synapse_v1";
const SERVERS_KEY = "servers_synapse_data_v1";

// In-memory sliding counters. Exact on Node; per-isolate (approximate) on Workers, which is the right
// trade-off for a read-only public API (a KV write per request would burn the free quota).
const _memHits = new Map();
function memRateLimit(key, max, windowSec) {
  const now = Date.now();
  const e = _memHits.get(key);
  if (!e || e.reset <= now) {
    if (_memHits.size > 5000) {
      for (const [k, v] of _memHits) if (v.reset <= now) _memHits.delete(k);
      if (_memHits.size > 5000) _memHits.clear();
    }
    _memHits.set(key, { count: 1, reset: now + windowSec * 1000 });
    return { ok: true, retryAfter: 0 };
  }
  e.count++;
  return { ok: e.count <= max, retryAfter: Math.max(1, Math.ceil((e.reset - now) / 1000)) };
}


function accessIP(v){
 v=String(v).toLowerCase();if(v.startsWith('::ffff:')&&v.includes('.'))v=v.slice(7);
 if(/^\d+\.\d+\.\d+\.\d+$/.test(v)){const a=v.split('.');if(a.some(x=>Number(x)>255||String(Number(x))!==x))throw Error('Invalid IPv4');return {bits:32,n:a.reduce((n,x)=>(n<<8n)+BigInt(x),0n)};}
 if(!/^[0-9a-f:]+$/.test(v)||!v.includes(':'))throw Error('Invalid IP');
 const sides=v.split('::');if(sides.length>2)throw Error('Invalid IPv6');const l=sides[0]?sides[0].split(':'):[],r=sides.length===2&&sides[1]?sides[1].split(':'):[];
 let a;if(sides.length===1){a=l;if(a.length!==8)throw Error('Invalid IPv6')}else{if(l.length+r.length>=8)throw Error('Invalid IPv6');a=[...l,...Array(8-l.length-r.length).fill('0'),...r];}
 if(a.some(x=>!/^[0-9a-f]{1,4}$/.test(x)))throw Error('Invalid IPv6');return {bits:128,n:a.reduce((n,x)=>(n<<16n)+BigInt('0x'+x),0n)};
}
function accessRange(v){const a=v.split('/');if(a.length>2)throw Error('Invalid subnet');const ip=accessIP(a[0]);const prefix=a.length===1?ip.bits:Number(a[1]);if(a.length===2&&!/^\d+$/.test(a[1])||!Number.isInteger(prefix)||prefix<0||prefix>ip.bits)throw Error('Invalid prefix');return {...ip,prefix};}
function accessAllowed(ip,list){if(!list||!list.length)return true;try{const x=accessIP(ip);return list.some(v=>{const r=accessRange(v),shift=BigInt(r.bits-r.prefix);return r.bits===x.bits&&(x.n>>shift)===(r.n>>shift)})}catch(e){return false}}
async function accessDigest(token){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),x=>x.toString(16).padStart(2,'0')).join('');}

function getClientIP(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Real-IP") || "unknown";
}

function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  });
  return out;
}

function clearCookieHeader(isHttps) {
  return "auth_session=; " + cookieAttrs(isHttps) + "; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
}

// ---------- PASSWORD HASHING (PBKDF2-SHA256; 100k iterations is the Workers maximum) ----------
const PBKDF2_ITER = 100000;
function b64(bytes) { let s = ""; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); }
function unb64(str) { const s = atob(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}
async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  // Falls back to fewer iterations if the runtime rejects / cannot afford 100k (e.g. tight CPU limits).
  let iter = PBKDF2_ITER, h = null, lastErr = null;
  for (const it of [PBKDF2_ITER, 50000, 10000]) {
    try { h = await pbkdf2(String(password), salt, it); iter = it; break; } catch (e) { lastErr = e; }
  }
  if (!h) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b64(salt) + String(password))));
    void lastErr;
    return "sha256$1$" + b64(salt) + "$" + b64(d);
  }
  return "pbkdf2$" + iter + "$" + b64(salt) + "$" + b64(h);
}
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length === 4 && parts[0] === "sha256") {
      const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts[2] + String(password))));
      const want = unb64(parts[3]);
      let diff = d.length ^ want.length;
      for (let i = 0; i < d.length && i < want.length; i++) diff |= d[i] ^ want[i];
      return diff === 0;
    }
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iter = Math.min(parseInt(parts[1], 10) || PBKDF2_ITER, PBKDF2_ITER);
    const h = await pbkdf2(String(password), unb64(parts[2]), iter);
    const want = unb64(parts[3]);
    if (want.length !== h.length) return false;
    let diff = 0;
    for (let i = 0; i < h.length; i++) diff |= h[i] ^ want[i];
    return diff === 0;
  } catch (e) { return false; }
}

// ---------- SETTINGS ----------
function defaultCapabilities() { return { ping: true, archive: true, cms: false, api: false }; }

// Fill missing fields with defaults. Returns true when anything had to be repaired.
function normalizeSettings(s) {
  let changed = false;
  const def = (k, v) => { if (s[k] === undefined || s[k] === null) { s[k] = v; changed = true; } };
  def("adminUser", DEFAULT_USER);
  def("pingRule34Active", true);
  def("autoPingIntervalEnabled", false);
  def("autoPingIntervalSeconds", 30);
  def("displayMode", "list");
  def("activeCategoryFilter", "ALL");
  def("activeSort", "recently");
  def("siteTitle", "Synapse Grid 34");
  def("announcementNote", "📢 **PENGUMUMAN:** Silakan tambahkan node atau item melalui panel admin.");
  def("sessionVersion", 0);
  def("webhookUrl", "");
  def("lockdownMode", false);
  def("turnstileSiteKey", "");
  def("turnstileSecretKey", "");
  def("autoBackupEnabled", true);
  def("autoBackupRetentionDays", 30);
  def("runtimeProfile", "worker");
  if (!["auto", "memory", "shared"].includes(s.pingCacheMode)) { s.pingCacheMode = "auto"; changed = true; }
  if (!s.publicColumns || typeof s.publicColumns !== "object") { s.publicColumns = { showCustomLink: true, customFields: {} }; changed = true; }
  if (!s.publicColumns.customFields || typeof s.publicColumns.customFields !== "object") { s.publicColumns.customFields = {}; changed = true; }
  if (!s.capabilities || typeof s.capabilities !== "object") { s.capabilities = defaultCapabilities(); changed = true; }
  s.capabilities = {
    ping: s.capabilities.ping !== false,
    archive: s.capabilities.archive !== false,
    cms: s.capabilities.cms === true,
    api: s.capabilities.api === true
  };
  if (!s.adminUser) s.adminUser = DEFAULT_USER;
  if (!s.autoPingIntervalSeconds) s.autoPingIntervalSeconds = 30;
  if (!s.displayMode) s.displayMode = "list";
  if (!s.activeSort) s.activeSort = "recently";
  if (!s.siteTitle) s.siteTitle = "Synapse Grid 34";
  return changed;
}

// ---------- PING ----------
function isPrivateIp(ip) {
  ip = String(ip).toLowerCase();
  if (ip.includes(":")) {
    // Canonicalize IPv6 before classifying mapped IPv4 and local ranges.
    try { ip = new URL("http://[" + ip + "]/").hostname.slice(1, -1); } catch (e) { return true; }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (mapped) {
      const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
      return isPrivateIp([hi >> 8, hi & 255, lo >> 8, lo & 255].join("."));
    }
  }
  const m4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m4) {
    const a = +m4[1], b = +m4[2];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (ip.indexOf(":") >= 0) return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  return false;
}

// On Node a public hostname could resolve to a LAN address (e.g. 127.0.0.1.nip.io). Cloudflare Workers
// cannot reach private ranges, so this guard only matters for the VPS / Local runtimes.
async function resolvesToPrivate(host) {
  if (!isNodeRuntime()) return false;
  let timer;
  try {
    const addrs = await Promise.race([
      require("dns").promises.lookup(host, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 3000); })
    ]);
    return addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address));
  } catch (e) { return true; }
  finally { clearTimeout(timer); }
}

// Node HTTPS requests use a validated, pinned address; Host/SNI remain the original name.
// Workers retain native fetch. Redirects are never followed by this transport.
async function publicFetch(input, init = {}) {
 if (!isNodeRuntime()) return fetch(input, init);
 const u = new URL(input);
 if (u.protocol !== 'https:' || u.username || u.password) throw Error('Invalid HTTPS destination');
 if (init.redirect !== 'manual' && init.redirect !== 'error') throw Error('Explicit redirect policy required');
 const dns = require('dns'), net = require('net');
 const host = u.hostname.replace(/^\[|\]$/g, '');
 let timer;
 const addresses = await Promise.race([
  net.isIP(host) ? Promise.resolve([{address:host,family:net.isIP(host)}]) : dns.promises.lookup(host,{all:true}),
  new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DNS timeout')),3000);})
 ]).finally(()=>clearTimeout(timer));
 if (!addresses.length || addresses.some(a=>!tcpPublicAddress(a.address))) throw Error('Blocked destination');
 const target = addresses[0];
 return new Promise((resolve,reject)=>{
  let req, done=false;
  const signal=init.signal;
  const finish=(err,value)=>{if(done)return;done=true;signal?.removeEventListener('abort',abort);if(err){req?.destroy();reject(err);}else resolve(value);};
  const abort=()=>finish(Error('Request aborted'));
  if(signal?.aborted)return abort();
  signal?.addEventListener('abort',abort,{once:true});
  try {
   req=require('https').request(u,{method:init.method||'GET',headers:init.headers,agent:false,
    lookup:(_hostname,options,cb)=>options.all ? cb(null,[target]) : cb(null,target.address,target.family)
   },res=>{
    const status=res.statusCode;
    if(init.redirect==='error' && [301,302,303,307,308].includes(status)){res.destroy();return finish(Error('Redirect rejected'));}
    if (init.sgDiscardBody) {
     try { const headers=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i],res.rawHeaders[i+1]);
      finish(null,new Response(null,{status,headers}));res.destroy();
     } catch(e) {res.destroy();finish(e);}return;
    }
    const chunks=[];let size=0;
    res.on('data',chunk=>{size+=chunk.length;if(size>1048576){res.destroy();finish(Error('Upstream body too large'));}else chunks.push(chunk);});
    res.on('error',e=>finish(e));res.on('aborted',()=>finish(Error('Response aborted')));
    res.on('end',()=>{try{const headers=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2)headers.append(res.rawHeaders[i],res.rawHeaders[i+1]);
     const body=init.method==='HEAD'||[204,205,304].includes(status)?null:Buffer.concat(chunks);
     finish(null,new Response(body,{status,headers}));}catch(e){finish(e);}});
   });
   req.on('error',e=>finish(e));
   req.end(init.body===undefined?undefined:init.body);
  }catch(e){finish(e);}
 });
}

// Scheduled monitoring: one aggregate write per 5-minute round, max 10 explicit hosts.
let _uptimeQueue = Promise.resolve();
function recordUptimeBatch(KV, results, now = Date.now()) {
 const task=_uptimeQueue.catch(()=>{}).then(async()=>{
  const month=new Date(now).toISOString().slice(0,7),key='uptime_v1:'+month;
  const row=await KV.get(key,{type:'json'})||{month,hosts:{}};
  const bucket=Math.floor(now/300000);
  if(row.scheduledBucket===bucket)return;
  for(const [host,online] of results){
   if(!HOST_RE.test(host)||typeof online!=='boolean')continue;
   if(!row.hosts[host]&&Object.keys(row.hosts).length>=100)continue;
   const h=row.hosts[host]||{up:0,total:0,first:now};
   h.total++;if(online)h.up++;h.last=now;
   h.scheduledTotal=(h.scheduledTotal||0)+1;
   h.scheduledUp=(h.scheduledUp||0)+(online?1:0);row.hosts[host]=h;
  }
  row.scheduledBucket=bucket;
  await KV.put(key,JSON.stringify(row),{expirationTtl:34560000});
 });_uptimeQueue=task;return task;
}
function recordUptime(KV,host,online,now){return recordUptimeBatch(KV,[[host,online]],now);}
async function handleScheduledUptime(event,env){
 const KV=createStore(env);if(!KV)return;
 const settings=await KV.get(SETTINGS_KEY,{type:'json'});
 if(!settings||!settings.uptimeEnabled||settings.lockdownMode||!settings.capabilities||!settings.capabilities.ping)return;
 const hosts=Array.isArray(settings.uptimeHosts)?settings.uptimeHosts:[];
 if(!hosts.length||hosts.length>10||hosts.some(h=>!HOST_RE.test(h)))return;
 const now=Date.now(),month=new Date(now).toISOString().slice(0,7);
 const previous=await KV.get('uptime_v1:'+month,{type:'json'});
 if(previous&&previous.scheduledBucket===Math.floor(now/300000))return;
 const results=[];
 // Limit fan-out and outbound requests on Workers Free.
 for(let i=0;i<hosts.length;i+=2){
  results.push(...await Promise.all(hosts.slice(i,i+2).map(async h=>[h,await probeHost(h)])));
 }
 await recordUptimeBatch(KV,results,now);
}
// Admin-only TCP connect; no payload and no UDP/WireGuard health claim.
function tcpPublicAddress(address){
 if(isPrivateIp(address))return false;
 const net=require('net');
 if(net.isIP(address)===4){const a=address.split('.').map(Number);return !(a[0]===192&&a[1]===0 || a[0]===198&&a[1]===51 || a[0]===203&&a[1]===0);}
 // Conservative IPv6: only global unicast, excluding documentation ranges.
 return net.isIP(address)===6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}
async function tcpProbe(host,port){
 if(!isNodeRuntime())return {status:'unsupported'};
 if(!HOST_RE.test(host)||!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid target');
 let timer;
 const addresses=await Promise.race([require('dns').promises.lookup(host,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DNS timeout')),3000);})]).finally(()=>clearTimeout(timer));
 if(!addresses.length||addresses.some(a=>!tcpPublicAddress(a.address)))throw Error('Blocked address');
 const target=addresses[0],started=Date.now();
 return new Promise(resolve=>{
  const socket=new (require('net').Socket)();let done=false;
  const finish=status=>{if(done)return;done=true;socket.destroy();resolve({status,latencyMs:Date.now()-started,transport:'tcp',scope:'connect_only'});};
  socket.setTimeout(3000);socket.once('timeout',()=>finish('timeout'));socket.once('error',()=>finish('closed_or_unreachable'));socket.once('connect',()=>finish('open'));
  try{socket.connect({host:target.address,family:target.family,port});}catch(e){finish('closed_or_unreachable');}
 });
}
async function probeHost(host) {
  if (await resolvesToPrivate(host)) return false;
  const attempt = async (init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await publicFetch("https://" + host, Object.assign({ redirect: "manual", sgDiscardBody: true, signal: controller.signal }, init));
      try { if (res.body) await res.body.cancel(); } catch (e) {}
      return res.status < 500;
    } catch (e) { return null; }
    finally { clearTimeout(timer); }
  };
  let ok = await attempt({ method: "HEAD" });
  if (ok === null) ok = await attempt({ method: "GET", headers: { Range: "bytes=0-0" } });
  return ok === true;
}
// ---------- UPLOAD INDEX (single KV key; blob stores cannot be listed portably) ----------
async function getUploadsIndex(KV) {
  const idx = await KV.get("uploads_index_v1", { type: "json" });
  return Array.isArray(idx) ? idx.filter((e) => e && UPLOAD_NAME_RE.test(e.name)) : [];
}
async function saveUploadsIndex(KV, idx) {
  await KV.put("uploads_index_v1", JSON.stringify(idx));
}

// ---------- RESPONSE HEADER SETS ----------
function htmlHeaders(settings, extra) {
  const ts = settings && settings.turnstileSiteKey ? " https://challenges.cloudflare.com" : "";
  return Object.assign({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache", "Expires": "0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; script-src 'self' 'unsafe-inline'" + ts + "; frame-src 'self'" + ts + "; connect-src 'self'" + ts + "; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none';"
  }, extra || {});
}

// Public viewer for /s/<id>. Fetch is a POST triggered by a button so link previews/prefetchers cannot burn a read-once secret.
function renderSecretViewer(id, lang) {
  const en = lang === "en";
  const L = { title: en ? "Encrypted secret" : "Secret terenkripsi", open: en ? "Reveal secret" : "Tampilkan secret",
    warn: en ? "If this secret is read-once, it is deleted after you reveal it." : "Jika secret ini sekali-baca, ia dihapus setelah ditampilkan.",
    gone: en ? "Secret not found, expired, or already read." : "Secret tidak ditemukan, kedaluwarsa, atau sudah dibaca.",
    nokey: en ? "The decryption key (#part of the link) is missing." : "Kunci dekripsi (bagian # pada tautan) tidak ada.",
    bad: en ? "Decryption failed: wrong or damaged link." : "Dekripsi gagal: tautan salah atau rusak.", network: en ? "Request failed. A read-once secret may already have been consumed. Retry carefully." : "Permintaan gagal. Secret sekali-baca mungkin sudah terpakai. Coba ulang dengan hati-hati.", copied: en ? "Copied." : "Tersalin.", copyfail: en ? "Copy failed. Select and copy the text manually." : "Gagal menyalin. Pilih dan salin teks secara manual.", copy: en ? "Copy" : "Salin" };
  const js = `(function(){var L=${safeJsonForScript(L)},ID=${safeJsonForScript(id)};
function d64(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u;}
var m=document.getElementById('m'),o=document.getElementById('o');
document.getElementById('go').onclick=async function(){var btn=this;btn.disabled=true;var key=location.hash.slice(1),k;
 if(!key){m.textContent=L.nokey;btn.disabled=false;return;}
 try{var raw=d64(key);if(raw.length!==32)throw Error('key');k=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);}
 catch(e){m.textContent=L.bad;btn.disabled=false;return;}
 var d;
 try{var r=await fetch('/api/paste_open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:ID})});
 if(!r.ok){m.textContent=r.status>=500?L.network:L.gone;btn.disabled=r.status<500;return;}d=await r.json();}
 catch(e){m.textContent=L.network;btn.disabled=false;return;}
 try{var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:d64(d.iv)},k,d64(d.ct));o.value=new TextDecoder().decode(pt);o.hidden=false;document.getElementById('cp').hidden=false;m.textContent='';}
 catch(e){m.textContent=L.bad;}};
 document.getElementById('cp').onclick=async function(){try{if(!navigator.clipboard)throw Error('clipboard');await navigator.clipboard.writeText(o.value);m.textContent=L.copied;}catch(e){m.textContent=L.copyfail;o.focus();o.select();}};})();`;
  return `<!doctype html><html lang="${en ? "en" : "id"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(L.title)}</title>
<style>${CMS_CSS}
[hidden]{display:none!important}</style></head>
<body><main class="cms-wrap"><article class="cms-article"><h1>${esc(L.title)}</h1><p><small>${esc(L.warn)}</small></p><p><button class="btn" id="go">${esc(L.open)}</button></p><p id="m" role="status" aria-live="polite"></p><div class="fld"><textarea id="o" aria-label="${esc(L.title)}" rows="12" readonly hidden></textarea></div><p><button class="btn ghost" id="cp" hidden>${esc(L.copy)}</button></p></article></main><script>${js}</script></body></html>`;
}

// Gateway configuration lives separately from public settings and exports.
async function gatewayConfig(KV) { return await KV.get('gateway_v1', {type:'json'}) || {enabled:false, secret:'', targets:[], template:'{{source}}: {{event}}\n{{summary}}'}; }
async function gatewayMac(secret, text) {
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
function validateGateway(c) {
 if(!c || typeof c.enabled!=='boolean' || typeof c.secret!=='string' || c.secret.length<24 || c.secret.length>256) throw Error('Secret must be 24–256 characters');
 if(!Array.isArray(c.targets)||c.targets.length>4) throw Error('Maximum 4 destinations');
 const targets=c.targets.map(t=>{
  if(!t||!['discord','telegram','ntfy','github'].includes(t.type))throw Error('Invalid destination type');
  if(t.type==='github') {
   if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t.repo||'')||! /^[A-Za-z0-9_.-]{1,100}$/.test(t.event||'')||! /^[A-Za-z0-9_]{20,256}$/.test(t.token||''))throw Error('Invalid GitHub repository/event/token');
   return {type:t.type,repo:t.repo,event:t.event,token:t.token};
  }
  if(t.type==='telegram') {
   if(!/^\d+:[A-Za-z0-9_-]{20,100}$/.test(t.token||'')||! /^-?\d{1,20}$/.test(t.chat||''))throw Error('Invalid Telegram token/chat');
   return {type:t.type,token:t.token,chat:t.chat};
  }
  let u;try{u=new URL(t.url)}catch(e){throw Error('Invalid URL')}
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search||u.port)throw Error('HTTPS URL required without credentials/query/port');
  if(t.type==='discord' && (u.hostname!=='discord.com'||!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(u.pathname)))throw Error('Expected official Discord webhook URL');
  if(t.type==='ntfy' && (u.hostname!=='ntfy.sh'||!/^\/[A-Za-z0-9_-]{1,128}$/.test(u.pathname)))throw Error('Expected https://ntfy.sh/topic');
  return {type:t.type,url:u.href};
 });
 return {enabled:c.enabled,secret:c.secret,targets,template:typeof c.template==='string'?c.template.slice(0,2000):'{{source}}: {{event}}\n{{summary}}'};
}
function gatewayMessage(source,event,data,template) {
 let summary=source==='github'?String(data.action||data.head_commit?.message||data.repository?.full_name||event):source==='alertmanager'?String(data.commonAnnotations?.summary||data.commonLabels?.alertname||data.status||event):String(data.msg||data.message||data.heartbeat?.msg||event);
 const values={source,event,summary:summary.slice(0,1200)};
 return template.replace(/\{\{(source|event|summary)\}\}/g,(_,k)=>values[k]).slice(0,1800);
}
async function gatewaySend(t,message,source,event) {
 let url,body,headers={'Content-Type':'application/json'};
 if(t.type==='discord'){url=t.url;body={content:message,allowed_mentions:{parse:[]}};}
 if(t.type==='telegram'){url='https://api.telegram.org/bot'+t.token+'/sendMessage';body={chat_id:t.chat,text:message};}
 if(t.type==='ntfy'){url=t.url;headers={'Content-Type':'text/plain; charset=utf-8'};body=message;}
 if(t.type==='github'){url='https://api.github.com/repos/'+t.repo+'/dispatches';headers.Authorization='Bearer '+t.token;headers.Accept='application/vnd.github+json';headers['X-GitHub-Api-Version']='2022-11-28';headers['User-Agent']='SynapseGrid';body={event_type:t.event,client_payload:{source,event,message}};}
 const u=new URL(url);if(await resolvesToPrivate(u.hostname))throw Error('Destination blocked');
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),7000);
 try{const r=await publicFetch(url,{method:'POST',redirect:'error',sgDiscardBody:true,signal:ctrl.signal,headers,body:typeof body==='string'?body:JSON.stringify(body)});try{await r.body?.cancel()}catch(e){}return {type:t.type,ok:r.ok,status:r.status};}finally{clearTimeout(timer)}
}


function validateProvision(c) {
 if(!c||typeof c.enabled!=='boolean'||typeof c.keys!=='string'||typeof c.script!=='string')throw Error('Expected enabled, keys, script');
 if(c.keys.length>32768||c.script.length>65536)throw Error('Content too large');
 const lines=c.keys.replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean);
 if(lines.length>100)throw Error('Maximum 100 public keys');
 for(const line of lines){
  if(!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\x00-\x1f\x7f]*)?$/.test(line))throw Error('Only plain SSH public keys accepted; no private keys or authorized_keys options');
  const [type,b64]=line.split(' ');let raw;try{raw=atob(b64)}catch(e){throw Error('Invalid public key encoding')}
  let offset=0;
  const field=()=>{
   if(offset+4>raw.length)throw Error('Truncated SSH key');
   const n=raw.charCodeAt(offset)*16777216+(raw.charCodeAt(offset+1)<<16)+(raw.charCodeAt(offset+2)<<8)+raw.charCodeAt(offset+3);offset+=4;
   if(n>raw.length-offset)throw Error('Truncated SSH key field');
   const value=raw.slice(offset,offset+n);offset+=n;return value;
  };
  if(field()!==type)throw Error('Invalid SSH key type/blob');
  if(type==='ssh-ed25519'){if(field().length!==32)throw Error('Invalid Ed25519 key length');}
  else if(type==='ssh-rsa'){
   for(let i=0;i<2;i++){const v=field();if(!v.length||(v.charCodeAt(0)&128)||v.charCodeAt(0)===0&&(v.length===1||!(v.charCodeAt(1)&128)))throw Error('Invalid RSA positive mpint');}
  }else{
   const curve=type.slice(11),sizes={nistp256:65,nistp384:97,nistp521:133};
   if(field()!==curve)throw Error('Invalid ECDSA curve');
   const point=field();if(point.length!==sizes[curve]||point.charCodeAt(0)!==4)throw Error('Invalid ECDSA point encoding');
  }
  if(offset!==raw.length)throw Error('Trailing SSH key data');
 }
 if(c.script.includes('\x00'))throw Error('NUL is not allowed');
 return {enabled:c.enabled,keys:lines.length?lines.join('\n')+'\n':'',script:c.script.replace(/\r\n/g,'\n')};
}

function cmsHeaders(cacheable, extra) {
  return Object.assign({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": cacheable ? "public, max-age=60" : "no-store",
    "Vary": "Cookie",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';"
  }, extra || {});
}

// Public-safe copy of settings for the page: no credentials, no webhook, no hidden hosts.
function buildViewSettings(settings, isAdmin, viewServers) {
  const hosts = new Set(viewServers.map((s) => s.host).filter(Boolean));
  const selection = (settings.pingSelection || []).filter((h) => hosts.has(h));
  const out = {
    siteTitle: settings.siteTitle, announcementNote: settings.announcementNote,
    displayMode: settings.displayMode, activeSort: settings.activeSort,
    pingSelection: selection, pingRule34Active: settings.pingRule34Active !== false,
    autoPingIntervalEnabled: !!settings.autoPingIntervalEnabled, autoPingIntervalSeconds: settings.autoPingIntervalSeconds || 30,
    publicColumns: settings.publicColumns, lockdownMode: !!settings.lockdownMode,
    turnstileSiteKey: settings.turnstileSiteKey || "", capabilities: settings.capabilities,
    runtimeProfile: settings.runtimeProfile || "worker",
    webhookUrl: "", turnstileSecretKey: "", autoBackupEnabled: true, autoBackupRetentionDays: 30
  };
  if (isAdmin) {
    out.webhookUrl = settings.webhookUrl || "";
    out.turnstileSecretKey = settings.turnstileSecretKey ? "set" : "";
    out.autoBackupEnabled = settings.autoBackupEnabled !== false;
    out.autoBackupRetentionDays = settings.autoBackupRetentionDays || 30;
    out.pingCacheMode = ["auto", "memory", "shared"].includes(settings.pingCacheMode) ? settings.pingCacheMode : "auto";
  }
  return out;
}

function safeFilePart(v) { return String(v || "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").substring(0, 60) || "export"; }

// Works for both the new hash and a legacy plaintext password that has not been upgraded yet.
// First-run credentials (fresh install only; existing installs keep whatever is stored).
//  - ADMIN_USER / ADMIN_PASSWORD (env var or Worker secret) win when set.
//  - Node/VPS without them: a random password is generated and printed once to the console.
//  - Worker without them: falls back to the documented default plus the in-app warning banner. A random password
//    cannot be shown safely there (a public page would let the first visitor claim the admin account).
let _bootCred = null;
function bootstrapCredentials(env) {
  if (_bootCred) return _bootCred;
  const envUser = String(safeBinding("ADMIN_USER", env) || (isNodeRuntime() && process.env.ADMIN_USER) || "").trim();
  const envPass = String(safeBinding("ADMIN_PASSWORD", env) || (isNodeRuntime() && process.env.ADMIN_PASSWORD) || "");
  const user = /^[A-Za-z0-9_.@-]{1,64}$/.test(envUser) ? envUser : DEFAULT_USER;
  if (envPass.length >= 8) { _bootCred = { user, pass: envPass, isDefault: false }; return _bootCred; }
  if (isNodeRuntime()) {
    const pass = randomHex(8);
    _bootCred = { user, pass, isDefault: false };
    console.log("[Synapse] First run: generated admin credentials -> user: " + user + "  password: " + pass + "  (shown once; change it in Settings)");
    return _bootCred;
  }
  _bootCred = { user, pass: DEFAULT_PASS, isDefault: true };
  return _bootCred;
}
async function checkAdminPassword(settings, password) {
  if (settings.adminPassHash) return verifyPassword(password, settings.adminPassHash);
  return safeEqual(password, String(settings.adminPass === undefined ? "" : settings.adminPass));
}

// ============================================================
// MAIN
// ============================================================
let _blobStore;
// Isolate-local ping cache (plain strings only). Lost on cold start, which only costs one extra probe.
const _pingMem = new Map();
function pingMemGet(host) {
  const e = _pingMem.get(host);
  if (!e) return null;
  if (e.exp <= Date.now()) { _pingMem.delete(host); return null; }
  return e.v;
}
function pingMemSet(host, v) {
  if (_pingMem.size >= 500) {
    const now = Date.now();
    for (const [k, e] of _pingMem) if (e.exp <= now) _pingMem.delete(k);
    if (_pingMem.size >= 500) _pingMem.clear();
  }
  _pingMem.set(host, { v, exp: Date.now() + PING_CACHE_TTL * 1000 });
}
// "auto": share the cache through storage only when that is cheap (not Workers KV on the light worker profile).
function pingCacheIsShared(settings, store) {
  const mode = settings.pingCacheMode;
  if (mode === "shared") return true;
  if (mode === "memory") return false;
  return !(store.kind === "kv" && (settings.runtimeProfile || "worker") === "worker");
}
let _pingAllow = null; // plain data only (never promises / I/O objects: Workers forbid sharing those across requests)
function getBlobStore(env) {
  if (_blobStore === undefined) {
    try { _blobStore = createBlobStore(env) || null; } catch (e) { console.error("[Blob] unavailable:", e); _blobStore = null; }
  }
  return _blobStore;
}

// ---------- MODULE REGISTRY (admin tools) ----------
// Single source of truth: which runtime profiles a tool supports and what it costs.
// Safeguards only WARN. Nothing is ever switched off automatically; the owner decides.
// null = no fixed cap (depends on the host / plan).
const ENV_LIMITS = {
  worker:  { cpuMs: 10,    subrequests: 50,   kvWritesPerDay: 1000, kvReadsPerDay: 100000, requestsPerDay: 100000 }, // Workers Free + KV Free
  managed: { cpuMs: 30000, subrequests: 1000, kvWritesPerDay: null, kvReadsPerDay: null,   requestsPerDay: null },   // paid plan defaults
  vps:     { cpuMs: null,  subrequests: null, kvWritesPerDay: null, kvReadsPerDay: null,   requestsPerDay: null },
  local:   { cpuMs: null,  subrequests: null, kvWritesPerDay: null, kvReadsPerDay: null,   requestsPerDay: null }
};
// status: "ready" | "planned". env: false = not supported on that profile. kvWritesDay: expected KV writes per day.
const TOOL_MODULES = [
  { id: "cidr", status: "ready", href: "/tools/cidr", env: { worker: true, managed: true, vps: true, local: true }, kvWritesDay: 0,
    name: { id: "Kalkulator CIDR", en: "CIDR Calculator" },
    note: { id: "IPv4/IPv6: jaringan, netmask, host, pecah subnet, cek keanggotaan. Murni di browser.", en: "IPv4/IPv6: network, netmask, hosts, subnet split, membership check. Browser-only." } },
  { id: "epoch", status: "ready", href: "/tools/epoch", env: { worker: true, managed: true, vps: true, local: true }, kvWritesDay: 0,
    name: { id: "Konverter Epoch", en: "Epoch Converter" },
    note: { id: "Epoch detik/ms/mikro/nano ke tanggal dan sebaliknya, zona waktu, waktu relatif. Murni di browser.", en: "Epoch seconds/ms/micro/nano to date and back, time zones, relative time. Browser-only." } },
{ id: "json", status: "ready", href: "/tools/json", env: { worker: true, managed: true, vps: true, local: true }, kvWritesDay: 0,
    name: { id: "Formatter JSON", en: "JSON Formatter" },
    note: { id: "Rapikan, padatkan, validasi (dengan baris/kolom error), urutkan kunci; angka besar tidak dibulatkan. Murni di browser.", en: "Format, minify, validate (with line/column errors), sort keys; big numbers are not rounded. Browser-only." } },
  { id: "cron", status: "ready", href: "/tools/cron", env: { worker: true, managed: true, vps: true, local: true }, kvWritesDay: 0,
    name: { id: "Parser Cron", en: "Cron Parser" },
    note: { id: "Validasi cron 5 field gaya Cloudflare (L, W, #, 1=Minggu) dan hitung jadwal berikutnya dalam UTC. Murni di browser.", en: "Validate Cloudflare-style 5-field cron (L, W, #, 1=Sunday) and compute upcoming runs in UTC. Browser-only." } },
  { id: "regex", status: "ready", href: "/tools/regex", env: { worker: true, managed: true, vps: true, local: true }, kvWritesDay: 0,
    name: { id: "Penguji Regex", en: "Regex Tester" },
    note: { id: "Uji regex JavaScript: kecocokan, grup (termasuk bernama), flag, dan penggantian. Murni di browser; ada batas ukuran input.", en: "Test JavaScript regex: matches, groups (including named), flags and replacement. Browser-only; input size is capped." } },
  { id: "curl", status: "ready", href: "/tools/curl", env: { worker: true, managed: true, vps: true, local: true }, kvWritesDay: 0,
    name: { id: "Pembuat Perintah curl", en: "curl Command Builder" },
    note: { id: "Susun perintah curl (atau kode fetch) dari formulir, atau muat perintah curl yang sudah ada ke formulir. Murni di browser; kutip gaya POSIX.", en: "Build a curl command (or fetch code) from a form, or load an existing curl command into the form. Browser-only; POSIX quoting." } },
  { id: "ssh-config", status: "ready", href: "/tools/ssh-config", env: { worker: true, managed: true, vps: true, local: true }, kvWritesDay: 0,
    name: { id: "Pembuat SSH Config", en: "SSH Config Builder" },
    note: { id: "Susun blok Host untuk ~/.ssh/config: HostName, User, Port, kunci, ProxyJump, forward port, keepalive. Murni di browser; tanpa kolom teks bebas.", en: "Build a Host block for ~/.ssh/config: HostName, User, Port, key, ProxyJump, port forwards, keepalive. Browser-only; no free-text field." } },
  { id: "tunnel", status: "ready", href: "/tools/tunnel", env: { worker: true, managed: true, vps: true, local: true }, kvWritesDay: 0,
    name: { id: "Pembuat Tunnel", en: "Tunnel Builder" },
    note: { id: "Susun perintah ssh -N dengan forward port (-L/-R/-D) atau config.yml ingress Cloudflare Tunnel. Hanya menghasilkan teks; murni di browser; kutip gaya POSIX.", en: "Build an ssh -N command with port forwards (-L/-R/-D) or a Cloudflare Tunnel ingress config.yml. Text output only; browser-only; POSIX quoting." } },
{"id": "export", "status": "ready", "href": "/tools/export", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Export MD/TXT", "en": "Export MD/TXT"}, "note": {"id": "Konversi JSON ekspor menjadi dokumen MD/TXT di browser; tanpa membaca KV.", "en": "Convert export JSON to MD/TXT in browser; no KV reads."}},
  {"id": "converter", "status": "ready", "href": "/tools/converter", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Konverter Teks & Data", "en": "String & Data Converter"}, "note": {"id": "Base64, URL, MD5, SHA-256, JWT inspector. Lokal di browser.", "en": "Base64, URL, MD5, SHA-256, JWT inspector. Browser-local."}},
  {"id": "keygen", "status": "ready", "href": "/tools/keygen", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Generator Kunci & UUID", "en": "Key & UUID Generator"}, "note": {"id": "UUID v4, secret acak, pasangan kunci X25519 native. Lokal di browser.", "en": "UUID v4, random secrets, native X25519 keypairs. Browser-local."}},
  {"id": "modern", "status": "ready", "href": "/tools/modern", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Formatter Protokol Modern", "en": "Modern Protocol Formatter"}, "note": {"id": "Profil TCP/WS/gRPC + TLS atau TCP/REALITY ke fragmen Sing-box, Clash/Meta, V2Ray/Xray, AWG legacy, link/subscription dan QR.", "en": "TCP/WS/gRPC + TLS or TCP/REALITY profiles to Sing-box, Clash/Meta, V2Ray/Xray fragments, legacy AWG, links/subscription and QR."}},
  {"id": "netdiag", "status": "ready", "href": "/tools/netdiag", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Diagnostik Jaringan", "en": "Network Diagnostics"}, "note": {"id": "DNS lewat DoH 1.1.1.1 (A/AAAA/CNAME/TXT/MX/NS), info IP/ASN koneksi, audit header keamanan HTTPS. Tanpa socket mentah.", "en": "DNS via 1.1.1.1 DoH (A/AAAA/CNAME/TXT/MX/NS), IP/ASN connection info, HTTPS security header audit. No raw sockets."}},
  {"id": "paste", "status": "ready", "href": "/tools/paste", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Secret Share Terenkripsi", "en": "Encrypted Secret Share"}, "note": {"id": "AES-GCM di browser, kunci di #fragment, TTL 1 jam-7 hari, opsi sekali-baca (best-effort di KV). 1 tulis KV per secret dibuat.", "en": "Browser AES-GCM, key in #fragment, TTL 1h-7d, optional read-once (best-effort on KV). 1 KV write per secret created."}},
  {"id": "gateway", "status": "ready", "href": "/tools/gateway", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Webhook Gateway", "en": "Webhook Gateway"}, "note": {"id": "GitHub, Alertmanager, Kuma \u2192 Discord, Telegram, Ntfy, GitHub dispatch", "en": "Signed inbound and authenticated outbound webhook gateway"}},
  {"id": "provision", "status": "ready", "href": "/tools/provision", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Provisioning Host", "en": "Provisioning Host"}, "note": {"id": "Public SSH keys dan setup.sh; nonaktif secara default", "en": "Public SSH keys and setup.sh; disabled by default"}},
 {"id": "vault", "status": "ready", "href": "/tools/vault", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Code Vault", "en": "Code Vault"}, "note": {"id": "Template publik dan AES-GCM privat", "en": "Public templates and private AES-GCM"}},
 {"id": "access", "status": "ready", "href": "/tools/access", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "Kontrol Akses", "en": "Access Control"}, "note": {"id": "Token read-only dan whitelist IP admin", "en": "Read-only tokens and admin IP allowlist"}},
{"id": "uptime", "status": "ready", "href": "/tools/uptime", "env": {"worker": true, "managed": true, "vps": true, "local": true}, "kvWritesDay": 288, "name": {"id": "Uptime Bulanan", "en": "Monthly Uptime"}, "note": {"id": "Persentase sampel ping bulanan, opt-in; bukan SLA berbasis waktu.", "en": "Monthly observed ping sample percentage, opt-in; not time-weighted SLA."}},
{"id": "tcp", "status": "ready", "href": "/tools/tcp", "env": {"worker": false, "managed": false, "vps": true, "local": true}, "kvWritesDay": 0, "name": {"id": "TCP Probe", "en": "TCP Probe"}, "note": {"id": "Admin, Node/VPS; TCP connect saja, bukan UDP.", "en": "Admin, Node/VPS; TCP connect only, not UDP."}},

];
function buildToolsRegistry(lang, profile, storageKind) {
  const en = lang === "en";
  const prof = ENV_LIMITS[profile] ? profile : "worker";
  const limits = ENV_LIMITS[prof];
  const lightKv = prof === "worker" && storageKind === "kv";
  const modules = TOOL_MODULES.map((m) => {
    const warnings = [];
    const supported = m.env[prof] !== false;
    if (!supported) warnings.push(en ? "Not supported on this runtime profile." : "Tidak didukung di profil runtime ini.");
    if (lightKv && m.kvWritesDay > 0 && limits.kvWritesPerDay) {
      const pct = Math.round((m.kvWritesDay / limits.kvWritesPerDay) * 100);
      warnings.push(en
        ? "Uses about " + m.kvWritesDay + " KV writes/day (" + pct + "% of the " + limits.kvWritesPerDay + " free budget)."
        : "Memakai sekitar " + m.kvWritesDay + " tulis KV/hari (" + pct + "% dari jatah gratis " + limits.kvWritesPerDay + ").");
    }
    return { id: m.id, name: en ? m.name.en : m.name.id, note: en ? m.note.en : m.note.id, status: m.status, href: m.href || "", supported, warnings };
  });
  return { profile: prof, storage: storageKind, limits, modules };
}
// ---------- BROWSER-ONLY TOOLS (Fase 2) ----------
// Every tool here runs entirely in the browser: the server only serves static HTML + script (0 CPU work, 0 KV).
// Client code lives in String.raw templates: it must not contain backticks or the dollar-brace sequence.
// Shared client helpers + common labels for every tool page (no backticks / dollar-brace inside).
const TOOL_COMMON = {
  id: { copy: "Salin", copied: "Disalin", copyFail: "Gagal menyalin", nothing: "Belum ada hasil", clear: "Bersihkan", ok: "OK" },
  en: { copy: "Copy", copied: "Copied", copyFail: "Copy failed", nothing: "No result yet", clear: "Clear", ok: "OK" }
};
const TOOL_PRELUDE = String.raw`
var $=function(i){return document.getElementById(i);};
function toast(m,bad){var t=$('cmsToast');if(!t)return;t.textContent=m;t.className=bad?'bad':'';t.style.display='block';setTimeout(function(){t.style.display='none';},1600);}
function copyText(x){if(!x){toast(L.nothing,true);return;}try{navigator.clipboard.writeText(x).then(function(){toast(L.copied);},function(){toast(L.copyFail,true);});}catch(e){toast(L.copyFail,true);}}
function msg(box,text,bad){box.textContent='';var d=document.createElement('div');d.textContent=text;d.className='sg-notice'+(bad?' sg-error':'');d.setAttribute('role',bad?'alert':'status');box.appendChild(d);}
function showPre(box,text){box.textContent='';var p=document.createElement('div');p.className='tool-list';p.textContent=text;box.appendChild(p);}
function onEnter(id,fn){var e=$(id);if(e)e.addEventListener('keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();fn();}});}
function on(id,fn){var e=$(id);if(e)e.addEventListener('click',fn);}
function kvTable(box,rows){var t=document.createElement('table');t.className='kv';rows.forEach(function(r){var tr=document.createElement('tr'),a=document.createElement('td'),b=document.createElement('td');a.textContent=r[0];b.textContent=r[1];tr.appendChild(a);tr.appendChild(b);t.appendChild(tr);});box.textContent='';box.appendChild(t);}
function rowsText(rows){return rows.map(function(r){return r[0]+': '+r[1];}).join('\n');}
`;
const TOOL_PAGES = {
  cidr: {
    title: { id: "Kalkulator CIDR", en: "CIDR Calculator" },
    labels: {
      id: { title: "Kalkulator CIDR", back: "Kembali ke Alat", inLabel: "Alamat/prefix (mis. 192.168.1.10/24, 10.0.0.0 255.255.0.0, 2001:db8::/32)", calc: "Hitung", copy: "Salin hasil",
        splitH: "Pecah subnet", splitLabel: "Prefix baru (mis. 26)", splitBtn: "Pecah", memberH: "Cek keanggotaan", memberLabel: "Alamat atau CIDR yang dicek", memberBtn: "Cek",
        copied: "Disalin", copyFail: "Gagal menyalin", nothing: "Belum ada hasil",
        eEmpty: "Isi dulu alamat.", eBad: "Format tidak dikenali.", eIp: "Alamat IP tidak valid.", ePre: "Prefix tidak valid.", eMask: "Netmask tidak valid.", eSplit: "Prefix baru harus lebih besar dari prefix awal dan tidak melebihi panjang bit.", eVer: "Versi IP berbeda (IPv4 vs IPv6).",
        kInput: "Alamat masukan", kCidr: "CIDR (jaringan)", kNet: "Alamat jaringan", kMask: "Netmask", kWild: "Wildcard", kBcast: "Broadcast", kFirst: "Host pertama", kLast: "Host terakhir", kSize: "Total alamat", kUsable: "Host yang dapat dipakai", kType: "Jenis alamat", kPrefix: "Prefix",
        note: "Masukan memiliki bit host; jaringan dihitung dari bit jaringannya saja.",
        total: "Total subnet", shown: "ditampilkan", inside: "Sepenuhnya berada di dalam jaringan.", overlap: "Sebagian tumpang tindih dengan jaringan.", none: "Tidak berada di jaringan ini.",
        kinds: { this: "Jaringan ini (0.0.0.0/8)", private: "Privat (RFC 1918)", cgnat: "CGNAT (100.64.0.0/10)", loopback: "Loopback", linklocal: "Link-local", reserved: "Dicadangkan", doc: "Dokumentasi", bench: "Benchmark", multicast: "Multicast", public: "Publik / global", unspecified: "Tidak ditentukan (::)", ula: "ULA (fc00::/7)", mapped: "IPv4-mapped" } },
      en: { title: "CIDR Calculator", back: "Back to Tools", inLabel: "Address/prefix (e.g. 192.168.1.10/24, 10.0.0.0 255.255.0.0, 2001:db8::/32)", calc: "Calculate", copy: "Copy result",
        splitH: "Split subnet", splitLabel: "New prefix (e.g. 26)", splitBtn: "Split", memberH: "Membership check", memberLabel: "Address or CIDR to test", memberBtn: "Check",
        copied: "Copied", copyFail: "Copy failed", nothing: "No result yet",
        eEmpty: "Enter an address first.", eBad: "Unrecognised format.", eIp: "Invalid IP address.", ePre: "Invalid prefix.", eMask: "Invalid netmask.", eSplit: "The new prefix must be larger than the current one and not exceed the bit length.", eVer: "Different IP versions (IPv4 vs IPv6).",
        kInput: "Input address", kCidr: "CIDR (network)", kNet: "Network address", kMask: "Netmask", kWild: "Wildcard", kBcast: "Broadcast", kFirst: "First host", kLast: "Last host", kSize: "Total addresses", kUsable: "Usable hosts", kType: "Address type", kPrefix: "Prefix",
        note: "The input has host bits set; the network is computed from the network bits only.",
        total: "Total subnets", shown: "shown", inside: "Fully inside the network.", overlap: "Partially overlaps the network.", none: "Not in this network.",
        kinds: { this: "This network (0.0.0.0/8)", private: "Private (RFC 1918)", cgnat: "CGNAT (100.64.0.0/10)", loopback: "Loopback", linklocal: "Link-local", reserved: "Reserved", doc: "Documentation", bench: "Benchmark", multicast: "Multicast", public: "Public / global", unspecified: "Unspecified (::)", ula: "ULA (fc00::/7)", mapped: "IPv4-mapped" } }
    },
    html: (L) => `<div class="ed-main">
      <div class="fld"><label for="cidrIn">${esc(L.inLabel)}</label><input class="tool-in" type="text" id="cidrIn" value="192.168.1.10/24" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="row"><button class="btn" id="cidrGo" type="button">${esc(L.calc)}</button><button class="btn ghost" id="cidrCopy" type="button">${esc(L.copy)}</button></div>
      <div id="cidrOut" style="margin-top:10px"></div>
    </div>
    <div class="ed-main" style="margin-top:12px"><h2>${esc(L.splitH)}</h2>
      <div class="fld"><label for="cidrSplitIn">${esc(L.splitLabel)}</label><input class="tool-in" type="text" id="cidrSplitIn" value="26" autocomplete="off" inputmode="numeric"></div>
      <div class="row"><button class="btn" id="cidrSplitGo" type="button">${esc(L.splitBtn)}</button></div>
      <div id="cidrSplitOut" class="tool-out"></div>
    </div>
    <div class="ed-main" style="margin-top:12px"><h2>${esc(L.memberH)}</h2>
      <div class="fld"><label for="cidrMemIn">${esc(L.memberLabel)}</label><input class="tool-in" type="text" id="cidrMemIn" value="192.168.1.77" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="row"><button class="btn" id="cidrMemGo" type="button">${esc(L.memberBtn)}</button></div>
      <div id="cidrMemOut" class="tool-out"></div>
    </div>`,
    js: String.raw`
var $=function(i){return document.getElementById(i);};
function p4(s){var m=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);if(!m)return null;var n=0n;for(var i=1;i<5;i++){if(m[i].length>1&&m[i].charAt(0)==='0')return null;var o=parseInt(m[i],10);if(o>255)return null;n=(n<<8n)|BigInt(o);}return n;}
function grp(x){if(x==='')return [];var a=x.split(':'),out=[];for(var i=0;i<a.length;i++){if(i===a.length-1&&a[i].indexOf('.')>=0){var v=p4(a[i]);if(v===null)return null;out.push(Number(v>>16n));out.push(Number(v&0xffffn));continue;}if(!/^[0-9a-fA-F]{1,4}$/.test(a[i]))return null;out.push(parseInt(a[i],16));}return out;}
function p6(s){if(s.indexOf('%')>=0||s.indexOf(':::')>=0)return null;var d=s.split('::');if(d.length>2)return null;var h=grp(d[0]);if(!h)return null;var t=d.length===2?grp(d[1]):[];if(!t)return null;var tot=h.length+t.length;if(d.length===1){if(tot!==8)return null;}else if(tot>7)return null;var g=h.concat(new Array(8-tot).fill(0),t),n=0n;for(var i=0;i<8;i++)n=(n<<16n)|BigInt(g[i]);return n;}
function f4(n){return [Number((n>>24n)&255n),Number((n>>16n)&255n),Number((n>>8n)&255n),Number(n&255n)].join('.');}
function hx(x){return x.toString(16);}
function f6(n){var g=[],i;for(i=7;i>=0;i--)g.push(Number((n>>BigInt(i*16))&0xffffn));var bs=-1,bl=0,cs=-1,cl=0;for(i=0;i<8;i++){if(g[i]===0){if(cs<0){cs=i;cl=0;}cl++;if(cl>bl){bl=cl;bs=cs;}}else cs=-1;}if(bl<2)return g.map(hx).join(':');return g.slice(0,bs).map(hx).join(':')+'::'+g.slice(bs+bl).map(hx).join(':');}
function fmt(v,n){return v===6?f6(n):f4(n);}
function parseIp(s){if(s.indexOf(':')>=0){var n=p6(s);return n===null?null:{v:6,n:n};}var m=p4(s);return m===null?null:{v:4,n:m};}
function parseNet(s){s=String(s==null?'':s).trim();if(!s)return {err:L.eEmpty};var a,b='',i=s.indexOf('/');if(i>=0){a=s.slice(0,i).trim();b=s.slice(i+1).trim();}else{var w=s.split(/\s+/);if(w.length>2)return {err:L.eBad};a=w[0];b=w.length>1?w[1]:'';}
 var ip=parseIp(a);if(!ip)return {err:L.eIp};var bits=ip.v===6?128:32,pre;
 if(b==='')pre=bits;
 else if(/^\d{1,3}$/.test(b)){pre=parseInt(b,10);if(pre>bits)return {err:L.ePre};}
 else if(ip.v===4){var mk=p4(b);if(mk===null)return {err:L.eMask};var inv=0xffffffffn^mk;if((inv&(inv+1n))!==0n)return {err:L.eMask};pre=32;while(inv>0n){inv>>=1n;pre--;}}
 else return {err:L.ePre};
 return {v:ip.v,bits:bits,pre:pre,ip:ip.n};}
function range(p){var size=1n<<BigInt(p.bits-p.pre),full=(1n<<BigInt(p.bits))-1n,mask=full^(size-1n),net=p.ip&mask;return {size:size,full:full,mask:mask,net:net,last:net|(size-1n)};}
var T4=[['0.0.0.0',8,'this'],['10.0.0.0',8,'private'],['100.64.0.0',10,'cgnat'],['127.0.0.0',8,'loopback'],['169.254.0.0',16,'linklocal'],['172.16.0.0',12,'private'],['192.0.0.0',24,'reserved'],['192.0.2.0',24,'doc'],['192.168.0.0',16,'private'],['198.18.0.0',15,'bench'],['198.51.100.0',24,'doc'],['203.0.113.0',24,'doc'],['224.0.0.0',4,'multicast'],['240.0.0.0',4,'reserved']];
function kind(v,n){var K=L.kinds;if(v===4){for(var i=0;i<T4.length;i++){var sh=BigInt(32-T4[i][1]);if((n>>sh)===(p4(T4[i][0])>>sh))return K[T4[i][2]];}return K.public;}
 if(n===0n)return K.unspecified;if(n===1n)return K.loopback;if((n>>32n)===0xffffn)return K.mapped;if((n>>118n)===0x3fan)return K.linklocal;if((n>>121n)===0x7en)return K.ula;if((n>>120n)===0xffn)return K.multicast;if((n>>96n)===0x20010db8n)return K.doc;return K.public;}
function calc(s){var p=parseNet(s);if(p.err)return {ok:false,err:p.err};var r=range(p),o={ok:true,v:p.v,pre:p.pre,bits:p.bits};
 o.input=fmt(p.v,p.ip);o.net=fmt(p.v,r.net);o.cidr=o.net+'/'+p.pre;o.size=r.size.toString();o.hostBitsSet=p.ip!==r.net;o.kind=kind(p.v,p.ip);
 if(p.v===4){o.mask=f4(r.mask);o.wild=f4(r.full^r.mask);
  if(p.pre===32){o.first=o.net;o.last=o.net;o.usable='1';o.bcast='-';}
  else if(p.pre===31){o.first=o.net;o.last=f4(r.last);o.usable='2';o.bcast='-';}
  else{o.first=f4(r.net+1n);o.last=f4(r.last-1n);o.usable=(r.size-2n).toString();o.bcast=f4(r.last);}
 }else{o.first=o.net;o.last=f6(r.last);o.usable=o.size;}
 return o;}
function split(s,np){var p=parseNet(s);if(p.err)return {ok:false,err:p.err};np=parseInt(np,10);if(!(np>p.pre&&np<=p.bits))return {ok:false,err:L.eSplit};
 var r=range(p),step=1n<<BigInt(p.bits-np),total=1n<<BigInt(np-p.pre),n=total<256n?total:256n,out=[];for(var i=0n;i<n;i++)out.push(fmt(p.v,r.net+i*step)+'/'+np);return {ok:true,total:total.toString(),list:out};}
function contains(a,b){var pa=parseNet(a),pb=parseNet(b);if(pa.err||pb.err)return {ok:false,err:pa.err||pb.err};if(pa.v!==pb.v)return {ok:false,err:L.eVer};var ra=range(pa),rb=range(pb);return {ok:true,inside:rb.net>=ra.net&&rb.last<=ra.last,overlap:rb.net<=ra.last&&ra.net<=rb.last};}
if(window.__SG_TEST)window.__SG_TEST.cidr={calc:calc,split:split,contains:contains,parseNet:parseNet};
var lastText='';
function toast(m,bad){var t=$('cmsToast');if(!t)return;t.textContent=m;t.className=bad?'bad':'';t.style.display='block';setTimeout(function(){t.style.display='none';},1600);}
function msg(box,text,bad){box.textContent='';var d=document.createElement('div');d.textContent=text;if(bad)d.style.color='#ff007f';box.appendChild(d);}
function addRow(t,k,v){var tr=document.createElement('tr'),a=document.createElement('td'),b=document.createElement('td');a.textContent=k;b.textContent=v;tr.appendChild(a);tr.appendChild(b);t.appendChild(tr);}
function run(){var box=$('cidrOut');var o=calc($('cidrIn').value);if(!o.ok){lastText='';msg(box,o.err,true);return;}
 var rows=[[L.kInput,o.input],[L.kCidr,o.cidr],[L.kPrefix,'/'+o.pre]];
 if(o.v===4){rows.push([L.kMask,o.mask],[L.kWild,o.wild]);}
 rows.push([L.kNet,o.net]);if(o.v===4)rows.push([L.kBcast,o.bcast]);
 rows.push([L.kFirst,o.first],[L.kLast,o.last],[L.kSize,o.size],[L.kUsable,o.usable],[L.kType,o.kind]);
 var t=document.createElement('table');t.className='kv';rows.forEach(function(r){addRow(t,r[0],r[1]);});
 box.textContent='';box.appendChild(t);if(o.hostBitsSet){var n=document.createElement('small');n.textContent=L.note;box.appendChild(n);}
 lastText=rows.map(function(r){return r[0]+': '+r[1];}).join('\n');}
function runSplit(){var box=$('cidrSplitOut');var o=split($('cidrIn').value,$('cidrSplitIn').value);if(!o.ok){msg(box,o.err,true);return;}
 box.textContent='';var h=document.createElement('div');h.textContent=L.total+': '+o.total+(o.list.length<Number(o.total>1000000n?1000000n:o.total)||BigInt(o.list.length)<BigInt(o.total)?' ('+o.list.length+' '+L.shown+')':'');box.appendChild(h);
 var pre=document.createElement('div');pre.className='tool-list';pre.textContent=o.list.join('\n');box.appendChild(pre);}
function runMem(){var box=$('cidrMemOut');var o=contains($('cidrIn').value,$('cidrMemIn').value);if(!o.ok){msg(box,o.err,true);return;}msg(box,o.inside?L.inside:(o.overlap?L.overlap:L.none),false);}
function onEnter(id,fn){var e=$(id);if(e)e.addEventListener('keydown',function(ev){if(ev.key==='Enter'){ev.preventDefault();fn();}});}
$('cidrGo').addEventListener('click',function(){run();runSplit();runMem();});
$('cidrSplitGo').addEventListener('click',runSplit);
$('cidrMemGo').addEventListener('click',runMem);
$('cidrCopy').addEventListener('click',function(){if(!lastText){toast(L.nothing,true);return;}
 try{navigator.clipboard.writeText(lastText).then(function(){toast(L.copied);},function(){toast(L.copyFail,true);});}catch(e){toast(L.copyFail,true);}});
onEnter('cidrIn',function(){run();runSplit();runMem();});onEnter('cidrSplitIn',runSplit);onEnter('cidrMemIn',runMem);
run();runSplit();runMem();
`
  },
"epoch": {
    title: { id: "Konverter Epoch", en: "Epoch Converter" },
    labels: {
      id: { title: "Konverter Epoch", back: "Kembali ke Alat", inLabel: "Epoch (detik/ms/mikro/nano) atau tanggal (mis. 1700000000, 2023-11-14 22:13:20, 2023-11-14T22:13:20+07:00)", modeLabel: "Tanggal tanpa zona dianggap", modeUtc: "UTC", modeLocal: "Waktu lokal perangkat", tzLabel: "Tampilkan juga di zona waktu (opsional, mis. Asia/Jakarta)",
        go: "Konversi", now: "Sekarang", copy: "Salin hasil",
        eEmpty: "Isi dulu epoch atau tanggal.", eBad: "Format tidak dikenali.", eRange: "Di luar rentang waktu yang didukung.", eTz: "Nama zona waktu tidak valid.",
        kUnit: "Satuan terdeteksi", kSec: "Epoch (detik)", kMs: "Epoch (milidetik)", kIso: "ISO 8601 (UTC)", kUtc: "UTC", kLocal: "Waktu lokal", kOffset: "Offset lokal", kWeekday: "Hari (UTC)", kRel: "Relatif terhadap sekarang", kTz: "Zona waktu perangkat",
        u_s: "detik", u_ms: "milidetik", u_us: "mikrodetik", u_ns: "nanodetik", u_date: "teks tanggal", lang: "id" },
      en: { title: "Epoch Converter", back: "Back to Tools", inLabel: "Epoch (seconds/ms/micro/nano) or a date (e.g. 1700000000, 2023-11-14 22:13:20, 2023-11-14T22:13:20+07:00)", modeLabel: "Dates without a zone are treated as", modeUtc: "UTC", modeLocal: "Device local time", tzLabel: "Also show in time zone (optional, e.g. Asia/Jakarta)",
        go: "Convert", now: "Now", copy: "Copy result",
        eEmpty: "Enter an epoch or a date first.", eBad: "Unrecognised format.", eRange: "Outside the supported time range.", eTz: "Invalid time zone name.",
        kUnit: "Detected unit", kSec: "Epoch (seconds)", kMs: "Epoch (milliseconds)", kIso: "ISO 8601 (UTC)", kUtc: "UTC", kLocal: "Local time", kOffset: "Local offset", kWeekday: "Weekday (UTC)", kRel: "Relative to now", kTz: "Device time zone",
        u_s: "seconds", u_ms: "milliseconds", u_us: "microseconds", u_ns: "nanoseconds", u_date: "date text", lang: "en" }
    },
    html: (L) => `<div class="ed-main">
      <div class="fld"><label for="epIn">${esc(L.inLabel)}</label><input class="tool-in" type="text" id="epIn" value="1700000000" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="epMode">${esc(L.modeLabel)}</label><select id="epMode" class="tool-sel"><option value="utc" selected>${esc(L.modeUtc)}</option><option value="local">${esc(L.modeLocal)}</option></select></div>
      <div class="fld"><label for="epTz">${esc(L.tzLabel)}</label><input class="tool-in" type="text" id="epTz" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="row"><button class="btn" id="epGo" type="button">${esc(L.go)}</button><button class="btn ghost" id="epNow" type="button">${esc(L.now)}</button><button class="btn ghost" id="epCopy" type="button">${esc(L.copy)}</button></div>
      <div id="epOut" class="tool-out"></div>
    </div>`,
    js: String.raw`
var lastText='';
function pad(n){return n<10?'0'+n:''+n;}
function offStr(d){var o=-d.getTimezoneOffset(),s=o<0?'-':'+';o=Math.abs(o);return 'UTC'+s+pad(Math.floor(o/60))+':'+pad(o%60);}
function parse(s,mode){s=String(s==null?'':s).trim();if(!s)return {ok:false,err:L.eEmpty};var ms,unit;
 if(/^[+-]?\d+(\.\d+)?$/.test(s)){var n=parseFloat(s),a=Math.abs(n);
  if(a<1e11){ms=n*1000;unit='s';}else if(a<1e14){ms=n;unit='ms';}else if(a<1e17){ms=n/1000;unit='us';}else{ms=n/1e6;unit='ns';}
  ms=Math.round(ms);}
 else{unit='date';var t=s;
  if(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?$/.test(s)){t=s.replace(' ','T');if(t.length===10)t+='T00:00:00';if(mode!=='local')t+='Z';}
  ms=Date.parse(t);if(isNaN(ms))return {ok:false,err:L.eBad};}
 if(!isFinite(ms)||Math.abs(ms)>8.64e15)return {ok:false,err:L.eRange};
 return {ok:true,ms:ms,unit:unit};}
function relTime(ms){var diff=ms-Date.now(),a=Math.abs(diff),u='second',v=0;
 var U=[['year',31557600000],['month',2629800000],['day',86400000],['hour',3600000],['minute',60000],['second',1000]];
 for(var i=0;i<U.length;i++){if(a>=U[i][1]||i===U.length-1){u=U[i][0];v=Math.round(diff/U[i][1]);break;}}
 try{return new Intl.RelativeTimeFormat(L.lang,{numeric:'auto'}).format(v===0?0:v,u);}catch(e){return '';}}
function convert(s,mode,tz){var p=parse(s,mode);if(!p.ok)return p;var d=new Date(p.ms);
 var o={ok:true,unit:p.unit,ms:p.ms,sec:Math.floor(p.ms/1000),iso:d.toISOString(),utc:d.toUTCString(),local:d.toString(),offset:offStr(d),rel:relTime(p.ms)};
 try{o.weekday=d.toLocaleDateString(L.lang,{weekday:'long',timeZone:'UTC'});}catch(e){o.weekday='';}
 try{o.devTz=Intl.DateTimeFormat().resolvedOptions().timeZone||'';}catch(e){o.devTz='';}
 if(tz){try{o.tzText=new Intl.DateTimeFormat(L.lang,{timeZone:tz,dateStyle:'full',timeStyle:'long'}).format(d);}catch(e){return {ok:false,err:L.eTz};}}
 return o;}
if(window.__SG_TEST)window.__SG_TEST.epoch={parse:parse,convert:convert};
function run(){var box=$('epOut'),tz=($('epTz').value||'').trim();var o=convert($('epIn').value,$('epMode').value==='local'?'local':'utc',tz);
 if(!o.ok){lastText='';msg(box,o.err,true);return;}
 var rows=[[L.kUnit,L['u_'+o.unit]],[L.kSec,String(o.sec)],[L.kMs,String(o.ms)],[L.kIso,o.iso],[L.kUtc,o.utc],[L.kLocal,o.local],[L.kOffset,o.offset],[L.kTz,o.devTz],[L.kWeekday,o.weekday],[L.kRel,o.rel]];
 if(o.tzText)rows.push([tz,o.tzText]);
 kvTable(box,rows);lastText=rowsText(rows);}
on('epGo',run);
on('epNow',function(){$('epIn').value=String(Math.floor(Date.now()/1000));run();});
on('epCopy',function(){copyText(lastText);});
onEnter('epIn',run);onEnter('epTz',run);
run();
`
  },
"json": {
    title: { id: "Formatter JSON", en: "JSON Formatter" },
    labels: {
      id: { title: "Formatter JSON", back: "Kembali ke Alat", inLabel: "JSON masukan", outLabel: "Hasil", indLabel: "Indentasi", ind2: "2 spasi", ind4: "4 spasi", indTab: "Tab", sortLabel: "Urutkan kunci (A-Z, seluruh level)",
        fmt: "Rapikan", min: "Padatkan", validate: "Validasi", okFmt: "JSON valid, sudah dirapikan.", okMin: "JSON valid, sudah dipadatkan.", okValid: "JSON valid.",
        eEmpty: "Isi dulu JSON-nya.", eBig: "Masukan terlalu besar (maks 5 juta karakter).", line: "baris", col: "kolom",
        e_end: "JSON berakhir terlalu cepat", e_ctrl: "Karakter kontrol tidak boleh ada di dalam string", e_esc: "Escape tidak valid di dalam string", e_key: "Kunci objek harus berupa string dengan tanda kutip ganda", e_colon: "Tanda titik dua (:) diharapkan", e_comma: "Koma atau penutup diharapkan", e_token: "Karakter tidak dikenali", e_extra: "Ada data berlebih setelah JSON selesai", e_depth: "Terlalu dalam (maks 500 tingkat)" },
      en: { title: "JSON Formatter", back: "Back to Tools", inLabel: "JSON input", outLabel: "Result", indLabel: "Indent", ind2: "2 spaces", ind4: "4 spaces", indTab: "Tab", sortLabel: "Sort keys (A-Z, all levels)",
        fmt: "Format", min: "Minify", validate: "Validate", okFmt: "Valid JSON, formatted.", okMin: "Valid JSON, minified.", okValid: "Valid JSON.",
        eEmpty: "Enter some JSON first.", eBig: "Input too large (max 5 million characters).", line: "line", col: "column",
        e_end: "JSON ended unexpectedly", e_ctrl: "Control characters are not allowed inside strings", e_esc: "Invalid escape inside a string", e_key: "Object keys must be double-quoted strings", e_colon: "Colon (:) expected", e_comma: "Comma or closing bracket expected", e_token: "Unrecognised character", e_extra: "Extra data after the JSON value", e_depth: "Nesting too deep (max 500 levels)" }
    },
    html: (L) => `<div class="ed-main">
      <div class="fld"><label for="jsIn">${esc(L.inLabel)}</label><textarea id="jsIn" class="tool-ta" spellcheck="false" autocapitalize="off" autocomplete="off">{"name":"synapse","tags":["a","b"],"n":12345678901234567890}</textarea></div>
      <div class="tool-grid">
        <div class="fld"><label for="jsInd">${esc(L.indLabel)}</label><select id="jsInd" class="tool-sel"><option value="2" selected>${esc(L.ind2)}</option><option value="4">${esc(L.ind4)}</option><option value="tab">${esc(L.indTab)}</option></select></div>
        <div class="fld"><label><input type="checkbox" id="jsSort"> ${esc(L.sortLabel)}</label></div>
      </div>
      <div class="row"><button class="btn" id="jsFmt" type="button">${esc(L.fmt)}</button><button class="btn" id="jsMin" type="button">${esc(L.min)}</button><button class="btn ghost" id="jsVal" type="button">${esc(L.validate)}</button><button class="btn ghost" id="jsCopy" type="button">${esc(L.copy)}</button><button class="btn ghost" id="jsClear" type="button">${esc(L.clear)}</button></div>
      <div id="jsMsg" class="tool-out"></div>
      <div class="fld"><label for="jsOut">${esc(L.outLabel)}</label><textarea id="jsOut" class="tool-ta" readonly spellcheck="false"></textarea></div>
    </div>`,
    js: String.raw`
var MAXD=500,MAXLEN=5000000;
function parse(src){var i=0,n=src.length,depth=0;
 function fail(code,pos){var e=new Error(code);e.code=code;e.pos=pos===undefined?i:pos;throw e;}
 function ws(){while(i<n){var c=src.charCodeAt(i);if(c===32||c===9||c===10||c===13)i++;else break;}}
 function str(){var st=i;i++;for(;;){if(i>=n)fail('end',n);var c=src.charCodeAt(i);if(c===34){i++;return {t:'s',raw:src.slice(st,i)};}if(c<32)fail('ctrl');
   if(c===92){i++;if(i>=n)fail('end',n);var e=src.charAt(i);if('"\\/bfnrt'.indexOf(e)>=0)i++;else if(e==='u'){if(!/^[0-9a-fA-F]{4}$/.test(src.substr(i+1,4)))fail('esc');i+=5;}else fail('esc');}else i++;}}
 function num(){var re=/-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;re.lastIndex=i;var m=re.exec(src);if(!m)fail('token');i+=m[0].length;return {t:'n',raw:m[0]};}
 function val(){ws();if(i>=n)fail('end',n);var c=src.charAt(i),d,v;
  if(c==='{'){if(++depth>MAXD)fail('depth');i++;var ks=[];ws();if(src.charAt(i)==='}'){i++;depth--;return {t:'o',k:ks};}
   for(;;){ws();if(i>=n)fail('end',n);if(src.charAt(i)!=='"')fail('key');var k=str();ws();if(i>=n)fail('end',n);if(src.charAt(i)!==':')fail('colon');i++;v=val();ks.push([k.raw,v]);ws();if(i>=n)fail('end',n);d=src.charAt(i);if(d===','){i++;continue;}if(d==='}'){i++;break;}fail('comma');}
   depth--;return {t:'o',k:ks};}
  if(c==='['){if(++depth>MAXD)fail('depth');i++;var vs=[];ws();if(src.charAt(i)===']'){i++;depth--;return {t:'a',v:vs};}
   for(;;){v=val();vs.push(v);ws();if(i>=n)fail('end',n);d=src.charAt(i);if(d===','){i++;continue;}if(d===']'){i++;break;}fail('comma');}
   depth--;return {t:'a',v:vs};}
  if(c==='"')return str();
  if(c==='-'||(c>='0'&&c<='9'))return num();
  if(src.substr(i,4)==='true'){i+=4;return {t:'l',raw:'true'};}
  if(src.substr(i,5)==='false'){i+=5;return {t:'l',raw:'false'};}
  if(src.substr(i,4)==='null'){i+=4;return {t:'l',raw:'null'};}
  fail('token');}
 var r=val();ws();if(i<n)fail('extra');return r;}
function rep(s,n){var r='';for(var k=0;k<n;k++)r+=s;return r;}
function emit(nd,ind,lvl,sort){var parts=[],j,nl;
 if(nd.t==='o'){var k=nd.k;if(!k.length)return '{}';
  if(sort)k=k.slice().sort(function(a,b){var x=JSON.parse(a[0]),y=JSON.parse(b[0]);return x<y?-1:(x>y?1:0);});
  if(ind===''){for(j=0;j<k.length;j++)parts.push(k[j][0]+':'+emit(k[j][1],ind,lvl+1,sort));return '{'+parts.join(',')+'}';}
  nl='\n'+rep(ind,lvl+1);for(j=0;j<k.length;j++)parts.push(k[j][0]+': '+emit(k[j][1],ind,lvl+1,sort));return '{'+nl+parts.join(','+nl)+'\n'+rep(ind,lvl)+'}';}
 if(nd.t==='a'){var a=nd.v;if(!a.length)return '[]';
  if(ind===''){for(j=0;j<a.length;j++)parts.push(emit(a[j],ind,lvl+1,sort));return '['+parts.join(',')+']';}
  nl='\n'+rep(ind,lvl+1);for(j=0;j<a.length;j++)parts.push(emit(a[j],ind,lvl+1,sort));return '['+nl+parts.join(','+nl)+'\n'+rep(ind,lvl)+']';}
 return nd.raw;}
function lc(src,pos){var l=1,c=1;for(var j=0;j<pos&&j<src.length;j++){if(src.charAt(j)==='\n'){l++;c=1;}else c++;}return {line:l,col:c};}
function run(src,indent,sort){src=typeof src==='string'?src:'';if(src.charCodeAt(0)===0xFEFF)src=src.slice(1);
 if(!src.trim())return {ok:false,err:L.eEmpty};if(src.length>MAXLEN)return {ok:false,err:L.eBig};
 var nd;try{nd=parse(src);}catch(e){if(e&&e.code){var p=lc(src,e.pos);return {ok:false,code:e.code,line:p.line,col:p.col,err:(L['e_'+e.code]||L.e_token)+' ('+L.line+' '+p.line+', '+L.col+' '+p.col+')'};}return {ok:false,err:String(e)};}
 return {ok:true,text:emit(nd,indent,0,!!sort)};}
if(window.__SG_TEST)window.__SG_TEST.json={run:run};
function indOf(v){return v==='4'?'    ':(v==='tab'?'\t':'  ');}
function act(indent,okMsg,fill){var r=run($('jsIn').value,indent,$('jsSort').checked),m=$('jsMsg');
 if(!r.ok){msg(m,r.err,true);return;}msg(m,okMsg,false);if(fill)$('jsOut').value=r.text;}
on('jsFmt',function(){act(indOf($('jsInd').value),L.okFmt,true);});
on('jsMin',function(){act('',L.okMin,true);});
on('jsVal',function(){act('',L.okValid,false);});
on('jsCopy',function(){copyText($('jsOut').value);});
on('jsClear',function(){$('jsIn').value='';$('jsOut').value='';$('jsMsg').textContent='';});
`
  },
"cron": {
    title: { id: "Parser Cron", en: "Cron Parser" },
    labels: {
      id: { title: "Parser Cron", back: "Kembali ke Alat", inLabel: "Ekspresi cron (5 field: menit jam hari-bulan bulan hari-minggu)", presetLabel: "Contoh", preset0: "Pilih contoh...", fromLabel: "Hitung dari (opsional, UTC: 2024-01-01 08:00 atau epoch; kosong = sekarang)", nLabel: "Jumlah jadwal berikutnya (1-50)",
        go: "Parse", copy: "Salin hasil",
        fMin: "Menit", fHour: "Jam", fDom: "Hari-bulan", fMon: "Bulan", fDow: "Hari-minggu",
        e_empty: "Isi dulu ekspresi cron.", e_count: "Harus tepat 5 field dipisah spasi (Cloudflare tidak memakai field detik atau tahun).", e_syntax: "Sintaks tidak dikenali.", e_range: "Nilai di luar rentang yang diizinkan.", e_step: "Langkah (/n) tidak valid.", e_order: "Rentang terbalik (awal lebih besar dari akhir).", e_dow0: "Hari-minggu memakai 1-7 (1=Minggu, 7=Sabtu) atau SUN-SAT; angka 0 tidak valid di Cloudflare.", e_lw: "Karakter L/W hanya valid dalam bentuk L, LW, atau nW (mis. 15W) di hari-bulan.", e_nth: "Urutan setelah # harus 1-5.",
        eFrom: "Waktu awal tidak valid (pakai YYYY-MM-DD HH:MM UTC atau epoch, tahun 1970-2999).", eNever: "Tidak ada jadwal yang cocok dalam sekitar 9 tahun ke depan (mis. 30 Februari).",
        vEvery: "setiap nilai", vLast: "hari terakhir bulan", vLastW: "hari kerja terakhir bulan", vNear: "hari kerja terdekat ke tanggal {n}", vNth: "{d} ke-{k} dalam bulan", vLastDow: "{d} terakhir dalam bulan",
        kNext: "Jadwal berikutnya", kNote: "Catatan", kTz: "Zona waktu",
        vUtc: "Cron Trigger Cloudflare berjalan pada UTC. Kolom lokal hanya konversi untuk perangkat ini.",
        wBoth: "Hari-bulan dan hari-minggu sama-sama diisi. Alat ini memakai logika ATAU (seperti cron standar). Perilaku persisnya di Cloudflare belum diverifikasi; cek hasilnya di dasbor.",
        dayNames: "Minggu,Senin,Selasa,Rabu,Kamis,Jumat,Sabtu", monNames: "Jan,Feb,Mar,Apr,Mei,Jun,Jul,Agu,Sep,Okt,Nov,Des", local: "lokal", lang: "id" },
      en: { title: "Cron Parser", back: "Back to Tools", inLabel: "Cron expression (5 fields: minute hour day-of-month month day-of-week)", presetLabel: "Examples", preset0: "Pick an example...", fromLabel: "Compute from (optional, UTC: 2024-01-01 08:00 or epoch; empty = now)", nLabel: "Number of upcoming runs (1-50)",
        go: "Parse", copy: "Copy result",
        fMin: "Minute", fHour: "Hour", fDom: "Day of month", fMon: "Month", fDow: "Day of week",
        e_empty: "Enter a cron expression first.", e_count: "Exactly 5 space-separated fields are required (Cloudflare has no seconds or year field).", e_syntax: "Unrecognised syntax.", e_range: "Value outside the allowed range.", e_step: "Invalid step (/n).", e_order: "Reversed range (start is greater than end).", e_dow0: "Day of week uses 1-7 (1=Sunday, 7=Saturday) or SUN-SAT; 0 is not valid on Cloudflare.", e_lw: "L/W are only valid as L, LW, or nW (e.g. 15W) in day-of-month.", e_nth: "The number after # must be 1-5.",
        eFrom: "Invalid start time (use YYYY-MM-DD HH:MM UTC or an epoch, year 1970-2999).", eNever: "No matching run in roughly the next 9 years (e.g. February 30).",
        vEvery: "every value", vLast: "last day of month", vLastW: "last weekday of month", vNear: "weekday nearest to day {n}", vNth: "{d} number {k} of the month", vLastDow: "last {d} of the month",
        kNext: "Upcoming runs", kNote: "Note", kTz: "Time zone",
        vUtc: "Cloudflare Cron Triggers run in UTC. The local column is only a conversion for this device.",
        wBoth: "Both day-of-month and day-of-week are set. This tool uses OR logic (like standard cron). The exact behaviour on Cloudflare is not verified; check the result in the dashboard.",
        dayNames: "Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday", monNames: "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec", local: "local", lang: "en" }
    },
    html: (L) => `<div class="ed-main">
      <div class="fld"><label for="crIn">${esc(L.inLabel)}</label><input class="tool-in" type="text" id="crIn" value="*/15 * * * *" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="crPre">${esc(L.presetLabel)}</label><select id="crPre" class="tool-sel"><option value="">${esc(L.preset0)}</option>${["*/5 * * * *", "0 * * * *", "0 0 * * *", "0 17 * * SUN", "10 7 * * MON-FRI", "0 15 1 * *", "0 18 * * 6L", "59 23 LW * *", "0 9 * * 2#1", "0 0 15W * *"].map(function (x) { return '<option value="' + esc(x) + '">' + esc(x) + '</option>'; }).join("")}</select></div>
      <div class="fld"><label for="crFrom">${esc(L.fromLabel)}</label><input class="tool-in" type="text" id="crFrom" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="crN">${esc(L.nLabel)}</label><input class="tool-in" type="text" id="crN" value="10" inputmode="numeric" autocomplete="off"></div>
      <div class="row"><button class="btn" id="crGo" type="button">${esc(L.go)}</button><button class="btn ghost" id="crCopy" type="button">${esc(L.copy)}</button></div>
      <div id="crBox" class="tool-out"></div>
    </div>`,
    js: String.raw`
var lastText='';
var MON={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
var DOW={SUN:1,MON:2,TUE:3,WED:4,THU:5,FRI:6,SAT:7};
var FN=[L.fMin,L.fHour,L.fDom,L.fMon,L.fDow];
var DN=L.dayNames.split(','),MN=L.monNames.split(',');
function E(i,code){return {ok:false,code:code,field:i,err:(i>=0?FN[i]+': ':'')+L['e_'+code]};}
function val(tok,names){var u=tok.toUpperCase();
 if(names&&Object.prototype.hasOwnProperty.call(names,u))return names[u];
 if(/^\d{1,3}$/.test(tok))return parseInt(tok,10);
 return NaN;}
function keys(set){return Object.keys(set).map(Number).sort(function(a,b){return a-b;});}
function parseBasic(txt,i,min,max,names){
 var set={},parts=txt.split(','),star=false;
 for(var k=0;k<parts.length;k++){var p=parts[k];if(!p)return E(i,'syntax');
  var step=1,hasStep=false,base=p,sl=p.indexOf('/');
  if(sl>=0){base=p.slice(0,sl);var st=p.slice(sl+1);if(!/^\d{1,3}$/.test(st))return E(i,'step');step=parseInt(st,10);if(step<1||step>max)return E(i,'step');hasStep=true;}
  var a,b;
  if(base==='*'){a=min;b=max;if(step===1&&parts.length===1)star=true;}
  else if(base.indexOf('-')>0){var ab=base.split('-');if(ab.length!==2)return E(i,'syntax');a=val(ab[0],names);b=val(ab[1],names);
   if(isNaN(a)||isNaN(b))return E(i,'syntax');
   if(i===4&&(a===0||b===0))return E(i,'dow0');
   if(a<min||a>max||b<min||b>max)return E(i,'range');
   if(a>b)return E(i,'order');}
  else{a=val(base,names);if(isNaN(a))return E(i,'syntax');
   if(i===4&&a===0)return E(i,'dow0');
   if(a<min||a>max)return E(i,'range');
   b=hasStep?max:a;}
  for(var v=a;v<=b;v+=step)set[v]=1;}
 return {ok:true,set:set,star:star};}
function parseDom(txt){
 var parts=txt.split(','),rest=[],sp={last:false,lastW:false,near:[]};
 for(var k=0;k<parts.length;k++){var p=parts[k].toUpperCase();
  if(p==='L')sp.last=true;
  else if(p==='LW')sp.lastW=true;
  else if(/^\d{1,2}W$/.test(p)){var n=parseInt(p,10);if(n<1||n>31)return E(2,'range');sp.near.push(n);}
  else if(/[LW]/.test(p))return E(2,'lw');
  else rest.push(parts[k]);}
 var r;
 if(rest.length){r=parseBasic(rest.join(','),2,1,31,null);if(!r.ok)return r;}else r={ok:true,set:{},star:false};
 r.sp=sp;return r;}
function parseDow(txt){
 var parts=txt.split(','),rest=[],sp={last:[],nth:[]};
 for(var k=0;k<parts.length;k++){var p=parts[k],u=p.toUpperCase();
  if(u.indexOf('#')>=0){var h=u.split('#');if(h.length!==2)return E(4,'syntax');
   var d=val(h[0],DOW),q=/^\d$/.test(h[1])?parseInt(h[1],10):NaN;
   if(isNaN(d)||isNaN(q))return E(4,'syntax');
   if(d===0)return E(4,'dow0');if(d<1||d>7)return E(4,'range');
   if(q<1||q>5)return E(4,'nth');
   sp.nth.push([d,q]);}
  else if(u.length>1&&u.charAt(u.length-1)==='L'){var d2=val(u.slice(0,-1),DOW);
   if(isNaN(d2))return E(4,'syntax');
   if(d2===0)return E(4,'dow0');if(d2<1||d2>7)return E(4,'range');
   sp.last.push(d2);}
  else rest.push(p);}
 var r;
 if(rest.length){r=parseBasic(rest.join(','),4,1,7,DOW);if(!r.ok)return r;}else r={ok:true,set:{},star:false};
 r.sp=sp;return r;}
function parse(expr){
 expr=String(expr==null?'':expr).trim();if(!expr)return E(-1,'empty');
 var f=expr.split(/\s+/);if(f.length!==5)return E(-1,'count');
 var mi=parseBasic(f[0],0,0,59,null);if(!mi.ok)return mi;
 var ho=parseBasic(f[1],1,0,23,null);if(!ho.ok)return ho;
 var dm=parseDom(f[2]);if(!dm.ok)return dm;
 var mo=parseBasic(f[3],3,1,12,MON);if(!mo.ok)return mo;
 var dw=parseDow(f[4]);if(!dw.ok)return dw;
 return {ok:true,fields:f,min:keys(mi.set),hour:keys(ho.set),mon:mo.set,dom:dm,dow:dw,domStar:dm.star,dowStar:dw.star,stars:[mi.star,ho.star,dm.star,mo.star,dw.star],warnBoth:!dm.star&&!dw.star};}
function dim(y,m){return new Date(Date.UTC(y,m,0)).getUTCDate();}
function wdOf(y,m,d){return new Date(Date.UTC(y,m-1,d)).getUTCDay()+1;}
function nearW(y,m,n){var last=dim(y,m);if(n>last)return -1;var w=wdOf(y,m,n);
 if(w>=2&&w<=6)return n;
 if(w===7)return n>1?n-1:n+2;
 return n<last?n+1:n-2;}
function lastWd(y,m){var last=dim(y,m),w=wdOf(y,m,last);if(w===7)return last-1;if(w===1)return last-2;return last;}
function dayOk(c,y,m,d){
 var last=dim(y,m),wd=wdOf(y,m,d),sp=c.dom.sp,sq=c.dow.sp;
 var a=!!c.dom.set[d]||(sp.last&&d===last)||(sp.lastW&&d===lastWd(y,m))||sp.near.some(function(n){return nearW(y,m,n)===d;});
 var b=!!c.dow.set[wd]||sq.last.some(function(x){return x===wd&&d+7>last;})||sq.nth.some(function(x){return x[0]===wd&&Math.floor((d-1)/7)+1===x[1];});
 if(c.domStar&&c.dowStar)return true;
 if(c.domStar)return b;
 if(c.dowStar)return a;
 return a||b;}
function nextRuns(c,fromMs,count){
 var out=[],s=(Math.floor(fromMs/60000)+1)*60000,day0=Math.floor(s/86400000)*86400000;
 for(var i=0;i<3300&&out.length<count;i++){
  var base=day0+i*86400000,dt=new Date(base),y=dt.getUTCFullYear(),m=dt.getUTCMonth()+1,d=dt.getUTCDate();
  if(!c.mon[m]||!dayOk(c,y,m,d))continue;
  for(var a=0;a<c.hour.length&&out.length<count;a++){for(var b=0;b<c.min.length&&out.length<count;b++){
   var ts=base+c.hour[a]*3600000+c.min[b]*60000;if(ts>=s)out.push(ts);}}}
 return out;}
function parseFrom(s){s=String(s==null?'':s).trim();if(!s)return Date.now();var ms;
 if(/^\d+$/.test(s)){var n=parseInt(s,10);ms=n<1e11?n*1000:n;}
 else if(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)){var t=s.replace(' ','T');if(t.length===10)t+='T00:00';ms=Date.parse(t+'Z');}
 else return NaN;
 if(isNaN(ms))return NaN;var y=new Date(ms).getUTCFullYear();if(y<1970||y>2999)return NaN;return ms;}
function lst(arr){var n=arr.length;return n>24?arr.slice(0,24).join(', ')+', ... ('+n+')':arr.join(', ');}
function describe(c){var R=[],S=c.stars;
 function basic(i,arr,fmt){return S[i]?L.vEvery:lst(arr.map(fmt||String));}
 R.push([FN[0]+' ('+c.fields[0]+')',basic(0,c.min)]);
 R.push([FN[1]+' ('+c.fields[1]+')',basic(1,c.hour)]);
 var dp=[],sp=c.dom.sp,dk=keys(c.dom.set);
 if(S[2])dp.push(L.vEvery);else{if(dk.length)dp.push(lst(dk));if(sp.last)dp.push(L.vLast);if(sp.lastW)dp.push(L.vLastW);sp.near.forEach(function(n){dp.push(L.vNear.replace('{n}',n));});}
 R.push([FN[2]+' ('+c.fields[2]+')',dp.join('; ')]);
 R.push([FN[3]+' ('+c.fields[3]+')',basic(3,keys(c.mon),function(x){return MN[x-1];})]);
 var wp=[],sq=c.dow.sp,wk=keys(c.dow.set);
 if(S[4])wp.push(L.vEvery);else{if(wk.length)wp.push(lst(wk.map(function(x){return DN[x-1];})));sq.last.forEach(function(x){wp.push(L.vLastDow.replace('{d}',DN[x-1]));});sq.nth.forEach(function(x){wp.push(L.vNth.replace('{d}',DN[x[0]-1]).replace('{k}',x[1]));});}
 R.push([FN[4]+' ('+c.fields[4]+')',wp.join('; ')]);
 return R;}
function pad(n){return n<10?'0'+n:''+n;}
function fmtRun(ts){var d=new Date(ts);
 var u=d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())+' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+' UTC ('+DN[d.getUTCDay()]+')';
 var l='';try{l=' | '+L.local+': '+d.toLocaleString(L.lang);}catch(e){}
 return u+l;}
if(window.__SG_TEST)window.__SG_TEST.cron={parse:parse,next:nextRuns,dayOk:dayOk,nearW:nearW,parseFrom:parseFrom,describe:describe,fmtRun:fmtRun};
function run(){var box=$('crBox'),r=parse($('crIn').value);
 if(!r.ok){lastText='';msg(box,r.err,true);return;}
 var from=parseFrom($('crFrom').value||'');if(isNaN(from)){lastText='';msg(box,L.eFrom,true);return;}
 var n=parseInt($('crN').value,10);if(!(n>=1))n=10;if(n>50)n=50;
 var rows=describe(r);
 if(r.warnBoth)rows.push([L.kNote,L.wBoth]);
 rows.push([L.kTz,L.vUtc]);
 var runs=nextRuns(r,from,n);
 if(!runs.length)rows.push([L.kNext,L.eNever]);
 else runs.forEach(function(ts,i){rows.push([L.kNext+' #'+(i+1),fmtRun(ts)]);});
 kvTable(box,rows);lastText=rowsText(rows);}
on('crGo',run);
on('crCopy',function(){copyText(lastText);});
on('crPre',function(){var v=$('crPre').value;if(v){$('crIn').value=v;run();}});
onEnter('crIn',run);onEnter('crFrom',run);onEnter('crN',run);
run();
`
  },
"regex": {
    title: { id: "Penguji Regex", en: "Regex Tester" },
    labels: {
      id: { title: "Penguji Regex", back: "Kembali ke Alat", patLabel: "Pola (tanpa garis miring, mis. (\\d+)-(?<nama>\\w+))", flagLabel: "Flag (d g i m s u v y)", txtLabel: "Teks uji", repLabel: "Pengganti (mis. $1-$<nama>, $&)", doRep: "Tampilkan hasil penggantian",
        go: "Uji", copy: "Salin hasil", warn: "Regex berjalan di browser Anda dan tidak bisa dihentikan di tengah jalan. Pola dengan backtracking berlebihan (mis. (a+)+$) bisa membuat tab membeku.",
        eEmpty: "Isi dulu pola regex.", eBigPat: "Pola terlalu panjang (maks 2000 karakter).", eBigTxt: "Teks terlalu besar (maks 200.000 karakter).", eRe: "Regex tidak valid", eFlags: "Flag tidak valid (hanya d g i m s u v y, tanpa duplikat).",
        kCount: "Jumlah kecocokan", kTime: "Waktu proses", kMatch: "Kecocokan", kGroup: "Grup", kNamed: "Grup bernama", kRepl: "Hasil penggantian", kNote: "Catatan",
        vNone: "(tidak ada kecocokan)", vUnd: "(tidak ikut cocok)", vCut: "dipotong", vAt: "posisi", vNoG: "Tanpa flag g, hanya kecocokan pertama yang dicari.", vMore: "Tampil {n} dari {t} kecocokan.", lang: "id" },
      en: { title: "Regex Tester", back: "Back to Tools", patLabel: "Pattern (no slashes, e.g. (\\d+)-(?<name>\\w+))", flagLabel: "Flags (d g i m s u v y)", txtLabel: "Test text", repLabel: "Replacement (e.g. $1-$<name>, $&)", doRep: "Show replacement result",
        go: "Test", copy: "Copy result", warn: "The regex runs in your browser and cannot be interrupted. Patterns with excessive backtracking (e.g. (a+)+$) can freeze the tab.",
        eEmpty: "Enter a regex pattern first.", eBigPat: "Pattern too long (max 2000 characters).", eBigTxt: "Text too large (max 200,000 characters).", eRe: "Invalid regex", eFlags: "Invalid flags (only d g i m s u v y, no duplicates).",
        kCount: "Match count", kTime: "Processing time", kMatch: "Match", kGroup: "Group", kNamed: "Named group", kRepl: "Replacement result", kNote: "Note",
        vNone: "(no matches)", vUnd: "(did not participate)", vCut: "truncated", vAt: "at", vNoG: "Without the g flag only the first match is searched.", vMore: "Showing {n} of {t} matches.", lang: "en" }
    },
    html: (L) => `<div class="ed-main">
      <div class="fld"><label for="reP">${esc(L.patLabel)}</label><input class="tool-in" type="text" id="reP" value="(\\d+)-(?<word>\\w+)" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="reF">${esc(L.flagLabel)}</label><input class="tool-in" type="text" id="reF" value="g" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="reT">${esc(L.txtLabel)}</label><textarea id="reT" class="tool-ta" spellcheck="false" autocapitalize="off" autocomplete="off">10-abc 20-def</textarea></div>
      <div class="fld"><label for="reR">${esc(L.repLabel)}</label><input class="tool-in" type="text" id="reR" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label><input type="checkbox" id="reDo"> ${esc(L.doRep)}</label></div>
      <div class="row"><button class="btn" id="reGo" type="button">${esc(L.go)}</button><button class="btn ghost" id="reCopy" type="button">${esc(L.copy)}</button></div>
      <p class="sg-notice sg-warning" role="note">${esc(L.warn)}</p>
      <div id="reBox" class="tool-out"></div>
    </div>`,
    js: String.raw`
var lastText='';var MAXP=2000,MAXT=200000,MAXM=1000,SHOW=100,MAXOUT=50000;
function show(v){if(v===undefined)return L.vUnd;var s=JSON.stringify(v);return s.length>300?s.slice(0,300)+'... ('+L.vCut+')':s;}
function advance(text,i,uni){if(uni&&i<text.length){var c=text.charCodeAt(i);if(c>=0xD800&&c<=0xDBFF&&i+1<text.length){var d=text.charCodeAt(i+1);if(d>=0xDC00&&d<=0xDFFF)return i+2;}}return i+1;}
function exec(pat,flags,text,rep,doRep){
 pat=String(pat==null?'':pat);flags=String(flags==null?'':flags).trim();text=String(text==null?'':text);
 if(!pat)return {ok:false,err:L.eEmpty};
 if(pat.length>MAXP)return {ok:false,err:L.eBigPat};
 if(text.length>MAXT)return {ok:false,err:L.eBigTxt};
 if(!/^[dgimsuvy]*$/.test(flags))return {ok:false,err:L.eFlags};
 var re;try{re=new RegExp(pat,flags);}catch(e){return {ok:false,err:L.eRe+': '+(e&&e.message?String(e.message).slice(0,200):'')};}
 var global=flags.indexOf('g')>=0,sticky=flags.indexOf('y')>=0,uni=flags.indexOf('u')>=0||flags.indexOf('v')>=0;
 var t0=Date.now(),list=[],total=0,m,guard=0;
 re.lastIndex=0;
 while((m=re.exec(text))!==null){
  total++;
  if(list.length<MAXM){var named=null;if(m.groups){named=[];Object.keys(m.groups).forEach(function(k){named.push([k,m.groups[k]]);});}
   list.push({index:m.index,text:m[0],groups:Array.prototype.slice.call(m,1),named:named});}
  if(!global)break;
  if(m[0]===''){re.lastIndex=advance(text,re.lastIndex,uni);}
  if(re.lastIndex>text.length){break;}
  if(++guard>200000)break;
  if(total>=MAXM&&total>=100000)break;}
 var out={ok:true,matches:list,total:total,global:global,sticky:sticky,ms:Date.now()-t0};
 if(doRep){try{var re2=new RegExp(pat,flags);var r=text.replace(re2,String(rep==null?'':rep));out.replaced=r.length>MAXOUT?r.slice(0,MAXOUT):r;out.replCut=r.length>MAXOUT;}catch(e){return {ok:false,err:L.eRe+': '+(e&&e.message?String(e.message).slice(0,200):'')};}}
 return out;}
if(window.__SG_TEST)window.__SG_TEST.regex={exec:exec,advance:advance,show:show};
function run(){var box=$('reBox');
 var o=exec($('reP').value,$('reF').value,$('reT').value,$('reR').value,$('reDo').checked);
 if(!o.ok){lastText='';msg(box,o.err,true);return;}
 var rows=[[L.kCount,String(o.total)],[L.kTime,o.ms+' ms']];
 if(!o.global)rows.push([L.kNote,L.vNoG]);
 if(o.total>o.matches.length||o.matches.length>SHOW)rows.push([L.kNote,L.vMore.replace('{n}',Math.min(SHOW,o.matches.length)).replace('{t}',String(o.total)+(o.total>=MAXM?'+':''))]);
 if(!o.total)rows.push([L.kMatch,L.vNone]);
 o.matches.slice(0,SHOW).forEach(function(x,i){
  rows.push([L.kMatch+' #'+(i+1),show(x.text)+' ('+L.vAt+' '+x.index+')']);
  x.groups.forEach(function(g,j){rows.push(['  '+L.kGroup+' '+(j+1),show(g)]);});
  if(x.named)x.named.forEach(function(p){rows.push(['  '+L.kNamed+' '+p[0],show(p[1])]);});});
 if(o.replaced!==undefined)rows.push([L.kRepl,JSON.stringify(o.replaced)+(o.replCut?' ... ('+L.vCut+')':'')]);
 kvTable(box,rows);lastText=rowsText(rows);}
on('reGo',run);
on('reCopy',function(){copyText(lastText);});
onEnter('reP',run);onEnter('reF',run);onEnter('reR',run);
run();
`
  },
"curl": {
    title: { id: "Pembuat Perintah curl", en: "curl Command Builder" },
    labels: {
      id: { title: "Pembuat Perintah curl", back: "Kembali ke Alat", urlL: "URL (http/https)", methL: "Metode", hdrL: "Header (satu per baris, Nama: nilai)", bodyL: "Isi body (opsional)", userL: "Basic auth (user:sandi)", bearL: "Token Bearer", timeL: "Batas waktu (detik, opsional)", optL: "Opsi",
        fFollow: "-L ikuti redirect", fIncl: "-i tampilkan header respons", fSil: "-s senyap", fIns: "-k lewati verifikasi TLS", fComp: "--compressed", fVer: "-v verbose", fOne: "Satu baris",
        fmtL: "Format keluaran", fmtCurl: "curl (shell POSIX)", fmtFetch: "fetch (JavaScript)", go: "Buat", copy: "Salin hasil", inL: "Atau tempel perintah curl yang sudah ada", doParse: "Muat ke formulir",
        warn: "Semua diproses di browser Anda. Token dan sandi tampil apa adanya di hasil, dan tersimpan di riwayat shell bila perintahnya dijalankan. Hasil curl memakai kutip tunggal gaya POSIX (bash/zsh/sh), bukan Windows cmd.",
        eUrl: "Isi URL dulu.", eBigU: "URL terlalu panjang (maks 4000 karakter).", eUrlFmt: "URL harus diawali http:// atau https:// dan tanpa spasi atau karakter kontrol.", eMeth: "Metode tidak dikenal.",
        eHdr: "Header tidak valid (format Nama: nilai, nilai tidak boleh kosong)", eBigH: "Terlalu banyak header (maks 100).", eBigB: "Body terlalu besar (maks 100.000 karakter).",
        eAuth: "Pilih salah satu: Basic auth atau token Bearer.", eBear: "Token Bearer tidak boleh berisi spasi atau karakter kontrol.", eUser: "Basic auth tidak boleh berisi baris baru atau karakter kontrol.", eTime: "Batas waktu harus bilangan bulat 1 sampai 86400.",
        eInEmpty: "Tempel perintah curl dulu.", eBigIn: "Perintah terlalu panjang (maks 200.000 karakter).", eNotCurl: "Perintah harus diawali kata curl.", eQuote: "Tanda kutip tidak berpasangan.", eNoUrl: "Tidak ada URL di perintah curl itu.", eBadArg: "Opsi {x} butuh nilai.",
        kNote: "Catatan", vLine: "baris",
        nGet: "GET dengan body: sebagian server mengabaikannya.", nHead: "HEAD tidak mengirim body; body diabaikan.", nJson: "Body tampak seperti JSON tetapi tidak ada header Content-Type. curl akan mengirim application/x-www-form-urlencoded.",
        nDup: "Ada header ganda; pada fetch nilainya digabung dengan koma (atau header Authorization yang ditulis manual dipakai).", nIns: "-k mematikan verifikasi sertifikat TLS. Jangan dipakai di produksi.",
        nFetchIgn: "Opsi curl tanpa padanan fetch dan diabaikan di keluaran fetch: {x}", nIgn: "Opsi curl berikut tidak didukung dan dilewati: {x}", lang: "id" },
      en: { title: "curl Command Builder", back: "Back to Tools", urlL: "URL (http/https)", methL: "Method", hdrL: "Headers (one per line, Name: value)", bodyL: "Body (optional)", userL: "Basic auth (user:password)", bearL: "Bearer token", timeL: "Timeout (seconds, optional)", optL: "Options",
        fFollow: "-L follow redirects", fIncl: "-i show response headers", fSil: "-s silent", fIns: "-k skip TLS verification", fComp: "--compressed", fVer: "-v verbose", fOne: "Single line",
        fmtL: "Output format", fmtCurl: "curl (POSIX shell)", fmtFetch: "fetch (JavaScript)", go: "Build", copy: "Copy result", inL: "Or paste an existing curl command", doParse: "Load into form",
        warn: "Everything runs in your browser. Tokens and passwords appear as-is in the result, and are stored in shell history if the command is run. The curl output uses POSIX single quotes (bash/zsh/sh), not Windows cmd.",
        eUrl: "Enter a URL first.", eBigU: "URL too long (max 4000 characters).", eUrlFmt: "URL must start with http:// or https:// and contain no spaces or control characters.", eMeth: "Unknown method.",
        eHdr: "Invalid header (format Name: value, value must not be empty)", eBigH: "Too many headers (max 100).", eBigB: "Body too large (max 100,000 characters).",
        eAuth: "Choose one: Basic auth or Bearer token.", eBear: "Bearer token must not contain spaces or control characters.", eUser: "Basic auth must not contain newlines or control characters.", eTime: "Timeout must be an integer from 1 to 86400.",
        eInEmpty: "Paste a curl command first.", eBigIn: "Command too long (max 200,000 characters).", eNotCurl: "The command must start with the word curl.", eQuote: "Unbalanced quotes.", eNoUrl: "No URL found in that curl command.", eBadArg: "Option {x} needs a value.",
        kNote: "Note", vLine: "line",
        nGet: "GET with a body: some servers ignore it.", nHead: "HEAD sends no body; the body was ignored.", nJson: "The body looks like JSON but there is no Content-Type header. curl will send application/x-www-form-urlencoded.",
        nDup: "Duplicate headers: in fetch the values are joined with a comma (or the manually written Authorization header wins).", nIns: "-k disables TLS certificate verification. Do not use it in production.",
        nFetchIgn: "curl options without a fetch equivalent, ignored in the fetch output: {x}", nIgn: "These curl options are unsupported and were skipped: {x}", lang: "en" }
    },
    html: (L) => `<div class="ed-main">
      <div class="fld"><label for="cuU">${esc(L.urlL)}</label><input class="tool-in" type="text" id="cuU" value="https://example.com/api" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="cuM">${esc(L.methL)}</label><select class="tool-sel" id="cuM"><option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="PATCH">PATCH</option><option value="DELETE">DELETE</option><option value="HEAD">HEAD</option><option value="OPTIONS">OPTIONS</option></select></div>
      <div class="fld"><label for="cuH">${esc(L.hdrL)}</label><textarea id="cuH" class="tool-ta" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>
      <div class="fld"><label for="cuB">${esc(L.bodyL)}</label><textarea id="cuB" class="tool-ta" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>
      <div class="fld"><label for="cuA">${esc(L.userL)}</label><input class="tool-in" type="text" id="cuA" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="cuBr">${esc(L.bearL)}</label><input class="tool-in" type="text" id="cuBr" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="cuT">${esc(L.timeL)}</label><input class="tool-in" type="text" id="cuT" value="" inputmode="numeric" autocomplete="off"></div>
      <div class="fld"><label>${esc(L.optL)}</label>
        <label><input type="checkbox" id="cuL"> ${esc(L.fFollow)}</label>
        <label><input type="checkbox" id="cuI"> ${esc(L.fIncl)}</label>
        <label><input type="checkbox" id="cuS"> ${esc(L.fSil)}</label>
        <label><input type="checkbox" id="cuK"> ${esc(L.fIns)}</label>
        <label><input type="checkbox" id="cuC"> ${esc(L.fComp)}</label>
        <label><input type="checkbox" id="cuV"> ${esc(L.fVer)}</label>
        <label><input type="checkbox" id="cuO"> ${esc(L.fOne)}</label></div>
      <div class="fld"><label for="cuF">${esc(L.fmtL)}</label><select class="tool-sel" id="cuF"><option value="curl">${esc(L.fmtCurl)}</option><option value="fetch">${esc(L.fmtFetch)}</option></select></div>
      <div class="row"><button class="btn" id="cuGo" type="button">${esc(L.go)}</button><button class="btn ghost" id="cuCopy" type="button">${esc(L.copy)}</button></div>
      <div class="fld"><label for="cuIn">${esc(L.inL)}</label><textarea id="cuIn" class="tool-ta" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>
      <div class="row"><button class="btn ghost" id="cuLoad" type="button">${esc(L.doParse)}</button></div>
      <p class="sg-notice sg-warning" role="note">${esc(L.warn)}</p>
      <div id="cuBox" class="tool-out"></div>
    </div>`,
    js: String.raw`
var lastText='';var MAXU=4000,MAXH=100,MAXB=100000,MAXIN=200000;
var METHODS=['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
var TOKEN=/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;
function quote(s){return "'"+String(s).replace(/'/g,"'\\''")+"'";}
function parseHeaders(text){var out=[],lines=String(text==null?'':text).split(/\r?\n/);
 for(var i=0;i<lines.length;i++){var ln=lines[i].trim();if(!ln)continue;var c=ln.indexOf(':');
  var bad={ok:false,err:L.eHdr+' ('+L.vLine+' '+(i+1)+')'};
  if(c<=0)return bad;
  var nm=ln.slice(0,c).trim(),val=ln.slice(c+1).trim();
  if(!TOKEN.test(nm)||!val||/[\x00-\x08\x0a-\x1f\x7f]/.test(val))return bad;
  out.push([nm,val]);}
 if(out.length>MAXH)return {ok:false,err:L.eBigH};
 return {ok:true,list:out};}
function build(o){o=o||{};
 var url=String(o.url==null?'':o.url).trim();
 if(!url)return {ok:false,err:L.eUrl};
 if(url.length>MAXU)return {ok:false,err:L.eBigU};
 if(!/^https?:\/\/\S+$/i.test(url)||/[\x00-\x1f\x7f]/.test(url))return {ok:false,err:L.eUrlFmt};
 var method=String(o.method||'GET').toUpperCase();
 if(METHODS.indexOf(method)<0)return {ok:false,err:L.eMeth};
 var h=parseHeaders(o.headers);if(!h.ok)return h;
 var body=String(o.body==null?'':o.body);
 if(body.length>MAXB)return {ok:false,err:L.eBigB};
 var user=String(o.user==null?'':o.user),bear=String(o.bearer==null?'':o.bearer).trim();
 if(user&&bear)return {ok:false,err:L.eAuth};
 if(bear&&/[\s\x00-\x1f\x7f]/.test(bear))return {ok:false,err:L.eBear};
 if(/[\x00-\x1f\x7f]/.test(user))return {ok:false,err:L.eUser};
 var tm=String(o.timeout==null?'':o.timeout).trim();
 if(tm&&(!/^\d{1,5}$/.test(tm)||+tm<1||+tm>86400))return {ok:false,err:L.eTime};
 var notes=[],hl=h.list.slice();
 if(bear)hl.push(['Authorization','Bearer '+bear]);
 var hasBody=body!=='';
 if(method==='HEAD'&&hasBody){notes.push(L.nHead);hasBody=false;body='';}
 var hasCT=hl.some(function(x){return x[0].toLowerCase()==='content-type';});
 if(hasBody&&!hasCT&&/^\s*[\[{]/.test(body))notes.push(L.nJson);
 if(method==='GET'&&hasBody)notes.push(L.nGet);
 if(o.insecure)notes.push(L.nIns);
 var p=['curl '+quote(url)];
 if(o.follow)p.push('-L');if(o.incl)p.push('-i');if(o.silent)p.push('-s');if(o.insecure)p.push('-k');if(o.comp)p.push('--compressed');if(o.verbose)p.push('-v');
 if(tm)p.push('--max-time '+tm);
 if(method==='HEAD')p.push('-I');
 else if(!((method==='POST'&&hasBody)||(method==='GET'&&!hasBody)))p.push('-X '+method);
 if(user)p.push('-u '+quote(user));
 hl.forEach(function(x){p.push('-H '+quote(x[0]+': '+x[1]));});
 if(hasBody)p.push('--data-raw '+quote(body));
 var cmd=p.join(o.one?' ':' \\\n  ');
 var map=Object.create(null),order=[];
 function addH(n,v,code){var k=n.toLowerCase();
  if(map[k]){notes.push(L.nDup);if(!map[k].code&&!code)map[k].val+=', '+v;return;}
  map[k]={name:n,val:v,code:code};order.push(k);}
 hl.forEach(function(x){addH(x[0],x[1]);});
 if(user)addH('Authorization','','"Basic " + btoa('+JSON.stringify(user)+')');
 var fo=[];
 if(method!=='GET')fo.push('  method: '+JSON.stringify(method));
 if(order.length)fo.push('  headers: {\n'+order.map(function(k){var e=map[k];return '    '+JSON.stringify(e.name)+': '+(e.code||JSON.stringify(e.val));}).join(',\n')+'\n  }');
 if(hasBody)fo.push('  body: '+JSON.stringify(body));
 if(!o.follow)fo.push('  redirect: "manual"');
 if(tm)fo.push('  signal: AbortSignal.timeout('+(+tm*1000)+')');
 var fetchTxt='fetch('+JSON.stringify(url)+(fo.length?', {\n'+fo.join(',\n')+'\n}':'')+');';
 var ign=[];if(o.incl)ign.push('-i');if(o.silent)ign.push('-s');if(o.insecure)ign.push('-k');if(o.verbose)ign.push('-v');
 var nn=[];notes.forEach(function(x){if(nn.indexOf(x)<0)nn.push(x);});
 return {ok:true,cmd:cmd,fetch:fetchTxt,notes:nn,fetchIgnored:ign};}
function ansiC(s,i){var n=s.length,j=i,buf='';
 while(j<n){var ch=s.charAt(j);
  if(ch==="'")return {ok:true,text:buf,end:j+1};
  if(ch==='\\'&&j+1<n){var e=s.charAt(j+1);
   if(e==='n'){buf+='\n';j+=2;}else if(e==='t'){buf+='\t';j+=2;}else if(e==='r'){buf+='\r';j+=2;}
   else if(e==='x'&&/^[0-9a-fA-F]{2}/.test(s.substr(j+2,2))){buf+=String.fromCharCode(parseInt(s.substr(j+2,2),16));j+=4;}
   else if(e==='u'&&/^[0-9a-fA-F]{4}/.test(s.substr(j+2,4))){buf+=String.fromCharCode(parseInt(s.substr(j+2,4),16));j+=6;}
   else{buf+=e;j+=2;}
   continue;}
  buf+=ch;j++;}
 return {ok:false};}
function tokenize(s){var out=[],cur='',has=false,i=0,n=s.length,c;
 while(i<n){c=s.charAt(i);
  if(c==='\\'){if(i+1>=n){i++;continue;}var d=s.charAt(i+1);
   if(d==='\n'){i+=2;continue;}
   if(d==='\r'&&s.charAt(i+2)==='\n'){i+=3;continue;}
   cur+=d;has=true;i+=2;continue;}
  if(c==='$'&&s.charAt(i+1)==="'"){var a=ansiC(s,i+2);if(!a.ok)return {ok:false,err:L.eQuote};cur+=a.text;has=true;i=a.end;continue;}
  if(c==="'"){var j=s.indexOf("'",i+1);if(j<0)return {ok:false,err:L.eQuote};cur+=s.slice(i+1,j);has=true;i=j+1;continue;}
  if(c==='"'){i++;var closed=false;
   while(i<n){c=s.charAt(i);
    if(c==='\\'&&i+1<n){var e=s.charAt(i+1);
     if(e==='"'||e==='\\'||e==='$'||e==='\x60'){cur+=e;i+=2;continue;}
     if(e==='\n'){i+=2;continue;}
     cur+='\\';i++;continue;}
    if(c==='"'){closed=true;i++;break;}
    cur+=c;i++;}
   if(!closed)return {ok:false,err:L.eQuote};
   has=true;continue;}
  if(/\s/.test(c)){if(has){out.push(cur);cur='';has=false;}i++;continue;}
  cur+=c;has=true;i++;}
 if(has)out.push(cur);
 return {ok:true,tokens:out};}
function parse(cmd){cmd=String(cmd==null?'':cmd);
 if(!cmd.trim())return {ok:false,err:L.eInEmpty};
 if(cmd.length>MAXIN)return {ok:false,err:L.eBigIn};
 var tk=tokenize(cmd);if(!tk.ok)return tk;
 var t=tk.tokens;
 if(!t.length||t[0]!=='curl')return {ok:false,err:L.eNotCurl};
 var r={url:'',method:'',headers:[],data:[],user:'',follow:false,incl:false,silent:false,insecure:false,comp:false,verbose:false,head:false,timeout:'',ignored:[]};
 var missing='',i;
 function take(flag,val){
  if(flag==='-X'||flag==='--request')r.method=String(val).toUpperCase();
  else if(flag==='-H'||flag==='--header'){if(/^[^:;]+:/.test(val)&&/:\s*\S/.test(val))r.headers.push(val);else r.ignored.push(flag+' '+val);}
  else if(flag==='-d'||flag==='--data'||flag==='--data-ascii'||flag==='--data-binary'||flag==='--data-raw'){
   if(flag!=='--data-raw'&&val.charAt(0)==='@')r.ignored.push(flag+' @file');else r.data.push(val);}
  else if(flag==='-u'||flag==='--user')r.user=val;
  else if(flag==='-m'||flag==='--max-time'){if(/^\d{1,5}$/.test(val))r.timeout=val;else r.ignored.push(flag+' '+val);}
  else if(flag==='--url'){if(!r.url)r.url=val;else r.ignored.push(flag+' '+val);}
  else r.ignored.push(flag);}
 var LONGARG={'--request':1,'--header':1,'--data':1,'--data-ascii':1,'--data-binary':1,'--data-raw':1,'--user':1,'--max-time':1,'--url':1,'--data-urlencode':1,'--output':1,'--cookie':1,'--user-agent':1,'--referer':1,'--form':1,'--upload-file':1,'--proxy':1,'--write-out':1,'--cacert':1,'--cert':1,'--key':1,'--connect-timeout':1,'--retry':1,'--resolve':1,'--json':1};
 var SHORTARG='XHdumoAebFTxwcEKrzCDtQ';
 for(i=1;i<t.length&&!missing;i++){var a=t[i];
  if(a.indexOf('--')===0&&a.length>2){var eq=a.indexOf('='),nm=eq>0?a.slice(0,eq):a,val=eq>0?a.slice(eq+1):null;
   if(nm==='--location')r.follow=true;
   else if(nm==='--include')r.incl=true;
   else if(nm==='--silent')r.silent=true;
   else if(nm==='--insecure')r.insecure=true;
   else if(nm==='--compressed')r.comp=true;
   else if(nm==='--verbose')r.verbose=true;
   else if(nm==='--head')r.head=true;
   else if(LONGARG[nm]){
    if(val===null){if(i+1<t.length){val=t[++i];}else{missing=nm;break;}}
    take(nm,val);}
   else r.ignored.push(nm);}
  else if(a.length>1&&a.charAt(0)==='-'){
   for(var k=1;k<a.length;k++){var ch=a.charAt(k);
    if(ch==='L')r.follow=true;else if(ch==='i')r.incl=true;else if(ch==='s')r.silent=true;else if(ch==='k')r.insecure=true;else if(ch==='v')r.verbose=true;else if(ch==='I')r.head=true;
    else if(SHORTARG.indexOf(ch)>=0){var rest=a.slice(k+1),v2;
     if(rest!=='')v2=rest;else if(i+1<t.length)v2=t[++i];else{missing='-'+ch;break;}
     take('-'+ch,v2);break;}
    else if(ch!=='S')r.ignored.push('-'+ch);}}
  else{if(!r.url)r.url=a;else r.ignored.push(a);}}
 if(missing)return {ok:false,err:L.eBadArg.replace('{x}',missing)};
 if(!r.url)return {ok:false,err:L.eNoUrl};
 var method=r.head?'HEAD':(r.method||'');
 if(method&&METHODS.indexOf(method)<0){r.ignored.push('-X '+method);method='';}
 if(!method)method=r.data.length?'POST':'GET';
 return {ok:true,ignored:r.ignored,fields:{url:r.url,method:method,headers:r.headers.join('\n'),body:r.data.join('&'),user:r.user,bearer:'',timeout:r.timeout,follow:r.follow,incl:r.incl,silent:r.silent,insecure:r.insecure,comp:r.comp,verbose:r.verbose,one:false}};}
if(window.__SG_TEST)window.__SG_TEST.curl={build:build,parse:parse,tokenize:tokenize,quote:quote,parseHeaders:parseHeaders};
function readForm(){return {url:$('cuU').value,method:$('cuM').value,headers:$('cuH').value,body:$('cuB').value,user:$('cuA').value,bearer:$('cuBr').value,timeout:$('cuT').value,follow:$('cuL').checked,incl:$('cuI').checked,silent:$('cuS').checked,insecure:$('cuK').checked,comp:$('cuC').checked,verbose:$('cuV').checked,one:$('cuO').checked};}
function render(o){var box=$('cuBox');
 if(!o.ok){lastText='';msg(box,o.err,true);return;}
 var fmt=$('cuF').value||'curl',txt=fmt==='fetch'?o.fetch:o.cmd;
 lastText=txt;showPre(box,txt);
 var notes=o.notes.slice();
 if(fmt==='fetch'&&o.fetchIgnored.length)notes.push(L.nFetchIgn.replace('{x}',o.fetchIgnored.join(' ')));
 notes.forEach(function(n){var d=document.createElement('div');d.textContent=L.kNote+': '+n;box.appendChild(d);});}
function run(){render(build(readForm()));}
function loadCmd(){var p=parse($('cuIn').value);
 if(!p.ok){lastText='';msg($('cuBox'),p.err,true);return;}
 var f=p.fields;
 $('cuU').value=f.url;$('cuM').value=f.method;$('cuH').value=f.headers;$('cuB').value=f.body;$('cuA').value=f.user;$('cuBr').value=f.bearer;$('cuT').value=f.timeout;
 $('cuL').checked=f.follow;$('cuI').checked=f.incl;$('cuS').checked=f.silent;$('cuK').checked=f.insecure;$('cuC').checked=f.comp;$('cuV').checked=f.verbose;$('cuO').checked=f.one;
 var o=build(readForm());
 if(o.ok&&p.ignored.length)o.notes.push(L.nIgn.replace('{x}',p.ignored.join(' ')));
 render(o);}
on('cuGo',run);
on('cuCopy',function(){copyText(lastText);});
on('cuLoad',loadCmd);
on('cuF',run);
run();
`
  },
"ssh-config": {
    title: { id: "Pembuat SSH Config", en: "SSH Config Builder" },
    labels: {
      id: { title: "Pembuat SSH Config", back: "Kembali ke Alat", aL: "Alias Host (boleh beberapa, pisah spasi)", hL: "HostName (domain atau IP)", uL: "User", pL: "Port (opsional)", iL: "IdentityFile (path kunci privat, opsional)", jL: "ProxyJump (mis. user@bastion:22, pisah koma)",
        fL: "Forward (satu per baris): L 8080 localhost:80 | R 9000 127.0.0.1:3000 | D 1080", kaL: "ServerAliveInterval (detik, opsional)", kcL: "ServerAliveCountMax (opsional)",
        agL: "ForwardAgent", shL: "StrictHostKeyChecking", oDef: "(bawaan)", oYes: "yes", oNo: "no", oNew: "accept-new", oAsk: "ask",
        ioL: "IdentitiesOnly (pakai hanya kunci di IdentityFile)", coL: "Compression", go: "Buat", copy: "Salin hasil",
        warn: "Semua diproses di browser Anda. Tidak ada kolom teks bebas: nilai yang berisi spasi, kutip ganda, backslash, atau baris baru ditolak supaya tidak bisa menyelipkan direktif lain (mis. ProxyCommand). Pakai garis miring biasa untuk path Windows.",
        eAlias: "Isi alias Host dulu.", eAliasBad: "Alias tidak valid: hanya huruf, angka, titik, garis bawah, minus, dan pola * ? !.", eAliasMany: "Terlalu banyak pola alias (maks 10).",
        eHost: "HostName tidak valid (hanya huruf, angka, titik, minus, garis bawah, titik dua untuk IPv6; maks 255).", eUser: "User tidak valid (hanya huruf, angka, titik, garis bawah, minus; maks 64).", ePort: "Port harus bilangan bulat 1 sampai 65535.",
        eId: "Path IdentityFile tidak valid (tanpa kutip ganda, backslash, atau karakter kontrol; maks 1000).", eJump: "ProxyJump tidak valid: {x}", eFwd: "Baris forward tidak valid", eFwdMany: "Terlalu banyak forward (maks 50).",
        eKa: "ServerAliveInterval harus bilangan bulat 0 sampai 86400.", eKc: "ServerAliveCountMax harus bilangan bulat 1 sampai 1000.", eSel: "Pilihan tidak dikenal.", vLine: "baris",
        kNote: "Catatan", nWild: "Alias berisi pola wildcard: HostName/User/Port di bawahnya berlaku untuk semua host yang cocok.", nStrict: "StrictHostKeyChecking no mematikan perlindungan terhadap server palsu (MITM). Jangan dipakai untuk server yang penting.",
        nBind: "Forward dengan alamat bind terbuka (*, 0.0.0.0, atau ::) bisa diakses dari jaringan lain, bukan hanya komputer ini.", nNoHost: "HostName kosong: ssh memakai alias sebagai nama host.", nAgent: "ForwardAgent yes: host tujuan bisa memakai kunci di agent Anda selama sesi. Hanya untuk host yang dipercaya.", lang: "id" },
      en: { title: "SSH Config Builder", back: "Back to Tools", aL: "Host alias (several allowed, space separated)", hL: "HostName (domain or IP)", uL: "User", pL: "Port (optional)", iL: "IdentityFile (private key path, optional)", jL: "ProxyJump (e.g. user@bastion:22, comma separated)",
        fL: "Forwards (one per line): L 8080 localhost:80 | R 9000 127.0.0.1:3000 | D 1080", kaL: "ServerAliveInterval (seconds, optional)", kcL: "ServerAliveCountMax (optional)",
        agL: "ForwardAgent", shL: "StrictHostKeyChecking", oDef: "(default)", oYes: "yes", oNo: "no", oNew: "accept-new", oAsk: "ask",
        ioL: "IdentitiesOnly (use only the key in IdentityFile)", coL: "Compression", go: "Build", copy: "Copy result",
        warn: "Everything runs in your browser. There is no free-text field: values containing spaces, double quotes, backslashes or newlines are rejected so no other directive (e.g. ProxyCommand) can be smuggled in. Use forward slashes for Windows paths.",
        eAlias: "Enter a Host alias first.", eAliasBad: "Invalid alias: only letters, digits, dot, underscore, minus and the patterns * ? ! are allowed.", eAliasMany: "Too many alias patterns (max 10).",
        eHost: "Invalid HostName (only letters, digits, dot, minus, underscore, colon for IPv6; max 255).", eUser: "Invalid User (only letters, digits, dot, underscore, minus; max 64).", ePort: "Port must be an integer from 1 to 65535.",
        eId: "Invalid IdentityFile path (no double quotes, backslashes or control characters; max 1000).", eJump: "Invalid ProxyJump: {x}", eFwd: "Invalid forward line", eFwdMany: "Too many forwards (max 50).",
        eKa: "ServerAliveInterval must be an integer from 0 to 86400.", eKc: "ServerAliveCountMax must be an integer from 1 to 1000.", eSel: "Unknown choice.", vLine: "line",
        kNote: "Note", nWild: "The alias contains a wildcard pattern: HostName/User/Port below apply to every matching host.", nStrict: "StrictHostKeyChecking no disables protection against fake servers (MITM). Do not use it for important servers.",
        nBind: "A forward with an open bind address (*, 0.0.0.0 or ::) is reachable from other machines, not just this computer.", nNoHost: "HostName is empty: ssh will use the alias as the host name.", nAgent: "ForwardAgent yes: the remote host can use the keys in your agent during the session. Only for hosts you trust.", lang: "en" }
    },
    html: (L) => `<div class="ed-main">
      <div class="fld"><label for="scA">${esc(L.aL)}</label><input class="tool-in" type="text" id="scA" value="myserver" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="scH">${esc(L.hL)}</label><input class="tool-in" type="text" id="scH" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="scU">${esc(L.uL)}</label><input class="tool-in" type="text" id="scU" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="scP">${esc(L.pL)}</label><input class="tool-in" type="text" id="scP" value="" inputmode="numeric" autocomplete="off"></div>
      <div class="fld"><label for="scI">${esc(L.iL)}</label><input class="tool-in" type="text" id="scI" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="scJ">${esc(L.jL)}</label><input class="tool-in" type="text" id="scJ" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="scF">${esc(L.fL)}</label><textarea id="scF" class="tool-ta" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></div>
      <div class="fld"><label for="scKA">${esc(L.kaL)}</label><input class="tool-in" type="text" id="scKA" value="" inputmode="numeric" autocomplete="off"></div>
      <div class="fld"><label for="scKC">${esc(L.kcL)}</label><input class="tool-in" type="text" id="scKC" value="" inputmode="numeric" autocomplete="off"></div>
      <div class="fld"><label for="scAG">${esc(L.agL)}</label><select class="tool-sel" id="scAG"><option value="">${esc(L.oDef)}</option><option value="yes">${esc(L.oYes)}</option><option value="no">${esc(L.oNo)}</option></select></div>
      <div class="fld"><label for="scSH">${esc(L.shL)}</label><select class="tool-sel" id="scSH"><option value="">${esc(L.oDef)}</option><option value="yes">${esc(L.oYes)}</option><option value="accept-new">${esc(L.oNew)}</option><option value="ask">${esc(L.oAsk)}</option><option value="no">${esc(L.oNo)}</option></select></div>
      <div class="fld"><label><input type="checkbox" id="scIO"> ${esc(L.ioL)}</label><label><input type="checkbox" id="scCo"> ${esc(L.coL)}</label></div>
      <div class="row"><button class="btn" id="scGo" type="button">${esc(L.go)}</button><button class="btn ghost" id="scCopy" type="button">${esc(L.copy)}</button></div>
      <p class="sg-notice sg-warning" role="note">${esc(L.warn)}</p>
      <div id="scBox" class="tool-out"></div>
    </div>`,
    js: String.raw`
var lastText='';
var V6='\\[[0-9A-Fa-f:.]+\\]';
var RE_PAT=/^[A-Za-z0-9._*?!-]+$/,RE_HOST=/^[A-Za-z0-9._:-]+$/,RE_USER=/^[A-Za-z0-9._-]+$/;
var RE_NAME=new RegExp('^(?:[A-Za-z0-9._-]+|'+V6+')$');
var RE_BIND=new RegExp('^(?:[A-Za-z0-9._*-]+|'+V6+')$');
function fmtPath(p){return /[\s#']/.test(p)?'"'+p+'"':p;}
function okPort(s){return /^\d{1,5}$/.test(s)&&+s>=1&&+s<=65535;}
function endPort(s){var i=s.lastIndexOf(':');return i<0?null:[s.slice(0,i),s.slice(i+1)];}
function parseJump(text){var parts=String(text).split(','),out=[];
 for(var i=0;i<parts.length;i++){var j=parts[i].trim();
  if(!j)return {ok:false,bad:parts[i]};
  var u='',rest=j,at=j.indexOf('@');
  if(at>=0){u=j.slice(0,at);rest=j.slice(at+1);if(!RE_USER.test(u))return {ok:false,bad:j};}
  var host=rest,port='';
  if(rest.charAt(0)==='['){var close=rest.indexOf(']');if(close<0)return {ok:false,bad:j};host=rest.slice(0,close+1);var tail=rest.slice(close+1);
   if(tail){if(tail.charAt(0)!==':')return {ok:false,bad:j};port=tail.slice(1);}}
  else{var c=rest.lastIndexOf(':');if(c>=0){host=rest.slice(0,c);port=rest.slice(c+1);}}
  if(!RE_NAME.test(host)||host.length>255)return {ok:false,bad:j};
  if(port!==''&&!okPort(port))return {ok:false,bad:j};
  out.push((u?u+'@':'')+host+(port!==''?':'+port:''));}
 return {ok:true,text:out.join(',')};}
function splitBind(spec){var m=spec.match(/^(.*):(\d{1,5})$/);
 if(!m){if(!okPort(spec))return null;return {bind:'',port:spec};}
 if(!okPort(m[2]))return null;
 if(m[1]===''||!RE_BIND.test(m[1])||m[1].length>255)return null;
 return {bind:m[1],port:m[2]};}
function parseFwd(text){var lines=String(text==null?'':text).split(/\r?\n/),out=[],n=0;
 for(var i=0;i<lines.length;i++){var ln=lines[i].trim();if(!ln)continue;n++;
  var bad={ok:false,err:L.eFwd+' ('+L.vLine+' '+(i+1)+')'};
  var tk=ln.split(/\s+/),ty=tk[0].replace(/^-/,'').toUpperCase();
  if(ty!=='L'&&ty!=='R'&&ty!=='D')return bad;
  var sp=splitBind(tk[1]||'');if(!sp)return bad;
  var exposed=sp.bind==='*'||sp.bind==='0.0.0.0'||sp.bind==='[::]'||sp.bind==='::';
  if(ty==='D'){if(tk.length!==2)return bad;out.push({k:'DynamicForward',v:(sp.bind?sp.bind+':':'')+sp.port,exposed:exposed});continue;}
  if(tk.length!==3)return bad;
  var d=tk[2],v6=d.charAt(0)==='[',ep;
  if(v6){var cl=d.indexOf(']');ep=cl<0?null:[d.slice(0,cl+1),d.slice(cl+1).replace(/^:/,''),d.slice(cl+1).charAt(0)];if(!ep||ep[2]!==':')return bad;}
  else ep=endPort(d);
  if(!ep||!RE_NAME.test(ep[0])||ep[0].length>255||!okPort(ep[1]))return bad;
  out.push({k:ty==='L'?'LocalForward':'RemoteForward',v:(sp.bind?sp.bind+':':'')+sp.port+' '+ep[0]+':'+ep[1],exposed:exposed});}
 if(n>50)return {ok:false,err:L.eFwdMany};
 return {ok:true,list:out};}
function build(o){o=o||{};
 var alias=String(o.alias==null?'':o.alias).trim();
 if(!alias)return {ok:false,err:L.eAlias};
 var pats=alias.split(/\s+/);
 if(pats.length>10)return {ok:false,err:L.eAliasMany};
 for(var i=0;i<pats.length;i++){if(!RE_PAT.test(pats[i])||pats[i].length>255)return {ok:false,err:L.eAliasBad};}
 var host=String(o.host==null?'':o.host).trim();
 if(host&&(!RE_HOST.test(host)||host.length>255))return {ok:false,err:L.eHost};
 var user=String(o.user==null?'':o.user).trim();
 if(user&&(!RE_USER.test(user)||user.length>64))return {ok:false,err:L.eUser};
 var port=String(o.port==null?'':o.port).trim();
 if(port&&!okPort(port))return {ok:false,err:L.ePort};
 var idf=String(o.identity==null?'':o.identity).trim();
 if(idf&&(idf.length>1000||/["\\\x00-\x1f\x7f]/.test(idf)))return {ok:false,err:L.eId};
 var jump=String(o.jump==null?'':o.jump).trim(),jt='';
 if(jump){if(jump.toLowerCase()==='none')jt='none';else{var pj=parseJump(jump);if(!pj.ok)return {ok:false,err:L.eJump.replace('{x}',String(pj.bad).trim().slice(0,80))};jt=pj.text;}}
 var fw=parseFwd(o.forwards);if(!fw.ok)return fw;
 var ka=String(o.alive==null?'':o.alive).trim();
 if(ka&&(!/^\d{1,5}$/.test(ka)||+ka>86400))return {ok:false,err:L.eKa};
 var kc=String(o.aliveMax==null?'':o.aliveMax).trim();
 if(kc&&(!/^\d{1,4}$/.test(kc)||+kc<1||+kc>1000))return {ok:false,err:L.eKc};
 var ag=String(o.agent==null?'':o.agent),sh=String(o.strict==null?'':o.strict);
 if(['','yes','no'].indexOf(ag)<0||['','yes','no','accept-new','ask'].indexOf(sh)<0)return {ok:false,err:L.eSel};
 var notes=[],ln=['Host '+pats.join(' ')];
 if(host)ln.push('    HostName '+host);
 if(user)ln.push('    User '+user);
 if(port)ln.push('    Port '+(+port));
 if(idf)ln.push('    IdentityFile '+fmtPath(idf));
 if(o.idOnly)ln.push('    IdentitiesOnly yes');
 if(jt)ln.push('    ProxyJump '+jt);
 if(ag)ln.push('    ForwardAgent '+ag);
 if(o.compress)ln.push('    Compression yes');
 if(sh)ln.push('    StrictHostKeyChecking '+sh);
 if(ka)ln.push('    ServerAliveInterval '+(+ka));
 if(kc)ln.push('    ServerAliveCountMax '+(+kc));
 var order=['LocalForward','RemoteForward','DynamicForward'],exp=false;
 order.forEach(function(k){fw.list.forEach(function(f){if(f.k===k){ln.push('    '+k+' '+f.v);if(f.exposed)exp=true;}});});
 if(pats.some(function(p){return /[*?]/.test(p);})&&(host||user||port))notes.push(L.nWild);
 if(!host&&!pats.some(function(p){return /[*?!]/.test(p);}))notes.push(L.nNoHost);
 if(sh==='no')notes.push(L.nStrict);
 if(exp)notes.push(L.nBind);
 if(ag==='yes')notes.push(L.nAgent);
 return {ok:true,text:ln.join('\n'),notes:notes};}
if(window.__SG_TEST)window.__SG_TEST['ssh-config']={build:build,parseJump:parseJump,parseFwd:parseFwd,fmtPath:fmtPath};
function readForm(){return {alias:$('scA').value,host:$('scH').value,user:$('scU').value,port:$('scP').value,identity:$('scI').value,jump:$('scJ').value,forwards:$('scF').value,alive:$('scKA').value,aliveMax:$('scKC').value,agent:$('scAG').value,strict:$('scSH').value,idOnly:$('scIO').checked,compress:$('scCo').checked};}
function run(){var box=$('scBox'),o=build(readForm());
 if(!o.ok){lastText='';msg(box,o.err,true);return;}
 lastText=o.text;showPre(box,o.text);
 o.notes.forEach(function(n){var d=document.createElement('div');d.textContent=L.kNote+': '+n;box.appendChild(d);});}
on('scGo',run);
on('scCopy',function(){copyText(lastText);});
['scA','scH','scU','scP','scI','scJ','scKA','scKC'].forEach(function(i){onEnter(i,run);});
run();
`
  },
"tunnel": {
    title: { id: "Pembuat Tunnel", en: "Tunnel Builder" },
    labels: {
      id: { title: "Pembuat Tunnel", back: "Kembali ke Alat", mL: "Jenis tunnel", mSsh: "SSH (perintah ssh dengan forward port)", mCf: "Cloudflare Tunnel (config.yml)",
        hL: "Host tujuan (domain atau IP)", uL: "User (opsional)", pL: "Port SSH (opsional)", iL: "IdentityFile (path kunci privat, opsional)", jL: "ProxyJump (mis. user@bastion:22, pisah koma)",
        fL: "Forward (satu per baris): L 8080 localhost:80 | R 9000 127.0.0.1:3000 | D 1080", kaL: "ServerAliveInterval (detik, opsional)", kcL: "ServerAliveCountMax (opsional)",
        bgL: "Jalankan di latar belakang (-f)", efL: "Keluar jika forward gagal (ExitOnForwardFailure)", coL: "Kompresi (-C)",
        idL: "Tunnel (UUID atau nama, opsional)", crL: "credentials-file (path, opsional)", rlL: "Aturan ingress (satu per baris): app.example.com http://localhost:8080 | *.example.com https://10.0.0.5:8443 | baris terakhir boleh hanya layanan (catch-all)",
        tlL: "noTLSVerify untuk layanan https (tidak aman)", go: "Buat", copy: "Salin hasil",
        warn: "Semua diproses di browser Anda. Nilai yang berisi karakter berbahaya ditolak atau dikutip supaya tidak bisa menyelipkan opsi atau perintah lain. Kutip gaya POSIX (bukan Windows cmd). Hasil hanya teks: tidak ada yang dijalankan.",
        eHostReq: "Isi host tujuan dulu.", eHost: "Host tidak valid (hanya huruf, angka, titik, minus, garis bawah, titik dua untuk IPv6; tidak boleh diawali minus; maks 255).",
        eUser: "User tidak valid (hanya huruf, angka, titik, garis bawah, minus; tidak boleh diawali minus; maks 64).", ePort: "Port harus bilangan bulat 1 sampai 65535.",
        eId: "Path IdentityFile tidak valid (tanpa kutip ganda, backslash, atau karakter kontrol; maks 1000).", eJump: "ProxyJump tidak valid: {x}", eFwd: "Baris forward tidak valid", eFwdMany: "Terlalu banyak forward (maks 50).",
        eNeedFwd: "Isi minimal satu forward.", eKa: "ServerAliveInterval harus bilangan bulat 0 sampai 86400.", eKc: "ServerAliveCountMax harus bilangan bulat 1 sampai 1000.",
        eTun: "Nama/UUID tunnel tidak valid (hanya huruf, angka, titik, garis bawah, minus; maks 64).", eCred: "Path credentials-file tidak valid (tanpa kutip ganda, backslash, atau karakter kontrol; maks 1000).",
        eRule: "Baris aturan tidak valid: pakai \"hostname layanan\"", eRuleHost: "Hostname tidak valid", eSvc: "Layanan tidak valid (http://host:port, https://, tcp://, ssh://, rdp://, smb://, http_status:404, hello_world, bastion)",
        eLast: "Aturan tanpa hostname (catch-all) harus jadi baris terakhir", eRuleMany: "Terlalu banyak aturan (maks 50).", eNoRule: "Isi minimal satu aturan.", vLine: "baris",
        kNote: "Catatan", nBind: "Forward dengan alamat bind terbuka (*, 0.0.0.0, atau ::) bisa diakses dari jaringan lain, bukan hanya komputer ini.",
        nBg: "Dengan -f, ssh berjalan di latar belakang setelah terhubung; hentikan dengan kill pada prosesnya.", nNoEF: "Tanpa ExitOnForwardFailure, ssh tetap terhubung walau forward gagal (mis. port sudah terpakai).",
        nTls: "noTLSVerify mematikan pemeriksaan sertifikat origin https. Jangan dipakai untuk origin di jaringan yang tidak dipercaya.",
        nDup: "Hostname ganda: aturan yang muncul belakangan tidak akan pernah dipakai (aturan pertama yang cocok menang).", nShadow: "Aturan wildcard di atas menutupi hostname yang lebih spesifik di bawahnya (aturan pertama yang cocok menang).",
        nNoId: "Tunnel kosong: baris tunnel tidak dibuat; isi lewat flag atau variabel saat menjalankan cloudflared.", nNoCred: "credentials-file kosong: baris itu tidak dibuat.",
        nCatch: "Aturan catch-all http_status:404 ditambahkan otomatis (cloudflared mewajibkan aturan terakhir tanpa hostname).", lang: "id" },
      en: { title: "Tunnel Builder", back: "Back to Tools", mL: "Tunnel type", mSsh: "SSH (ssh command with port forwards)", mCf: "Cloudflare Tunnel (config.yml)",
        hL: "Target host (domain or IP)", uL: "User (optional)", pL: "SSH port (optional)", iL: "IdentityFile (private key path, optional)", jL: "ProxyJump (e.g. user@bastion:22, comma separated)",
        fL: "Forwards (one per line): L 8080 localhost:80 | R 9000 127.0.0.1:3000 | D 1080", kaL: "ServerAliveInterval (seconds, optional)", kcL: "ServerAliveCountMax (optional)",
        bgL: "Run in the background (-f)", efL: "Exit if a forward fails (ExitOnForwardFailure)", coL: "Compression (-C)",
        idL: "Tunnel (UUID or name, optional)", crL: "credentials-file (path, optional)", rlL: "Ingress rules (one per line): app.example.com http://localhost:8080 | *.example.com https://10.0.0.5:8443 | the last line may be a service only (catch-all)",
        tlL: "noTLSVerify for https services (insecure)", go: "Build", copy: "Copy result",
        warn: "Everything runs in your browser. Values containing dangerous characters are rejected or quoted so no other option or command can be smuggled in. POSIX quoting (not Windows cmd). The result is text only: nothing is executed.",
        eHostReq: "Enter the target host first.", eHost: "Invalid host (only letters, digits, dot, minus, underscore, colon for IPv6; must not start with a minus; max 255).",
        eUser: "Invalid user (only letters, digits, dot, underscore, minus; must not start with a minus; max 64).", ePort: "Port must be an integer from 1 to 65535.",
        eId: "Invalid IdentityFile path (no double quotes, backslashes or control characters; max 1000).", eJump: "Invalid ProxyJump: {x}", eFwd: "Invalid forward line", eFwdMany: "Too many forwards (max 50).",
        eNeedFwd: "Enter at least one forward.", eKa: "ServerAliveInterval must be an integer from 0 to 86400.", eKc: "ServerAliveCountMax must be an integer from 1 to 1000.",
        eTun: "Invalid tunnel name/UUID (only letters, digits, dot, underscore, minus; max 64).", eCred: "Invalid credentials-file path (no double quotes, backslashes or control characters; max 1000).",
        eRule: "Invalid rule line: use \"hostname service\"", eRuleHost: "Invalid hostname", eSvc: "Invalid service (http://host:port, https://, tcp://, ssh://, rdp://, smb://, http_status:404, hello_world, bastion)",
        eLast: "A rule without a hostname (catch-all) must be the last line", eRuleMany: "Too many rules (max 50).", eNoRule: "Enter at least one rule.", vLine: "line",
        kNote: "Note", nBind: "A forward with an open bind address (*, 0.0.0.0 or ::) is reachable from other machines, not just this computer.",
        nBg: "With -f, ssh goes to the background after connecting; stop it by killing the process.", nNoEF: "Without ExitOnForwardFailure, ssh stays connected even if a forward fails (e.g. the port is already in use).",
        nTls: "noTLSVerify turns off certificate checks for https origins. Do not use it for origins on an untrusted network.",
        nDup: "Duplicate hostname: the later rule will never be used (the first matching rule wins).", nShadow: "A wildcard rule above hides a more specific hostname below it (the first matching rule wins).",
        nNoId: "Tunnel is empty: the tunnel line is not written; pass it by flag or variable when running cloudflared.", nNoCred: "credentials-file is empty: that line is not written.",
        nCatch: "A catch-all http_status:404 rule was added automatically (cloudflared requires the last rule to have no hostname).", lang: "en" }
    },
    html: (L) => `<div class="ed-main">
      <div class="fld"><label for="tnMode">${esc(L.mL)}</label><select class="tool-sel" id="tnMode"><option value="ssh">${esc(L.mSsh)}</option><option value="cf">${esc(L.mCf)}</option></select></div>
      <div id="tnSsh">
        <div class="fld"><label for="tnH">${esc(L.hL)}</label><input class="tool-in" type="text" id="tnH" value="example.com" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div class="fld"><label for="tnU">${esc(L.uL)}</label><input class="tool-in" type="text" id="tnU" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div class="fld"><label for="tnP">${esc(L.pL)}</label><input class="tool-in" type="text" id="tnP" value="" inputmode="numeric" autocomplete="off"></div>
        <div class="fld"><label for="tnI">${esc(L.iL)}</label><input class="tool-in" type="text" id="tnI" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div class="fld"><label for="tnJ">${esc(L.jL)}</label><input class="tool-in" type="text" id="tnJ" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div class="fld"><label for="tnF">${esc(L.fL)}</label><textarea id="tnF" class="tool-ta" spellcheck="false" autocapitalize="off" autocomplete="off">L 8080 localhost:80</textarea></div>
        <div class="fld"><label for="tnKA">${esc(L.kaL)}</label><input class="tool-in" type="text" id="tnKA" value="30" inputmode="numeric" autocomplete="off"></div>
        <div class="fld"><label for="tnKC">${esc(L.kcL)}</label><input class="tool-in" type="text" id="tnKC" value="3" inputmode="numeric" autocomplete="off"></div>
        <div class="fld"><label><input type="checkbox" id="tnBg"> ${esc(L.bgL)}</label><label><input type="checkbox" id="tnEF" checked> ${esc(L.efL)}</label><label><input type="checkbox" id="tnCo"> ${esc(L.coL)}</label></div>
      </div>
      <div id="tnCf" style="display:none">
        <div class="fld"><label for="tnCfId">${esc(L.idL)}</label><input class="tool-in" type="text" id="tnCfId" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div class="fld"><label for="tnCfCred">${esc(L.crL)}</label><input class="tool-in" type="text" id="tnCfCred" value="" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
        <div class="fld"><label for="tnCfRules">${esc(L.rlL)}</label><textarea id="tnCfRules" class="tool-ta" spellcheck="false" autocapitalize="off" autocomplete="off">app.example.com http://localhost:8080</textarea></div>
        <div class="fld"><label><input type="checkbox" id="tnCfTls"> ${esc(L.tlL)}</label></div>
      </div>
      <div class="row"><button class="btn" id="tnGo" type="button">${esc(L.go)}</button><button class="btn ghost" id="tnCopy" type="button">${esc(L.copy)}</button></div>
      <p class="sg-notice sg-warning" role="note">${esc(L.warn)}</p>
      <div id="tnBox" class="tool-out"></div>
    </div>`,
    js: String.raw`
var lastText='';
var V6='\\[[0-9A-Fa-f:.]+\\]';
var RE_USER=/^[A-Za-z0-9._-]+$/,RE_HOST=/^[A-Za-z0-9._:-]+$/,RE_SAFE=/^[A-Za-z0-9_@%+=:,.\/-]+$/;
var RE_NAME=new RegExp('^(?:[A-Za-z0-9._-]+|'+V6+')$');
var RE_BIND=new RegExp('^(?:[A-Za-z0-9._*-]+|'+V6+')$');
function S(v){return String(v==null?'':v).trim();}
function shq(s){s=String(s);return RE_SAFE.test(s)?s:"'"+s.replace(/'/g,"'\\''")+"'";}
function okPort(s){return /^\d{1,5}$/.test(s)&&+s>=1&&+s<=65535;}
function endPort(s){var i=s.lastIndexOf(':');return i<0?null:[s.slice(0,i),s.slice(i+1)];}
function parseJump(text){var parts=String(text).split(','),out=[];
 for(var i=0;i<parts.length;i++){var j=parts[i].trim();
  if(!j)return {ok:false,bad:parts[i]};
  var u='',rest=j,at=j.indexOf('@');
  if(at>=0){u=j.slice(0,at);rest=j.slice(at+1);if(!RE_USER.test(u)||u.charAt(0)==='-')return {ok:false,bad:j};}
  var host=rest,port='';
  if(rest.charAt(0)==='['){var close=rest.indexOf(']');if(close<0)return {ok:false,bad:j};host=rest.slice(0,close+1);var tail=rest.slice(close+1);
   if(tail){if(tail.charAt(0)!==':')return {ok:false,bad:j};port=tail.slice(1);}}
  else{var c=rest.lastIndexOf(':');if(c>=0){host=rest.slice(0,c);port=rest.slice(c+1);}}
  // "none" dibaca ssh sebagai "matikan ProxyJump", bukan nama host
  if(!RE_NAME.test(host)||host.length>255||host.charAt(0)==='-'||j.toLowerCase()==='none')return {ok:false,bad:j};
  if(port!==''&&!okPort(port))return {ok:false,bad:j};
  out.push((u?u+'@':'')+host+(port!==''?':'+(+port):''));}
 return {ok:true,text:out.join(',')};}
function splitBind(spec){var m=spec.match(/^(.*):(\d{1,5})$/);
 if(!m){if(!okPort(spec))return null;return {bind:'',port:spec};}
 if(!okPort(m[2]))return null;
 if(m[1]===''||!RE_BIND.test(m[1])||m[1].length>255)return null;
 return {bind:m[1],port:m[2]};}
function parseFwd(text){var lines=String(text==null?'':text).split(/\r?\n/),out=[],n=0;
 for(var i=0;i<lines.length;i++){var ln=lines[i].trim();if(!ln)continue;
  if(++n>50)return {ok:false,err:L.eFwdMany};
  var bad={ok:false,err:L.eFwd+' ('+L.vLine+' '+(i+1)+')'};
  var tk=ln.split(/\s+/),ty=tk[0].replace(/^-/,'').toUpperCase();
  if(ty!=='L'&&ty!=='R'&&ty!=='D')return bad;
  var sp=splitBind(tk[1]||'');if(!sp)return bad;
  var exposed=sp.bind==='*'||sp.bind==='0.0.0.0'||sp.bind==='[::]'||sp.bind==='::';
  var lead=(sp.bind?sp.bind+':':'')+sp.port;
  if(ty==='D'){if(tk.length!==2)return bad;out.push({f:'-D',v:lead,exposed:exposed});continue;}
  if(tk.length!==3)return bad;
  var d=tk[2],ep;
  if(d.charAt(0)==='['){var cl=d.indexOf(']');ep=cl<0?null:[d.slice(0,cl+1),d.slice(cl+1).replace(/^:/,''),d.slice(cl+1).charAt(0)];if(!ep||ep[2]!==':')return bad;}
  else ep=endPort(d);
  if(!ep||!RE_NAME.test(ep[0])||ep[0].length>255||!okPort(ep[1]))return bad;
  out.push({f:'-'+ty,v:lead+':'+ep[0]+':'+(+ep[1]),exposed:exposed});}
 return {ok:true,list:out};}
function buildSsh(o){o=o||{};
 var host=S(o.host);
 if(!host)return {ok:false,err:L.eHostReq};
 if(!RE_HOST.test(host)||host.length>255||host.charAt(0)==='-')return {ok:false,err:L.eHost};
 var user=S(o.user);
 if(user&&(!RE_USER.test(user)||user.length>64||user.charAt(0)==='-'))return {ok:false,err:L.eUser};
 var port=S(o.port);
 if(port&&!okPort(port))return {ok:false,err:L.ePort};
 var idf=S(o.identity);
 if(idf&&(idf.length>1000||/["\\\x00-\x1f\x7f]/.test(idf)))return {ok:false,err:L.eId};
 var jump=S(o.jump),jt='';
 if(jump){var pj=parseJump(jump);if(!pj.ok)return {ok:false,err:L.eJump.replace('{x}',String(pj.bad).trim().slice(0,80))};jt=pj.text;}
 var fw=parseFwd(o.forwards);if(!fw.ok)return fw;
 if(!fw.list.length)return {ok:false,err:L.eNeedFwd};
 var ka=S(o.alive);
 if(ka&&(!/^\d{1,5}$/.test(ka)||+ka>86400))return {ok:false,err:L.eKa};
 var kc=S(o.aliveMax);
 if(kc&&(!/^\d{1,4}$/.test(kc)||+kc<1||+kc>1000))return {ok:false,err:L.eKc};
 var a=['ssh'],notes=[],exp=false;
 if(o.bg)a.push('-f');
 a.push('-N');
 if(o.compress)a.push('-C');
 if(o.exitFail)a.push('-o','ExitOnForwardFailure=yes');
 if(ka)a.push('-o','ServerAliveInterval='+(+ka));
 if(kc)a.push('-o','ServerAliveCountMax='+(+kc));
 if(port)a.push('-p',String(+port));
 if(idf)a.push('-i',idf);
 if(jt)a.push('-J',jt);
 fw.list.forEach(function(f){a.push(f.f,f.v);if(f.exposed)exp=true;});
 a.push((user?user+'@':'')+host);
 if(o.bg)notes.push(L.nBg);
 if(!o.exitFail)notes.push(L.nNoEF);
 if(exp)notes.push(L.nBind);
 return {ok:true,text:a.map(shq).join(' '),notes:notes};}
function hostOk(h){return h.length<=253&&!/\.\d[^.]*$/.test(h)&&/^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(h);}
function svcOk(s){
 var m=/^http_status:(\d{3})$/.exec(s);
 if(m)return +m[1]>=100&&+m[1]<=599?s:null;
 if(s==='hello_world'||s==='bastion')return s;
 m=/^([A-Za-z]+):\/\/(.+)$/.exec(s);if(!m)return null;
 var sc=m[1].toLowerCase();if(['http','https','tcp','ssh','rdp','smb'].indexOf(sc)<0)return null;
 var rest=m[2],host=rest,port='';
 if(rest.charAt(0)==='['){var c=rest.indexOf(']');if(c<0)return null;host=rest.slice(0,c+1);var tl=rest.slice(c+1);
  if(tl){if(tl.charAt(0)!==':')return null;port=tl.slice(1);if(!okPort(port))return null;}}
 else{var i=rest.lastIndexOf(':');if(i>=0){host=rest.slice(0,i);port=rest.slice(i+1);if(!okPort(port))return null;}}
 if(!RE_NAME.test(host)||host.length>255)return null;
 return sc+'://'+host+(port!==''?':'+(+port):'');}
function buildCf(o){o=o||{};
 var tid=S(o.tunnel),cred=S(o.cred);
 if(tid&&!/^[A-Za-z0-9._-]{1,64}$/.test(tid))return {ok:false,err:L.eTun};
 if(cred&&(cred.length>1000||/["\\\x00-\x1f\x7f-\x9f\u2028\u2029\ufeff]/.test(cred)))return {ok:false,err:L.eCred};
 var lines=String(o.rules==null?'':o.rules).split(/\r?\n/),rules=[],n=0,catchAll=null;
 for(var i=0;i<lines.length;i++){var ln=lines[i].trim();if(!ln)continue;
  if(++n>50)return {ok:false,err:L.eRuleMany};
  var where=' ('+L.vLine+' '+(i+1)+')';
  if(catchAll!==null)return {ok:false,err:L.eLast+where};
  var tk=ln.split(/\s+/);
  if(tk.length>2)return {ok:false,err:L.eRule+where};
  if(tk.length===1){var s1=svcOk(tk[0]);if(!s1)return {ok:false,err:L.eSvc+where};catchAll=s1;continue;}
  if(!hostOk(tk[0]))return {ok:false,err:L.eRuleHost+where};
  var s2=svcOk(tk[1]);if(!s2)return {ok:false,err:L.eSvc+where};
  rules.push({h:tk[0].toLowerCase(),s:s2});}
 if(!rules.length&&catchAll===null)return {ok:false,err:L.eNoRule};
 var notes=[],out=[],tls=false,dup=false,shadow=false;
 if(catchAll===null){catchAll='http_status:404';notes.push(L.nCatch);}
 if(tid)out.push('tunnel: "'+tid+'"');else notes.push(L.nNoId);
 if(cred)out.push('credentials-file: "'+cred+'"');else notes.push(L.nNoCred);
 if(out.length)out.push('');
 out.push('ingress:');
 function origin(s){if(o.noTls&&s.indexOf('https://')===0){tls=true;out.push('    originRequest:');out.push('      noTLSVerify: true');}}
 rules.forEach(function(r,j){
  for(var k=0;k<j;k++){var p=rules[k].h;
   if(p===r.h)dup=true;
   else if(p.indexOf('*.')===0&&r.h.length>p.length-1&&r.h.slice(-(p.length-1))===p.slice(1))shadow=true;}
  out.push('  - hostname: "'+r.h+'"');out.push('    service: "'+r.s+'"');origin(r.s);});
 out.push('  - service: "'+catchAll+'"');origin(catchAll);
 if(dup)notes.push(L.nDup);
 if(shadow)notes.push(L.nShadow);
 if(tls)notes.push(L.nTls);
 return {ok:true,text:out.join('\n'),notes:notes};}
function build(o){o=o||{};return o.mode==='cf'?buildCf(o):buildSsh(o);}
if(window.__SG_TEST)window.__SG_TEST['tunnel']={build:build,buildSsh:buildSsh,buildCf:buildCf,parseFwd:parseFwd,parseJump:parseJump,shq:shq,svcOk:svcOk,hostOk:hostOk};
function readForm(){return {mode:$('tnMode').value==='cf'?'cf':'ssh',host:$('tnH').value,user:$('tnU').value,port:$('tnP').value,identity:$('tnI').value,jump:$('tnJ').value,forwards:$('tnF').value,alive:$('tnKA').value,aliveMax:$('tnKC').value,bg:$('tnBg').checked,exitFail:$('tnEF').checked,compress:$('tnCo').checked,tunnel:$('tnCfId').value,cred:$('tnCfCred').value,rules:$('tnCfRules').value,noTls:$('tnCfTls').checked};}
function setMode(){var cf=$('tnMode').value==='cf';$('tnSsh').style.display=cf?'none':'block';$('tnCf').style.display=cf?'block':'none';}
function run(){var box=$('tnBox'),o=build(readForm());
 if(!o.ok){lastText='';msg(box,o.err,true);return;}
 lastText=o.text;showPre(box,o.text);
 o.notes.forEach(function(n){var d=document.createElement('div');d.textContent=L.kNote+': '+n;box.appendChild(d);});}
on('tnGo',run);
on('tnCopy',function(){copyText(lastText);});
$('tnMode').addEventListener('change',function(){setMode();run();});
['tnH','tnU','tnP','tnI','tnJ','tnKA','tnKC','tnCfId','tnCfCred'].forEach(function(i){onEnter(i,run);});
setMode();
run();
`
  },
"export": {title:{"id": "Export Markdown / TXT", "en": "Export Markdown / TXT"},labels:{"id": {"title": "Export Markdown / TXT", "back": "Kembali ke Alat", "warning": "Bukan pengganti backup JSON. Tempel JSON backup/ekspor Synapse. Catatan bersifat privat. TXT mempertahankan sintaks sumber Markdown. Pengaturan tidak diekspor.", "input": "JSON masukan", "private": "Sertakan data privat dan catatan", "section": "Bagian", "all": "Semua", "servers": "Item", "notes": "Catatan", "pages": "Halaman", "format": "Format", "build": "Buat hasil", "download": "Unduh", "error": "JSON/struktur tidak valid atau melewati batas (5 juta karakter, 5.000 item per bagian).", "empty": "Tidak ada data yang cocok.", "done": "Hasil siap. Periksa sebelum dibagikan.", "out": "Hasil", "lang": "Bahasa konten halaman"}, "en": {"title": "Export Markdown / TXT", "back": "Back to Tools", "warning": "Not a replacement for JSON backups. Paste Synapse backup/export JSON. Notes are private. TXT preserves source Markdown syntax. Settings are never exported.", "input": "Input JSON", "private": "Include private data and notes", "section": "Section", "all": "All", "servers": "Items", "notes": "Notes", "pages": "Pages", "format": "Format", "build": "Generate", "download": "Download", "error": "Invalid JSON/structure or limit exceeded (5 million characters, 5,000 entries per section).", "empty": "No matching data.", "done": "Result ready. Review before sharing.", "out": "Result", "lang": "Page content language"}},html:(L)=>`<div class="ed-main"><p class="sg-notice sg-warning" role="note">${esc(L.warning)}</p><div class="fld"><label for="exIn">${esc(L.input)}</label><textarea id="exIn" class="tool-ta" spellcheck="false" autocomplete="off"></textarea></div><div class="tool-grid"><label>${esc(L.section)} <select id="exSection" class="tool-sel"><option value="all">${esc(L.all)}</option><option value="servers">${esc(L.servers)}</option><option value="notes">${esc(L.notes)}</option><option value="pages">${esc(L.pages)}</option></select></label><label>${esc(L.format)} <select id="exFormat" class="tool-sel"><option value="md">Markdown</option><option value="txt">TXT</option></select></label><label>${esc(L.lang)} <select id="exLang" class="tool-sel"><option value="id">Indonesia</option><option value="en">English</option></select></label></div><label><input type="checkbox" id="exPrivate"> ${esc(L.private)}</label><div class="row"><button id="exBuild" class="btn">${esc(L.build)}</button><button id="exDownload" class="btn">${esc(L.download)}</button><button id="exCopy" class="btn ghost">${esc(L.copy)}</button><button id="exClear" class="btn ghost">${esc(L.clear)}</button></div><div id="exMsg" role="status"></div><label for="exOut">${esc(L.out)}</label><textarea id="exOut" class="tool-ta" readonly></textarea></div>`,js:String.raw`
var last=null,MAX=5000000;
function clean(v){return typeof v==='string'?v.replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,''):'';}
function meta(v,md){var s=clean(v).replace(/\n/g,' ');return md?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\\x60*_{}\[\]()#+.!|~\-]/g,'\\$&'):s;}
function run(src,opt){try{
 if(typeof src!=='string'||src.length>MAX)throw Error();
 opt=opt||{};var fmt=opt.format||'md',section=opt.section||'all';
 if(['md','txt'].indexOf(fmt)<0||['all','servers','notes','pages'].indexOf(section)<0)throw Error();
 var d=JSON.parse(src.replace(/^\uFEFF/,''));if(Array.isArray(d))d={servers:d};
 if(!d||typeof d!=='object'||!['servers','notes','pages'].some(function(k){return Object.prototype.hasOwnProperty.call(d,k);}))throw Error();
 var out=[],size=0,count=0,md=fmt==='md';
 function add(s){size+=s.length+1;if(size>MAX)throw Error();out.push(s);}
 ['servers','notes','pages'].forEach(function(k){
 var a=d[k];if(a===undefined)return;if(!Array.isArray(a)||a.length>5000)throw Error();
 a.forEach(function(x){if(!x||typeof x!=='object'||Array.isArray(x))throw Error();});
 if(section!=='all'&&section!==k)return;
 a.forEach(function(x){if(!opt.private&&(k==='notes'||x.isPublic===false))return;
 count++;add((md?'## ':'')+meta(k==='servers'?x.name:(k==='pages'&&opt.lang==='en'&&x.titleEn?x.titleEn:x.title),md));
 var fields=k==='servers'?['id','host','category','groupType','description','customLink']:k==='pages'?['slug','description']:['id'];
 fields.forEach(function(f){if(typeof x[f]==='string'&&x[f])add((md?'- ':'')+f+': '+meta(x[f],md));});
 if(k==='servers'&&Array.isArray(x.customFields))x.customFields.forEach(function(c){if(c&&typeof c==='object')add((md?'- ':'')+meta(c.label,md)+': '+meta(c.value,md));});
 if(k!=='servers'){var body=clean(k==='notes'?x.text:(opt.lang==='en'&&x.contentEn?x.contentEn:x.content));add('');
 // Fence source content: no active HTML, links, images, or accidental headings in Markdown export.
 if(md){var max=2;body.replace(/~+/g,function(s){max=Math.max(max,s.length);return s;});var fence='~'.repeat(max+1);add(fence+'text');add(body);add(fence);}else add(body);}
 add('');});});
 return count?{ok:true,text:out.join('\n'),format:fmt,count:count}:{ok:false,error:L.empty};
 }catch(e){return {ok:false,error:L.error};}}
function invalidate(){last=null;$('exOut').value='';}
on('exBuild',function(){invalidate();var r=run($('exIn').value,{format:$('exFormat').value,section:$('exSection').value,lang:$('exLang').value,private:$('exPrivate').checked});if(r.ok){last=r;$('exOut').value=r.text;}msg($('exMsg'),r.ok?L.done:r.error,!r.ok);});
on('exDownload',function(){if(!last){toast(L.nothing,true);return;}var u=null,a=null;try{u=URL.createObjectURL(new Blob([last.text],{type:'text/plain;charset=utf-8'}));a=document.createElement('a');a.href=u;a.download='synapse-export.'+last.format;document.body.appendChild(a);a.click();}catch(e){toast(L.error,true);}finally{if(a&&a.parentNode)a.parentNode.removeChild(a);if(u)setTimeout(function(){URL.revokeObjectURL(u);},1000);}});
on('exCopy',function(){copyText(last?last.text:'');});
on('exClear',function(){invalidate();$('exIn').value='';$('exMsg').textContent='';});
['exIn','exFormat','exSection','exLang','exPrivate'].forEach(function(id){$(id).addEventListener('input',invalidate);$(id).addEventListener('change',invalidate);});
if(window.__SG_TEST)window.__SG_TEST.export={run:run,meta:meta};
`
},
  "converter": {title: {"id": "Konverter Teks & Data", "en": "String & Data Converter"}, labels: {"id": {"title": "Konverter Teks & Data", "warning": "Lokal di browser. MD5 hanya untuk checksum non-keamanan. JWT dibaca tanpa verifikasi tanda tangan; jangan percaya klaimnya. URL memakai encodeURIComponent/decodeURIComponent, bukan form encoding (+ tidak berubah menjadi spasi). Base64 memakai UTF-8 dan format standar dengan padding. Maksimal 1 juta karakter.", "run": "Proses", "input": "Masukan", "output": "Hasil", "invalid": "Format masukan tidak valid.", "big": "Maksimal 1 juta karakter.", "crypto": "Web Crypto tidak tersedia; gunakan HTTPS dan browser yang mendukung.", "jwt": "BELUM DIVERIFIKASI: tanda tangan dan klaim JWT tidak divalidasi."}, "en": {"title": "String & Data Converter", "warning": "Browser-local. MD5 is for non-security checksums only. JWT signatures are NOT verified; do not trust its claims. URL uses encodeURIComponent/decodeURIComponent, not form encoding (+ remains +). Base64 uses UTF-8 and standard padded encoding. Maximum 1 million characters.", "run": "Process", "input": "Input", "output": "Result", "invalid": "Invalid input format.", "big": "Maximum 1 million characters.", "crypto": "Web Crypto unavailable; use HTTPS and a supported browser.", "jwt": "UNVERIFIED: JWT signature and claims are not validated."}}, html: (L)=>`<div class="ed-main"><p class="sg-notice sg-warning" role="note">${esc(L.warning)}</p><select id="cvMode" class="tool-sel"><option value="base64-encode">Base64 encode</option><option value="base64-decode">Base64 decode</option><option value="url-encode">URL encode</option><option value="url-decode">URL decode</option><option value="md5">MD5</option><option value="sha256">SHA-256</option><option value="jwt">JWT Payload Inspector</option></select><div class="fld"><label for="cvIn">${esc(L.input)}</label><textarea id="cvIn" class="tool-ta" spellcheck="false" autocomplete="off"></textarea></div><div class="row"><button id="cvRun" class="btn">${esc(L.run)}</button><button id="cvCopy" class="btn ghost">${esc(L.copy)}</button><button id="cvClear" class="btn ghost">${esc(L.clear)}</button></div><div id="cvMsg" class="tool-out"></div><div class="fld"><label for="cvOut">${esc(L.output)}</label><textarea id="cvOut" class="tool-ta" readonly></textarea></div></div>`, js: String.raw`
function bytes(s){return new TextEncoder().encode(s);}
function b64(b){var s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s);}
function un64(s,url){if(url){if(!/^[A-Za-z0-9_-]*$/.test(s)||s.length%4===1)throw Error(L.invalid);s=s.replace(/-/g,'+').replace(/_/g,'/');s+='='.repeat((4-s.length%4)%4);}else if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))throw Error(L.invalid);
var raw=atob(s),b=Uint8Array.from(raw,function(c){return c.charCodeAt(0);});if(b64(b)!==s)throw Error(L.invalid);return b;}
function text(b){return new TextDecoder('utf-8',{fatal:true}).decode(b);}
function hex(b){return Array.from(b,function(x){return x.toString(16).padStart(2,'0');}).join('');}
function md5(b){var n=b.length,buf=new Uint8Array(Math.ceil((n+9)/64)*64);buf.set(b);buf[n]=128;var dv=new DataView(buf.buffer);dv.setUint32(buf.length-8,(n*8)>>>0,true);dv.setUint32(buf.length-4,Math.floor(n/536870912),true);
var h=[0x67452301,0xefcdab89,0x98badcfe,0x10325476],sh=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
for(var off=0;off<buf.length;off+=64){var a=h[0],c=h[2],d=h[3],v=h[1];for(var i=0;i<64;i++){var f,g;if(i<16){f=(v&c)|(~v&d);g=i;}else if(i<32){f=(d&v)|(~d&c);g=(5*i+1)%16;}else if(i<48){f=v^c^d;g=(3*i+5)%16;}else{f=c^(v|~d);g=(7*i)%16;}var z=(a+f+Math.floor(Math.abs(Math.sin(i+1))*4294967296)+dv.getUint32(off+g*4,true))|0,s=sh[Math.floor(i/16)*4+i%4],old=d;d=c;c=v;v=(v+((z<<s)|(z>>>(32-s))))|0;a=old;}h[0]=(h[0]+a)|0;h[1]=(h[1]+v)|0;h[2]=(h[2]+c)|0;h[3]=(h[3]+d)|0;}
var out=new Uint8Array(16),od=new DataView(out.buffer);h.forEach(function(x,i){od.setUint32(i*4,x,true);});return hex(out);}
async function run(mode,src){if(typeof src!=='string'||src.length>1000000)throw Error(L.big);
switch(mode){case 'base64-encode':return b64(bytes(src));case 'base64-decode':return text(un64(src,false));case 'url-encode':return encodeURIComponent(src);case 'url-decode':return decodeURIComponent(src);case 'md5':return md5(bytes(src));case 'sha256':if(!globalThis.crypto||!crypto.subtle)throw Error(L.crypto);return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(src))));case 'jwt':var a=src.split('.');if(a.length!==3||!a[0]||!a[1])throw Error(L.invalid);var header=JSON.parse(text(un64(a[0],true))),payload=JSON.parse(text(un64(a[1],true)));un64(a[2],true);if(!header||Array.isArray(header)||typeof header!=='object'||!payload||Array.isArray(payload)||typeof payload!=='object')throw Error(L.invalid);return JSON.stringify({warning:L.jwt,header:header,payload:payload},null,2);default:throw Error(L.invalid);}}
if(window.__SG_TEST)window.__SG_TEST.converter={run:run,md5:md5};
var revision=0;
on('cvRun',async function(){var rev=++revision;$('cvOut').value='';msg($('cvMsg'),'',false);try{var out=await run($('cvMode').value,$('cvIn').value);if(rev===revision)$('cvOut').value=out;}catch(e){if(rev===revision)msg($('cvMsg'),e.message,true);}});
on('cvCopy',function(){copyText($('cvOut').value);});
on('cvClear',function(){revision++;$('cvIn').value='';$('cvOut').value='';msg($('cvMsg'),'',false);});
`
  },
  "keygen": {title: {"id": "Generator Kunci & UUID", "en": "Key & UUID Generator"}, labels: {"id": {"title": "Generator Kunci & UUID", "warning": "Dibuat lokal dengan Web Crypto; tidak dikirim atau disimpan oleh tool. Clipboard dan ekstensi browser tetap bisa mengekspos rahasia. Bersihkan hasil setelah dipakai. HMAC secret adalah byte acak (keluaran Base64), bukan tanda tangan HMAC. WireGuard/AmneziaWG memakai X25519 native dan memerlukan browser pendukung serta HTTPS; ini hanya pasangan kunci, bukan koneksi atau config lengkap. Pembersihan memori JavaScript tidak dapat dijamin.", "size": "Ukuran kunci acak (byte, 16\u2013128; tidak berlaku untuk UUID/X25519)", "run": "Buat baru", "output": "Hasil \u2014 rahasia untuk mode kunci", "invalid": "Mode/ukuran tidak valid (16\u2013128 byte).", "unavailable": "Web Crypto tidak tersedia. Gunakan HTTPS dan browser pendukung.", "x25519": "X25519 native tidak tersedia atau gagal diekspor. Tidak ada fallback kriptografi buatan sendiri."}, "en": {"title": "Key & UUID Generator", "warning": "Generated locally using Web Crypto; this tool does not send or store keys. Clipboard and browser extensions can expose secrets. Clear results after use. HMAC secret is random bytes (Base64 output), not an HMAC signature. WireGuard/AmneziaWG use native X25519 and require a supported browser and HTTPS; only a keypair, not a connection or complete config. JavaScript memory erasure cannot be guaranteed.", "size": "Random key size (bytes, 16\u2013128; not used for UUID/X25519)", "run": "Generate new", "output": "Result \u2014 secret for key modes", "invalid": "Invalid mode/size (16\u2013128 bytes).", "unavailable": "Web Crypto unavailable. Use HTTPS and a supported browser.", "x25519": "Native X25519 unavailable or export failed. No custom cryptographic fallback."}}, html: (L)=>`<div class="ed-main"><p class="sg-notice sg-warning" role="note">${esc(L.warning)}</p><select id="kgMode" class="tool-sel"><option value="uuid">UUID v4</option><option value="hmac">HMAC secret (Base64)</option><option value="hex">Random Hex</option><option value="base64">Random Base64</option><option value="wireguard">WireGuard keypair</option><option value="amneziawg">AmneziaWG keypair</option></select><div class="fld"><label for="kgSize">${esc(L.size)}</label><input class="tool-in" id="kgSize" type="number" min="16" max="128" value="32"></div><div class="row"><button class="btn" id="kgRun">${esc(L.run)}</button><button class="btn ghost" id="kgCopy">${esc(L.copy)}</button><button class="btn ghost" id="kgClear">${esc(L.clear)}</button></div><div id="kgMsg" class="tool-out"></div><div class="fld"><label for="kgOut">${esc(L.output)}</label><textarea id="kgOut" class="tool-ta" readonly spellcheck="false" autocomplete="off"></textarea></div></div>`, js: String.raw`
function enc(b){var s='';b.forEach(function(v){s+=String.fromCharCode(v);});return btoa(s);}
function hx(b){return Array.from(b,function(v){return v.toString(16).padStart(2,'0');}).join('');}
function random(n){if(!globalThis.crypto||!crypto.getRandomValues)throw Error(L.unavailable);return crypto.getRandomValues(new Uint8Array(n));}
async function run(mode,size){if(['uuid','hex','base64','hmac','wireguard','amneziawg'].indexOf(mode)<0)throw Error(L.invalid);
if(mode==='uuid'){var b=random(16);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=hx(b);b.fill(0);return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
if(mode==='wireguard'||mode==='amneziawg'){if(!globalThis.crypto||!crypto.subtle)throw Error(L.unavailable);var pair,jwk;try{pair=await crypto.subtle.generateKey({name:'X25519'},true,['deriveBits']);jwk=await crypto.subtle.exportKey('jwk',pair.privateKey);}catch(e){throw Error(L.x25519);}if(jwk.kty!=='OKP'||jwk.crv!=='X25519'||!jwk.d||!jwk.x)throw Error(L.x25519);
function decode(s){if(!/^[A-Za-z0-9_-]{43}$/.test(s))throw Error(L.x25519);return Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='),function(c){return c.charCodeAt(0);});}
var secret=decode(jwk.d),pub=decode(jwk.x);if(secret.length!==32||pub.length!==32)throw Error(L.x25519);secret[0]&=248;secret[31]=(secret[31]&127)|64;var result=JSON.stringify({type:mode,privateKey:enc(secret),publicKey:enc(pub)},null,2);secret.fill(0);jwk.d='';return result;}
var n=Number(size);if(!Number.isInteger(n)||n<16||n>128)throw Error(L.invalid);var data=random(n),out=mode==='hex'?hx(data):enc(data);data.fill(0);return out;}
if(window.__SG_TEST)window.__SG_TEST.keygen={run:run};
var rev=0;
on('kgRun',async function(){var version=++rev;$('kgOut').value='';msg($('kgMsg'),'',false);try{var out=await run($('kgMode').value,$('kgSize').value);if(version===rev)$('kgOut').value=out;}catch(e){if(version===rev)msg($('kgMsg'),e.message,true);}});
on('kgCopy',function(){copyText($('kgOut').value);});
on('kgClear',function(){rev++;$('kgOut').value='';msg($('kgMsg'),'',false);});
`
  },
  "modern": {title: {"id": "Formatter Protokol Modern", "en": "Modern Protocol Formatter"}, labels: {"id": {"title": "Formatter Protokol Modern", "warning": "Lokal, tanpa relay/koneksi. Masukan adalah profil JSON tool ini (gunakan contoh), bukan parser semua config vendor. Keluaran JSON/YAML adalah fragmen outbound/proxy, bukan config aplikasi lengkap. Transport TCP/WebSocket/gRPC dengan TLS; VLESS REALITY hanya TCP. Field opsional: transport (tcp/ws/grpc), path dan wsHost untuk WebSocket, serviceName untuk gRPC. Field flow opsional: xtls-rprx-vision, hanya VLESS TCP untuk Sing-box, Clash Meta/Mihomo, Xray, dan link/subscription (bukan V2Ray murni). REALITY memakai target Xray, bukan V2Ray murni; VLESS memerlukan Clash Meta/Mihomo. AmneziaWG memakai parameter numerik legacy Jc/Jmin/Jmax/S1/S2/H1\u2013H4; sesuaikan dengan server, bukan AWG 2.x. Rentang padding dibatasi konservatif 0\u20131280. Jangan membagikan QR yang berisi rahasia. Validasi akhir dengan versi aplikasi tujuan Anda.", "input": "Profil JSON", "output": "Konfigurasi / link / subscription", "run": "Format / buat", "example": "Contoh profil TLS", "awgExample": "Contoh AmneziaWG (isi kunci sendiri)", "qrLimit": "QR memerlukan hasil nonkosong maksimal 1000 byte. Gunakan link atau salin config panjang."}, "en": {"title": "Modern Protocol Formatter", "warning": "Local, no relay or connection. Input uses this tool\u2019s JSON profile (see examples), not arbitrary vendor config. JSON/YAML output is an outbound/proxy fragment, not a complete application config. TCP/WebSocket/gRPC with TLS; VLESS REALITY is TCP-only. Optional fields: transport (tcp/ws/grpc), path and wsHost for WebSocket, serviceName for gRPC. Optional flow: xtls-rprx-vision, VLESS TCP only for Sing-box, Clash Meta/Mihomo, Xray, and links/subscriptions (not pure V2Ray). REALITY targets Xray, not pure V2Ray; VLESS requires Clash Meta/Mihomo. AmneziaWG uses legacy numeric Jc/Jmin/Jmax/S1/S2/H1\u2013H4; match server values, not AWG 2.x. Padding limits conservatively capped at 0\u20131280. Do not share secret-bearing QR codes. Validate with your target application version.", "input": "JSON profile", "output": "Config / link / subscription", "run": "Format / generate", "example": "TLS profile example", "awgExample": "AmneziaWG example (supply your own keys)", "qrLimit": "QR requires nonempty output up to 1000 bytes. Use a link or copy larger configs."}}, html: (L)=>`<div class="ed-main"><p class="sg-notice sg-warning" role="note">${esc(L.warning)}</p><div class="row"><button id="mtExample" class="btn ghost">${esc(L.example)}</button><button id="mtAwgExample" class="btn ghost">${esc(L.awgExample)}</button></div><div class="fld"><label for="mtIn">${esc(L.input)}</label><textarea id="mtIn" class="tool-ta" spellcheck="false" autocomplete="off"></textarea></div><select id="mtFormat" class="tool-sel"><option value="sing-box">Sing-box JSON</option><option value="clash">Clash YAML (VMess/Trojan)</option><option value="clash-meta">Clash Meta / Mihomo YAML</option><option value="v2ray">V2Ray JSON (TLS)</option><option value="xray">Xray JSON (TLS / REALITY)</option><option value="amneziawg">AmneziaWG .conf</option><option value="link">Share link</option><option value="subscription">Base64 subscription (1 profile)</option></select><div class="row"><button id="mtRun" class="btn">${esc(L.run)}</button><button id="mtCopy" class="btn ghost">${esc(L.copy)}</button><button id="mtQrButton" class="btn ghost">QR</button><button id="mtClear" class="btn ghost">${esc(L.clear)}</button></div><div id="mtMsg" class="tool-out"></div><div class="fld"><label for="mtOut">${esc(L.output)}</label><textarea id="mtOut" class="tool-ta" readonly spellcheck="false"></textarea></div><div id="mtQr" style="max-width:360px;background:white"></div></div>`, js: String.raw`function bad(s){throw Error(s);}
function str(v,k,max){if(typeof v!=='string'||!v||v.length>(max||255)||/[\x00-\x1f\x7f]/.test(v))bad(k);return v;}
function num(v,k,min,max){if(typeof v!=='number'||!Number.isInteger(v)||v<min||v>max)bad(k);return v;}
function host(v){str(v,'server');if(v.indexOf(':')>=0){try{new URL('http://['+v+']/');}catch(e){bad('IPv6');}return v;}if(!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(v)||v.split('.').some(function(x){return !x||x.length>63||x[0]==='-'||x.endsWith('-');}))bad('server');if(/^[0-9.]+$/.test(v)&&(!/^\d+\.\d+\.\d+\.\d+$/.test(v)||v.split('.').some(function(x){return Number(x)>255||String(Number(x))!==x;})))bad('IPv4');return v;}
function keys(o,allowed){if(!o||Array.isArray(o)||typeof o!=='object')bad('object');Object.keys(o).forEach(function(k){if(allowed.indexOf(k)<0)bad('Unknown field: '+k);});}
function b64(s){var a=new TextEncoder().encode(s),r='';a.forEach(function(x){r+=String.fromCharCode(x);});return btoa(r);}
function key(s,label){if(typeof s!=='string'||! /^[A-Za-z0-9+/]{43}=$/.test(s))bad(label);var raw=atob(s);if(raw.length!==32||btoa(raw)!==s)bad(label);return s;}
function cidr(s){str(s,'CIDR');var a=s.split('/');if(a.length!==2||!/^\d+$/.test(a[1]))bad('CIDR');host(a[0]);if(a[0].indexOf(':')<0&&!/^\d+\.\d+\.\d+\.\d+$/.test(a[0]))bad('CIDR IP');num(Number(a[1]),'prefix',0,a[0].indexOf(':')>=0?128:32);return s;}
function awg(o){keys(o,['name','privateKey','address','dns','mtu','publicKey','presharedKey','server','port','allowedIPs','persistentKeepalive','Jc','Jmin','Jmax','S1','S2','H1','H2','H3','H4']);key(o.privateKey,'privateKey');key(o.publicKey,'publicKey');host(o.server);num(o.port,'port',1,65535);
function list(v,k,fn){if(!Array.isArray(v)||!v.length||v.length>32)bad(k);return v.map(fn).join(', ');}
var lines=['[Interface]','PrivateKey = '+o.privateKey,'Address = '+list(o.address,'address',cidr)];if(o.dns!==undefined)lines.push('DNS = '+list(o.dns,'dns',function(x){host(x);if(x.indexOf(':')<0&&!/^\d+\.\d+\.\d+\.\d+$/.test(x))bad('DNS IP');return x;}));if(o.mtu!==undefined)lines.push('MTU = '+num(o.mtu,'mtu',576,9000));
['Jc','Jmin','Jmax','S1','S2','H1','H2','H3','H4'].forEach(function(k){var max=k[0]==='H'?4294967295:1280;num(o[k],k,0,max);lines.push(k+' = '+o[k]);});if(o.Jmin>o.Jmax)bad('Jmin > Jmax');if(o.S1+56===o.S2+92)bad('S1/S2 packet size collision');if(new Set([o.H1,o.H2,o.H3,o.H4]).size!==4)bad('H1-H4 must be distinct');
lines.push('','[Peer]','PublicKey = '+o.publicKey);if(o.presharedKey!==undefined)lines.push('PresharedKey = '+key(o.presharedKey,'presharedKey'));lines.push('Endpoint = '+(o.server.indexOf(':')>=0?'['+o.server+']':o.server)+':'+o.port,'AllowedIPs = '+list(o.allowedIPs,'allowedIPs',cidr));if(o.persistentKeepalive!==undefined)lines.push('PersistentKeepalive = '+num(o.persistentKeepalive,'persistentKeepalive',0,65535));return lines.join('\n')+'\n';}
function profile(o){keys(o,['name','protocol','server','port','uuid','password','security','serverName','publicKey','shortId','fingerprint','transport','path','wsHost','serviceName','flow']);str(o.name,'name',100);if(['vmess','vless','trojan'].indexOf(o.protocol)<0)bad('protocol');host(o.server);num(o.port,'port',1,65535);if(o.protocol==='trojan'){str(o.password,'password',1024);if(o.uuid!==undefined)bad('uuid not used');}else{if(typeof o.uuid!=='string'||! /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(o.uuid))bad('uuid');if(o.password!==undefined)bad('password not used');}
if(['tls','reality'].indexOf(o.security)<0)bad('security: tls or reality required');host(o.serverName);if(o.security==='reality'){if(o.protocol!=='vless')bad('REALITY requires VLESS in this tool');if(typeof o.publicKey!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(o.publicKey))bad('REALITY publicKey');var pk=o.publicKey.replace(/-/g,'+').replace(/_/g,'/')+'=';if(btoa(atob(pk))!==pk)bad('REALITY publicKey canonical');if(typeof o.shortId!=='string'||! /^(?:[a-f0-9]{2}){0,8}$/i.test(o.shortId))bad('shortId');if(['chrome','firefox','safari','edge'].indexOf(o.fingerprint)<0)bad('fingerprint');}else if(o.publicKey!==undefined||o.shortId!==undefined||o.fingerprint!==undefined)bad('REALITY fields not used with TLS');var transport=o.transport||'tcp';
if(!['tcp','ws','grpc'].includes(transport))bad('transport: tcp, ws or grpc');
if(o.security==='reality'&&transport!=='tcp')bad('REALITY requires TCP in this tool');
if(o.flow!==undefined&&(o.flow!=='xtls-rprx-vision'||o.protocol!=='vless'||transport!=='tcp'))bad('flow: xtls-rprx-vision requires VLESS TCP');
if(transport==='ws'){if(o.path!==undefined){str(o.path,'path',2048);if(o.path[0]!=='/')bad('WebSocket path must start with /');}if(o.wsHost!==undefined)host(o.wsHost);if(o.serviceName!==undefined)bad('serviceName requires gRPC');}
else if(transport==='grpc'){if(o.serviceName!==undefined){str(o.serviceName,'serviceName',255);if(!/^[A-Za-z0-9_.-]+$/.test(o.serviceName))bad('serviceName');}if(o.path!==undefined||o.wsHost!==undefined)bad('WebSocket fields require ws');}
else if(o.path!==undefined||o.wsHost!==undefined||o.serviceName!==undefined)bad('Transport fields not used with TCP');
return o;}
function generate(format,source){if(typeof source!=='string'||source.length>100000)bad('Input maximum 100000 characters');var o=JSON.parse(source);if(format==='amneziawg')return awg(o);profile(o);var proto=o.protocol,real=o.security==='reality',transport=o.transport||'tcp';
if(format==='sing-box'){var x={type:proto,tag:o.name,server:o.server,server_port:o.port};if(proto==='trojan')x.password=o.password;else x.uuid=o.uuid;if(proto==='vmess')x.security='auto';if(o.flow)x.flow=o.flow;x.tls={enabled:true,server_name:o.serverName};if(real){x.tls.utls={enabled:true,fingerprint:o.fingerprint};x.tls.reality={enabled:true,public_key:o.publicKey,short_id:o.shortId};}if(transport==='ws'){x.transport={type:'ws',path:o.path||'/'};if(o.wsHost)x.transport.headers={Host:o.wsHost};}else if(transport==='grpc')x.transport={type:'grpc',service_name:o.serviceName||''};return JSON.stringify({outbounds:[x]},null,2);}
if(format==='clash'||format==='clash-meta'){if(format==='clash'&&(proto==='vless'||real))bad('VLESS/REALITY requires Clash Meta (Mihomo)');var c={name:o.name,type:proto,server:o.server,port:o.port};if(proto==='trojan'){c.password=o.password;c.sni=o.serverName;}else{c.uuid=o.uuid;c.tls=true;c.servername=o.serverName;if(proto==='vmess'){c.alterId=0;c.cipher='auto';}}if(o.flow)c.flow=o.flow;c['skip-cert-verify']=false;if(real){c['client-fingerprint']=o.fingerprint;c['reality-opts']={'public-key':o.publicKey,'short-id':o.shortId};}if(transport!=='tcp'){if(format==='clash'&&transport==='grpc')bad('gRPC requires Clash Meta (Mihomo)');c.network=transport;if(transport==='ws'){c['ws-opts']={path:o.path||'/'};if(o.wsHost)c['ws-opts'].headers={Host:o.wsHost};}else c['grpc-opts']={'grpc-service-name':o.serviceName||''};}var lines=['proxies:'];Object.keys(c).forEach(function(k,i){var v=c[k];if(v&&typeof v==='object'){lines.push('    '+k+':');Object.keys(v).forEach(function(j){lines.push('      '+j+': '+JSON.stringify(v[j]));});}else lines.push((i===0?'  - ':'    ')+k+': '+JSON.stringify(v));});return lines.join('\n')+'\n';}
if(format==='v2ray'){if(real)bad('REALITY requires Xray; choose Xray target');if(o.flow)bad('Vision flow requires Xray; choose Xray target');}
if(format==='v2ray'||format==='xray'){var user=proto==='trojan'?null:{id:o.uuid};if(proto==='vmess')user.security='auto';else if(proto==='vless')user.encryption='none';if(o.flow)user.flow=o.flow;var settings=proto==='trojan'?{servers:[{address:o.server,port:o.port,password:o.password}]}:{vnext:[{address:o.server,port:o.port,users:[user]}]};var stream={network:transport,security:o.security};if(transport==='ws'){stream.wsSettings={path:o.path||'/'};if(o.wsHost)stream.wsSettings.headers={Host:o.wsHost};}else if(transport==='grpc')stream.grpcSettings={serviceName:o.serviceName||''};if(real)stream.realitySettings={serverName:o.serverName,fingerprint:o.fingerprint,publicKey:o.publicKey,shortId:o.shortId};else stream.tlsSettings={serverName:o.serverName,allowInsecure:false};return JSON.stringify({outbounds:[{tag:o.name,protocol:proto,settings:settings,streamSettings:stream}]},null,2);}
if(format==='link'||format==='subscription'){var link;if(proto==='vmess')link='vmess://'+b64(JSON.stringify({v:'2',ps:o.name,add:o.server,port:String(o.port),id:o.uuid,aid:'0',scy:'auto',net:transport,type:'none',host:transport==='ws'?(o.wsHost||''):'',path:transport==='ws'?(o.path||'/'):transport==='grpc'?(o.serviceName||''):'',tls:'tls',sni:o.serverName}));else{var q=new URLSearchParams({security:o.security,type:transport,sni:o.serverName});if(transport==='ws'){q.set('path',o.path||'/');if(o.wsHost)q.set('host',o.wsHost);}else if(transport==='grpc'){q.set('serviceName',o.serviceName||'');q.set('mode','gun');}if(proto==='vless')q.set('encryption','none');if(o.flow)q.set('flow',o.flow);if(real){q.set('pbk',o.publicKey);q.set('sid',o.shortId);q.set('fp',o.fingerprint);}link=proto+'://'+encodeURIComponent(proto==='trojan'?o.password:o.uuid)+'@'+(o.server.indexOf(':')>=0?'['+o.server+']':o.server)+':'+o.port+'?'+q.toString()+'#'+encodeURIComponent(o.name);}return format==='subscription'?b64(link+'\n'):link;}
bad('format');}
if(window.__SG_TEST)window.__SG_TEST.modern={generate:generate};
function clearOut(){$('mtOut').value='';$('mtQr').textContent='';msg($('mtMsg'),'',false);}
on('mtRun',function(){clearOut();try{$('mtOut').value=generate($('mtFormat').value,$('mtIn').value);}catch(e){msg($('mtMsg'),e.message,true);}});
on('mtCopy',function(){copyText($('mtOut').value);});
on('mtClear',function(){clearOut();$('mtIn').value='';});
on('mtQrButton',function(){$('mtQr').textContent='';try{var v=$('mtOut').value;if(!v||new TextEncoder().encode(v).length>1000)bad(L.qrLimit);$('mtQr').innerHTML=makeQrSvg(v);}catch(e){msg($('mtMsg'),e.message,true);}});
on('mtExample',function(){clearOut();$('mtIn').value=JSON.stringify({name:'Example TLS',protocol:'vless',server:'vpn.example.com',port:443,uuid:'00000000-0000-4000-8000-000000000001',security:'tls',serverName:'vpn.example.com'},null,2);});
on('mtAwgExample',function(){clearOut();$('mtIn').value=JSON.stringify({privateKey:'REPLACE_WITH_PRIVATE_KEY',address:['10.8.0.2/32'],publicKey:'REPLACE_WITH_SERVER_PUBLIC_KEY',server:'vpn.example.com',port:51820,allowedIPs:['0.0.0.0/0','::/0'],persistentKeepalive:25,Jc:4,Jmin:40,Jmax:70,S1:0,S2:0,H1:1,H2:2,H3:3,H4:4},null,2);$('mtFormat').value='amneziawg';});

// Invalidate stale output and secret-bearing QR whenever its source changes.
$('mtIn').addEventListener('input',clearOut);
$('mtFormat').addEventListener('change',clearOut);
`
  },
"netdiag": {
    title: { id: "Diagnostik Jaringan", en: "Network Diagnostics" },
    labels: {
      id: { title: "Diagnostik Jaringan", back: "Kembali ke Alat", dnsT: "DNS Inspector (DoH Cloudflare)", host: "Domain", type: "Tipe", run: "Periksa", ipT: "Info IP & Koneksi", ipRun: "Muat info", hdrT: "Audit Header HTTP/TLS", hdrRun: "Audit", out: "Hasil", busy: "Memproses…", fail: "Gagal", note: "Diproses server lewat HTTPS ke layanan publik tetap (1.1.1.1, ipify). Detail sertifikat tidak tersedia dari fetch Worker; audit hanya memeriksa koneksi HTTPS dan header keamanan." },
      en: { title: "Network Diagnostics", back: "Back to Tools", dnsT: "DNS Inspector (Cloudflare DoH)", host: "Domain", type: "Type", run: "Lookup", ipT: "IP & Connection Info", ipRun: "Load info", hdrT: "HTTP/TLS Header Audit", hdrRun: "Audit", out: "Result", busy: "Working…", fail: "Failed", note: "Processed server-side over HTTPS to fixed public services (1.1.1.1, ipify). Certificate details are not exposed to Worker fetch; the audit only checks HTTPS reachability and security headers." }
    },
    html: (L) => `<div class="ed-main"><p><small>${esc(L.note)}</small></p>
      <h3>${esc(L.dnsT)}</h3><div class="tool-grid"><div class="fld"><label for="ndHost">${esc(L.host)}</label><input id="ndHost" class="tool-sel" value="example.com" autocapitalize="off" spellcheck="false"></div>
      <div class="fld"><label for="ndType">${esc(L.type)}</label><select id="ndType" class="tool-sel"><option>A</option><option>AAAA</option><option>CNAME</option><option>TXT</option><option>MX</option><option>NS</option></select></div></div>
      <p><button id="ndDns" class="btn">${esc(L.run)}</button></p>
      <h3>${esc(L.ipT)}</h3><p><button id="ndIp" class="btn">${esc(L.ipRun)}</button></p>
      <h3>${esc(L.hdrT)}</h3><div class="fld"><label for="ndHdrHost">${esc(L.host)}</label><input id="ndHdrHost" class="tool-sel" value="example.com" autocapitalize="off" spellcheck="false"></div>
      <p><button id="ndHdr" class="btn">${esc(L.hdrRun)}</button></p>
      <div id="ndMsg" role="status" aria-live="polite"></div><div class="fld"><label for="ndOut">${esc(L.out)}</label><textarea id="ndOut" class="tool-ta" readonly spellcheck="false"></textarea></div></div>`,
    js: `
var ndSeq=0;
function call(u){var seq=++ndSeq,m=$('ndMsg');$('ndOut').value='';msg(m,L.busy,false);return fetch(u,{credentials:'same-origin'}).then(function(r){return r.json().then(function(d){if(seq!==ndSeq)return;if(!r.ok||!d.success)throw Error(d.message||r.status);msg(m,'',false);$('ndOut').value=JSON.stringify(d.result,null,2);});}).catch(function(e){if(seq===ndSeq)msg(m,L.fail+': '+e.message,true);});}
on('ndDns',function(){call('/api/tools/dns?name='+encodeURIComponent($('ndHost').value.trim())+'&type='+encodeURIComponent($('ndType').value));});
on('ndIp',function(){call('/api/tools/netinfo');});
on('ndHdr',function(){call('/api/tools/headers?host='+encodeURIComponent($('ndHdrHost').value.trim()));});
`
  },
"paste": {
    title: { id: "Secret Share Terenkripsi", en: "Encrypted Secret Share" },
    labels: {
      id: { title: "Secret Share Terenkripsi", back: "Kembali ke Alat", inLabel: "Teks rahasia (maks 32 KB)", ttl: "Kedaluwarsa", h1: "1 jam", d1: "1 hari", d7: "7 hari", once: "Hapus setelah dibaca sekali", create: "Buat tautan", link: "Tautan (kunci ada di bagian #, tidak dikirim ke server)", busy: "Mengenkripsi…", done: "Tautan dibuat. Simpan sekarang, tidak bisa ditampilkan ulang.", fail: "Gagal", eEmpty: "Isi dulu teksnya.", eBig: "Terlalu besar (maks 32 KB).", eCrypto: "Browser tidak mendukung Web Crypto.", note: "Enkripsi AES-GCM 256 bit di browser. Server hanya menyimpan ciphertext. Mode sekali-baca di Workers KV bersifat best-effort: dua pembaca serentak di lokasi berbeda masih mungkin sama-sama berhasil." },
      en: { title: "Encrypted Secret Share", back: "Back to Tools", inLabel: "Secret text (max 32 KB)", ttl: "Expiry", h1: "1 hour", d1: "1 day", d7: "7 days", once: "Delete after first read", create: "Create link", link: "Link (key is in the #part, never sent to the server)", busy: "Encrypting…", done: "Link created. Save it now; it cannot be shown again.", fail: "Failed", eEmpty: "Enter some text first.", eBig: "Too large (max 32 KB).", eCrypto: "This browser lacks Web Crypto.", note: "AES-GCM 256-bit encryption in the browser. The server stores ciphertext only. Read-once on Workers KV is best-effort: two simultaneous readers in different locations might both succeed." }
    },
    html: (L) => `<div class="ed-main"><p><small>${esc(L.note)}</small></p>
      <div class="fld"><label for="psIn">${esc(L.inLabel)}</label><textarea id="psIn" class="tool-ta" spellcheck="false" autocomplete="off"></textarea></div>
      <div class="tool-grid"><div class="fld"><label for="psTtl">${esc(L.ttl)}</label><select id="psTtl" class="tool-sel"><option value="3600">${esc(L.h1)}</option><option value="86400" selected>${esc(L.d1)}</option><option value="604800">${esc(L.d7)}</option></select></div>
      <div class="fld"><label><input type="checkbox" id="psOnce" checked> ${esc(L.once)}</label></div></div>
      <p><button id="psCreate" class="btn">${esc(L.create)}</button></p><div id="psMsg"></div>
      <div class="fld"><label for="psLink">${esc(L.link)}</label><textarea id="psLink" class="tool-ta" readonly spellcheck="false"></textarea></div>
      <p><button id="psCopy" class="btn">${esc(L.copy)}</button></p></div>`,
    js: `
function b64u(b){var s='';b=new Uint8Array(b);for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
async function seal(text){var key=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12));
 var k=await crypto.subtle.importKey('raw',key,'AES-GCM',false,['encrypt']);var ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},k,new TextEncoder().encode(text));
 return {key:b64u(key),iv:b64u(iv),ct:b64u(ct)};}
if(window.__SG_TEST)window.__SG_TEST.paste={seal:seal,b64u:b64u};
on('psCreate',async function(){var m=$('psMsg'),t=$('psIn').value;if(!t){msg(m,L.eEmpty,true);return;}
 if(new TextEncoder().encode(t).length>32768){msg(m,L.eBig,true);return;}
 if(!window.crypto||!crypto.subtle){msg(m,L.eCrypto,true);return;}
 msg(m,L.busy,false);try{var s=await seal(t);
 var r=await fetch('/api/paste_create',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({iv:s.iv,ct:s.ct,ttl:+$('psTtl').value,once:$('psOnce').checked})});
 var d=await r.json();if(!r.ok||!d.success)throw Error(d.message||r.status);
 $('psLink').value=location.origin+'/s/'+d.id+'#'+s.key;$('psIn').value='';msg(m,L.done,false);}catch(e){msg(m,L.fail+': '+e.message,true);}});
on('psCopy',function(){copyText($('psLink').value);});
`
  },
"gateway": {
 title:{id:"Webhook Gateway",en:"Webhook Gateway"},
 labels: {"id":{"title":"Webhook Gateway","back":"Kembali","inLabel":"Konfigurasi JSON (admin saja)","save":"Simpan","saved":"Tersimpan","failed":"Gagal","gatewayNote":"Pengiriman GitHub: repository_dispatch; memerlukan token dengan izin Contents: write pada repositori. Tidak ada retry atau deduplikasi otomatis; hindari loop. Kiriman masuk bisa berulang. Rahasia disimpan di KV server tanpa enkripsi tambahan oleh aplikasi ini.","targets":"Tujuan (maks 4):"},"en":{"title":"Webhook Gateway","back":"Back","inLabel":"Configuration JSON (admin only)","save":"Save","saved":"Saved","failed":"Failed","gatewayNote":"GitHub outbound: repository_dispatch; requires a token with repository Contents: write. No automatic retry/deduplication; avoid loops. Incoming deliveries can repeat. Secrets stored in server KV, not encrypted at rest by this app.","targets":"Targets (max 4):"}}, html:L=>`<div class="ed-main"><p>POST /api/v1/webhook/ingest — GitHub: X-Hub-Signature-256 (HMAC SHA-256). Alertmanager / Uptime Kuma / generic: Authorization: Bearer SECRET.</p><p>${esc(L.gatewayNote)}</p><p>${esc(L.targets)} {"type":"discord","url":"https://discord.com/api/webhooks/ID/TOKEN"}, {"type":"telegram","token":"BOT:TOKEN","chat":"ID"}, {"type":"ntfy","url":"https://ntfy.sh/TOPIC"}, {"type":"github","repo":"OWNER/REPO","event":"synapse-alert","token":"TOKEN"}.</p><label for="gwConfig">${esc(L.inLabel)}</label><textarea id="gwConfig" class="tool-ta" spellcheck="false" style="min-height:320px"></textarea><button id="gwSave" class="btn">${esc(L.save)}</button><p id="gwMsg"></p></div>`,
 js:`function configError(r,d){return new Error(d&&d.message||L.failed+' (HTTP '+r.status+')');}
$('gwSave').disabled=true;
fetch('/api/gateway_config').then(async function(r){var d=await r.json();if(!r.ok||!d.config||typeof d.config!=='object')throw configError(r,d);$('gwConfig').value=JSON.stringify(d.config,null,2);$('gwSave').disabled=false;}).catch(function(e){$('gwMsg').textContent=e.message;});
on('gwSave',async function(){if($('gwSave').disabled)return;$('gwSave').disabled=true;try{var c=JSON.parse($('gwConfig').value);var r=await fetch('/api/gateway_config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});var d=await r.json();if(!r.ok||!d.success)throw configError(r,d);$('gwMsg').textContent=L.saved;}catch(e){$('gwMsg').textContent=e.message;}finally{$('gwSave').disabled=false;}});`
},
"provision": {
 title:{id:"Provisioning Host",en:"Provisioning Host"},
 labels: {"id":{"title":"Provisioning Host","back":"Kembali","warning":"Semua konten yang diaktifkan bersifat PUBLIK. Jangan masukkan private key, token, atau sandi. Skrip hanya disajikan sebagai teks, tidak dijalankan server. Periksa sebelum menjalankannya di VPS.","keys":"SSH public keys","script":"setup.sh (opsional)","enable":"Publikasikan","save":"Simpan","saved":"Tersimpan","failed":"Gagal"},"en":{"title":"Provisioning Host","back":"Back","warning":"Enabled content is PUBLIC. Never include private keys, tokens, or passwords. Scripts are served as text, never executed by the server. Review before running on your VPS.","keys":"SSH public keys","script":"setup.sh (optional)","enable":"Publish","save":"Save","saved":"Saved","failed":"Failed"}}, html:L=>`<div class="ed-main"><p class="sg-notice sg-warning" role="note">${esc(L.warning)}</p><label><input type="checkbox" id="pvEnabled"> ${esc(L.enable)}</label><div class="fld"><label for="pvKeys">${esc(L.keys)}</label><textarea id="pvKeys" class="tool-ta" spellcheck="false"></textarea></div><div class="fld"><label for="pvScript">${esc(L.script)}</label><textarea id="pvScript" class="tool-ta" spellcheck="false"></textarea></div><button class="btn" id="pvSave">${esc(L.save)}</button><p id="pvMsg"></p><p>/p/authorized_keys — /p/pubkey — /p/setup.sh</p></div>`,
 js:`function configError(r,d){return new Error(d&&d.message||L.failed+' (HTTP '+r.status+')');}
$('pvSave').disabled=true;
fetch('/api/provision_config').then(async function(r){var d=await r.json();if(!r.ok||!d.config||typeof d.config!=='object')throw configError(r,d);$('pvEnabled').checked=d.config.enabled;$('pvKeys').value=d.config.keys;$('pvScript').value=d.config.script;$('pvSave').disabled=false;}).catch(function(e){$('pvMsg').textContent=e.message;});
on('pvSave',async function(){if($('pvSave').disabled)return;$('pvSave').disabled=true;try{var c={enabled:$('pvEnabled').checked,keys:$('pvKeys').value,script:$('pvScript').value};var r=await fetch('/api/provision_config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});var d=await r.json();if(!r.ok||!d.success)throw configError(r,d);$('pvMsg').textContent=L.saved;}catch(e){$('pvMsg').textContent=e.message;}finally{$('pvSave').disabled=false;}});`
},
"vault": {title:{id:"Code Vault",en:"Code Vault"},labels:{id:{title:"Code Vault",back:"Kembali"},en:{title:"Code Vault",back:"Back"}},html:L=>(L.uiEnglish?"<div class=\"ed-main\"><p>Public templates: read-only JSON link. Private: AES-GCM + PBKDF2 in your browser; master password never sent. Titles and language are NOT encrypted. Keep the ID and password. Each save creates a new immutable version; no automatic expiry. Highlighting is lightweight, not a full language parser.</p><label for=\"vTitle\">Title</label><input class=\"tool-in\" id=\"vTitle\" placeholder=\"Title\"><label for=\"vLang\">Code language</label><select class=\"tool-sel\" id=\"vLang\"><option>kotlin</option><option>go</option><option>python</option><option>javascript</option><option>typescript</option><option>bash</option><option>yaml</option><option>json</option><option>dockerfile</option><option>ssh</option></select><label for=\"vMode\">Storage mode</label><select class=\"tool-sel\" id=\"vMode\"><option value=\"private\">Private encrypted</option><option value=\"public\">Public template</option></select><label for=\"vPass\">Master password</label><input class=\"tool-in\" id=\"vPass\" type=\"password\" autocomplete=\"off\" placeholder=\"Master password (12+ characters)\"><label for=\"vText\">Code / configuration</label><textarea id=\"vText\" class=\"tool-ta\" spellcheck=\"false\"></textarea><pre class=\"tool-list\" id=\"vPreview\" style=\"white-space:pre-wrap\"></pre><button class=\"btn ghost\" id=\"vSave\">Save new version</button><label for=\"vId\">Vault ID</label><input class=\"tool-in\" id=\"vId\" placeholder=\"Vault ID\"><button class=\"btn ghost\" id=\"vLoad\">Load</button><button class=\"btn ghost\" id=\"vClear\">Clear sensitive fields</button><p id=\"vMsg\"></p></div>":"<div class=\"ed-main\"><p>Template publik: tautan JSON hanya-baca. Privat: AES-GCM + PBKDF2 di browser; kata sandi utama tidak dikirim. Judul dan bahasa TIDAK dienkripsi. Simpan ID dan kata sandi. Setiap penyimpanan membuat versi baru yang tidak dapat diubah; tanpa kedaluwarsa otomatis. Highlighting ringan, bukan parser bahasa lengkap.</p><label for=\"vTitle\">Judul</label><input class=\"tool-in\" id=\"vTitle\" placeholder=\"Judul\"><label for=\"vLang\">Bahasa kode</label><select class=\"tool-sel\" id=\"vLang\"><option>kotlin</option><option>go</option><option>python</option><option>javascript</option><option>typescript</option><option>bash</option><option>yaml</option><option>json</option><option>dockerfile</option><option>ssh</option></select><label for=\"vMode\">Mode penyimpanan</label><select class=\"tool-sel\" id=\"vMode\"><option value=\"private\">Privat terenkripsi</option><option value=\"public\">Template publik</option></select><label for=\"vPass\">Kata sandi utama</label><input class=\"tool-in\" id=\"vPass\" type=\"password\" autocomplete=\"off\" placeholder=\"Kata sandi utama (12+ karakter)\"><label for=\"vText\">Kode / konfigurasi</label><textarea id=\"vText\" class=\"tool-ta\" spellcheck=\"false\"></textarea><pre class=\"tool-list\" id=\"vPreview\" style=\"white-space:pre-wrap\"></pre><button class=\"btn ghost\" id=\"vSave\">Simpan versi baru</button><label for=\"vId\">ID Vault</label><input class=\"tool-in\" id=\"vId\" placeholder=\"ID Vault\"><button class=\"btn ghost\" id=\"vLoad\">Muat</button><button class=\"btn ghost\" id=\"vClear\">Bersihkan data sensitif</button><p id=\"vMsg\"></p></div>"),js:"\nconst enc=new TextEncoder(),dec=new TextDecoder();\nfunction b64(a){return btoa(String.fromCharCode(...a))}function bytes(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}\nasync function key(pass,salt){if(pass.length<12)throw Error('Master password minimum 12 characters');const k=await crypto.subtle.importKey('raw',enc.encode(pass),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},k,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}\nfunction vaultTokens(text,lang){\n const words={kotlin:'fun val var class object interface package import return if else when is in as null true false suspend override private public data sealed',go:'func package import return if else range for type struct interface map chan go defer select case var const nil true false',python:'def class import from return if elif else for while in is not and or None True False async await with try except pass lambda',javascript:'const let var function class return if else import export from async await new null true false throw try catch',typescript:'const let var function class return if else import export from async await new null true false interface type enum implements public private readonly',bash:'if then else elif fi for do done case esac function in export local readonly while',yaml:'true false null yes no',json:'true false null',dockerfile:'FROM RUN COPY ADD CMD ENTRYPOINT ENV ARG WORKDIR USER EXPOSE VOLUME LABEL SHELL HEALTHCHECK ONBUILD STOPSIGNAL',ssh:'Host HostName User Port IdentityFile ProxyJump LocalForward RemoteForward DynamicForward ServerAliveInterval ServerAliveCountMax StrictHostKeyChecking Include Match'};\n const kw=new Set((words[lang]||'').split(' ')),hash=['python','bash','yaml','dockerfile','ssh'].includes(lang),slash=['kotlin','go','javascript','typescript'].includes(lang),out=[];let i=0,start=0;\n function emit(end,type){if(start<i)out.push({text:text.slice(start,i),type:''});out.push({text:text.slice(i,end),type});i=end;start=i;}\n while(i<text.length){let c=text[i];if((hash&&c==='#')||(slash&&text.slice(i,i+2)==='//')){let e=text.indexOf('\\n',i);emit(e<0?text.length:e,'comment');continue;}\n if(slash&&text.slice(i,i+2)==='/*'){let e=text.indexOf('*/',i+2);emit(e<0?text.length:e+2,'comment');continue;}\n if(c==='\"'||c===\"'\"||(c==='`'&&['go','javascript','typescript','bash'].includes(lang))){let delim=c;if(['python','kotlin'].includes(lang)&&text.slice(i,i+3)===c.repeat(3))delim=c.repeat(3);let e=i+delim.length;while(e<text.length){if(text[e]==='\\\\'){e+=2;continue;}if(text.slice(e,e+delim.length)===delim){e+=delim.length;break;}e++;}emit(Math.min(e,text.length),'string');continue;}\n if(/[A-Za-z_]/.test(c)){let e=i+1;while(e<text.length&&/[A-Za-z0-9_]/.test(text[e]))e++;const w=text.slice(i,e);if(kw.has(w)||(lang==='dockerfile'&&kw.has(w.toUpperCase()))||(lang==='ssh'&&Array.from(kw).some(x=>x.toLowerCase()===w.toLowerCase())))emit(e,'keyword');else i=e;continue;}\n if(/[0-9]/.test(c)&&(i===0||!/[\\w]/.test(text[i-1]))){let e=i+1;while(e<text.length&&/[0-9]/.test(text[e]))e++;emit(e,'number');continue;}i++;\n }if(start<text.length)out.push({text:text.slice(start),type:''});return out;\n}\nfunction highlight(){const out=$('vPreview');out.textContent='';const text=$('vText').value;if(text.length>64000){out.textContent=text;return;}const colors={comment:'#94a3b8',string:'#86efac',keyword:'#67e8f9',number:'#fda4af'};for(const token of vaultTokens(text,$('vLang').value)){if(!token.type){out.append(document.createTextNode(token.text));continue;}const span=document.createElement('span');span.style.color=colors[token.type];span.textContent=token.text;out.append(span);}}\n$('vLang').addEventListener('change',highlight);\n\n$('vText').addEventListener('input',highlight);\non('vSave',async()=>{try{let c={title:$('vTitle').value,lang:$('vLang').value,mode:$('vMode').value,text:$('vText').value};if(enc.encode(c.text).length>64000)throw Error('Maximum 64 KB');if(c.mode==='private'){const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));const k=await key($('vPass').value,salt);c.text=b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},k,enc.encode(c.text))));c.salt=b64(salt);c.iv=b64(iv);}const r=await fetch('/api/vault_save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});const d=await r.json();if(!d.success)throw Error('Save failed');$('vId').value=d.id;$('vMsg').textContent=c.mode==='public'?location.origin+'/api/vault_get?id='+d.id:'Saved encrypted. Keep this ID; password cannot be recovered.';}catch(e){$('vMsg').textContent=e.message}});\non('vLoad',async()=>{try{const r=await fetch('/api/vault_get?id='+encodeURIComponent($('vId').value.trim()));const d=await r.json();if(!d.success)throw Error('Not found / denied');const c=d.doc;let text=c.text;if(c.mode==='private'){const k=await key($('vPass').value,bytes(c.salt));text=dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(c.iv)},k,bytes(c.text)));}$('vText').value=text;$('vTitle').value=c.title;$('vLang').value=c.lang;$('vMode').value=c.mode;highlight();$('vMsg').textContent='Loaded';}catch(e){$('vMsg').textContent='Load failed: wrong password, invalid data, or unavailable'}});\non('vClear',()=>{$('vText').value='';$('vPass').value='';$('vPreview').textContent='';});\n"},
"access": {title:{id:"Kontrol Akses",en:"Access Control"},labels:{id:{title:"Kontrol Akses",back:"Kembali"},en:{title:"Access Control",back:"Back"}},html:L=>(L.uiEnglish?"<div class=\"ed-main\"><p>Token only reads /api/v1/public/data. It never grants admin access. Public data remains anonymously readable. Save the token and revocation ID; token is shown once. KV revocation may propagate with delay.</p><label for=\"acDays\">Token lifetime (days)</label><input class=\"tool-in\" id=\"acDays\" type=\"number\" value=\"30\" min=\"1\" max=\"365\"><button class=\"btn ghost\" id=\"acMake\">Generate token</button><label for=\"acToken\">Generated token</label><textarea id=\"acToken\" class=\"tool-ta\" readonly></textarea><label for=\"acId\">Revocation ID</label><input class=\"tool-in\" id=\"acId\" placeholder=\"Revocation ID\"><button class=\"btn ghost\" id=\"acRevoke\">Revoke</button><p>Admin IP/subnet allowlist: JSON array, IPv4/IPv6. Empty array disables restriction. Your current IP must stay allowed. Dynamic IP changes can lock you out: recover through server-side settings/backup. Node: TRUST_PROXY only behind a trusted, restricted proxy.</p><p id=\"acIP\"></p><label for=\"acAllow\">IP/subnet allowlist (JSON)</label><textarea id=\"acAllow\" class=\"tool-ta\">[]</textarea><button class=\"btn ghost\" id=\"acSave\">Save allowlist</button><p id=\"acMsg\"></p></div>":"<div class=\"ed-main\"><p>Token hanya membaca /api/v1/public/data, tidak memberikan akses admin. Data publik tetap dapat dibaca tanpa login. Simpan token dan ID pencabutan; token hanya ditampilkan sekali. Pencabutan melalui KV dapat tertunda.</p><label for=\"acDays\">Masa berlaku token (hari)</label><input class=\"tool-in\" id=\"acDays\" type=\"number\" value=\"30\" min=\"1\" max=\"365\"><button class=\"btn ghost\" id=\"acMake\">Buat token</button><label for=\"acToken\">Token yang dibuat</label><textarea id=\"acToken\" class=\"tool-ta\" readonly></textarea><label for=\"acId\">ID pencabutan</label><input class=\"tool-in\" id=\"acId\" placeholder=\"ID pencabutan\"><button class=\"btn ghost\" id=\"acRevoke\">Cabut</button><p>Daftar IP/subnet admin: array JSON IPv4/IPv6. Array kosong menonaktifkan pembatasan. IP Anda saat ini harus tetap diizinkan. Perubahan IP dinamis dapat mengunci akses: pulihkan melalui pengaturan server/backup. Node: gunakan TRUST_PROXY hanya di belakang proxy tepercaya yang dibatasi.</p><p id=\"acIP\"></p><label for=\"acAllow\">Daftar IP/subnet (JSON)</label><textarea id=\"acAllow\" class=\"tool-ta\">[]</textarea><button class=\"btn ghost\" id=\"acSave\">Simpan daftar izin</button><p id=\"acMsg\"></p></div>"),js:"\nasync function acPost(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!d.success)throw Error(d.message||'Request denied');return d;}\nfetch('/api/access_config').then(r=>r.json()).then(d=>{$('acIP').textContent='Current IP: '+d.ip;$('acAllow').value=JSON.stringify(d.allow)});\non('acMake',async()=>{try{const d=await acPost('/api/access_token',{days:Number($('acDays').value)});$('acToken').value=d.token;$('acId').value=d.id;}catch(e){$('acMsg').textContent=e.message}});\non('acSave',async()=>{try{await acPost('/api/access_config',{allow:JSON.parse($('acAllow').value)});$('acMsg').textContent='Saved';}catch(e){$('acMsg').textContent=e.message}});\non('acRevoke',async()=>{try{await acPost('/api/access_revoke',{id:$('acId').value.trim()});$('acToken').value='';$('acMsg').textContent='Revoked';}catch(e){$('acMsg').textContent=e.message}});\n"},
"uptime": {title:{"id": "Uptime Bulanan", "en": "Monthly Uptime"},labels:{"id": {}, "en": {}},html:L=>(L.uiEnglish?"<div class=\"ed-main\"><h2>Monthly observed uptime</h2><p>Admin only. Scheduled HTTPS checks every 5 minutes, up to 10 hosts; one aggregate write per round. Worker: add cron */5 * * * * separately from backup cron. Node timer is automatic. Missing intervals are unknown; percentages estimate availability, not exact duration. KV concurrency is approximate.</p><label for=\"uh\">HTTPS host list</label><textarea class=\"tool-ta\" id=\"uh\" placeholder=\"example.com, status.example.com\"></textarea><label for=\"um\">Month (UTC)</label><input class=\"tool-in\" id=\"um\" type=\"month\"><button class=\"btn ghost\" id=\"ur\">Read</button><button class=\"btn ghost\" id=\"ue\">Enable logging</button><button class=\"btn ghost\" id=\"ud\">Disable logging</button><pre class=\"tool-list\" id=\"uo\"></pre></div>":"<div class=\"ed-main\"><h2>Uptime bulanan teramati</h2><p>Khusus admin. Pemeriksaan HTTPS setiap 5 menit, maksimal 10 host; satu penulisan gabungan per putaran. Worker: tambahkan cron */5 * * * * terpisah dari cron backup. Timer Node otomatis. Interval tanpa sampel berstatus tidak diketahui; persentase adalah estimasi ketersediaan, bukan durasi pasti. Pembaruan bersamaan di KV tidak dijamin atomik.</p><label for=\"uh\">Daftar host HTTPS</label><textarea class=\"tool-ta\" id=\"uh\" placeholder=\"example.com, status.example.com\"></textarea><label for=\"um\">Bulan (UTC)</label><input class=\"tool-in\" id=\"um\" type=\"month\"><button class=\"btn ghost\" id=\"ur\">Baca</button><button class=\"btn ghost\" id=\"ue\">Aktifkan pencatatan</button><button class=\"btn ghost\" id=\"ud\">Nonaktifkan pencatatan</button><pre class=\"tool-list\" id=\"uo\"></pre></div>"),js:"var loaded=false,busy=false;\nfunction lock(){['ue','ud'].forEach(function(id){$(id).disabled=!loaded||busy;});}\nfunction errorText(e){return (L.uiEnglish?'Failed: ':'Gagal: ')+e.message;}\nasync function read(){if(busy)return;busy=true;lock();try{var r=await fetch('/api/uptime?month='+encodeURIComponent($('um').value));var d=await r.json();if(!r.ok||d.error)throw Error(d.error||'HTTP '+r.status);if(!loaded){$('uh').value=(d.configuredHosts||[]).join('\\n');loaded=true;}$('uo').textContent=JSON.stringify(d,null,2);}catch(e){$('uo').textContent=errorText(e);}finally{busy=false;lock();}}\non('ur',read);['ue','ud'].forEach(function(id){on(id,async function(){if(!loaded||busy)return;busy=true;lock();try{var body={enabled:id==='ue'};if(body.enabled)body.hosts=$('uh').value.split(/[ ,\\n]+/).filter(Boolean);var r=await fetch('/api/uptime_config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});var d=await r.json();if(!r.ok||d.error||d.enabled!==body.enabled)throw Error(d.error||'HTTP '+r.status);$('uo').textContent=L.uiEnglish?'Saved':'Tersimpan';}catch(e){$('uo').textContent=errorText(e);}finally{busy=false;lock();}});});$('um').value=new Date().toISOString().slice(0,7);lock();read();"},
"tcp": {title:{id:"TCP Probe",en:"TCP Probe"},labels:{id:{},en:{}},html:L=>(L.uiEnglish?"<div class=\"ed-main\"><h2>TCP Probe (Node/VPS)</h2><p>Admin only. TCP handshake only; not application health. Does not test UDP or WireGuard. Private/reserved targets blocked. No payload is sent.</p><label for=\"th\">Host</label><input class=\"tool-in\" id=\"th\" placeholder=\"example.com\"><label for=\"tp\">TCP port</label><input class=\"tool-in\" id=\"tp\" type=\"number\" value=\"443\" min=\"1\" max=\"65535\"><button class=\"btn ghost\" id=\"tg\">Probe</button><pre class=\"tool-list\" id=\"to\"></pre></div>":"<div class=\"ed-main\"><h2>TCP Probe (Node/VPS)</h2><p>Khusus admin. Hanya menguji koneksi TCP, bukan kesehatan aplikasi. Tidak menguji UDP atau WireGuard. Target privat/cadangan diblokir. Tidak mengirim payload.</p><label for=\"th\">Host</label><input class=\"tool-in\" id=\"th\" placeholder=\"example.com\"><label for=\"tp\">Port TCP</label><input class=\"tool-in\" id=\"tp\" type=\"number\" value=\"443\" min=\"1\" max=\"65535\"><button class=\"btn ghost\" id=\"tg\">Uji koneksi</button><pre class=\"tool-list\" id=\"to\"></pre></div>"),js:"on('tg',async function(){try{var r=await fetch('/api/tcp_probe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({host:$('th').value.trim(),port:Number($('tp').value)})});$('to').textContent=JSON.stringify(await r.json(),null,2);}catch(e){$('to').textContent=e.message;}});"}
};
function formatterQrInit(en,getText){
 const root=document.querySelector('.cms-article');if(!root)return;
 const fields=[{id:en?'Generated output':'Hasil formatter',get value(){return getText();}}];
 const box=document.createElement('section'),label=document.createElement('p'),select=document.createElement('select'),button=document.createElement('button'),clear=document.createElement('button'),status=document.createElement('p'),image=document.createElement('div');
 box.className='ed-main tool-out';select.className='tool-sel';image.className='tool-qr-image';
 label.textContent=en?'Local QR: output text only, not guaranteed importable. May contain secrets. Maximum 1000 UTF-8 bytes.':'QR lokal: hanya teks keluaran, belum tentu bisa diimpor. Dapat berisi rahasia. Maksimal 1000 byte UTF-8.';
 fields.forEach(function(field,i){const option=document.createElement('option');option.value=String(i);option.textContent=field.id||String(i+1);select.appendChild(option);});
 button.type=clear.type='button';button.className=clear.className='btn ghost';button.textContent=en?'Generate QR':'Buat QR';clear.textContent=en?'Clear QR':'Bersihkan QR';status.setAttribute('role','status');
 function reset(){image.textContent='';status.textContent='';}
 button.addEventListener('click',function(){reset();try{const text=fields[Number(select.value)].value;if(!text||new TextEncoder().encode(text).length>1000)throw Error(en?'Output empty or exceeds 1000 bytes.':'Keluaran kosong atau melebihi 1000 byte.');image.innerHTML=makeQrSvg(text);}catch(e){status.textContent=e.message;}});
 clear.addEventListener('click',reset);select.addEventListener('change',reset);
 root.addEventListener('input',reset);root.addEventListener('change',function(e){if(e.target!==select)reset();});root.addEventListener('click',function(e){if(!box.contains(e.target))reset();});
 box.append(label,select,button,clear,status,image);root.appendChild(box);
}

const RELEASE_TOOL_HELP43 = {"cidr": {"en": "Enter 192.168.1.10/24 and Calculate: network 192.168.1.0/24. Split with prefix 26 for four subnets. Check membership of 192.168.1.20. This calculates addresses, not reachability.", "id": "Isi 192.168.1.10/24 lalu Hitung: jaringan 192.168.1.0/24. Pecah prefix 26 menjadi empat subnet. Cek anggota 192.168.1.20. Ini hitungan alamat, bukan uji koneksi."}, "epoch": {"en": "Convert 0 seconds: 1970-01-01 UTC. Select units and timezone before conversion; milliseconds are not seconds.", "id": "Konversi 0 detik: 1970-01-01 UTC. Pilih satuan dan zona waktu; milidetik bukan detik."}, "json": {"en": "Paste {\"b\":2,\"a\":1}, format/minify/sort, then copy. Fix reported error positions. Large numeric literals are preserved; this is not schema validation.", "id": "Tempel {\"b\":2,\"a\":1}, rapikan/padatkan/urutkan lalu salin. Perbaiki posisi error. Angka besar dipertahankan; bukan validasi skema."}, "cron": {"en": "Enter */5 * * * * and preview upcoming UTC runs. Five-field Cloudflare syntax: 1=Sunday. This does not install a Cron Trigger.", "id": "Isi */5 * * * * lalu lihat jadwal UTC. Sintaks lima field Cloudflare: 1=Minggu. Ini tidak memasang Cron Trigger."}, "regex": {"en": "Pattern (hello), flag g, text hello world hello: run and inspect matches/groups; optionally replace. JavaScript syntax; complex patterns may freeze a browser.", "id": "Pola (hello), flag g, teks hello world hello: jalankan dan periksa grup; bisa ganti teks. Sintaks JavaScript; pola kompleks dapat membebani browser."}, "curl": {"en": "Choose GET, https://example.com, and optional headers. Generate curl/fetch, inspect and copy. Generation sends no request. POSIX quoting is not PowerShell. Never share Authorization values.", "id": "Pilih GET, https://example.com dan header opsional. Buat curl/fetch, periksa dan salin. Generator tidak mengirim request. Kutip POSIX bukan PowerShell. Jangan bagikan Authorization."}, "ssh-config": {"en": "Set alias demo, HostName example.com, User deploy, Port 22 and key path. Generate, review and add to ~/.ssh/config. ProxyJump/forwarding are optional. No connection is made.", "id": "Isi alias demo, HostName example.com, User deploy, Port 22 dan lokasi kunci. Buat, periksa lalu tambah ke ~/.ssh/config. ProxyJump/forward opsional. Tidak membuat koneksi."}, "tunnel": {"en": "Select SSH or Cloudflare mode, fill host/forward or tunnel/ingress fields, generate and inspect. Install/authorize the actual SSH or cloudflared client separately. Text generation does not activate a tunnel.", "id": "Pilih SSH atau Cloudflare, isi host/forward atau tunnel/ingress, buat lalu periksa. Instal/otorisasi SSH atau cloudflared terpisah. Teks hasil tidak mengaktifkan tunnel."}, "export": {"en": "Export dashboard JSON first, paste it, select MD/TXT and convert. Inspect private fields before sharing. No direct KV reads; formatted text is not a restore backup.", "id": "Ekspor JSON dashboard, tempel, pilih MD/TXT lalu konversi. Periksa field privat sebelum berbagi. Tidak membaca KV langsung; teks hasil bukan backup restore."}, "converter": {"en": "Encode hello as Base64: aGVsbG8=. Decode to reverse. Select URL/hash/JWT modes separately. JWT inspection does not verify signatures; MD5 is not password security; Base64 is not encryption.", "id": "Encode hello ke Base64: aGVsbG8=. Decode untuk membalik. Pilih mode URL/hash/JWT terpisah. JWT tidak memverifikasi tanda tangan; MD5 bukan keamanan sandi; Base64 bukan enkripsi."}, "keygen": {"en": "Select UUID, random secret or X25519 and generate. Save privately; share public keys only. X25519 requires browser support. Web Crypto needs HTTPS/trusted localhost.", "id": "Pilih UUID, secret acak atau X25519 lalu buat. Simpan aman; bagikan hanya public key. X25519 perlu dukungan browser. Web Crypto perlu HTTPS/localhost tepercaya."}, "modern": {"en": "Load the built-in TLS/AWG example, replace placeholders, choose target and generate. Validate in the target client: output is a fragment, not full configuration. REALITY is VLESS TCP/Xray; Clash VLESS needs Meta/Mihomo. AWG is legacy, not 2.x. QR can contain credentials.", "id": "Muat contoh TLS/AWG bawaan, ganti placeholder, pilih tujuan lalu buat. Validasi di klien: hasil fragmen, bukan konfigurasi lengkap. REALITY untuk VLESS TCP/Xray; Clash VLESS perlu Meta/Mihomo. AWG legacy bukan 2.x. QR bisa berisi kredensial."}, "netdiag": {"en": "Query example.com type A, load connection info or audit https://example.com. External services receive requests. IP may be server egress, not your device. Header audit does not expose certificate issuer/expiry.", "id": "Query example.com tipe A, muat info koneksi atau audit https://example.com. Layanan eksternal menerima request. IP dapat berupa IP server, bukan perangkat. Audit header tidak memberi penerbit/kedaluwarsa sertifikat."}, "paste": {"en": "Enter a test secret, choose 1-hour TTL, optionally read-once, then create. Retain the full link including #fragment: it carries the decryption key. Max 32 KB. KV read-once is best-effort under concurrent reads; anyone with the link can decrypt.", "id": "Isi secret uji, pilih TTL 1 jam, opsi sekali-baca lalu buat. Simpan tautan lengkap termasuk #fragment yang membawa kunci. Maks 32 KB. Sekali-baca KV best-effort jika pembaca bersamaan; pemegang tautan dapat mendekripsi."}, "gateway": {"en": "Load configuration JSON and preserve its schema; set inbound secret and up to four destination objects using page examples. Save and send a test event to POST /api/v1/webhook/ingest. GitHub: X-Hub-Signature-256; generic/Kuma/Alertmanager: Bearer. Verify destination delivery. GitHub outbound uses repository_dispatch/Contents:write. No automatic retry/dedup; avoid loops. Server secrets are not encrypted by this app.", "id": "Muat JSON konfigurasi dan pertahankan skema; isi secret masuk dan maksimal empat tujuan sesuai contoh halaman. Simpan lalu kirim event uji ke POST /api/v1/webhook/ingest. GitHub: X-Hub-Signature-256; generic/Kuma/Alertmanager: Bearer. Cek penerimaan. GitHub keluar repository_dispatch/Contents:write. Tanpa retry/deduplikasi otomatis; hindari loop. Secret server tidak dienkripsi aplikasi."}, "provision": {"en": "Paste SSH public keys and an optional reviewed setup.sh, enable Publish and save. Verify displayed public endpoints. Never publish private keys/tokens. Download and inspect scripts before running on your VPS. Server serves text only.", "id": "Tempel SSH public key dan setup.sh yang sudah diperiksa, aktifkan Publish lalu simpan. Periksa endpoint publik. Jangan publikasikan private key/token. Unduh dan periksa skrip sebelum menjalankan di VPS. Server hanya menyajikan teks."}, "vault": {"en": "Enter title, language and code; choose public template or private encrypted mode. For private mode choose a strong master password. Save a new version and retain ID/password; load by ID. Clear sensitive data afterward. Title/language are plaintext. Versions have no automatic expiry; lost passwords cannot be recovered.", "id": "Isi judul, bahasa dan kode; pilih publik atau privat terenkripsi. Mode privat perlu sandi utama kuat. Simpan versi baru dan ID/sandi; muat berdasarkan ID. Bersihkan data sensitif. Judul/bahasa tidak dienkripsi. Versi tanpa kedaluwarsa otomatis; sandi hilang tidak bisa dipulihkan."}, "access": {"en": "Set token lifetime, create and save token plus revocation ID. Token reads /api/v1/public/data only, not admin; public data can already be anonymous. Revoke by ID; KV propagation may lag. Admin allowlist is a JSON IP/CIDR array including your current IP; [] disables. Prepare recovery before saving: dynamic IP changes may lock you out.", "id": "Isi umur token, buat dan simpan token serta ID pencabutan. Token hanya membaca /api/v1/public/data, bukan admin; data publik bisa anonim. Cabut berdasarkan ID; KV bisa terlambat. Allowlist admin berupa array JSON IP/CIDR termasuk IP saat ini; [] menonaktifkan. Siapkan pemulihan: IP dinamis bisa mengunci akses."}, "uptime": {"en": "Enable recording for up to ten HTTPS hosts. Worker needs separate */5 * * * * Cron Trigger; Node timer is automatic. Select UTC month and read. Five-minute batches estimate 288 writes/day before other use. Missing samples are unknown; percentage is sampled uptime, not SLA. Concurrent KV updates are not atomic.", "id": "Aktifkan pencatatan maksimal sepuluh host HTTPS. Worker perlu Cron Trigger */5 * * * * terpisah; timer Node otomatis. Pilih bulan UTC lalu baca. Batch lima menit diperkirakan 288 tulis/hari sebelum penggunaan lain. Sampel hilang tidak diketahui; persentase bukan SLA. Update KV bersamaan tidak atomik."}, "tcp": {"en": "On Node/VPS enter an authorized public host and port, e.g. example.com:443, then test. Success proves TCP connection, not application health. No UDP/WireGuard or payload; private/reserved targets blocked. Not supported on Worker.", "id": "Di Node/VPS isi host publik berizin dan port, misalnya example.com:443 lalu uji. Sukses hanya koneksi TCP, bukan kesehatan aplikasi. Tanpa UDP/WireGuard/payload; target privat/cadangan diblokir. Tidak didukung Worker."}};
function renderReleaseHelp43(id,lang){const h=RELEASE_TOOL_HELP43[id];if(!h)return "";const en=lang==="en";return '<details class="tool-out"><summary>'+(en?"How to use & safety":"Cara pakai & keamanan")+'</summary><p>'+esc(h[en?"en":"id"])+'</p></details>';}

const GUIDE34_DOCS = {"id": "# Synapse Grid 34 — Panduan tools\n\n[English](TOOLS.md) · [Indonesia](TOOLS.id.md)\n\nLogin, buka /tools, pilih alat lalu buka Cara pakai & keamanan. Gunakan browser modern dan HTTPS. Pemrosesan lokal bukan berarti offline: font eksternal dapat dimuat. Contoh bukan kredensial asli. Uji hanya sistem berizin.\n\n## Kalkulator CIDR\n\n`/tools/cidr`\n\nIPv4/IPv6: jaringan, netmask, host, pecah subnet, cek keanggotaan. Murni di browser.\n\nIsi 192.168.1.10/24 lalu Hitung: jaringan 192.168.1.0/24. Pecah prefix 26 menjadi empat subnet. Cek anggota 192.168.1.20. Ini hitungan alamat, bukan uji koneksi.\n\n## Konverter Epoch\n\n`/tools/epoch`\n\nEpoch detik/ms/mikro/nano ke tanggal dan sebaliknya, zona waktu, waktu relatif. Murni di browser.\n\nKonversi 0 detik: 1970-01-01 UTC. Pilih satuan dan zona waktu; milidetik bukan detik.\n\n## Formatter JSON\n\n`/tools/json`\n\nRapikan, padatkan, validasi (dengan baris/kolom error), urutkan kunci; angka besar tidak dibulatkan. Murni di browser.\n\nTempel {\"b\":2,\"a\":1}, rapikan/padatkan/urutkan lalu salin. Perbaiki posisi error. Angka besar dipertahankan; bukan validasi skema.\n\n## Parser Cron\n\n`/tools/cron`\n\nValidasi cron 5 field gaya Cloudflare (L, W, #, 1=Minggu) dan hitung jadwal berikutnya dalam UTC. Murni di browser.\n\nIsi */5 * * * * lalu lihat jadwal UTC. Sintaks lima field Cloudflare: 1=Minggu. Ini tidak memasang Cron Trigger.\n\n## Penguji Regex\n\n`/tools/regex`\n\nUji regex JavaScript: kecocokan, grup (termasuk bernama), flag, dan penggantian. Murni di browser; ada batas ukuran input.\n\nPola (hello), flag g, teks hello world hello: jalankan dan periksa grup; bisa ganti teks. Sintaks JavaScript; pola kompleks dapat membebani browser.\n\n## Pembuat Perintah curl\n\n`/tools/curl`\n\nSusun perintah curl (atau kode fetch) dari formulir, atau muat perintah curl yang sudah ada ke formulir. Murni di browser; kutip gaya POSIX.\n\nPilih GET, https://example.com dan header opsional. Buat curl/fetch, periksa dan salin. Generator tidak mengirim request. Kutip POSIX bukan PowerShell. Jangan bagikan Authorization.\n\n## Pembuat SSH Config\n\n`/tools/ssh-config`\n\nSusun blok Host untuk ~/.ssh/config: HostName, User, Port, kunci, ProxyJump, forward port, keepalive. Murni di browser; tanpa kolom teks bebas.\n\nIsi alias demo, HostName example.com, User deploy, Port 22 dan lokasi kunci. Buat, periksa lalu tambah ke ~/.ssh/config. ProxyJump/forward opsional. Tidak membuat koneksi.\n\n## Pembuat Tunnel\n\n`/tools/tunnel`\n\nSusun perintah ssh -N dengan forward port (-L/-R/-D) atau config.yml ingress Cloudflare Tunnel. Hanya menghasilkan teks; murni di browser; kutip gaya POSIX.\n\nPilih SSH atau Cloudflare, isi host/forward atau tunnel/ingress, buat lalu periksa. Instal/otorisasi SSH atau cloudflared terpisah. Teks hasil tidak mengaktifkan tunnel.\n\n## Export MD/TXT\n\n`/tools/export`\n\nKonversi JSON ekspor menjadi dokumen MD/TXT di browser; tanpa membaca KV.\n\nEkspor JSON dashboard, tempel, pilih MD/TXT lalu konversi. Periksa field privat sebelum berbagi. Tidak membaca KV langsung; teks hasil bukan backup restore.\n\n## Konverter Teks & Data\n\n`/tools/converter`\n\nBase64, URL, MD5, SHA-256, JWT inspector. Lokal di browser.\n\nEncode hello ke Base64: aGVsbG8=. Decode untuk membalik. Pilih mode URL/hash/JWT terpisah. JWT tidak memverifikasi tanda tangan; MD5 bukan keamanan sandi; Base64 bukan enkripsi.\n\n## Generator Kunci & UUID\n\n`/tools/keygen`\n\nUUID v4, secret acak, pasangan kunci X25519 native. Lokal di browser.\n\nPilih UUID, secret acak atau X25519 lalu buat. Simpan aman; bagikan hanya public key. X25519 perlu dukungan browser. Web Crypto perlu HTTPS/localhost tepercaya.\n\n## Formatter Protokol Modern\n\n`/tools/modern`\n\nProfil TCP/WS/gRPC + TLS atau TCP/REALITY ke fragmen Sing-box, Clash/Meta, V2Ray/Xray, AWG legacy, link/subscription dan QR.\n\nMuat contoh TLS/AWG bawaan, ganti placeholder, pilih tujuan lalu buat. Validasi di klien: hasil fragmen, bukan konfigurasi lengkap. REALITY untuk VLESS TCP/Xray; Clash VLESS perlu Meta/Mihomo. AWG legacy bukan 2.x. QR bisa berisi kredensial.\n\n## Diagnostik Jaringan\n\n`/tools/netdiag`\n\nDNS lewat DoH 1.1.1.1 (A/AAAA/CNAME/TXT/MX/NS), info IP/ASN koneksi, audit header keamanan HTTPS. Tanpa socket mentah.\n\nQuery example.com tipe A, muat info koneksi atau audit https://example.com. Layanan eksternal menerima request. IP dapat berupa IP server, bukan perangkat. Audit header tidak memberi penerbit/kedaluwarsa sertifikat.\n\n## Secret Share Terenkripsi\n\n`/tools/paste`\n\nAES-GCM di browser, kunci di #fragment, TTL 1 jam-7 hari, opsi sekali-baca (best-effort di KV). 1 tulis KV per secret dibuat.\n\nIsi secret uji, pilih TTL 1 jam, opsi sekali-baca lalu buat. Simpan tautan lengkap termasuk #fragment yang membawa kunci. Maks 32 KB. Sekali-baca KV best-effort jika pembaca bersamaan; pemegang tautan dapat mendekripsi.\n\n## Webhook Gateway\n\n`/tools/gateway`\n\nGitHub, Alertmanager, Kuma → Discord, Telegram, Ntfy, GitHub dispatch\n\nMuat JSON konfigurasi dan pertahankan skema; isi secret masuk dan maksimal empat tujuan sesuai contoh halaman. Simpan lalu kirim event uji ke POST /api/v1/webhook/ingest. GitHub: X-Hub-Signature-256; generic/Kuma/Alertmanager: Bearer. Cek penerimaan. GitHub keluar repository_dispatch/Contents:write. Tanpa retry/deduplikasi otomatis; hindari loop. Secret server tidak dienkripsi aplikasi.\n\n## Provisioning Host\n\n`/tools/provision`\n\nPublic SSH keys dan setup.sh; nonaktif secara default\n\nTempel SSH public key dan setup.sh yang sudah diperiksa, aktifkan Publish lalu simpan. Periksa endpoint publik. Jangan publikasikan private key/token. Unduh dan periksa skrip sebelum menjalankan di VPS. Server hanya menyajikan teks.\n\n## Code Vault\n\n`/tools/vault`\n\nTemplate publik dan AES-GCM privat\n\nIsi judul, bahasa dan kode; pilih publik atau privat terenkripsi. Mode privat perlu sandi utama kuat. Simpan versi baru dan ID/sandi; muat berdasarkan ID. Bersihkan data sensitif. Judul/bahasa tidak dienkripsi. Versi tanpa kedaluwarsa otomatis; sandi hilang tidak bisa dipulihkan.\n\n## Kontrol Akses\n\n`/tools/access`\n\nToken read-only dan whitelist IP admin\n\nIsi umur token, buat dan simpan token serta ID pencabutan. Token hanya membaca /api/v1/public/data, bukan admin; data publik bisa anonim. Cabut berdasarkan ID; KV bisa terlambat. Allowlist admin berupa array JSON IP/CIDR termasuk IP saat ini; [] menonaktifkan. Siapkan pemulihan: IP dinamis bisa mengunci akses.\n\n## Uptime Bulanan\n\n`/tools/uptime`\n\nPersentase sampel ping bulanan, opt-in; bukan SLA berbasis waktu.\n\nAktifkan pencatatan maksimal sepuluh host HTTPS. Worker perlu Cron Trigger */5 * * * * terpisah; timer Node otomatis. Pilih bulan UTC lalu baca. Batch lima menit diperkirakan 288 tulis/hari sebelum penggunaan lain. Sampel hilang tidak diketahui; persentase bukan SLA. Update KV bersamaan tidak atomik.\n\n## TCP Probe\n\n`/tools/tcp`\n\nAdmin, Node/VPS; TCP connect saja, bukan UDP.\n\nDi Node/VPS isi host publik berizin dan port, misalnya example.com:443 lalu uji. Sukses hanya koneksi TCP, bukan kesehatan aplikasi. Tanpa UDP/WireGuard/payload; target privat/cadangan diblokir. Tidak didukung Worker.\n", "en": "# Synapse Grid 34 — Tools guide\n\n[English](TOOLS.md) · [Indonesia](TOOLS.id.md)\n\nLog in, open /tools, select a tool and expand How to use & safety. Use modern browsers and HTTPS. Browser-local processing does not mean offline: fonts can load externally. Examples are not real credentials. Test only authorized systems.\n\n## CIDR Calculator\n\n`/tools/cidr`\n\nIPv4/IPv6: network, netmask, hosts, subnet split, membership check. Browser-only.\n\nEnter 192.168.1.10/24 and Calculate: network 192.168.1.0/24. Split with prefix 26 for four subnets. Check membership of 192.168.1.20. This calculates addresses, not reachability.\n\n## Epoch Converter\n\n`/tools/epoch`\n\nEpoch seconds/ms/micro/nano to date and back, time zones, relative time. Browser-only.\n\nConvert 0 seconds: 1970-01-01 UTC. Select units and timezone before conversion; milliseconds are not seconds.\n\n## JSON Formatter\n\n`/tools/json`\n\nFormat, minify, validate (with line/column errors), sort keys; big numbers are not rounded. Browser-only.\n\nPaste {\"b\":2,\"a\":1}, format/minify/sort, then copy. Fix reported error positions. Large numeric literals are preserved; this is not schema validation.\n\n## Cron Parser\n\n`/tools/cron`\n\nValidate Cloudflare-style 5-field cron (L, W, #, 1=Sunday) and compute upcoming runs in UTC. Browser-only.\n\nEnter */5 * * * * and preview upcoming UTC runs. Five-field Cloudflare syntax: 1=Sunday. This does not install a Cron Trigger.\n\n## Regex Tester\n\n`/tools/regex`\n\nTest JavaScript regex: matches, groups (including named), flags and replacement. Browser-only; input size is capped.\n\nPattern (hello), flag g, text hello world hello: run and inspect matches/groups; optionally replace. JavaScript syntax; complex patterns may freeze a browser.\n\n## curl Command Builder\n\n`/tools/curl`\n\nBuild a curl command (or fetch code) from a form, or load an existing curl command into the form. Browser-only; POSIX quoting.\n\nChoose GET, https://example.com, and optional headers. Generate curl/fetch, inspect and copy. Generation sends no request. POSIX quoting is not PowerShell. Never share Authorization values.\n\n## SSH Config Builder\n\n`/tools/ssh-config`\n\nBuild a Host block for ~/.ssh/config: HostName, User, Port, key, ProxyJump, port forwards, keepalive. Browser-only; no free-text field.\n\nSet alias demo, HostName example.com, User deploy, Port 22 and key path. Generate, review and add to ~/.ssh/config. ProxyJump/forwarding are optional. No connection is made.\n\n## Tunnel Builder\n\n`/tools/tunnel`\n\nBuild an ssh -N command with port forwards (-L/-R/-D) or a Cloudflare Tunnel ingress config.yml. Text output only; browser-only; POSIX quoting.\n\nSelect SSH or Cloudflare mode, fill host/forward or tunnel/ingress fields, generate and inspect. Install/authorize the actual SSH or cloudflared client separately. Text generation does not activate a tunnel.\n\n## Export MD/TXT\n\n`/tools/export`\n\nConvert export JSON to MD/TXT in browser; no KV reads.\n\nExport dashboard JSON first, paste it, select MD/TXT and convert. Inspect private fields before sharing. No direct KV reads; formatted text is not a restore backup.\n\n## String & Data Converter\n\n`/tools/converter`\n\nBase64, URL, MD5, SHA-256, JWT inspector. Browser-local.\n\nEncode hello as Base64: aGVsbG8=. Decode to reverse. Select URL/hash/JWT modes separately. JWT inspection does not verify signatures; MD5 is not password security; Base64 is not encryption.\n\n## Key & UUID Generator\n\n`/tools/keygen`\n\nUUID v4, random secrets, native X25519 keypairs. Browser-local.\n\nSelect UUID, random secret or X25519 and generate. Save privately; share public keys only. X25519 requires browser support. Web Crypto needs HTTPS/trusted localhost.\n\n## Modern Protocol Formatter\n\n`/tools/modern`\n\nTCP/WS/gRPC + TLS or TCP/REALITY profiles to Sing-box, Clash/Meta, V2Ray/Xray fragments, legacy AWG, links/subscription and QR.\n\nLoad the built-in TLS/AWG example, replace placeholders, choose target and generate. Validate in the target client: output is a fragment, not full configuration. REALITY is VLESS TCP/Xray; Clash VLESS needs Meta/Mihomo. AWG is legacy, not 2.x. QR can contain credentials.\n\n## Network Diagnostics\n\n`/tools/netdiag`\n\nDNS via 1.1.1.1 DoH (A/AAAA/CNAME/TXT/MX/NS), IP/ASN connection info, HTTPS security header audit. No raw sockets.\n\nQuery example.com type A, load connection info or audit https://example.com. External services receive requests. IP may be server egress, not your device. Header audit does not expose certificate issuer/expiry.\n\n## Encrypted Secret Share\n\n`/tools/paste`\n\nBrowser AES-GCM, key in #fragment, TTL 1h-7d, optional read-once (best-effort on KV). 1 KV write per secret created.\n\nEnter a test secret, choose 1-hour TTL, optionally read-once, then create. Retain the full link including #fragment: it carries the decryption key. Max 32 KB. KV read-once is best-effort under concurrent reads; anyone with the link can decrypt.\n\n## Webhook Gateway\n\n`/tools/gateway`\n\nSigned inbound and authenticated outbound webhook gateway\n\nLoad configuration JSON and preserve its schema; set inbound secret and up to four destination objects using page examples. Save and send a test event to POST /api/v1/webhook/ingest. GitHub: X-Hub-Signature-256; generic/Kuma/Alertmanager: Bearer. Verify destination delivery. GitHub outbound uses repository_dispatch/Contents:write. No automatic retry/dedup; avoid loops. Server secrets are not encrypted by this app.\n\n## Provisioning Host\n\n`/tools/provision`\n\nPublic SSH keys and setup.sh; disabled by default\n\nPaste SSH public keys and an optional reviewed setup.sh, enable Publish and save. Verify displayed public endpoints. Never publish private keys/tokens. Download and inspect scripts before running on your VPS. Server serves text only.\n\n## Code Vault\n\n`/tools/vault`\n\nPublic templates and private AES-GCM\n\nEnter title, language and code; choose public template or private encrypted mode. For private mode choose a strong master password. Save a new version and retain ID/password; load by ID. Clear sensitive data afterward. Title/language are plaintext. Versions have no automatic expiry; lost passwords cannot be recovered.\n\n## Access Control\n\n`/tools/access`\n\nRead-only tokens and admin IP allowlist\n\nSet token lifetime, create and save token plus revocation ID. Token reads /api/v1/public/data only, not admin; public data can already be anonymous. Revoke by ID; KV propagation may lag. Admin allowlist is a JSON IP/CIDR array including your current IP; [] disables. Prepare recovery before saving: dynamic IP changes may lock you out.\n\n## Monthly Uptime\n\n`/tools/uptime`\n\nMonthly observed ping sample percentage, opt-in; not time-weighted SLA.\n\nEnable recording for up to ten HTTPS hosts. Worker needs separate */5 * * * * Cron Trigger; Node timer is automatic. Select UTC month and read. Five-minute batches estimate 288 writes/day before other use. Missing samples are unknown; percentage is sampled uptime, not SLA. Concurrent KV updates are not atomic.\n\n## TCP Probe\n\n`/tools/tcp`\n\nAdmin, Node/VPS; TCP connect only, not UDP.\n\nOn Node/VPS enter an authorized public host and port, e.g. example.com:443, then test. Success proves TCP connection, not application health. No UDP/WireGuard or payload; private/reserved targets blocked. Not supported on Worker.\n"};
const GUIDE34_LICENSES = {"NAYUKI_LICENSE.txt": "/* \n * QR Code generator library (TypeScript)\n * \n * Copyright (c) Project Nayuki. (MIT License)\n * https://www.nayuki.io/page/qr-code-generator-library\n * \n * Permission is hereby granted, free of charge, to any person obtaining a copy of\n * this software and associated documentation files (the \"Software\"), to deal in\n * the Software without restriction, including without limitation the rights to\n * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of\n * the Software, and to permit persons to whom the Software is furnished to do so,\n * subject to the following conditions:\n * - The above copyright notice and this permission notice shall be included in\n *   all copies or substantial portions of the Software.\n * - The Software is provided \"as is\", without warranty of any kind, express or\n *   implied, including but not limited to the warranties of merchantability,\n *   fitness for a particular purpose and noninfringement. In no event shall the\n *   authors or copyright holders be liable for any claim, damages or other\n *   liability, whether in an action of contract, tort or otherwise, arising from,\n *   out of or in connection with the Software or the use or other dealings in the\n *   Software.\n */\n", "Orbitron-OFL.txt": "Copyright 2018 The Orbitron Project Authors (https://github.com/theleagueof/orbitron), with Reserved Font Name: \"Orbitron\"\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttp://scripts.sil.org/OFL\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded, \nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.\n", "Rajdhani-OFL.txt": "Copyright (c) 2014, Indian Type Foundry (info@indiantypefoundry.com).\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttp://scripts.sil.org/OFL\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded, \nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.\n", "JetBrainsMono-OFL.txt": "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\n\nThis license is copied below, and is also available with a FAQ at: https://scripts.sil.org/OFL\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded,\nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.\n"};
function guideFooter34(lang, dashboard) {
 const en=lang==='en';
 return '<footer class="'+(dashboard?'footer-container':'cms-footer')+'" style="padding:20px 12px;line-height:1.7;overflow-wrap:anywhere"><strong>Synapse Grid 34</strong><nav aria-label="'+(en?'Help links':'Tautan bantuan')+'" style="display:flex;flex-wrap:wrap;justify-content:center;gap:12px"><a href="/guide?lang='+lang+'">'+(en?'User guide':'Panduan penggunaan')+'</a><a href="/guide?lang='+lang+'#credits">'+(en?'Third-party credits':'Credit pihak ketiga')+'</a></nav><small>'+(en?'No project-wide license designated. Third-party terms remain applicable.':'Belum ada lisensi proyek. Ketentuan pihak ketiga tetap berlaku.')+'</small></footer>';
}
function renderGuide34(ctx) {
 const {lang,caps,isLoggedIn,siteTitle}=ctx,en=lang==='en',lc=en?'en':'id';
 const title=en?'User guide':'Panduan penggunaan';
 const core=en?[
 ['start','Getting started','Open the dashboard and sign in to manage data. Change the default password before exposing the site. Open Tools to see environment support; this guide does not activate unsupported features.'],
 ['dashboard','Dashboard & monitoring','Add an authorized target through the dashboard, fill in the available fields and save. Use search/filter to locate the entry, then run its available check. Success describes the time of the check, not continuous availability. Only test systems you have permission to access.'],
 ['notes','Notes & pages','When CMS is enabled, open Notes for private notes or Pages to manage articles. Enter a title and Markdown content, preview and save. Check public/private visibility before sharing /p/slug. Uploads require supported blob storage. Never publish secrets.'],
 ['backup','Backup & restore','Export a backup before changing storage or importing data. Keep it private: exports may contain sensitive configuration. Restore manually into the intended instance, read the confirmation and verify records. Back up uploaded blobs separately; JSON exports are not complete media backups.'],
 ['limits','Environment & limits','Worker + KV is the primary lightweight deployment. Tools shows the active profile, storage and support. TCP checks require Node/VPS. Provider quotas apply; warnings do not enforce billing limits. Changing environments does not migrate data automatically.']
 ]:[
 ['start','Mulai menggunakan','Buka dashboard dan login untuk mengelola data. Ganti password bawaan sebelum web dibuka ke publik. Buka Alat untuk melihat dukungan lingkungan; panduan tidak mengaktifkan fitur yang tidak didukung.'],
 ['dashboard','Dashboard & monitoring','Tambahkan target berizin melalui dashboard, isi kolom yang tersedia lalu simpan. Gunakan pencarian/filter untuk menemukan entri dan jalankan pemeriksaan yang tersedia. Hasil berhasil menunjukkan kondisi saat diperiksa, bukan jaminan selalu aktif. Uji hanya sistem yang boleh kamu akses.'],
 ['notes','Catatan & halaman','Saat CMS aktif, buka Catatan untuk catatan pribadi atau Halaman untuk mengelola artikel. Isi judul dan konten Markdown, periksa pratinjau lalu simpan. Periksa status publik/pribadi sebelum membagikan /p/slug. Upload memerlukan penyimpanan blob yang didukung. Jangan memublikasikan rahasia.'],
 ['backup','Backup & restore','Ekspor backup sebelum mengganti storage atau mengimpor data. Simpan secara pribadi karena ekspor dapat memuat konfigurasi sensitif. Restore manual ke instans tujuan, baca konfirmasi lalu periksa data hasilnya. Cadangkan file upload terpisah; ekspor JSON bukan backup media lengkap.'],
 ['limits','Lingkungan & batas','Worker + KV merupakan jalur utama yang ringan. Alat menampilkan profil, storage dan dukungan aktif. Pemeriksaan TCP memerlukan Node/VPS. Kuota penyedia tetap berlaku; peringatan tidak membatasi tagihan. Pergantian lingkungan tidak memindahkan data otomatis.']
 ];
 const groups=groupToolModules(Object.keys(TOOL_PAGES).map(id=>({id})),en);
 let body='<article class="cms-article"><h1>'+title+'</h1><p>'+(en?'Choose a function below. Examples are not real credentials. Use HTTPS and authorized targets only.':'Pilih fungsi di bawah. Contoh bukan kredensial asli. Gunakan HTTPS dan hanya target berizin.')+'</p><p><a href="/?lang='+lc+'">← Dashboard</a>'+(isLoggedIn?' · <a href="/tools?lang='+lc+'">'+(en?'Open tools':'Buka alat')+'</a>':' · '+(en?'Sign in from the dashboard to use admin tools.':'Login dari dashboard untuk menggunakan alat admin.'))+'</p><nav aria-label="'+title+'"><ul>'+core.map(c=>'<li><a href="#'+c[0]+'">'+esc(c[1])+'</a></li>').join('')+groups.filter(g=>g.modules.length).map(g=>'<li><a href="#group-'+g.id+'">'+esc(g.title)+'</a></li>').join('')+'<li><a href="#credits">'+(en?'Third-party credits':'Credit pihak ketiga')+'</a></li></ul></nav>';
 body+=core.map(c=>'<section id="'+c[0]+'"><h2>'+esc(c[1])+'</h2><p>'+esc(c[2])+'</p></section>').join('');
 groups.forEach(g=>{if(!g.modules.length)return;body+='<section id="group-'+g.id+'"><h2>'+esc(g.title)+'</h2>';g.modules.forEach(m=>{const def=TOOL_PAGES[m.id],help=RELEASE_TOOL_HELP43[m.id];const sections=GUIDE34_DOCS[lc].split('## ');const section=sections.find(x=>x.includes('`/tools/'+m.id+'`'));const purpose=section?section.trim().split('\n')[2]:'';body+='<section class="tool-out" id="tool-'+m.id+'"><h3>'+esc(def.title[lc])+'</h3><p>'+esc(purpose)+'</p><h4>'+(en?'Steps, examples & results':'Langkah, contoh & hasil')+'</h4><p>'+esc(help?help[lc]:'')+'</p>'+(isLoggedIn?'<a href="/tools/'+m.id+'?lang='+lc+'">'+(en?'Open function':'Buka fungsi')+' →</a>':'<small>'+(en?'Admin login required.':'Memerlukan login admin.')+'</small>')+'</section>';});body+='</section>';});
 body+='<section id="credits"><h2>'+(en?'Third-party credits & licensing status':'Credit pihak ketiga & status lisensi')+'</h2><p>'+(en?'No project-wide license is designated. No claim is made that the entire codebase was authored or owned by the uploader. Some provenance remains unverified. These notices apply to their respective components, not the whole project.':'Belum ada lisensi proyek. Tidak ada klaim bahwa seluruh kode dibuat atau dimiliki pengunggah. Sebagian asal-usul kode belum terverifikasi. Pemberitahuan berikut berlaku untuk komponen masing-masing, bukan seluruh proyek.')+'</p><p>QR: Project Nayuki (MIT). Fonts: Orbitron, Rajdhani, JetBrains Mono (SIL OFL). '+(en?'Fonts may load from Google Fonts; requests are sent to that provider.':'Font dapat dimuat dari Google Fonts; permintaan dikirim ke penyedia tersebut.')+'</p>'+Object.keys(GUIDE34_LICENSES).map(n=>'<details class="tool-out"><summary>'+esc(n)+'</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(GUIDE34_LICENSES[n])+'</pre></details>').join('')+'</section></article>';
 return renderCmsShell({lang:lc,siteTitle,title,noindex:true,nav:renderCmsNav('guide',lc,caps,isLoggedIn,siteTitle),body});
}

function renderToolPage(id, ctx) {
  const { lang, siteTitle, caps, isLoggedIn } = ctx;
  const def = TOOL_PAGES[id];
  const L = Object.assign({}, TOOL_COMMON[lang === "en" ? "en" : "id"], {title:def.title[lang === "en" ? "en" : "id"],back:lang === "en" ? "Back to tools" : "Kembali ke alat"}, def.labels[lang === "en" ? "en" : "id"], {uiEnglish:lang === "en"});
  const script = "<script>(function(){var L=" + safeJsonForScript(L) + ";" + TOOL_PRELUDE + (["modern", "ssh-config", "tunnel"].includes(id) ? makeQrSvg.toString() + ";" : "") + def.js + (["ssh-config", "tunnel"].includes(id) ? ";" + formatterQrInit.toString() + ";formatterQrInit(" + (lang === "en") + ",function(){return lastText;});" : "") + "})();</script>";
  const body = `<article class="cms-article"><h1>${esc(L.title)}</h1>
    <p><a href="/tools">← ${esc(L.back)}</a></p>
    ${renderReleaseHelp43(id,lang)}<p><a href="/guide?lang=${lang}#tool-${id}">${lang === "en" ? "Full guide & examples" : "Panduan lengkap & contoh"} →</a></p>${renderDemoTool34(id,lang)}${def.html(L)}</article>`;
  return renderCmsShell({
    lang, siteTitle, title: L.title, noindex: true,
    nav: renderCmsNav("tools", lang, caps, isLoggedIn, siteTitle), body, scripts: script + "<script>(" + demoToolInit34.toString() + ")(" + safeJsonForScript(DEMO_TOOL_INPUTS34[id] || {}) + "," + (lang === "en") + ");</script>"
  });
}

// Stable functional groups; unknown future modules remain visible in Other.
function groupToolModules(modules, en) {
  const groups = [
    ['network', 'Jaringan & Diagnostik', 'Network & Diagnostics', ['cidr', 'netdiag']],
    ['config', 'Konfigurasi & Tunnel', 'Configuration & Tunnels', ['ssh-config', 'tunnel', 'modern']],
    ['monitor', 'Monitoring & Status', 'Monitoring & Status', ['uptime', 'tcp', 'badges', 'badge']],
    ['developer', 'Utilitas Developer', 'Developer Utilities', ['converter', 'json', 'regex', 'curl', 'cron', 'epoch']],
    ['sharing', 'Penyimpanan & Berbagi', 'Storage & Sharing', ['vault', 'paste', 'export', 'feeds', 'feed']],
    ['automation', 'Integrasi & Otomasi', 'Integration & Automation', ['gateway', 'provision']],
    ['security', 'Keamanan & Akses', 'Security & Access', ['keygen', 'access']],
    ['other', 'Lainnya', 'Other', []]
  ];
  const buckets = groups.map(g => ({id:g[0], title:en ? g[2] : g[1], modules:[]}));
  modules.forEach(m => {
    const index = groups.findIndex(g => g[3].includes(m.id));
    buckets[index < 0 ? buckets.length - 1 : index].modules.push(m);
  });
  return buckets.filter(g => g.modules.length);
}
function renderToolsPage(ctx) {
  const { lang, siteTitle, caps, isLoggedIn } = ctx;
  const en = lang === "en";
  const L = {
    title: en ? "Admin Tools" : "Alat Admin",
    env: en ? "Environment" : "Lingkungan",
    loading: en ? "Loading…" : "Memuat…",
    failed: en ? "Failed to load the registry." : "Gagal memuat registri.",
    profile: en ? "Profile" : "Profil", storage: en ? "Storage" : "Penyimpanan",
    limits: en ? "Limits" : "Batas",
    ready: en ? "READY" : "SIAP", planned: en ? "PLANNED" : "DIRENCANAKAN",
    unsupported: en ? "NOT SUPPORTED HERE" : "TIDAK DIDUKUNG DI SINI",
    none: en ? "no fixed cap" : "tanpa batas tetap",
    hint: en ? "Warnings are advisory only. Nothing is disabled automatically." : "Peringatan hanya saran. Tidak ada fitur yang dimatikan otomatis."
  };
  const script = `<script>(function(){
var L=${safeJsonForScript(L)};
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e;}
var box=document.getElementById('envBox'),list=document.getElementById('toolsList');
fetch('/api/tools_registry',{credentials:'same-origin'}).then(function(r){return r.json();}).then(function(d){
  if(!d||!d.success)throw 0;
  box.textContent='';
  box.appendChild(el('div','',L.profile+': '+d.profile+'  |  '+L.storage+': '+d.storage));
  var lm=d.limits,p=[];
  Object.keys(lm).forEach(function(k){p.push(k+'='+(lm[k]===null?L.none:lm[k]));});
  box.appendChild(el('small','',L.limits+': '+p.join(', ')));
  list.textContent='';
  var grouped=(${groupToolModules.toString()})(d.modules,${en});
  grouped.forEach(function(group){
    var section=el('section','tool-out');
    var heading=el('h2','',group.title+' ('+group.modules.length+')');
    heading.id='tools-group-'+group.id;section.setAttribute('aria-labelledby',heading.id);
    section.appendChild(heading);list.appendChild(section);
    group.modules.forEach(function(m){
    var row=el('div','pg-item');var left=el('div');
    if(m.href&&m.supported&&m.href.indexOf('/tools/')===0){var a=el('a','',m.name);a.href=m.href;a.style.fontWeight='700';left.appendChild(a);}else left.appendChild(el('strong','',m.name));left.appendChild(el('br'));
    left.appendChild(el('small','',m.note));
    m.warnings.forEach(function(w){left.appendChild(el('br'));left.appendChild(el('small','sg-notice sg-warning','⚠ '+w));});
    row.appendChild(left);
    row.appendChild(el('span','badge',!m.supported?L.unsupported:(m.status==='ready'?L.ready:L.planned)));
    section.appendChild(row);
    });
  });
}).catch(function(){box.textContent=L.failed;list.textContent='';});
})();</script>`;
  const body = `<article class="cms-article"><h1>${esc(L.title)}</h1>
    <p><a href="/guide?lang=${lang}">${en ? "User guide — steps & examples" : "Panduan penggunaan — langkah & contoh"}</a></p><h2>${esc(L.env)}</h2><div id="envBox" class="pg-item" style="display:block">${esc(L.loading)}</div>
    <p><small>${esc(L.hint)}</small></p>
    <div id="toolsList">${esc(L.loading)}</div></article>`;
  return renderCmsShell({
    lang, siteTitle, title: L.title, noindex: true,
    nav: renderCmsNav("tools", lang, caps, isLoggedIn, siteTitle), body, scripts: script
  });
}
const POST_ADMIN_ROUTES = new Set([
  "/api/add", "/api/edit", "/api/reorder", "/api/delete", "/api/clear_filtered", "/api/restore",
  "/api/save_ping_selection", "/api/save_public_columns", "/api/toggle_pin", "/api/save_settings_general",
  "/api/save_display_mode", "/api/save_sort", "/api/seed_demo", "/api/change_password", "/api/toggle_lockdown",
  "/api/save_dev_config", "/api/bulk_action", "/api/save_note", "/api/delete_note", "/api/save_page", "/api/delete_page",
  "/api/upload", "/api/delete_upload", "/api/paste_create", "/api/gateway_config", "/api/provision_config"
]);
const GET_ADMIN_ROUTES = new Set(["/api/provision_config", "/api/gateway_config", "/api/export_filtered", "/api/uploads", "/api/page", "/api/note", "/api/tools_registry", "/api/tools/dns", "/api/tools/netinfo", "/api/tools/headers"]);

let _stage = "start";
async function handleRequest(request, env, ctx) {
  _stage = "start";
  try {
    return await routeRequest(request, env, ctx);
  } catch (err) {
    console.error("[Request] Unhandled error at stage \"" + _stage + "\":", err && err.stack ? err.stack : err);
    let p = "/";
    try { p = new URL(request.url).pathname; } catch (e) {}
    if (p.indexOf("/api/") === 0) return jsonResp({ success: false, message: "Internal server error" }, 500);
    // Short reason (name + message only, no stack) so a failed deploy can be diagnosed from the browser.
    let detail = "";
    try { detail = String(err && err.name ? err.name + ": " + err.message : err).substring(0, 300) + " [stage: " + _stage + "]"; } catch (e) {}
    return new Response("Internal Server Error\n\n" + detail + "\n\n(" + APP_VERSION + " - full stack trace is in the Worker logs)", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
}

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const origin = getOrigin(request, url);
  const isHttps = origin.indexOf("https://") === 0;
  const isRead = method === "GET" || method === "HEAD";

  if (path === "/robots.txt" && isRead) {
    return new Response("User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /notes\nSitemap: " + origin + "/sitemap.xml\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" }
    });
  }

  const KV = createStore(env);
  if (!KV) {
    return new Response("SERVER_KV binding required. Configure KV namespace binding as SERVER_KV in Cloudflare Worker settings (or bind D1 as DB).", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // ---------- UPLOADED FILES (no settings / session needed) ----------
  if (path.indexOf("/uploads/") === 0 && isRead) {
    const name = path.slice(9);
    if (!UPLOAD_NAME_RE.test(name)) return new Response("Not found", { status: 404 });
    const blob = getBlobStore(env);
    const obj = blob ? await blob.get(name) : null;
    if (!obj) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    // Type comes from the extension we generated (validated by magic bytes at upload), never from the client.
    return new Response(method === "HEAD" ? null : obj.body, {
      status: 200,
      headers: {
        "Content-Type": MIME_BY_EXT[name.split(".")[1]] || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Length": String(obj.size)
      }
    });
  }

  // ---------- CORS PREFLIGHT (public API only) ----------
  if (method === "OPTIONS") {
    if (path === "/api/v1/public/data") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" } });
    }
    return new Response(null, { status: 204, headers: { "Allow": "GET, HEAD, POST" } });
  }

  // ---------- CSRF: state-changing requests must come from this site ----------
  if (!isRead) {
    const o = request.headers.get("Origin");
    if (o) {
      let ok = false;
      try {
        const oh = new URL(o).host;
        const fwd = (request.headers.get("x-forwarded-host") || "").split(",")[0].trim();
        ok = oh === url.host || (fwd && oh === fwd);
      } catch (e) { ok = false; }
      if (!ok) return jsonResp({ success: false, message: "Cross-site request blocked" }, 403);
    }
  }

  // ---------- SETTINGS ----------
  _stage = "settings:read";
  let settings = await KV.get(SETTINGS_KEY, { type: "json" });
  let settingsDirty = false;
  if (!settings || typeof settings !== "object") {
    // Fresh install. The password is hashed lazily on the first successful login, so opening the
    // page never depends on crypto or on a KV write.
    const boot = bootstrapCredentials(env);
    settings = {
      adminUser: boot.user, adminPass: boot.pass, passIsDefault: boot.isDefault,
      pingSelection: [], announcementNote: "📢 Selamat datang di Synapse Grid 34. [Link](https://google.com)",
      publicColumns: { showCustomLink: true, customFields: {} }, capabilities: defaultCapabilities()
    };
    settingsDirty = true;
  }
  if (normalizeSettings(settings)) settingsDirty = true;
  if (!settings.adminPassHash && settings.adminPass === undefined) {
    settings.adminPass = DEFAULT_PASS; settings.passIsDefault = true; settingsDirty = true;
  }
  if (settings.adminPassHash && settings.adminPass !== undefined) { delete settings.adminPass; settingsDirty = true; }
  if (settingsDirty) {
    _stage = "settings:write";
    try { await KV.put(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { console.error("[Settings] write failed:", e); }
  }
  const saveSettings = async () => { _stage = "settings:save"; await KV.put(SETTINGS_KEY, JSON.stringify(settings)); };
  const caps = settings.capabilities;
  const ADMIN_USER = settings.adminUser;

  const cookies = parseCookies(request.headers.get("Cookie"));
  let lang = cookies.pref_lang === "en" ? "en" : "id";
  const langParam = url.searchParams.get("lang");
  if (langParam === "en" || langParam === "id") lang = langParam;
  const M = (id, en) => (lang === "en" ? en : id);
  const langCookie = (langParam === "en" || langParam === "id") ? "pref_lang=" + langParam + "; Path=/; SameSite=Lax; Max-Age=31536000" : null;

  // ---------- SERVERS (loaded lazily: ping / public API never touch the big item list) ----------
  let _servers = null;
  const getServers = async () => {
    if (_servers) return _servers;
    _stage = "servers:read";
    let list = await KV.get(SERVERS_KEY, { type: "json" });
    if (!Array.isArray(list)) list = [];
    let migrate = false;
    list.forEach((s) => { if (!s.id) { s.id = crypto.randomUUID(); migrate = true; } });
    if (migrate) await KV.put(SERVERS_KEY, JSON.stringify(list));
    if (settings.pingSelection === undefined || !Array.isArray(settings.pingSelection)) {
      settings.pingSelection = list.filter((s) => s.enablePing !== false && s.host && s.host.trim() !== "").slice(0, 34).map((s) => s.host);
      await saveSettings();
    }
    _servers = list;
    return list;
  };
  const saveServers = async (list) => { _servers = list; await KV.put(SERVERS_KEY, JSON.stringify(list)); };


  // Public feeds expose only public page-index metadata, never private content.
  if ((path === "/feed.xml" || path === "/atom.xml") && isRead) {
    if (!caps.cms) return new Response("Not found", {status:404});
    const rl = memRateLimit("feed:" + getClientIP(request), 60, 60);
    if (!rl.ok) return new Response("Rate limited", {status:429,headers:{"Retry-After":String(rl.retryAfter)}});
    const xml = v => String(v == null ? "" : v).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/[&<>"']/g,c=>String.fromCharCode(38)+"#"+c.charCodeAt(0)+";");
    const list = (await getPagesIndex(KV)).filter(p=>p.isPublic !== false).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,50);
    const title = xml(settings.siteTitle || "Synapse Grid 34"), origin = url.origin;
    const date = n => {const d=new Date(n||0);return Number.isFinite(d.getTime())?d:new Date(0);};
    let body;
    if(path === "/atom.xml") {
      body = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>'+title+'</title><id>'+xml(origin+'/')+'</id><link href="'+xml(origin+'/atom.xml')+'" rel="self"/><updated>'+date(list[0]?.updatedAt).toISOString()+'</updated>'+list.map(p=>{const link=xml(origin+'/p/'+encodeURIComponent(p.slug));return '<entry><title>'+xml(p.title)+'</title><id>'+link+'</id><link href="'+link+'"/><updated>'+date(p.updatedAt).toISOString()+'</updated></entry>';}).join('')+'</feed>';
    } else {
      body = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>'+title+'</title><link>'+xml(origin+'/')+'</link><description>Public pages</description>'+list.map(p=>{const link=xml(origin+'/p/'+encodeURIComponent(p.slug));return '<item><title>'+xml(p.title)+'</title><link>'+link+'</link><guid isPermaLink="true">'+link+'</guid><pubDate>'+date(p.updatedAt).toUTCString()+'</pubDate></item>';}).join('')+'</channel></rss>';
    }
    return new Response(method === "HEAD" ? null : body,{headers:{"Content-Type":path === "/atom.xml"?"application/atom+xml; charset=utf-8":"application/rss+xml; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }
  // Badge reads existing observations only: no outbound probe or KV write on embed requests.
  if (path.startsWith("/api/v1/badge/") && isRead) {
    if (!caps.api) return new Response("Not found",{status:404});
    const rl = memRateLimit("badge:"+getClientIP(request),120,60);
    if(!rl.ok)return new Response("Rate limited",{status:429,headers:{"Retry-After":String(rl.retryAfter)}});
    const id = path.slice("/api/v1/badge/".length);
    const item = (await getServers()).find(s=>s.id===id && s.isPublic!==false);
    if(!item)return new Response("Not found",{status:404,headers:{"Cache-Control":"no-store"}});
    let value=null;
    if(caps.ping && item.enablePing!==false && !settings.lockdownMode && item.host){
      const h=String(item.host).trim().toLowerCase();
      try {value=pingCacheIsShared(settings,KV)?await KV.get("ping_cache:"+h):pingMemGet(h);}catch(e){}
    }
    const status=value==="1"?"up":value==="0"?"down":"unknown";
    const color=value==="1"?"#2cbe4e":value==="0"?"#cb2431":"#767676";
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="140" height="20" role="img" aria-label="status: '+status+'"><title>status: '+status+' (cached observation)</title><rect width="140" height="20" rx="3" fill="#555"/><path fill="'+color+'" d="M60 0h77q3 0 3 3v14q0 3-3 3H60z"/><g fill="#fff" font-family="Verdana,sans-serif" font-size="11" text-anchor="middle"><text x="30" y="14">status</text><text x="100" y="14">'+status+'</text></g></svg>';
    return new Response(method === "HEAD"?null:svg,{headers:{"Content-Type":"image/svg+xml; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; sandbox"}});
  }

  // ---------- ENCRYPTED SECRET SHARE (public read; ciphertext only, key never reaches the server) ----------
  if (path.startsWith("/s/") && isRead) {
    const id = path.slice(3);
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return new Response("Not found", { status: 404 });
    return new Response(method === "HEAD" ? null : renderSecretViewer(id, lang), { headers: cmsHeaders(false, { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" }) });
  }
  if (path === "/api/paste_open" && method === "POST") {
    const rl = memRateLimit("paste_open:" + getClientIP(request), 20, 60);
    if (!rl.ok) return jsonResp({ success: false, message: "Rate limit exceeded" }, 429, { "Retry-After": String(rl.retryAfter) });
    const body = await readJson(request);
    const id = body && typeof body.id === "string" ? body.id : "";
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return jsonResp({ success: false }, 404);
    let rec = null;
    try { rec = await KV.get("paste:" + id, { type: "json" }); } catch (e) { return jsonResp({ success: false }, 503, { "Cache-Control": "no-store" }); }
    if (!rec || typeof rec.ct !== "string" || (rec.exp && rec.exp <= Date.now())) return jsonResp({ success: false }, 404, { "Cache-Control": "no-store" });
    if (rec.once) { try { await KV.delete("paste:" + id); } catch (e) { return jsonResp({ success: false }, 503, { "Cache-Control": "no-store" }); } }
    return jsonResp({ success: true, iv: rec.iv, ct: rec.ct, once: !!rec.once }, 200, { "Cache-Control": "no-store" });
  }

  // Signed incoming GitHub or authenticated generic/Alertmanager/Kuma webhooks.
  if(path==='/api/v1/webhook/ingest') {
   if(method!=='POST')return jsonResp({success:false},405,{Allow:'POST'});
   if(!memRateLimit('gateway:'+getClientIP(request),20,60).ok)return jsonResp({success:false},429);
   const c=await gatewayConfig(KV);if(!c.enabled)return jsonResp({success:false},404);
   if(Number(request.headers.get('content-length')||0)>65536)return jsonResp({success:false},413);
   let raw='';const reader=request.body?.getReader();if(!reader)return jsonResp({success:false},400);
   const chunks=[];let size=0;
   try { while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){try{await reader.cancel()}catch(e){}return jsonResp({success:false},413)}chunks.push(value)} }
   catch(e){return jsonResp({success:false},400)}
   const bytes=new Uint8Array(size);let off=0;for(const b of chunks){bytes.set(b,off);off+=b.length}
   try{raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch(e){return jsonResp({success:false},400)}
   const gh=request.headers.get('x-github-event');
   if(gh){const sig=request.headers.get('x-hub-signature-256')||'';if(!await safeEqual(sig,'sha256='+await gatewayMac(c.secret,raw)))return jsonResp({success:false},401);}
   else if(!await safeEqual(request.headers.get('authorization')||'','Bearer '+c.secret))return jsonResp({success:false},401);
   let data;try{data=JSON.parse(raw)}catch(e){return jsonResp({success:false},400)}
   if(!data||typeof data!=='object'||Array.isArray(data))return jsonResp({success:false},400);
   const source=gh?'github':Array.isArray(data.alerts)?'alertmanager':data.heartbeat?'uptime-kuma':'generic';
   const event=String(gh||data.status||data.event||'notification').slice(0,100);
   if(gh==='ping')return jsonResp({success:true,pong:true});
   const message=gatewayMessage(source,event,data,c.template);
   const results=await Promise.all(c.targets.map(async t=>{try{return await gatewaySend(t,message,source,event)}catch(e){return {type:t.type,ok:false,error:'Delivery failed'}}}));
   return jsonResp({success:results.every(r=>r.ok),results},results.every(r=>r.ok)?200:502);
  }


  if(['/p/authorized_keys','/p/pubkey','/p/setup.sh'].includes(path)) {
   if(!isRead)return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
   if(!memRateLimit('provision:'+getClientIP(request),30,60).ok)return new Response('Rate limited',{status:429});
   const c=await KV.get('provision_v1',{type:'json'});
   if(!c||!c.enabled)return new Response('Not found',{status:404});
   const body=path==='/p/setup.sh'?c.script:c.keys;
   if(!body)return new Response('Not found',{status:404});
   return new Response(method==='HEAD'?null:body,{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'X-Robots-Tag':'noindex','Content-Disposition':'inline; filename="'+(path==='/p/setup.sh'?'setup.sh':'authorized_keys')+'"'}});
  }



  const bearer=request.headers.get('authorization');
  if(bearer && /^Bearer /i.test(bearer)) {
   if(!memRateLimit('access_token:'+getClientIP(request),60,60).ok)return jsonResp({success:false},429);
   if(path!=='/api/v1/public/data'||!isRead)return jsonResp({success:false,message:'Token scope: public:data:read only'},403);
   const hash=await accessDigest(bearer.slice(7));const t=await KV.get('ro_token:'+hash,{type:'json'});
   if(!t||t.expires<Date.now())return jsonResp({success:false},401);
  }

  // ---------- PUBLIC API (capability: api) ----------
  if (path === "/api/v1/public/data" && isRead) {
    if (!caps.api) return new Response("API capability is disabled in Developer Options.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    const rl = memRateLimit("api:" + getClientIP(request), API_RATE_LIMIT_MAX, API_RATE_LIMIT_WINDOW);
    if (!rl.ok) {
      return jsonResp({ success: false, message: "Rate limit exceeded" }, 429, { "Retry-After": String(rl.retryAfter), "Access-Control-Allow-Origin": "*" });
    }
    const servers = await getServers();
    // Explicit whitelist: nothing outside this list can ever reach the public API.
    const items = servers.filter((s) => s.isPublic !== false).map((s) => publicItemView(s, settings.publicColumns)).map((s) => ({
      id: s.id, name: s.name, category: s.category, groupType: s.groupType, description: s.description,
      host: s.host, customLink: s.customLink, imageUrl: s.imageUrl || "", mode: s.mode, createdAt: s.createdAt, customFields: s.customFields
    }));
    return jsonResp({ version: 1, generatedAt: new Date().toISOString(), totalItems: items.length, items }, 200, {
      "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60"
    });
  }

  // ---------- PING CHECK ----------
  if (path === "/api/check" && isRead) {
    if (!caps.ping) return jsonResp({ disabled: true, reason: "ping_capability_disabled" });
    const host = String(url.searchParams.get("host") || "").trim().toLowerCase();
    if (!HOST_RE.test(host)) return jsonResp({ online: false }, 400);
    // Only hosts that belong to an item (same rule the page uses to decide what to ping) can be probed.
    // V38 let any visitor make the server fetch any domain (SSRF / open scanner) and write one KV row per host.
    const allowedHost = async () => {
      const sel = (settings.pingSelection || []).map((h) => String(h).trim().toLowerCase());
      if (sel.includes(host)) return true;
      const now = Date.now();
      if (!_pingAllow || now - _pingAllow.at > 30000) {
        const list = await getServers();
        _pingAllow = { at: now, set: new Set(list.filter((s) => s.enablePing !== false && s.host && String(s.host).trim() !== "").map((s) => String(s.host).trim().toLowerCase())) };
      }
      return _pingAllow.set.has(host);
    };
    if (settings.lockdownMode) return jsonResp({ host, online: false, lockdown: true });
    const rl = memRateLimit("chk:" + getClientIP(request), 900, 60);
    if (!rl.ok) return jsonResp({ host, online: false, throttled: true, reason: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfter) });

    // Quota safeguard: on Workers KV Free (~1,000 writes/day) one KV write per host per minute would burn the
    // daily budget in ~30 minutes with a single open dashboard tab. So on the light "worker" profile the ping
    // cache lives in isolate memory (zero KV ops). Other profiles / storages keep the shared cache.
    // settings.pingCacheMode: "auto" (default) | "memory" | "shared"
    const cacheKey = "ping_cache:" + host;
    const sharedCache = pingCacheIsShared(settings, KV);
    try {
      const cached = sharedCache ? await KV.get(cacheKey) : pingMemGet(host);
      if (cached === "1") return jsonResp({ host, online: true, cached: true });
      if (cached === "0") return jsonResp({ host, online: false, cached: true });
    } catch (e) {}
    if (!(await allowedHost())) return jsonResp({ host, online: false, ignored: true, reason: "host_not_in_items" }, 403);
    const isOnline = await probeHost(host);

    if (sharedCache) { try { await KV.put(cacheKey, isOnline ? "1" : "0", { expirationTtl: PING_CACHE_TTL }); } catch (e) {} }
    else pingMemSet(host, isOnline ? "1" : "0");

    if (!isOnline && settings.webhookUrl && normalizeWebhookUrl(settings.webhookUrl)) {
      const cooldownKey = "webhook_cd:" + host;
      try {
        if (!(await KV.get(cooldownKey))) {
          await KV.put(cooldownKey, "1", { expirationTtl: 3600 });
          runBackground(ctx, fetch(settings.webhookUrl, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: `⚠️ **SYNAPSE ALERT** ⚠️\n\nNode/Item dengan Host: \`${host}\` terdeteksi OFFLINE/DOWN.\n\nSilakan periksa server Anda.` })
          }));
        }
      } catch (e) {}
    }
    return jsonResp({ host, online: isOnline });
  }

  // ---------- SESSION ----------
  let isLoggedIn = false;
  let isCookieInvalid = false;
  const sessionToken = cookies.auth_session || null;
  _stage = "session";
  if (sessionToken) {
    const user = await validateSession(KV, sessionToken, settings.sessionVersion || 0);
    if (user && user === ADMIN_USER) isLoggedIn = true; else isCookieInvalid = true;
  }

  if(!accessAllowed(getClientIP(request),settings.adminAllowIPs))isLoggedIn=false;
  if(path==='/api/tcp_probe'){
    if(!memRateLimit('tcp:'+getClientIP(request),12,60).ok)return jsonResp({error:'Rate limited'},429);
    if(!isLoggedIn)return jsonResp({error:'Admin only'},403);
    if(method!=='POST')return jsonResp({error:'POST required'},405);
    if(!isNodeRuntime())return jsonResp({error:'Node/VPS only'},501);
    if(settings.lockdownMode||!caps.ping)return jsonResp({error:'Probing disabled'},403);
    const b=await readJson(request);
    if(!b||typeof b.host!=='string'||!HOST_RE.test(b.host)||!Number.isInteger(b.port)||b.port<1||b.port>65535)return jsonResp({error:'Invalid host or port'},400);
    try{return jsonResp(await tcpProbe(b.host.toLowerCase(),b.port));}catch(e){return jsonResp({error:'DNS failed or destination blocked'},400);}
  }
  if(path==='/api/uptime' || path==='/api/uptime_config') {
    if(!memRateLimit('uptime:'+getClientIP(request),30,60).ok)return jsonResp({error:'Rate limited'},429);
    if(!isLoggedIn)return jsonResp({error:'Admin only'},403);
    if(path==='/api/uptime_config') {
      if(method!=='POST')return jsonResp({error:'POST required'},405);
      const b=await readJson(request);if(!b||typeof b.enabled!=='boolean')return jsonResp({error:'enabled must be boolean'},400);
      const hosts=b.hosts===undefined?(settings.uptimeHosts||[]):b.hosts;
      if(!Array.isArray(hosts)||hosts.length>10||hosts.some(h=>typeof h!=='string'||!HOST_RE.test(h)))return jsonResp({error:'Provide at most 10 domain names'},400);
      if(b.enabled&&!hosts.length)return jsonResp({error:'Select at least one host'},400);
      settings.uptimeHosts=[...new Set(hosts.map(h=>h.toLowerCase()))];
      settings.uptimeEnabled=b.enabled;await saveSettings();
      return jsonResp({enabled:b.enabled});
    }
    if(!isRead)return jsonResp({error:'GET required'},405);
    const month=url.searchParams.get('month')||new Date().toISOString().slice(0,7);
    if(!/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(month))return jsonResp({error:'Invalid month'},400);
    const data=await KV.get('uptime_v1:'+month,{type:'json'})||{month,hosts:{}};
    return jsonResp({enabled:!!settings.uptimeEnabled,month,configuredHosts:settings.uptimeHosts||[],metric:'scheduled_sample_percentage',warning:'Configure Worker cron */5 * * * *; Node timer runs automatically. Unknown intervals are not online. KV concurrent isolates may lose updates.',hosts:Object.entries(data.hosts).map(([host,h])=>({host,...h,percentage:h.scheduledTotal?100*h.scheduledUp/h.scheduledTotal:null,observedMinutes:(h.scheduledTotal||0)*5,expectedMonthSamples:(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)-Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-1,1))/300000}))});
  }
  // ---------- AUTH ----------
  if (path === "/api/login" && method === "POST") {
    const ip = getClientIP(request);
    if(!accessAllowed(ip,settings.adminAllowIPs))return jsonResp({success:false,message:'Admin IP denied'},403);
    const rateKey = "rate_login:" + ip;
    let attempts = 0;
    try { attempts = parseInt((await KV.get(rateKey)) || "0", 10) || 0; } catch (e) {}
    if (attempts >= RATE_LIMIT_MAX) {
      return jsonResp({ success: false, message: M("Terlalu banyak percobaan login. Tunggu 1 menit.", "Too many login attempts. Wait 1 minute.") }, 429);
    }
    const body = await readJson(request);
    if (body) {
      if (settings.turnstileSiteKey && settings.turnstileSecretKey) {
        const captchaOk = await verifyTurnstile(settings.turnstileSecretKey, body.turnstileToken, ip);
        if (!captchaOk) return jsonResp({ success: false, message: M("Verifikasi CAPTCHA gagal. Silakan coba lagi.", "CAPTCHA verification failed. Please try again.") }, 400);
      }
      // Always run both checks so response time does not reveal whether the username exists.
      const userOk = await safeEqual(String(body.username || ""), ADMIN_USER);
      _stage = "login:verify";
      const passOk = await checkAdminPassword(settings, String(body.password || ""));
      if (userOk && passOk) {
        if (!settings.adminPassHash) {
          // Upgrade the legacy plaintext password to a salted hash; keep working if hashing fails.
          try { settings.adminPassHash = await hashPassword(String(body.password)); delete settings.adminPass; await saveSettings(); }
          catch (e) { delete settings.adminPassHash; console.error("[Auth] hash upgrade skipped:", e); }
        }
        try { await KV.delete(rateKey); } catch (e) {}
        const token = await createSession(KV, ADMIN_USER, settings.sessionVersion || 0);
        if (!token) return jsonResp({ success: false, message: "Session error" }, 500);
        return jsonResp({ success: true }, 200, { "Set-Cookie": `auth_session=${token}; ${cookieAttrs(isHttps)}; Max-Age=${SESSION_TTL}` });
      }
    }
    try { await KV.put(rateKey, String(attempts + 1), { expirationTtl: RATE_LIMIT_WINDOW }); } catch (e) {}
    return jsonResp({ success: false, message: M("Username atau Password Salah!", "Invalid Username or Password!") }, 401);
  }

  if (path === "/api/logout" && method === "POST") {
    if (sessionToken) await destroySession(KV, sessionToken);
    return jsonResp({ success: true }, 200, { "Set-Cookie": clearCookieHeader(isHttps) });
  }

  // ---------- AUTH GUARD ----------
  if (path.indexOf("/api/") === 0 && !isLoggedIn) {
    if ((POST_ADMIN_ROUTES.has(path) && method === "POST") || (GET_ADMIN_ROUTES.has(path) && isRead)) {
      return jsonResp({ success: false, message: "Access Denied!" }, 403);
    }
  }
  if (POST_ADMIN_ROUTES.has(path) && method !== "POST") return jsonResp({ success: false, message: "Method not allowed" }, 405, { "Allow": "POST" });

  // ---------- SPA DATA ----------
  if (path === "/api/data" && method === "GET") {
    const servers = await getServers();
    const viewServers = viewServersFor(isLoggedIn, servers, settings);
    const vs = buildViewSettings(settings, isLoggedIn, viewServers);
    return jsonResp({
      servers: viewServers,
      settings: {
        displayMode: vs.displayMode, activeSort: vs.activeSort, siteTitle: vs.siteTitle, announcementNote: vs.announcementNote,
        pingSelection: vs.pingSelection, pingRule34Active: vs.pingRule34Active, autoPingIntervalEnabled: vs.autoPingIntervalEnabled,
        autoPingIntervalSeconds: vs.autoPingIntervalSeconds, lockdownMode: vs.lockdownMode, publicColumns: vs.publicColumns,
        capabilities: vs.capabilities, runtimeProfile: vs.runtimeProfile
      },
      user: isLoggedIn ? ADMIN_USER : null
    });
  }

  // ---------- TOOLS REGISTRY (admin only, guarded by GET_ADMIN_ROUTES) ----------
  if (path === "/api/tools_registry" && isRead) {
    return jsonResp(Object.assign({ success: true }, buildToolsRegistry(lang, settings.runtimeProfile || "worker", KV.kind || "kv")));
  }
  // ---------- NETWORK DIAGNOSTICS (admin only via GET_ADMIN_ROUTES; fixed HTTPS upstreams) ----------
  if ((path === "/api/tools/dns" || path === "/api/tools/netinfo" || path === "/api/tools/headers") && isRead) {
    const rl = memRateLimit("diag:" + getClientIP(request), 30, 60);
    if (!rl.ok) return jsonResp({ success: false, message: "Rate limit exceeded" }, 429, { "Retry-After": String(rl.retryAfter) });
    const timed = async (u, init, consume) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), 5000); try { const r = await publicFetch(u, Object.assign({}, init, { redirect: init.redirect || "error", sgDiscardBody: !consume, signal: c.signal })); return consume ? await consume(r) : r; } finally { clearTimeout(t); } };
    const upstreamJson = async (r) => {
      if (!r.ok) { try { if (r.body) await r.body.cancel(); } catch (e) {} throw new Error("Upstream HTTP " + r.status); }
      if (!r.body) throw new Error("Empty upstream body");
      const reader = r.body.getReader(); const chunks = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error("Upstream JSON too large"); chunks.push(part.value); } }
      catch (e) { try { await reader.cancel(); } catch (_) {} throw e; }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    try {
      if (path === "/api/tools/dns") {
        const name = String(url.searchParams.get("name") || "").trim().toLowerCase().replace(/\.$/, "");
        const type = String(url.searchParams.get("type") || "A").toUpperCase();
        if (!HOST_RE.test(name)) return jsonResp({ success: false, message: "Invalid domain" }, 400);
        if (!["A", "AAAA", "CNAME", "TXT", "MX", "NS"].includes(type)) return jsonResp({ success: false, message: "Invalid type" }, 400);
        const d = await timed("https://1.1.1.1/dns-query?name=" + encodeURIComponent(name) + "&type=" + type, { headers: { Accept: "application/dns-json" } }, upstreamJson);
        const RC = { 0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 5: "REFUSED" };
        const T = { 1: "A", 2: "NS", 5: "CNAME", 15: "MX", 16: "TXT", 28: "AAAA" };
        return jsonResp({ success: true, result: { name, type, status: RC[d.Status] || String(d.Status), dnssecValidated: !!d.AD,
          answers: (Array.isArray(d.Answer) ? d.Answer : []).slice(0, 100).map((a) => ({ name: String(a.name || ""), type: T[a.type] || String(a.type), ttl: a.TTL, data: String(a.data || "").slice(0, 2048) })) } });
      }
      if (path === "/api/tools/netinfo") {
        const cf = request.cf || null;
        const conn = cf ? { country: cf.country || null, asn: cf.asn || null, asOrganization: cf.asOrganization || null, colo: cf.colo || null, city: cf.city || null, tlsVersion: cf.tlsVersion || null, httpProtocol: cf.httpProtocol || null }
          : { note: "request.cf is only available on Cloudflare Workers" };
        let serverEgressIp = null;
        try { const j = await timed("https://api.ipify.org?format=json", {}, upstreamJson); if (typeof j.ip === "string" && j.ip.length <= 45) serverEgressIp = j.ip; } catch (e) {}
        let serverNetwork = null;
        if (serverEgressIp && /^[0-9a-fA-F:.]+$/.test(serverEgressIp) && !isPrivateIp(serverEgressIp)) {
          try {
            const geo = await timed("https://ipwho.is/" + encodeURIComponent(serverEgressIp), {}, upstreamJson);
            if (geo.success === true && geo.ip === serverEgressIp && geo.connection && typeof geo.connection === "object") {
              const text = (v) => typeof v === "string" ? v.slice(0, 256) : null;
              serverNetwork = { ip: serverEgressIp, asn: Number.isSafeInteger(geo.connection.asn) && geo.connection.asn > 0 ? geo.connection.asn : null,
                isp: text(geo.connection.isp), organization: text(geo.connection.org), country: text(geo.country), city: text(geo.city), source: "ipwho.is" };
            }
          } catch (e) { /* Optional enrichment: preserve original IP on upstream failure. */ }
        }
        return jsonResp({ success: true, result: { visitorIp: getClientIP(request), visitorConnection: conn, serverEgressIp, serverNetwork,
          note: "On Workers the egress IP is a shared Cloudflare address, not a dedicated server IP. Optional ASN/ISP/location from ipwho.is refer to this egress IP; free quota, no SLA. Null means unavailable, not offline." } });
      }
      const host = String(url.searchParams.get("host") || "").trim().toLowerCase();
      if (!HOST_RE.test(host)) return jsonResp({ success: false, message: "Invalid host" }, 400);
      if (await resolvesToPrivate(host)) return jsonResp({ success: false, message: "Host resolves to a private address" }, 400);
      const t0 = Date.now();
      let r;
      try { r = await timed("https://" + host + "/", { method: "GET", redirect: "manual", headers: { "User-Agent": "SynapseGrid-Audit/1" } }); }
      catch (e) { return jsonResp({ success: true, result: { host, https: false, error: "HTTPS connection failed or timed out (invalid certificate also fails here)" } }); }
      try { if (r.body) await r.body.cancel(); } catch (e) {}
      const h = (k) => r.headers.get(k);
      const checks = {
        "strict-transport-security": h("strict-transport-security"), "content-security-policy": h("content-security-policy"),
        "x-content-type-options": h("x-content-type-options"), "x-frame-options": h("x-frame-options"),
        "referrer-policy": h("referrer-policy"), "permissions-policy": h("permissions-policy")
      };
      // CORS is policy information, not a mandatory security header or a score penalty.
      const cors = {};
      for (const k of ["access-control-allow-origin", "access-control-allow-credentials", "access-control-allow-methods", "access-control-allow-headers", "access-control-expose-headers", "access-control-max-age", "vary"]) {
        const v = h(k); if (v !== null) cors[k] = String(v).slice(0, 512);
      }
      const missing = Object.keys(checks).filter((k) => !checks[k]);
      const shown = {}; Object.keys(checks).forEach((k) => { if (checks[k]) shown[k] = String(checks[k]).slice(0, 512); });
      return jsonResp({ success: true, result: { host, https: true, status: r.status, location: h("location") ? String(h("location")).slice(0, 512) : null,
        server: h("server") ? String(h("server")).slice(0, 128) : null, elapsedMs: Date.now() - t0, securityHeaders: shown, cors, missing,
        score: (Object.keys(checks).length - missing.length) + "/" + Object.keys(checks).length,
        certificate: "not exposed by fetch(); a successful HTTPS response means the certificate was accepted by the runtime" } });
    } catch (e) {
      return jsonResp({ success: false, message: "Upstream failed" }, 502);
    }
  }
  if (path === "/api/paste_create") {
    const rl = memRateLimit("paste_new:" + getClientIP(request), 20, 60);
    if (!rl.ok) return jsonResp({ success: false, message: "Rate limit exceeded" }, 429, { "Retry-After": String(rl.retryAfter) });
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const B64U = /^[A-Za-z0-9_-]+$/;
    if (typeof body.iv !== "string" || body.iv.length !== 16 || !B64U.test(body.iv)) return jsonResp({ success: false, message: "Invalid iv" }, 400);
    if (typeof body.ct !== "string" || body.ct.length < 22 || body.ct.length > 44000 || !B64U.test(body.ct)) return jsonResp({ success: false, message: "Invalid ciphertext" }, 400);
    const ttl = [3600, 86400, 604800].includes(body.ttl) ? body.ttl : 86400;
    const raw = crypto.getRandomValues(new Uint8Array(16));
    let id = btoa(String.fromCharCode.apply(null, raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await KV.put("paste:" + id, JSON.stringify({ iv: body.iv, ct: body.ct, once: body.once !== false, exp: Date.now() + ttl * 1000 }), { expirationTtl: ttl });
    return jsonResp({ success: true, id, expiresIn: ttl });
  }

  if(path==='/api/gateway_config' && (isRead||method==='POST')) {
   if(!memRateLimit('gateway_cfg:'+getClientIP(request),20,60).ok)return jsonResp({success:false},429);
   if(isRead)return jsonResp({success:true,config:await gatewayConfig(KV)});
   try{const c=validateGateway(await readJson(request));await KV.put('gateway_v1',JSON.stringify(c));return jsonResp({success:true});}catch(e){return jsonResp({success:false,message:e.message},400)}
  }


  if(path==='/api/provision_config' && (isRead||method==='POST')) {
   if(!memRateLimit('provision_cfg:'+getClientIP(request),20,60).ok)return jsonResp({success:false},429);
   if(isRead)return jsonResp({success:true,config:await KV.get('provision_v1',{type:'json'})||{enabled:false,keys:'',script:''}});
   let c;try{c=validateProvision(await readJson(request))}catch(e){return jsonResp({success:false,message:e.message},400)}
   await KV.put('provision_v1',JSON.stringify(c));return jsonResp({success:true});
  }

  if(path==='/api/vault_save' || path==='/api/vault_get') {
   if(!memRateLimit('vault:'+getClientIP(request),30,60).ok)return jsonResp({success:false},429);
   if(path==='/api/vault_save') {
    if(method!=='POST')return jsonResp({success:false},405);
    if(!isLoggedIn)return jsonResp({success:false},403);
    let c;try{c=await readJson(request)}catch(e){return jsonResp({success:false},400)}
    const langs=['kotlin','go','python','javascript','typescript','bash','yaml','json','dockerfile','ssh'];
    if(!c||!langs.includes(c.lang)||!['public','private'].includes(c.mode)||typeof c.title!=='string'||c.title.length>120||typeof c.text!=='string'||c.text.length>90000)return jsonResp({success:false},400);
    if(c.mode==='private'&&(!/^[A-Za-z0-9+/]{22}==$/.test(c.salt||'')||!/^[A-Za-z0-9+/]{16}$/.test(c.iv||'')||! /^[A-Za-z0-9+/]+={0,2}$/.test(c.text)||c.text.length<24))return jsonResp({success:false},400);
    const id=crypto.randomUUID();const doc={id,title:c.title,lang:c.lang,mode:c.mode,text:c.text};
    if(c.mode==='private'){doc.salt=c.salt;doc.iv=c.iv;doc.kdf='PBKDF2-SHA256-310000';}
    await KV.put('vault:'+id,JSON.stringify(doc));return jsonResp({success:true,id});
   }
   if(!isRead)return jsonResp({success:false},405);
   const id=url.searchParams.get('id')||'';if(!/^[0-9a-f-]{36}$/.test(id))return jsonResp({success:false},404);
   const doc=await KV.get('vault:'+id,{type:'json'});
   if(!doc||(doc.mode==='private'&&!isLoggedIn))return jsonResp({success:false},404);
   return jsonResp({success:true,doc},200,{'Cache-Control':'no-store'});
  }


  if(['/api/access_config','/api/access_token','/api/access_revoke'].includes(path)) {
   if(!memRateLimit('access_admin:'+getClientIP(request),20,60).ok)return jsonResp({success:false},429);
   if(!isLoggedIn)return jsonResp({success:false},403);
   if(path==='/api/access_config'&&isRead)return jsonResp({success:true,ip:getClientIP(request),allow:settings.adminAllowIPs||[]});
   if(method!=='POST')return jsonResp({success:false},405);
   const b=await readJson(request);if(!b)return jsonResp({success:false},400);
   if(path==='/api/access_config'){
    try{if(!Array.isArray(b.allow)||b.allow.length>50||b.allow.some(x=>typeof x!=='string'||x.length>64))throw Error('Expected up to 50 IPs/subnets');b.allow.forEach(accessRange);if(!accessAllowed(getClientIP(request),b.allow))throw Error('Current IP must remain allowed');}catch(e){return jsonResp({success:false,message:e.message},400)}
    settings.adminAllowIPs=b.allow;await saveSettings();return jsonResp({success:true});
   }
   if(path==='/api/access_revoke'){if(!/^[0-9a-f]{64}$/.test(b.id||''))return jsonResp({success:false},400);await KV.delete('ro_token:'+b.id);return jsonResp({success:true});}
   const days=Number(b.days);if(!Number.isInteger(days)||days<1||days>365)return jsonResp({success:false},400);
   const token='sgro_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join(''),id=await accessDigest(token),expires=Date.now()+days*86400000;
   await KV.put('ro_token:'+id,JSON.stringify({expires,scope:'public:data:read'}),{expirationTtl:days*86400});return jsonResp({success:true,token,id,expires,scope:'public:data:read'},200,{'Cache-Control':'no-store'});
  }

  // ---------- DEVELOPER OPTIONS ----------
  if (path === "/api/save_dev_config") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    if (body.runtimeProfile && ["worker", "managed", "vps", "local"].includes(body.runtimeProfile)) settings.runtimeProfile = body.runtimeProfile;
    if (["auto", "memory", "shared"].includes(body.pingCacheMode)) settings.pingCacheMode = body.pingCacheMode;
    if (body.capabilities && typeof body.capabilities === "object") {
      settings.capabilities = { ping: !!body.capabilities.ping, archive: !!body.capabilities.archive, cms: !!body.capabilities.cms, api: !!body.capabilities.api };
    }
    await saveSettings();
    return jsonResp({ success: true, capabilities: settings.capabilities, runtimeProfile: settings.runtimeProfile, pingCacheMode: settings.pingCacheMode });
  }

  if (path === "/api/toggle_lockdown") {
    settings.lockdownMode = !settings.lockdownMode;
    await saveSettings();
    return jsonResp({ success: true, lockdownMode: !!settings.lockdownMode });
  }

  // ---------- SETTINGS ----------
  if (path === "/api/save_settings_general") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    if (body.siteTitle !== undefined) settings.siteTitle = str(body.siteTitle, 200) || "Synapse Grid 34";
    if (body.announcementNote !== undefined) settings.announcementNote = String(body.announcementNote).substring(0, 10000);
    if (body.webhookUrl !== undefined) {
      const wh = normalizeWebhookUrl(body.webhookUrl);
      if (wh === null) return jsonResp({ success: false, message: M("Webhook harus berupa URL https:// publik.", "Webhook must be a public https:// URL.") }, 400);
      settings.webhookUrl = wh;
    }
    if (body.turnstileSiteKey !== undefined) settings.turnstileSiteKey = str(body.turnstileSiteKey, 200);
    if (body.turnstileSecretKey !== undefined) settings.turnstileSecretKey = str(body.turnstileSecretKey, 200);
    if (body.autoBackupEnabled !== undefined) settings.autoBackupEnabled = !!body.autoBackupEnabled;
    if (body.autoBackupRetentionDays !== undefined) settings.autoBackupRetentionDays = Math.max(1, Math.min(365, parseInt(body.autoBackupRetentionDays) || 30));
    await saveSettings();
    return jsonResp({ success: true });
  }

  if (path === "/api/change_password") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const { oldPassword, newPassword, confirmPassword } = body;
    if (!(await checkAdminPassword(settings, String(oldPassword || "")))) {
      return jsonResp({ success: false, message: M("Password lama tidak sesuai!", "Old password does not match!") }, 400);
    }
    const np = String(newPassword || "").trim();
    if (np.length < 4) return jsonResp({ success: false, message: M("Password baru minimal 4 karakter!", "New password must be at least 4 characters!") }, 400);
    if (np !== confirmPassword) return jsonResp({ success: false, message: M("Password baru dan konfirmasi tidak cocok!", "New password and confirmation do not match!") }, 400);
    settings.adminPassHash = await hashPassword(np);
    delete settings.adminPass;
    settings.passIsDefault = false;
    settings.sessionVersion = (settings.sessionVersion || 0) + 1;
    await saveSettings();
    if (sessionToken) await destroySession(KV, sessionToken);
    const token = await createSession(KV, ADMIN_USER, settings.sessionVersion);
    return jsonResp({ success: true }, 200, { "Set-Cookie": `auth_session=${token}; ${cookieAttrs(isHttps)}; Max-Age=${SESSION_TTL}` });
  }

  if (path === "/api/save_display_mode") {
    const body = await readJson(request);
    if (body && ["list", "compact_grid", "comfortable_grid", "panorama"].includes(body.displayMode)) {
      settings.displayMode = body.displayMode; await saveSettings();
      return jsonResp({ success: true });
    }
    return jsonResp({ success: false }, 400);
  }

  if (path === "/api/save_sort") {
    const body = await readJson(request);
    if (body && ["recently", "oldest", "az", "za", "manual"].includes(body.sortMode)) {
      settings.activeSort = body.sortMode; await saveSettings();
      return jsonResp({ success: true });
    }
    return jsonResp({ success: false }, 400);
  }

  if (path === "/api/save_public_columns") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const cf = {};
    if (body.customFields && typeof body.customFields === "object") Object.keys(body.customFields).slice(0, 50).forEach((k) => { cf[str(k, 80)] = body.customFields[k] !== false; });
    settings.publicColumns = { showCustomLink: !!body.showCustomLink, customFields: cf };
    await saveSettings();
    return jsonResp({ success: true });
  }

  if (path === "/api/save_ping_selection") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const rule34 = body.pingRule34Active !== undefined ? !!body.pingRule34Active : settings.pingRule34Active !== false;
    if (Array.isArray(body.selection)) {
      const clean = [...new Set(body.selection.map((h) => String(h).trim().toLowerCase()).filter((h) => HOST_RE.test(h)))];
      if (rule34 && clean.length > 34) {
        return jsonResp({ success: false, message: M("Maksimal hanya 34 URL yang diizinkan saat Rule 34 aktif!", "Maximum 34 URLs allowed when Rule 34 is active!") }, 400);
      }
      settings.pingSelection = clean.slice(0, 100);
    }
    if (body.pingRule34Active !== undefined) settings.pingRule34Active = rule34;
    if (body.autoPingIntervalEnabled !== undefined) settings.autoPingIntervalEnabled = !!body.autoPingIntervalEnabled;
    if (body.autoPingIntervalSeconds !== undefined) settings.autoPingIntervalSeconds = Math.max(10, Math.min(300, parseInt(body.autoPingIntervalSeconds) || 30));
    await saveSettings();
    return jsonResp({ success: true });
  }

  // ---------- BULK ACTIONS ----------
  if (path === "/api/bulk_action") {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) return jsonResp({ success: false, message: "No items selected" }, 400);
    const idSet = new Set(body.ids.slice(0, 1000).map(String));
    const servers = await getServers();
    let affected = 0;
    if (body.action === "delete") {
      const remaining = servers.filter((s) => !idSet.has(s.id));
      affected = servers.length - remaining.length;
      pruneSelection(settings, remaining);
      await saveServers(remaining);
      await saveSettings();
    } else if (body.action === "pin" || body.action === "unpin") {
      const pin = body.action === "pin";
      servers.forEach((s) => { if (idSet.has(s.id) && !!s.isPinned !== pin) { s.isPinned = pin; affected++; } });
      await saveServers(servers);
    } else {
      return jsonResp({ success: false, message: "Invalid action" }, 400);
    }
    return jsonResp({ success: true, affected });
  }

  // ---------- CRUD ----------
  if (path === "/api/toggle_pin") {
    const body = await readJson(request);
    const servers = await getServers();
    const s = body && servers.find((x) => x.id === body.id);
    if (!s) return jsonResp({ success: false }, 400);
    s.isPinned = !s.isPinned;
    await saveServers(servers);
    return jsonResp({ success: true, isPinned: s.isPinned });
  }

  const syncSelection = (servers, oldHost, item) => {
    const sel = settings.pingSelection = settings.pingSelection || [];
    const usedElsewhere = (h) => servers.some((s) => s.id !== item.id && s.host === h && s.enablePing !== false);
    if (oldHost && oldHost !== item.host && !usedElsewhere(oldHost)) settings.pingSelection = settings.pingSelection.filter((h) => h !== oldHost);
    if (item.host && item.enablePing) {
      if (!settings.pingSelection.includes(item.host) && (!settings.pingRule34Active || settings.pingSelection.length < 34)) settings.pingSelection.push(item.host);
    } else if (item.host && !usedElsewhere(item.host)) {
      settings.pingSelection = settings.pingSelection.filter((h) => h !== item.host);
    }
    void sel;
  };

  if (path === "/api/add") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const servers = await getServers();
    if (servers.length >= MAX_ITEMS) return jsonResp({ success: false, message: M("Batas maksimum item tercapai.", "Maximum item limit reached.") }, 400);
    const built = buildItem(body, null, false);
    if (built.error) return jsonResp({ success: false, message: itemError(built.error, lang) }, 400);
    const item = built.item;
    if (servers.some((s) => s.name === item.name && (s.host || "") === item.host)) {
      return jsonResp({ success: false, message: M("Duplikat: nama + host sudah ada!", "Duplicate: same name + host already exists!") }, 400);
    }
    servers.push(item);
    syncSelection(servers, "", item);
    await saveServers(servers);
    await saveSettings();
    return jsonResp({ success: true, id: item.id });
  }

  if (path === "/api/edit") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const servers = await getServers();
    const idx = servers.findIndex((s) => s.id === body.id);
    if (idx === -1) return jsonResp({ success: false, message: M("Data tidak ditemukan!", "Data not found!") }, 400);
    const built = buildItem(body, servers[idx], false);
    if (built.error) return jsonResp({ success: false, message: itemError(built.error, lang) }, 400);
    const item = built.item;
    if (servers.some((s, i) => i !== idx && s.name === item.name && (s.host || "") === item.host)) {
      return jsonResp({ success: false, message: M("Duplikat: nama + host sudah ada!", "Duplicate: same name + host already exists!") }, 400);
    }
    const oldHost = servers[idx].host;
    servers[idx] = item;
    syncSelection(servers, oldHost, item);
    await saveServers(servers);
    await saveSettings();
    return jsonResp({ success: true });
  }

  if (path === "/api/reorder") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const servers = await getServers();
    const idx = servers.findIndex((s) => s.id === body.itemId);
    if (idx === -1) return jsonResp({ success: false }, 404);
    if (body.targetId) {
      const targetIdx = servers.findIndex((s) => s.id === body.targetId);
      if (targetIdx === -1) return jsonResp({ success: false }, 404);
      const [moved] = servers.splice(idx, 1);
      servers.splice(targetIdx, 0, moved);
    } else {
      if (body.direction !== "up" && body.direction !== "down") return jsonResp({ success: false }, 400);
      const target = body.direction === "up" ? idx - 1 : idx + 1;
      if (target < 0 || target >= servers.length) return jsonResp({ success: false }, 400);
      [servers[idx], servers[target]] = [servers[target], servers[idx]];
    }
    await saveServers(servers);
    return jsonResp({ success: true });
  }

  if (path === "/api/delete") {
    const body = await readJson(request);
    const servers = await getServers();
    const idx = body ? servers.findIndex((s) => s.id === body.id) : -1;
    if (idx === -1) return jsonResp({ success: false }, 400);
    servers.splice(idx, 1);
    pruneSelection(settings, servers);
    await saveServers(servers);
    await saveSettings();
    return jsonResp({ success: true });
  }

  if (path === "/api/clear_filtered") {
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const { targetType } = body;
    let servers = await getServers();
    if (targetType === "all") {
      servers = [];
    } else if (targetType === "group" || targetType === "category" || targetType === "independen") {
      const key = targetType === "category" ? "category" : "groupType";
      const fallback = targetType === "category" ? "General" : "Independen";
      const matchVal = targetType === "independen" ? "Independen" : str(body.targetValue, 80);
      if (!matchVal) return jsonResp({ success: false, message: "Missing value" }, 400);
      servers = servers.filter((s) => (s[key] || fallback) !== matchVal);
    } else {
      return jsonResp({ success: false, message: "Invalid type" }, 400);
    }
    pruneSelection(settings, servers);
    await saveServers(servers);
    await saveSettings();
    return jsonResp({ success: true });
  }

  // ---------- EXPORT / RESTORE ----------
  if (path === "/api/export_filtered") {
    const type = url.searchParams.get("type") || "full";
    const val = url.searchParams.get("val") || "";
    const servers = await getServers();
    const stamp = Date.now();
    let exportData; let filename;
    if (type === "full") {
      const cms = await loadCmsSnapshot(KV);
      exportData = { version: APP_VERSION, exportedAt: new Date().toISOString(), settings: sanitizeSettingsForBackup(settings), servers, notes: cms.notes, pages: cms.pages };
      filename = `SYNAPSE_FULL_${stamp}.json`;
    } else if (type === "group") {
      exportData = servers.filter((s) => (s.groupType || "Independen") === val); filename = `SYNAPSE_GROUP_${safeFilePart(val)}_${stamp}.json`;
    } else if (type === "category") {
      exportData = servers.filter((s) => (s.category || "General") === val); filename = `SYNAPSE_CATEGORY_${safeFilePart(val)}_${stamp}.json`;
    } else if (type === "independen") {
      exportData = servers.filter((s) => (s.groupType || "Independen") === "Independen"); filename = `SYNAPSE_INDEPENDEN_${stamp}.json`;
    } else {
      return jsonResp({ success: false, message: "Invalid type" }, 400);
    }
    return new Response(JSON.stringify(exportData, null, 2), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="${filename}"` }
    });
  }

  if (path === "/api/restore") {
    const incoming = await readJson(request);
    if (!incoming) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const servers = await getServers();

    if (Array.isArray(incoming)) {
      // Partial export: merge, skipping items that already exist (same id, or same name + host).
      const known = new Set(servers.map((s) => s.id));
      const keys = new Set(servers.map((s) => s.name + "\u0000" + (s.host || "")));
      const added = [];
      for (const raw of incoming.slice(0, MAX_ITEMS)) {
        if (servers.length + added.length >= MAX_ITEMS) break;
        const r = buildItem(raw, null, true);
        if (!r.item) continue;
        const k = r.item.name + "\u0000" + r.item.host;
        if (known.has(r.item.id) || keys.has(k)) continue;
        known.add(r.item.id); keys.add(k); added.push(r.item);
      }
      if (added.length === 0) return jsonResp({ success: true, count: 0 });
      const merged = servers.concat(added);
      added.forEach((it) => syncSelection(merged, "", it));
      await saveServers(merged);
      await saveSettings();
      return jsonResp({ success: true, count: added.length });
    }

    if (Array.isArray(incoming.servers)) {
      const seen = new Set();
      const next = [];
      for (const raw of incoming.servers.slice(0, MAX_ITEMS)) {
        const r = buildItem(raw, null, true);
        if (!r.item) continue;
        if (seen.has(r.item.id)) r.item.id = crypto.randomUUID();
        seen.add(r.item.id); next.push(r.item);
      }
      const hadSelection = incoming.settings && Array.isArray(incoming.settings.pingSelection);
      mergeRestoredSettings(settings, incoming.settings);
      if (!hadSelection) settings.pingSelection = next.filter((s) => s.enablePing !== false && s.host).map((s) => s.host).slice(0, 34);
      pruneSelection(settings, next);
      if (settings.pingRule34Active) settings.pingSelection = settings.pingSelection.slice(0, 34);
      await saveServers(next);
      await saveSettings();

      {
        // Accepts the V39 array format and the older single-note object { text }.
        const rawNotes = Array.isArray(incoming.notes) ? incoming.notes : (incoming.notes && typeof incoming.notes.text === "string" ? [{ title: "Catatan 1", text: incoming.notes.text, updatedAt: incoming.notes.updatedAt }] : []);
        if (rawNotes.length) {
          const nidx = await getNotesIndex(KV);
          const byId = new Map(nidx.map((e) => [e.id, e]));
          for (const rn of rawNotes.slice(0, MAX_NOTES)) {
            if (!rn || typeof rn.text !== "string") continue;
            const id = NOTE_ID_RE.test(String(rn.id || "")) ? String(rn.id) : randomHex(6);
            if (!byId.has(id) && byId.size >= MAX_NOTES) continue;
            const n = { id, title: str(rn.title, 120) || CMS_T[lang].untitledNote, text: rn.text.substring(0, MAX_NOTES_CHARS), updatedAt: Number(rn.updatedAt) || Date.now() };
            await KV.put("note:v1:" + id, JSON.stringify(n));
            byId.set(id, noteIndexEntry(n));
          }
          await KV.put("notes_index_v1", JSON.stringify([...byId.values()]));
        }
      }
      if (Array.isArray(incoming.pages)) {
        const idx = await getPagesIndex(KV);
        const bySlug = new Map(idx.map((e) => [e.slug, e]));
        for (const raw of incoming.pages.slice(0, MAX_PAGES)) {
          const r = normalizePageInput(raw, { createdAt: Number(raw && raw.createdAt) || 0 });
          if (!r.page) continue;
          if (!bySlug.has(r.page.slug) && bySlug.size >= MAX_PAGES) continue;
          await KV.put("page:v1:" + r.page.slug, JSON.stringify(r.page));
          bySlug.set(r.page.slug, pageIndexEntry(r.page));
        }
        await KV.put("pages_index_v1", JSON.stringify([...bySlug.values()]));
      }
      return jsonResp({ success: true, count: next.length, reload: true });
    }
    return jsonResp({ success: false, message: "Unrecognised backup format" }, 400);
  }

  if (path === "/api/seed_demo") {
    let servers = await getServers();
    if (servers.length > 0) {
      return jsonResp({ success: false, message: M("Database sudah ada isinya. Kosongkan dulu untuk load demo.", "Database not empty. Clear data first.") }, 400);
    }
    const demoExtras = await seedDemoCms34(KV);
    servers = generateDemoData();
    settings.pingSelection = servers.filter((s) => s.enablePing !== false && s.host).map((s) => s.host).slice(0, 34);
    await saveServers(servers);
    await saveSettings();
    return jsonResp({ success: true, count: servers.length, demoExtras });
  }

  // ---------- SPRINT 4: UPLOADS ----------
  if (path === "/api/upload") {
    if (!caps.cms && !caps.archive) return jsonResp({ success: false, message: "Capability disabled" }, 403);
    const blob = getBlobStore(env);
    if (!blob) return jsonResp({ success: false, message: CMS_T[lang].uploadUnsupported }, 501);
    const declared = parseInt(request.headers.get("content-length") || "0", 10);
    if (declared > MAX_UPLOAD_BYTES + 1024) return jsonResp({ success: false, message: CMS_T[lang].uploadTooBig }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return jsonResp({ success: false, message: "Empty file" }, 400);
    if (bytes.length > MAX_UPLOAD_BYTES) return jsonResp({ success: false, message: CMS_T[lang].uploadTooBig }, 413);
    const ext = sniffImageType(bytes);
    if (!ext) return jsonResp({ success: false, message: M("Hanya PNG, JPEG, GIF, atau WebP yang diizinkan.", "Only PNG, JPEG, GIF or WebP images are allowed.") }, 415);
    const index = await getUploadsIndex(KV);
    const used = index.reduce((n, e) => n + (Number(e.size) || 0), 0);
    if (used + bytes.length > UPLOAD_QUOTA_BYTES) return jsonResp({ success: false, message: M("Kuota penyimpanan gambar penuh. Hapus gambar lama.", "Image storage quota is full. Delete old images.") }, 413);
    const name = randomHex(16) + "." + ext;
    await blob.put(name, bytes, MIME_BY_EXT[ext]);
    index.push({ name, size: bytes.length, createdAt: Date.now() });
    await saveUploadsIndex(KV, index);
    return jsonResp({ success: true, name, url: "/uploads/" + name, size: bytes.length });
  }

  if (path === "/api/uploads") {
    const index = await getUploadsIndex(KV);
    const items = index.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((e) => ({ name: e.name, url: "/uploads/" + e.name, size: e.size, createdAt: e.createdAt }));
    return jsonResp({ success: true, items, usedBytes: index.reduce((n, e) => n + (Number(e.size) || 0), 0), quotaBytes: UPLOAD_QUOTA_BYTES, supported: !!getBlobStore(env) });
  }

  if (path === "/api/delete_upload") {
    const body = await readJson(request);
    const name = body && String(body.name || "");
    if (!name || !UPLOAD_NAME_RE.test(name)) return jsonResp({ success: false, message: "Invalid name" }, 400);
    const blob = getBlobStore(env);
    if (blob) await blob.delete(name);
    const index = (await getUploadsIndex(KV)).filter((e) => e.name !== name);
    await saveUploadsIndex(KV, index);
    return jsonResp({ success: true });
  }

  // ---------- SPRINT 4: NOTES & PAGES API ----------
  if (path === "/api/note") {
    if (!caps.cms) return jsonResp({ success: false, message: "CMS capability disabled" }, 403);
    const id = String(url.searchParams.get("id") || "");
    if (!NOTE_ID_RE.test(id)) return jsonResp({ success: false, message: "Invalid id" }, 400);
    const note = await KV.get("note:v1:" + id, { type: "json" });
    if (!note) return jsonResp({ success: false, message: CMS_T[lang].notFoundTitle }, 404);
    return jsonResp({ success: true, note });
  }

  if (path === "/api/save_note") {
    if (!caps.cms) return jsonResp({ success: false, message: "CMS capability disabled" }, 403);
    const body = await readJson(request);
    if (!body || typeof body.text !== "string") return jsonResp({ success: false, message: "Invalid payload" }, 400);
    if (body.text.length > MAX_NOTES_CHARS) return jsonResp({ success: false, message: CMS_T[lang].saveFailed + " (max " + MAX_NOTES_CHARS + ")" }, 413);
    const title = str(body.title, 120) || CMS_T[lang].untitledNote;
    const idx = await getNotesIndex(KV);
    let note;
    if (body.id) {
      if (!NOTE_ID_RE.test(String(body.id))) return jsonResp({ success: false, message: "Invalid id" }, 400);
      const existing = await KV.get("note:v1:" + body.id, { type: "json" });
      if (!existing) return jsonResp({ success: false, message: CMS_T[lang].notFoundTitle }, 404);
      if (Number(body.baseUpdatedAt) && Number(body.baseUpdatedAt) !== existing.updatedAt) return jsonResp({ success: false, message: CMS_T[lang].noteConflict }, 409);
      note = { id: existing.id, title, text: body.text, updatedAt: Date.now() };
    } else {
      if (idx.length >= MAX_NOTES) return jsonResp({ success: false, message: M("Batas jumlah catatan tercapai.", "Note limit reached.") }, 400);
      note = { id: randomHex(6), title, text: body.text, updatedAt: Date.now() };
    }
    try {
      await KV.put("note:v1:" + note.id, JSON.stringify(note));
      const next = idx.filter((e) => e.id !== note.id);
      next.push(noteIndexEntry(note));
      await KV.put("notes_index_v1", JSON.stringify(next));
    } catch (e) {
      // Workers KV allows ~1 write per second per key; a rapid second save is rejected by the platform.
      console.error("[Notes] save failed:", e);
      return jsonResp({ success: false, message: CMS_T[lang].saveTooFast }, 429);
    }
    return jsonResp({ success: true, note: noteIndexEntry(note) });
  }

  if (path === "/api/delete_note") {
    if (!caps.cms) return jsonResp({ success: false, message: "CMS capability disabled" }, 403);
    const body = await readJson(request);
    const id = body ? String(body.id || "") : "";
    if (!NOTE_ID_RE.test(id)) return jsonResp({ success: false, message: "Invalid id" }, 400);
    await KV.delete("note:v1:" + id);
    const idx = (await getNotesIndex(KV)).filter((e) => e.id !== id);
    await KV.put("notes_index_v1", JSON.stringify(idx));
    return jsonResp({ success: true });
  }

  if (path === "/api/page") {
    if (!caps.cms) return jsonResp({ success: false, message: "CMS capability disabled" }, 403);
    const slug = String(url.searchParams.get("slug") || "");
    if (!SLUG_RE.test(slug)) return jsonResp({ success: false, message: CMS_T[lang].badSlug }, 400);
    const page = await KV.get("page:v1:" + slug, { type: "json" });
    if (!page) return jsonResp({ success: false, message: CMS_T[lang].notFoundTitle }, 404);
    return jsonResp({ success: true, page });
  }

  if (path === "/api/save_page") {
    if (!caps.cms) return jsonResp({ success: false, message: "CMS capability disabled" }, 403);
    const body = await readJson(request);
    if (!body) return jsonResp({ success: false, message: "Invalid JSON" }, 400);
    const originalSlug = body.originalSlug ? String(body.originalSlug) : "";
    if (originalSlug && !SLUG_RE.test(originalSlug)) return jsonResp({ success: false, message: CMS_T[lang].badSlug }, 400);
    const slugIn = str(body.slug, 64).toLowerCase();
    const existing = await KV.get("page:v1:" + (originalSlug || slugIn), { type: "json" });
    const norm = normalizePageInput(body, existing);
    if (norm.error) {
      const msg = norm.error === "slug" ? CMS_T[lang].badSlug : norm.error === "title" ? M("Judul wajib diisi!", "Title is required!") : M("Konten terlalu panjang.", "Content is too long.");
      return jsonResp({ success: false, message: msg }, 400);
    }
    const page = norm.page;
    const idx = await getPagesIndex(KV);
    const renamed = originalSlug && originalSlug !== page.slug;
    const taken = idx.some((e) => e.slug === page.slug) || !!(await KV.get("page:v1:" + page.slug));
    if ((!originalSlug || renamed) && taken) return jsonResp({ success: false, message: M("Slug sudah dipakai.", "Slug is already in use.") }, 409);
    if (!originalSlug && idx.length >= MAX_PAGES) return jsonResp({ success: false, message: M("Batas jumlah halaman tercapai.", "Page limit reached.") }, 400);
    if (renamed && existing) page.createdAt = existing.createdAt || page.createdAt;
    await KV.put("page:v1:" + page.slug, JSON.stringify(page));
    let nextIdx = idx.filter((e) => e.slug !== page.slug && e.slug !== originalSlug);
    nextIdx.push(pageIndexEntry(page));
    await KV.put("pages_index_v1", JSON.stringify(nextIdx));
    if (renamed) await KV.delete("page:v1:" + originalSlug);
    return jsonResp({ success: true, page: pageIndexEntry(page) });
  }

  if (path === "/api/delete_page") {
    if (!caps.cms) return jsonResp({ success: false, message: "CMS capability disabled" }, 403);
    const body = await readJson(request);
    const slug = body ? String(body.slug || "") : "";
    if (!SLUG_RE.test(slug)) return jsonResp({ success: false, message: CMS_T[lang].badSlug }, 400);
    await KV.delete("page:v1:" + slug);
    const idx = (await getPagesIndex(KV)).filter((e) => e.slug !== slug);
    await KV.put("pages_index_v1", JSON.stringify(idx));
    return jsonResp({ success: true });
  }

  // ---------- UNKNOWN API ----------
  if (path.indexOf("/api/") === 0) return jsonResp({ success: false, message: "Not found" }, 404);

  // ---------- HTML ROUTES ----------
  if (!isRead) return new Response("Method Not Allowed", { status: 405, headers: { "Allow": "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" } });

  const pageCtx = { lang, isLoggedIn, siteTitle: settings.siteTitle, origin, caps };
  const cmsResponse = (html, status, cacheable) => {
    const headers = new Headers(cmsHeaders(cacheable && !isLoggedIn));
    if (langCookie) headers.append("Set-Cookie", langCookie);
    if (isCookieInvalid) headers.append("Set-Cookie", clearCookieHeader(isHttps));
    return new Response(method === "HEAD" ? null : html, { status, headers });
  };
  const notFound = () => cmsResponse(renderNotFoundPage(pageCtx), 404, false);

  if (path === "/sitemap.xml") {
    const idx = caps.cms ? await getPagesIndex(KV) : [];
    return new Response(method === "HEAD" ? null : renderSitemap(origin, caps, idx), {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" }
    });
  }

  const pageMatch = /^\/p\/([^\/]+)\/?$/.exec(path);
  if (pageMatch) {
    if (!caps.cms) return notFound();
    let slug = "";
    try { slug = decodeURIComponent(pageMatch[1]); } catch (e) { return notFound(); }
    if (!SLUG_RE.test(slug)) return notFound();
    const page = await KV.get("page:v1:" + slug, { type: "json" });
    if (!page || (page.isPublic === false && !isLoggedIn)) return notFound();
    return cmsResponse(renderPublicPage(page, pageCtx), 200, true);
  }

    const toolMatch = /^\/tools\/([a-z0-9-]+)\/?$/.exec(path);
  if (toolMatch) {
    if (!isLoggedIn || !Object.prototype.hasOwnProperty.call(TOOL_PAGES, toolMatch[1])) return notFound();
    return cmsResponse(renderToolPage(toolMatch[1], pageCtx), 200, false);
  }
  if (path === "/guide" || path === "/guide/") {
    return cmsResponse(renderGuide34(pageCtx), 200, false);
  }
  if (path === "/tools" || path === "/tools/") {
    if (!isLoggedIn) return notFound();
    return cmsResponse(renderToolsPage(pageCtx), 200, false);
  }
  if (path === "/notes" || path === "/notes/") {
    if (!caps.cms || !isLoggedIn) return notFound();
    const notes = await getNotesIndex(KV);
    return cmsResponse(renderNotesPage(notes, Object.assign({ uploadSupported: !!getBlobStore(env) }, pageCtx)), 200, false);
  }

  if (path === "/pages" || path === "/pages/") {
    if (!caps.cms) return notFound();
    const idx = await getPagesIndex(KV);
    if (isLoggedIn) {
      const editParam = String(url.searchParams.get("edit") || "");
      return cmsResponse(renderPagesManager(idx, Object.assign({ uploadSupported: !!getBlobStore(env), editSlug: SLUG_RE.test(editParam) ? editParam : "" }, pageCtx)), 200, false);
    }
    return cmsResponse(renderPagesIndex(idx, pageCtx), 200, true);
  }

  if (path !== "/" && path !== "/index.html") return notFound();

  // ---------- DASHBOARD ----------
  _stage = "dashboard:data";
  const servers = await getServers();
  const viewServers = viewServersFor(isLoggedIn, servers, settings);
  const viewSettings = buildViewSettings(settings, isLoggedIn, viewServers);
  const headers = new Headers(htmlHeaders(settings));
  if (isCookieInvalid) headers.append("Set-Cookie", clearCookieHeader(isHttps));
  if (langCookie) headers.append("Set-Cookie", langCookie);
  _stage = "dashboard:render";
  const html = getHTML(viewServers, viewSettings, isLoggedIn, lang, {
    origin, uploadSupported: !!getBlobStore(env), passIsDefault: isLoggedIn && !!settings.passIsDefault
  });
  return new Response(method === "HEAD" ? null : html, { headers });
}

// ---------- HTML ----------
function getHTML(servers, settings, isLoggedIn, lang, ctx) {
  ctx = ctx || {};
  // `servers` and `settings` arrive already filtered/redacted for the viewer (see routeRequest).
  const pingSelection = settings.pingSelection || [];
  const pingRule34Active = settings.pingRule34Active !== false;
  const autoPingIntervalEnabled = !!settings.autoPingIntervalEnabled;
  const autoPingIntervalSeconds = settings.autoPingIntervalSeconds || 30;
  const publicCols = settings.publicColumns || { showCustomLink: true, customFields: {} };
  const currentDisplayMode = settings.displayMode || "list";
  const currentSort = settings.activeSort || "recently";
  const announcementNote = settings.announcementNote || "";
  const siteTitle = settings.siteTitle || "Synapse Grid 34";
  const lockdownMode = !!settings.lockdownMode;
  const turnstileSiteKey = settings.turnstileSiteKey || "";
  const caps = settings.capabilities || { ping: true, archive: true, cms: false, api: false };
  const runtimeProfile = settings.runtimeProfile || "worker";
  const pingCacheMode = ["auto", "memory", "shared"].includes(settings.pingCacheMode) ? settings.pingCacheMode : "auto";

  const manualCategories = [...new Set(servers.map(s => s.category || "General"))];
  const allGroups = [...new Set(servers.map(s => s.groupType || "Independen"))];

  const t = lang === "en" ? {
    pingAll: "PING", pingConfig: "PING SETTINGS", backup: "BACKUP & RESTORE", settings: "SETTINGS", addNew: "ADD NEW", login: "LOGIN", logout: "LOGOUT", status: "STATUS", link: "LINK", copyAll: "COPY ALL", clearAll: "CLEAR DATA", click: "CLICK", close: "CLOSE", cancel: "CANCEL", save: "SAVE",
    announcement: "ANNOUNCEMENT", edit: "Edit", searchPlaceholder: "Search item, name, host...", filter: "Filter", display: "Display", sort: "Sort",
    allCategories: "All Categories", autoFilterVisPub: "[VISIBILITY: Public]", autoFilterVisPriv: "[VISIBILITY: Private]", autoFilterOn: "[STATUS: Online]", autoFilterOff: "[STATUS: Down / Offline]", autoFilterRest: "[STATUS: Restricted]", autoFilterMaint: "[STATUS: Maintenance / Purge]",
    sortRecently: "Recently Upload / Edit", sortOldest: "Oldest", sortAZ: "Sort A - Z", sortZA: "Sort Z - A", sortManual: "Manual Order (Enable Reorder)",
    dispList: "List Mode", dispCompact: "Compact Grid", dispComfort: "Comfortable Grid", dispPanorama: "Panorama Comfortable Grid",
    siteTitleLabel: "WEBSITE TITLE", siteTitlePlaceholder: "Enter custom website title...", updateTitleBtn: "UPDATE TITLE",
    changePassTitle: "CHANGE ADMIN PASSWORD", oldPass: "Old Password", oldPassPlaceholder: "Current password", newPass: "New Password", confirmPass: "Confirm New Password", newPassPlaceholder: "Min 4 characters", updatePass: "UPDATE PASSWORD",
    backupRestore: "BACKUP & RESTORE", dataMgmt: "Data Management:", pasteJson: "Paste JSON data here or upload file...",
    restore: "Restore",
    addTitle: "ADD NEW", nameLabel: "Name (Required)", catLabel: "Category", groupLabel: "Group / Independent", descLabel: "Description", hostLabel: "Ping URL (Optional)",
    enablePingLbl: "Enable Ping for This URL", displayTableLbl: "Display as Main Table Column", pinTopLbl: "Pin to Top Featured", customLinkLbl: "Custom Target URL (Optional)",
    clickCopyToggleLbl: "Change 'CLICK' Button Action to Copy Target URL",
    customFieldsLbl: "Additional Custom Fields (Max 5):", addColBtn: "+ Add New Column", visPubLbl: "Public Visibility", visPubOpt: "Show to Public", visPubPriv: "Hide (Private)",
    statusNodeLbl: "System / Node Status", statusNorm: "Online (Normal)", statusRest: "Restricted (Encrypted)", statusMaint: "Purge / Maintenance",
    detailTitle: "DETAIL", editDataBtn: "EDIT DATA", createdLbl: "Created",
    copySuccess: "Successfully Copied!", allHubList: "ALL HUB LIST",
    seeMore: "See More ▼", seeLess: "See Less ▲",
    rule34Title: "Rule 34", autoPingTitle: "Auto Ping Interval",
    itemNameLbl: "ITEM NAME", customUrlLbl: "CUSTOM URL",
    announcementFormat: "Format: [Link Text Label](https://...) or write in consecutive lines",
    rule34Desc: "Maximum 34 active ping URLs",
    autoPingDesc: "Periodic auto ping (Default: OFF)",
    intervalTimeRange: "Interval Time Range (Seconds)",
    selectUrlPing: "Select URL for Ping:",
    clearMethodLabel: "Select data cleansing method:",
    clearAllSystem: "Clear Entire System (All)",
    clearByGroup: "Clear By Group...",
    clearByCategory: "Clear By Category...",
    clearIndependen: "Clear All Independent Items",
    backupFull: "Backup Entire System (Full)",
    backupGroup: "Backup By Group...",
    backupCategory: "Backup By Category...",
    backupIndependen: "Backup Independent Items",
    restoreUploadOrPaste: "Restore (Upload File or Paste Code):",
    demoSecTitle: "DEMO PREVIEW",
    demoDescEmpty: "Load 50 original items plus CMS examples. Tools also have explicit demo-input buttons; actions remain manual.",
    demoDescFilled: "Clear data first to load demo.",
    demoBtn: "Load Demo Data (50 items + CMS)",
    webhookSecTitle: "SYSTEM WEBHOOK ALERTS",
    webhookDesc: "Send alerts to Discord/Telegram when server goes offline.",
    webhookPlaceholder: "https://discord.com/api/webhooks/...",
    uptimeTitle: "UPTIME HISTORY (LOCAL)",
    readmeTitle: "README / HELP",
    readmeBtn: "Help & Docs",
    readmeSubtitle: "Multi-Function Control Hub.",
    readmeFeaturesTitle: "Key Features",
    readmeFeaturePing: "<strong>Ping Monitor:</strong> Auto/manual server status check.",
    readmeFeatureWebhook: "<strong>Webhooks:</strong> Send alerts to Discord/Telegram if down.",
    readmeFeatureSort: "<strong>Manual Sort:</strong> Drag & Drop (desktop) or arrow buttons.",
    readmeFeatureUptime: "<strong>Uptime History:</strong> Last 20 ping results stored in local browser.",
    readmeFeatureFields: "<strong>Custom Fields:</strong> Up to 5 extra fields per item.",
    readmeGuideTitle: "Quick Guide",
    readmeGuideDemo: "Use <strong>Load Demo Data</strong> in Settings to try out features.",
    readmeGuideSort: "Set <strong>Sort Mode</strong> to \"Manual\" to enable drag/arrow features.",
    readmeGuideWebhook: "Change <strong>Webhook URL</strong> in Settings to receive server down alerts.",
    lockdownOn: "Lockdown activated. All ping functions disabled.",
    lockdownOff: "Lockdown deactivated. Ping functions restored.",
    lockdownActive: "LOCKDOWN ACTIVE — All ping activity is disabled",
    lockdownBtnOn: "UNLOCK",
    lockdownBtnOff: "LOCKDOWN",
    pingDisabledLockdown: "Ping disabled during lockdown",
    turnstileTitle: "CLOUDFLARE TURNSTILE",
    turnstileDesc: "Anti-bot CAPTCHA for login. Leave Site Key empty to disable.",
    turnstileSiteKeyLabel: "Site Key (Public)",
    turnstileSecretKeyLabel: "Secret Key (Private)",
    turnstileSecretPlaceholder: "Enter secret key",
    turnstileSecretSetPlaceholder: "••••••••• (already set)",
    saveTurnstileBtn: "SAVE TURNSTILE",
    backupTitle: "AUTO-BACKUP TO R2",
    backupDesc: "Automatic backup to Cloudflare R2 via Cron Trigger.",
    backupEnabledLabel: "Enable",
    backupRetentionLabel: "Retention (days)",
    saveBackupBtn: "SAVE BACKUP SETTINGS",
    saveWebhookBtn: "SAVE WEBHOOK",
    pinnedTitle: "PINNED",
    labelPublic: "PUBLIC",
    labelPrivate: "PRIVATE",
    labelOnline: "ONLINE",
    labelRestricted: "RESTRICTED",
    labelPurge: "PURGE",
    tooltipCopy: "Copy",
    tooltipDetail: "Details",
    msgNameRequired: "Name is required!",
    msgMaxCustomFields: "Max 5 custom fields!",
    msgNoData: "No data!",
    msgDemoLoaded: "Demo loaded!",
    msgError: "Error",
    msgFailedPin: "Failed to change pin status!",
    msgFailedAnnouncement: "Failed to save announcement!",
    msgFailedTitle: "Failed to update website title!",
    msgFailedWebhook: "Failed to save webhook!",
    msgFailedDisplayMode: "Failed to save display mode!",
    msgFailedSortMode: "Failed to save sort mode!",
    msgFailedTurnstile: "Failed to save Turnstile settings",
    msgFailedBackup: "Failed to save backup settings",
    msgCopiedPrefix: "Copied: ",
    msgUrlCopiedPrefix: "URL Copied: ",
    devTitle: "DEVELOPER OPTIONS",
    devRuntimeLabel: "RUNTIME PROFILE",
    devRuntimeWorker: "Worker (Lightweight)",
    devRuntimeManaged: "Managed (D1 + R2)",
    devRuntimeVps: "VPS (SQLite)",
    devRuntimeLocal: "Local (Offline)",
    devModeLabel: "CAPABILITY MODE",
    devModePing: "Ping Only",
    devModeArchive: "Archive Only",
    devModeBoth: "Ping + Archive",
    devModeCms: "CMS Only",
    devModeApi: "API Only",
    devModeFull: "Full Features",
    devCapabilityPing: "Ping Monitoring",
    devCapabilityArchive: "Archive Items",
    devCapabilityCms: "Notes & Pages",
    devCapabilityApi: "Public API",
    devActiveCaps: "Active Capabilities",
    devSaveBtn: "SAVE CONFIG",
    devSaved: "Developer config saved! Reloading...",
    devSaveFailed: "Failed to save dev config",
    devPresetHint: "Click a preset to auto-configure capability flags.",
    devSprintNote: "Sprint 4: storage auto-detected (D1 > KV > File). Image upload needs R2 (MEDIA_BUCKET / BACKUP_BUCKET) or Node.js disk. Runtime profile is a label.",
    devRuntimeNote: "Auto-detected: D1 > KV > File.",
    devPingCacheLabel: "Ping cache",
    devPingCacheHint: "auto: memory on Worker + KV (saves KV writes), shared storage elsewhere. memory: always per-isolate. shared: always in storage (uses KV writes on Worker Free).",
    bulkSelect: "selected",
    bulkPin: "Pin",
    bulkUnpin: "Unpin",
    bulkDelete: "Delete",
    bulkConfirmDelete: "Delete selected items?",
    bulkSuccess: "Bulk action applied!",
    bulkFailed: "Failed to apply bulk action.",
    qrTitle: "QR CODE",
    qrBtn: "Generate QR Code",
    qrNoUrl: "No valid URL to encode.",
    bulkSelectAll: "Select All",
    bulkClear: "Clear",
    navDashboard: "Dashboard", navNotes: "Notes", navPages: "Pages", navTools: "Tools",
    imageLbl: "Image URL (Optional)", imageUploadBtn: "Upload image", imageUploading: "Uploading...", imageUploaded: "Image uploaded!",
    imageTooBig: "Image must be 2 MB or smaller.", imageFailed: "Upload failed", imageHint: "https:// or uploaded file. Shown as thumbnail in grid.",
    noHistory: "No ping history in this browser yet.", yes: "YES", qrTooLong: "URL is too long for a QR code (max 1000 bytes).",
    copyFailed: "Copy failed. Select the text and copy manually.", clearFailed: "Failed to clear data!",
    defaultPassWarn: "Security: you are still using the default password. Change it in Settings.",
    cmsOnlyMsg: "CMS mode is on. Use the menu above for Notes and Pages.", apiOnlyMsg: "API mode enabled. Public endpoint: /api/v1/public/data",
    invalidUrl: "Blocked: the target URL must start with http:// or https://",
    pageDesc: "Dashboard and personal archive."
  } : {
    pingAll: "PING", pingConfig: "⚙️ PENGATURAN PING", backup: "BACKUP & RESTORE", settings: "PENGATURAN", addNew: "ADD NEW", login: "LOGIN", logout: "LOGOUT", status: "STATUS", link: "LINK", copyAll: "SALIN SEMUA", clearAll: "HAPUS DATA", click: "KLIK", close: "TUTUP", cancel: "BATAL", save: "SIMPAN",
    announcement: "PENGUMUMAN", edit: "Edit", searchPlaceholder: "Cari item, nama, host...", filter: "Filter", display: "Tampilan", sort: "Urutkan",
    allCategories: "Semua Kategori", autoFilterVisPub: "[VISIBILITAS: Public]", autoFilterVisPriv: "[VISIBILITAS: Private]", autoFilterOn: "[STATUS: Online]", autoFilterOff: "[STATUS: Down / Offline]", autoFilterRest: "[STATUS: Restricted]", autoFilterMaint: "[STATUS: Maintenance / Purge]",
    sortRecently: "Recently Upload / Edit (Terbaru)", sortOldest: "Oldest (Terlama)", sortAZ: "Urutkan A - Z", sortZA: "Urutkan Z - A", sortManual: "Manual Order (Aktifkan Reorder)",
    dispList: "List Mode (Default)", dispCompact: "Compact Grid", dispComfort: "Comfortable Grid", dispPanorama: "Panorama Comfortable Grid",
    siteTitleLabel: "JUDUL WEBSITE", siteTitlePlaceholder: "Masukkan judul website kustom...", updateTitleBtn: "UPDATE JUDUL",
    changePassTitle: "GANTI PASSWORD ADMIN", oldPass: "Password Lama", oldPassPlaceholder: "Password saat ini", newPass: "Password Baru", confirmPass: "Konfirmasi Password Baru", newPassPlaceholder: "Minimal 4 karakter", updatePass: "UPDATE PASSWORD",
    backupRestore: "BACKUP & RESTORE", dataMgmt: "Manajemen Data Sistem:", pasteJson: "Paste data JSON di sini atau upload file...",
    restore: "Pulihkan",
    addTitle: "ADD NEW", nameLabel: "Nama (Wajib diisi)", catLabel: "Kategori", groupLabel: "Group / Independen", descLabel: "Deskripsi", hostLabel: "URL yang bisa di-ping (Opsional)",
    enablePingLbl: "Aktifkan Ping untuk URL Ini", displayTableLbl: "Jadikan Display di Tabel Utama", pinTopLbl: "Pin ke Featured Atas", customLinkLbl: "Target URL Custom (Opsional)",
    clickCopyToggleLbl: "Ubah Aksi Tombol 'KLIK' Menjadi Salin URL Target",
    customFieldsLbl: "Kolom Tambahan Custom (Maksimal 5 Kolom):", addColBtn: "+ Tambah Kolom Baru (Max 5)", visPubLbl: "Visibilitas Publik", visPubOpt: "Tampilkan di Publik", visPubPriv: "Sembunyikan (Privasi)",
    statusNodeLbl: "Status Sistem / Node", statusNorm: "Online (Normal)", statusRest: "Restricted (Terenkripsi)", statusMaint: "Purge / Maintenance (Pemeliharaan)",
    detailTitle: "DETAIL", editDataBtn: "EDIT DATA", createdLbl: "Dibuat",
    copySuccess: "Berhasil disalin!", allHubList: "SEMUA DAFTAR HUB",
    seeMore: "Selengkapnya ▼", seeLess: "Tutup ▲",
    rule34Title: "Rule 34", autoPingTitle: "Auto Ping Interval",
    itemNameLbl: "NAMA ITEM", customUrlLbl: "CUSTOM URL",
    announcementFormat: "Format: [Label Teks Link](https://...) atau tulis berderet ke bawah",
    rule34Desc: "Maksimal 34 URL ping aktif",
    autoPingDesc: "Ping otomatis berkala (Default: OFF)",
    intervalTimeRange: "Rentang Waktu Interval (Detik)",
    selectUrlPing: "Pilih URL untuk Ping:",
    clearMethodLabel: "Pilih metode pembersihan data:",
    clearAllSystem: "Hapus Seluruh Sistem (Semua)",
    clearByGroup: "Hapus Per Group...",
    clearByCategory: "Hapus Per Kategori...",
    clearIndependen: "Hapus Semua Item Independen",
    backupFull: "Backup Seluruh Sistem (Full)",
    backupGroup: "Backup Per Group...",
    backupCategory: "Backup Per Kategori...",
    backupIndependen: "Backup Item Independen",
    restoreUploadOrPaste: "Restore (Upload File atau Paste Code):",
    demoSecTitle: "DEMO PREVIEW",
    demoDescEmpty: "Muat 50 item contoh untuk pengujian seluruh fitur.",
    demoDescFilled: "Kosongkan data terlebih dahulu untuk memuat demo.",
    demoBtn: "Load Demo Data (50 items + CMS)",
    webhookSecTitle: "SYSTEM WEBHOOK ALERTS",
    webhookDesc: "Kirim peringatan ke Discord/Telegram jika server mati.",
    webhookPlaceholder: "https://discord.com/api/webhooks/...",
    uptimeTitle: "UPTIME HISTORY (LOCAL)",
    readmeTitle: "README / HELP",
    readmeBtn: "Bantuan & Docs",
    readmeSubtitle: "Multi-Fungsi Control Hub.",
    readmeFeaturesTitle: "Fitur Utama",
    readmeFeaturePing: "<strong>Ping Monitor:</strong> Cek status server otomatis/manual.",
    readmeFeatureWebhook: "<strong>Webhooks:</strong> Kirim notifikasi ke Discord/Telegram jika down.",
    readmeFeatureSort: "<strong>Manual Sort:</strong> Drag & Drop (desktop) atau tombol panah.",
    readmeFeatureUptime: "<strong>Uptime History:</strong> 20 riwayat ping terakhir disimpan di browser lokal.",
    readmeFeatureFields: "<strong>Custom Fields:</strong> Hingga 5 field tambahan per item.",
    readmeGuideTitle: "Panduan Cepat",
    readmeGuideDemo: "Gunakan <strong>Load Demo Data</strong> di Pengaturan untuk mencoba fitur.",
    readmeGuideSort: "Atur <strong>Sort Mode</strong> ke \"Manual\" untuk mengaktifkan fitur drag/tombol panah.",
    readmeGuideWebhook: "Ubah <strong>Webhook URL</strong> di Pengaturan untuk menerima peringatan server down.",
    lockdownOn: "Lockdown diaktifkan. Semua fungsi ping dinonaktifkan.",
    lockdownOff: "Lockdown dinonaktifkan. Fungsi ping kembali seperti semula.",
    lockdownActive: "LOCKDOWN AKTIF — Semua aktivitas ping dinonaktifkan",
    lockdownBtnOn: "UNLOCK",
    lockdownBtnOff: "LOCKDOWN",
    pingDisabledLockdown: "Ping dinonaktifkan selama lockdown",
    turnstileTitle: "CLOUDFLARE TURNSTILE",
    turnstileDesc: "Anti-bot CAPTCHA untuk login. Kosongkan Site Key untuk menonaktifkan.",
    turnstileSiteKeyLabel: "Site Key (Publik)",
    turnstileSecretKeyLabel: "Secret Key (Privat)",
    turnstileSecretPlaceholder: "Masukkan secret key",
    turnstileSecretSetPlaceholder: "••••••••• (sudah di-set)",
    saveTurnstileBtn: "SIMPAN TURNSTILE",
    backupTitle: "AUTO-BACKUP KE R2",
    backupDesc: "Backup otomatis ke Cloudflare R2 via Cron Trigger.",
    backupEnabledLabel: "Aktifkan",
    backupRetentionLabel: "Retensi (hari)",
    saveBackupBtn: "SIMPAN PENGATURAN BACKUP",
    saveWebhookBtn: "SIMPAN WEBHOOK",
    pinnedTitle: "DISEMATKAN",
    labelPublic: "PUBLIK",
    labelPrivate: "PRIVAT",
    labelOnline: "ONLINE",
    labelRestricted: "TERBATAS",
    labelPurge: "PEMELIHARAAN",
    tooltipCopy: "Salin",
    tooltipDetail: "Rincian",
    msgNameRequired: "Nama wajib diisi!",
    msgMaxCustomFields: "Maksimal 5 kolom custom!",
    msgNoData: "Tidak ada data!",
    msgDemoLoaded: "Demo dimuat!",
    msgError: "Kesalahan",
    msgFailedPin: "Gagal mengubah pin status!",
    msgFailedAnnouncement: "Gagal menyimpan pengumuman!",
    msgFailedTitle: "Gagal memperbarui judul website!",
    msgFailedWebhook: "Gagal menyimpan webhook!",
    msgFailedDisplayMode: "Gagal menyimpan mode tampilan!",
    msgFailedSortMode: "Gagal menyimpan urutan!",
    msgFailedTurnstile: "Gagal menyimpan pengaturan Turnstile",
    msgFailedBackup: "Gagal menyimpan pengaturan backup",
    msgCopiedPrefix: "Disalin: ",
    msgUrlCopiedPrefix: "URL Disalin: ",
    devTitle: "DEVELOPER OPTIONS",
    devRuntimeLabel: "PROFIL RUNTIME",
    devRuntimeWorker: "Worker (Ringan)",
    devRuntimeManaged: "Managed (D1 + R2)",
    devRuntimeVps: "VPS (SQLite)",
    devRuntimeLocal: "Local (Offline)",
    devModeLabel: "MODE CAPABILITY",
    devModePing: "Ping Saja",
    devModeArchive: "Arsip Saja",
    devModeBoth: "Ping + Arsip",
    devModeCms: "CMS Saja",
    devModeApi: "API Saja",
    devModeFull: "Fitur Lengkap",
    devCapabilityPing: "Ping Monitoring",
    devCapabilityArchive: "Arsip Item",
    devCapabilityCms: "Catatan & Halaman",
    devCapabilityApi: "API Publik",
    devActiveCaps: "Capability Aktif",
    devSaveBtn: "SIMPAN KONFIG",
    devSaved: "Konfigurasi developer disimpan! Memuat ulang...",
    devSaveFailed: "Gagal menyimpan konfigurasi developer",
    devPresetHint: "Klik preset untuk mengisi flag capability otomatis.",
    devSprintNote: "Sprint 4: storage auto-detect (D1 > KV > File). Upload gambar butuh R2 (MEDIA_BUCKET / BACKUP_BUCKET) atau disk Node.js. Runtime profile hanya label.",
    devRuntimeNote: "Auto-detect: D1 > KV > File.",
    devPingCacheLabel: "Cache ping",
    devPingCacheHint: "auto: di memori untuk Worker + KV (hemat tulis KV), di penyimpanan bersama untuk lainnya. memory: selalu di memori. shared: selalu di penyimpanan (memakai tulis KV di Worker Free).",
    bulkSelect: "dipilih",
    bulkPin: "Pin",
    bulkUnpin: "Unpin",
    bulkDelete: "Hapus",
    bulkConfirmDelete: "Hapus item yang dipilih?",
    bulkSuccess: "Aksi massal diterapkan!",
    bulkFailed: "Gagal menerapkan aksi massal.",
    qrTitle: "QR CODE",
    qrBtn: "Generate QR Code",
    qrNoUrl: "Tidak ada URL valid untuk dijadikan QR.",
    bulkSelectAll: "Pilih Semua",
    bulkClear: "Batal",
    navDashboard: "Dashboard", navNotes: "Catatan", navPages: "Halaman", navTools: "Alat",
    imageLbl: "URL Gambar (Opsional)", imageUploadBtn: "Unggah gambar", imageUploading: "Mengunggah...", imageUploaded: "Gambar diunggah!",
    imageTooBig: "Ukuran gambar maksimal 2 MB.", imageFailed: "Upload gagal", imageHint: "https:// atau file hasil upload. Tampil sebagai thumbnail di grid.",
    noHistory: "Belum ada riwayat ping di browser ini.", yes: "YA", qrTooLong: "URL terlalu panjang untuk QR (maks 1000 byte).",
    copyFailed: "Gagal menyalin. Blok teks lalu salin manual.", clearFailed: "Gagal menghapus data!",
    defaultPassWarn: "Keamanan: kamu masih memakai password default. Segera ganti di Pengaturan.",
    cmsOnlyMsg: "Mode CMS aktif. Gunakan menu di atas untuk Catatan dan Halaman.", apiOnlyMsg: "Mode API aktif. Endpoint publik: /api/v1/public/data",
    invalidUrl: "Diblokir: URL target harus diawali http:// atau https://",
    pageDesc: "Dashboard dan arsip pribadi."
  };

  const safeJSON = (obj) => JSON.stringify(obj).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
  const serversJson = safeJSON(servers);
  const pingSelectionJson = safeJSON(pingSelection);
  const publicColsJson = safeJSON(publicCols);
  const manualCategoriesJson = safeJSON(manualCategories);
  const allGroupsJson = safeJSON(allGroups);
  const tJson = safeJSON(t);
  const capsJson = safeJSON(caps);
  const runtimeProfileJson = safeJSON(runtimeProfile);

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(siteTitle)}</title>
  <meta name="description" content="${esc(t.pageDesc)}">
  <meta name="robots" content="${isLoggedIn ? 'noindex' : 'index, follow'}">
  ${ctx.origin ? `<link rel="canonical" href="${esc(ctx.origin)}/">` : ''}
  <meta property="og:title" content="${esc(siteTitle)}"><meta property="og:description" content="${esc(t.pageDesc)}"><meta property="og:type" content="website">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800;900&family=Rajdhani:wght@500;600;700&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  ${!isLoggedIn && turnstileSiteKey ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer><\/script>` : ''}
  <style>
    :root{--bg-dark:#030712;--card-bg:#070e1b;--border-cyan:#00f0ff;--neon-pink:#ff007f;--neon-green:#00ff87;--neon-warning:#f59e0b;--text-blue:#38bdf8}
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
    body{background-color:var(--bg-dark);color:#e2e8f0;font-family:'Rajdhani',sans-serif;margin:0;padding:clamp(8px,2vw,16px);display:flex;flex-direction:column;align-items:center;min-height:100vh;overflow-x:hidden}
    .main-wrap{width:100%;max-width:950px;position:relative;z-index:10}
    .header-bar{display:flex;flex-direction:column;gap:10px;margin-bottom:12px;padding:12px 14px;background:linear-gradient(135deg,rgba(7,14,27,.95),rgba(3,7,18,.98));border:1.5px solid rgba(0,240,255,.35);border-radius:12px;box-shadow:0 0 15px rgba(0,240,255,.15)}
    @media(min-width:768px){.header-bar{flex-direction:row;align-items:center;justify-content:space-between}}
    .title-glow{display:flex;align-items:center;gap:8px;flex-shrink:0;overflow:hidden}
    .title-glow h1{font-family:'Orbitron',sans-serif;font-size:clamp(.75rem,1.6vw,1.05rem);font-weight:800;letter-spacing:.5px;margin:0;background:linear-gradient(100deg,#248b9b 0%,#248b9b 40%,#00d9ed 46%,#ffffff 50%,#00d9ed 54%,#248b9b 60%,#248b9b 100%);background-size:250% 100%;background-repeat:no-repeat;background-position:100% center;color:transparent;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:shine 4s linear infinite;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    @keyframes shine{0%{background-position:100% center}100%{background-position:0% center}}
    .dot-led{width:7px;height:7px;background-color:var(--neon-green);border-radius:50%;box-shadow:0 0 8px var(--neon-green);animation:pulseDot 2s infinite ease-in-out;flex-shrink:0}
    @keyframes pulseDot{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.3);opacity:.5}}
    .header-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-start;width:100%}
    @media(min-width:768px){.header-controls{justify-content:flex-end;width:auto}}
    .btn-cyber{background:rgba(0,240,255,.05);border:1px solid var(--border-cyan);color:var(--border-cyan);border-radius:8px;padding:8px 12px;font-family:'Orbitron',sans-serif;font-size:.68rem;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;transition:all .25s cubic-bezier(.4,0,.2,1);box-shadow:0 0 8px rgba(0,240,255,.15);animation:subtleBtnGlow 4s infinite ease-in-out;white-space:nowrap;position:relative;z-index:20;pointer-events:auto!important}
    @keyframes subtleBtnGlow{0%,100%{box-shadow:0 0 4px rgba(0,240,255,.08);border-color:rgba(0,240,255,.3)}50%{box-shadow:0 0 10px rgba(0,240,255,.4);border-color:rgba(0,240,255,.7)}}
    @media (hover:hover){.btn-cyber:hover{background:var(--border-cyan);color:#030712;box-shadow:0 0 20px var(--border-cyan);transform:translateY(-1px)}} .btn-cyber:active{background:var(--border-cyan);color:#030712;box-shadow:0 0 20px var(--border-cyan);transform:translateY(-1px)}
    .btn-cyber:disabled{opacity:.4;cursor:not-allowed;pointer-events:none}
    
    /* BUG FIX: Modal Active State */
    .btn-cyber.active-option { background:var(--border-cyan)!important; color:#030712!important; animation:none!important; box-shadow:0 0 15px rgba(0,240,255,.55)!important; transform:none!important; }

    .lang-btn{background:rgba(0,240,255,.1);border:1px solid var(--border-cyan);color:var(--border-cyan);border-radius:6px;padding:6px 10px;font-size:.68rem;font-weight:bold;cursor:pointer;font-family:'Orbitron',sans-serif;animation:subtleBtnGlow 4s infinite ease-in-out}
    .announcement-box{background:linear-gradient(135deg,rgba(192,132,252,.1),rgba(7,14,27,.98));border:1.5px solid rgba(192,132,252,.7);border-radius:12px;padding:12px 14px;margin-bottom:12px;position:relative;overflow:hidden;box-shadow:0 0 18px rgba(192,132,252,.25)}
    .announcement-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
    @keyframes textShiftMotion{0%,100%{transform:translateX(0);opacity:.9}50%{transform:translateX(4px);opacity:1}}
    .announcement-title{font-family:'Orbitron',sans-serif;font-size:.72rem;font-weight:800;color:#d8b4fe;display:flex;align-items:center;gap:6px;letter-spacing:.5px;animation:textShiftMotion 3s infinite ease-in-out}
    @keyframes bellRingGentle{0%,100%{transform:rotate(0deg) scale(1)}20%{transform:rotate(14deg) scale(1.1)}40%{transform:rotate(-12deg) scale(1)}60%{transform:rotate(8deg) scale(1.1)}80%{transform:rotate(-6deg) scale(1)}}
    .announcement-icon-anim{display:inline-block;animation:bellRingGentle 2.5s infinite ease-in-out;transform-origin:top center}
    .announcement-text-wrap{position:relative}
    .announcement-content{font-size:.82rem;color:#f1f5f9;line-height:1.5;word-break:break-word;white-space:pre-line;max-height:22.5em;overflow:hidden;transition:max-height .3s cubic-bezier(.4,0,.2,1)}
    .announcement-content.expanded{max-height:none}
    .announcement-gradient{position:absolute;bottom:0;left:0;width:100%;height:25px;background:linear-gradient(transparent,#070e1b);display:none;pointer-events:none}
    .announcement-see-more-btn{background:none;border:none;color:#d8b4fe;font-size:.68rem;font-weight:bold;cursor:pointer;padding:4px 0 0 0;display:none;font-family:'Orbitron',sans-serif}
    .announcement-content a{color:var(--border-cyan);text-decoration:underline;font-weight:700;word-break:break-all}
    .search-toolbar{display:flex;gap:6px;margin-bottom:10px;width:100%;align-items:center;flex-wrap:nowrap}
    .search-input-wrap{position:relative;flex:1;display:flex;align-items:center;min-width:0}
    .search-input-wrap input{width:100%;background:#070e1b;border:1.5px solid rgba(0,240,255,.35);border-radius:10px;padding:10px 10px 10px 34px;color:#fff;font-size:.85rem;outline:none;transition:all .2s cubic-bezier(.4,0,.2,1);font-family:'Rajdhani',sans-serif}
    .search-input-wrap input:focus{border-color:var(--border-cyan);box-shadow:0 0 12px rgba(0,240,255,.25)}
    .search-icon-abs{position:absolute;left:10px;color:var(--border-cyan);pointer-events:none;font-size:.85rem}
    .action-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:6px;flex-wrap:wrap}
    .hub-container{width:100%;display:flex;flex-direction:column;gap:14px}
    .featured-section{background:linear-gradient(135deg,rgba(245,158,11,.08),rgba(7,14,27,.95));border:1.5px solid rgba(245,158,11,.6);border-radius:12px;padding:12px;box-shadow:0 0 25px rgba(245,158,11,.2);position:relative;overflow:hidden}
    @keyframes titleSlideAnim{0%,100%{transform:translateX(0)}50%{transform:translateX(5px)}}
    .featured-title{font-family:'Orbitron',sans-serif;font-size:.78rem;color:var(--neon-warning);margin-bottom:8px;display:flex;align-items:center;gap:6px;letter-spacing:1px;animation:titleSlideAnim 2.5s infinite ease-in-out}
    .all-hub-title{font-family:'Orbitron',sans-serif;font-size:.75rem;color:var(--border-cyan);margin-top:2px;display:flex;align-items:center;gap:6px;animation:titleSlideAnim 3s infinite ease-in-out}
    @keyframes filterBadgeShift{0%,100%{transform:translateX(0);opacity:.95}50%{transform:translateX(3px);opacity:1}}
    .active-filter-badge-anim{font-size:.7rem;color:var(--border-cyan);margin-bottom:10px;font-family:'Orbitron',sans-serif;display:flex;align-items:center;gap:5px;flex-wrap:wrap;animation:filterBadgeShift 3s infinite ease-in-out}
    .table-card{background:var(--card-bg);border:1.5px solid rgba(0,240,255,.25);border-radius:12px;overflow-x:auto;box-shadow:0 10px 30px rgba(0,0,0,.8)}
    table{width:100%;border-collapse:collapse;font-size:clamp(.72rem,1.2vw,.84rem);table-layout:fixed}
    th{background:rgba(0,240,255,.04);color:var(--border-cyan);font-family:'Orbitron',sans-serif;padding:10px 4px;font-weight:700;letter-spacing:.3px;border-bottom:1.5px solid rgba(0,240,255,.3);text-align:center;white-space:nowrap}
    @keyframes slowSoftPulse{0%,100%{background-color:rgba(3,7,18,.4)}50%{background-color:rgba(5,22,45,.65)}}
    tr{animation:slowSoftPulse 6s infinite ease-in-out}
    td{padding:9px 4px;border-bottom:1px solid rgba(0,240,255,.1);text-align:center;vertical-align:middle}
    tr:nth-child(even){background-color:rgba(0,240,255,.02)}
    
    /* BUG FIX: Grid Reorder Drag-over */
    tr[draggable="true"], .grid-card-item[draggable="true"] { cursor: grab; }
    tr[draggable="true"]:active, .grid-card-item[draggable="true"]:active { cursor: grabbing; }
    tr.drag-over { border-top: 2px dashed var(--border-cyan); background: rgba(0, 240, 255, 0.1); }
    .grid-card-item.drag-over { border: 2px dashed var(--border-cyan)!important; background: rgba(0,240,255,0.15)!important; }

    .reorder-btns{display:flex;flex-direction:column;align-items:center;gap:2px}
    .btn-arr{background:rgba(0,240,255,.05);border:1px solid rgba(0,240,255,.2);border-radius:4px;color:var(--border-cyan);cursor:pointer;font-size:.62rem;padding:3px 6px}
    @media (hover:hover){.btn-arr:hover{background:var(--border-cyan);color:#030712}}
    .td-host-wrap{display:flex;align-items:center;justify-content:flex-start;gap:4px;width:100%;overflow:hidden;position:relative}
    .host-badge-btn{background:rgba(3,7,18,.85);border:1.5px solid var(--border-cyan);border-radius:8px;padding:7px 10px;display:inline-flex;align-items:center;cursor:pointer;max-width:calc(100% - 24px);overflow:hidden;position:relative;box-shadow:0 0 10px rgba(0,240,255,.15);pointer-events:auto!important}
    .host-badge-btn.pulse-blur{border-color:var(--neon-pink)!important;background:rgba(255,0,127,.08)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:pulseAuraBlur 2s infinite ease-in-out}
    @keyframes pulseAuraBlur{0%,100%{box-shadow:0 0 6px rgba(255,0,127,.4)}50%{box-shadow:0 0 18px rgba(255,0,127,.8)}}
    .host-badge-btn.pulse-maint{border-color:var(--neon-warning)!important;background:rgba(245,158,11,.08)!important;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:pulseAuraMaint 2s infinite ease-in-out}
    @keyframes pulseAuraMaint{0%,100%{box-shadow:0 0 6px rgba(245,158,11,.4)}50%{box-shadow:0 0 18px rgba(245,158,11,.8)}}
    .td-host-text{font-family:'JetBrains Mono',monospace;font-size:clamp(.7rem,1.1vw,.82rem);font-weight:700;background:linear-gradient(100deg,#248b9b 0%,#248b9b 40%,#00d9ed 46%,#ffffff 50%,#00d9ed 54%,#248b9b 60%,#248b9b 100%);background-size:250% 100%;background-repeat:no-repeat;background-position:100% center;color:transparent;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:nameShine 3.5s linear infinite;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%;text-shadow:none}
    @keyframes nameShine{0%{background-position:100% center}100%{background-position:0% center}}
    .frost-glass-overlay{position:absolute;top:0;left:0;width:100%;height:100%;background:rgba(3,7,18,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border:1px solid rgba(255,0,127,.5);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:'Orbitron',sans-serif;font-size:.62rem;font-weight:700;color:var(--neon-pink);z-index:5;user-select:none;letter-spacing:.5px}
    .btn-icon-svg{background:rgba(0,240,255,.08);border:1px solid rgba(0,240,255,.25);border-radius:6px;color:var(--border-cyan);cursor:pointer;padding:6px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s cubic-bezier(.4,0,.2,1);pointer-events:auto!important}
    @media (hover:hover){.btn-icon-svg:hover{background:rgba(0,240,255,.25);color:#fff;box-shadow:0 0 12px var(--border-cyan)}} .btn-icon-svg:active{background:rgba(0,240,255,.25);color:#fff;box-shadow:0 0 12px var(--border-cyan)}
    @keyframes pulseBlinkOnline{0%,100%{opacity:1;transform:scale(1.1);box-shadow:0 0 10px var(--neon-green)}50%{opacity:.3;transform:scale(.7)}}
    @keyframes pulseWaveOffline{0%,100%{opacity:.9;transform:scale(1);box-shadow:0 0 6px var(--neon-warning)}50%{opacity:.2;transform:scale(1.3)}}
    .status-dot-notification{width:10px;height:10px;border-radius:50%;display:inline-block;background-color:#4b5563}
    .status-dot-notification.online{background-color:var(--neon-green);animation:pulseBlinkOnline .65s infinite cubic-bezier(.4,0,.6,1)}
    .status-dot-notification.offline{background-color:var(--neon-warning);animation:pulseWaveOffline 1.8s infinite ease-in-out}
    a.link-btn{color:var(--border-cyan);text-decoration:none;font-weight:700;font-size:.72rem;padding:6px 10px;background:rgba(0,240,255,.1);border:1px solid rgba(0,240,255,.35);border-radius:6px;display:inline-flex;align-items:center;gap:4px;transition:all .2s cubic-bezier(.4,0,.2,1);white-space:nowrap;pointer-events:auto!important}
    @media (hover:hover){a.link-btn:hover{background:var(--border-cyan);color:#030712;box-shadow:0 0 14px var(--border-cyan)}} a.link-btn:active{background:var(--border-cyan);color:#030712;box-shadow:0 0 14px var(--border-cyan)}
    .btn-trash-svg{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.35);border-radius:6px;color:var(--neon-warning);cursor:pointer;padding:6px;display:inline-flex;align-items:center;justify-content:center;transition:all .2s cubic-bezier(.4,0,.2,1);pointer-events:auto!important}
    @media (hover:hover){.btn-trash-svg:hover{background:rgba(245,158,11,.3);color:#fff;box-shadow:0 0 12px var(--neon-warning)}} .btn-trash-svg:active{background:rgba(245,158,11,.3);color:#fff;box-shadow:0 0 12px var(--neon-warning)}
    .grid-view-wrap{display:grid;gap:10px;width:100%}
    .grid-view-wrap.compact_grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}
    .grid-view-wrap.comfortable_grid{grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}
    .grid-view-wrap.panorama{grid-template-columns:1fr}
    .grid-card-item{background:linear-gradient(145deg,rgba(7,14,27,.95),rgba(3,7,18,.98));border:1px solid rgba(0,240,255,.22);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:7px;box-shadow:0 4px 15px rgba(0,0,0,.5);position:relative;overflow:hidden;transition:all .2s cubic-bezier(.4,0,.2,1)}
    @keyframes pinnedCardShiftBorder{0%,100%{border-color:rgba(245,158,11,.5)}50%{border-color:rgba(245,158,11,1)}}
    .grid-card-item.pinned-card-special{background:linear-gradient(145deg,rgba(18,10,32,.98),rgba(10,16,32,.98));border:1.5px solid rgba(245,158,11,.65);box-shadow:0 4px 16px rgba(0,0,0,.7);animation:pinnedCardShiftBorder 3.5s infinite ease-in-out}
    @media (hover:hover){.grid-card-item:hover{border-color:rgba(0,240,255,.6);box-shadow:0 0 14px rgba(0,240,255,.18)}}
    .grid-card-top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(0,240,255,.1);padding-bottom:5px}
    .grid-card-group{font-family:'Orbitron',sans-serif;font-size:.6rem;font-weight:700;color:var(--text-blue);letter-spacing:.3px}
    .grid-card-meta{display:flex;align-items:center;gap:6px}
    .grid-card-bottom{display:flex;justify-content:space-between;align-items:center;margin-top:2px}
    .modal-overlay{display:none!important;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(3,7,18,.88);backdrop-filter:blur(8px);z-index:99999!important}
    .modal-overlay.active{display:flex!important;align-items:center;justify-content:center;padding:12px}
    .modal-card{background:linear-gradient(145deg,#091328 0%,#030712 100%);border:1.5px solid var(--border-cyan);border-radius:14px;width:100%;max-width:440px;padding:18px;box-shadow:0 0 25px rgba(0,240,255,.2);max-height:90vh;overflow-y:auto;position:relative}
    .modal-header-flex{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(0,240,255,.25);padding-bottom:8px;margin-bottom:12px}
    .modal-card h3{font-family:'Orbitron',sans-serif;margin:0;color:var(--border-cyan);font-size:.9rem;display:flex;align-items:center;gap:6px}
    .btn-modal-close{background:rgba(255,0,127,.1);border:1px solid var(--neon-pink);color:var(--neon-pink);border-radius:6px;padding:6px 10px;font-family:'Orbitron',sans-serif;font-size:.65rem;font-weight:bold;cursor:pointer;transition:all .2s cubic-bezier(.4,0,.2,1);pointer-events:auto!important}
    @media (hover:hover){.btn-modal-close:hover{background:var(--neon-pink);color:#fff;box-shadow:0 0 10px var(--neon-pink)}} .btn-modal-close:active{background:var(--neon-pink);color:#fff;box-shadow:0 0 10px var(--neon-pink)}
    .det-label-shimmer{font-family:'Orbitron',sans-serif;font-size:.62rem;font-weight:700;letter-spacing:.5px;margin-bottom:2px;display:inline-block;background:linear-gradient(100deg,#248b9b 0%,#248b9b 40%,#00d9ed 46%,#ffffff 50%,#00d9ed 54%,#248b9b 60%,#248b9b 100%);background-size:250% 100%;background-repeat:no-repeat;background-position:100% center;color:transparent;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:seamlessShine 3s linear infinite}
    @keyframes seamlessShine{0%{background-position:100% center}100%{background-position:0% center}}
    @keyframes boxMovingBg{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    .det-box-shimmer{position:relative;background:linear-gradient(135deg,rgba(7,14,27,.95),rgba(0,240,255,.04),rgba(7,14,27,.98),rgba(56,189,248,.05));background-size:300% 300%;border:1px solid rgba(0,240,255,.3);border-radius:10px;padding:10px;margin-top:8px;will-change:background-position,border-color,box-shadow;animation:boxMovingBg 8s ease infinite,smoothGlowPulse 4s infinite ease-in-out}
    @keyframes smoothGlowPulse{0%,100%{border-color:rgba(0,240,255,.25);box-shadow:0 0 5px rgba(0,240,255,.08)}50%{border-color:rgba(0,240,255,.65);box-shadow:0 0 16px rgba(0,240,255,.28)}}
    .form-group{margin-bottom:10px}
    .form-group label{display:block;font-size:.72rem;color:#94a3b8;margin-bottom:4px}
    .form-group input,.form-group textarea,.form-group select{width:100%;background:#030712;border:1px solid rgba(0,240,255,.3);border-radius:8px;padding:9px 10px;color:#fff;font-size:.85rem;outline:none;transition:all .2s cubic-bezier(.4,0,.2,1);font-family:'Rajdhani',sans-serif;pointer-events:auto!important}
    .form-group input:focus,.form-group select:focus{border-color:var(--border-cyan);box-shadow:0 0 8px var(--border-cyan)}
    .input-pass-wrap{position:relative;display:flex;align-items:center}
    .input-pass-wrap input{padding-right:36px;width:100%}
    .btn-eye-toggle{position:absolute;right:6px;background:none;border:none;cursor:pointer;color:var(--border-cyan);font-size:.9rem;padding:6px;display:flex;align-items:center;justify-content:center;pointer-events:auto!important}
    .cyber-select-trigger{background:#030712;border:1.5px solid rgba(0,240,255,.3);border-radius:8px;padding:9px 10px;color:#fff;font-size:.85rem;cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:all .2s cubic-bezier(.4,0,.2,1);pointer-events:auto!important}
    @media (hover:hover){.cyber-select-trigger:hover{border-color:var(--border-cyan);box-shadow:0 0 8px var(--border-cyan)}}
    .cyber-dropdown-modal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(3,7,18,.85);backdrop-filter:blur(6px);z-index:120000;align-items:center;justify-content:center;padding:16px}
    .cyber-dropdown-modal.active{display:flex}
    .cyber-dropdown-card{background:linear-gradient(145deg,#091328 0%,#030712 100%);border:1.5px solid var(--border-cyan);border-radius:12px;width:100%;max-width:340px;padding:14px;box-shadow:0 0 25px rgba(0,240,255,.3);display:flex;flex-direction:column;gap:6px;max-height:80vh;overflow-y:auto}
    .cyber-dropdown-item{background:rgba(0,240,255,.05);border:1px solid rgba(0,240,255,.2);border-radius:8px;padding:10px 12px;color:#e2e8f0;font-family:'Orbitron',sans-serif;font-size:.75rem;font-weight:bold;cursor:pointer;text-align:center;transition:all .2s cubic-bezier(.4,0,.2,1);pointer-events:auto!important}
    @media (hover:hover){.cyber-dropdown-item:hover{background:rgba(0,240,255,.2);border-color:var(--border-cyan);color:var(--border-cyan);box-shadow:0 0 10px rgba(0,240,255,.3)}} .cyber-dropdown-item.selected{background:rgba(0,240,255,.2);border-color:var(--border-cyan);color:var(--border-cyan);box-shadow:0 0 10px rgba(0,240,255,.3)}
    .backup-json-textarea{width:100%!important;min-height:100px!important;max-height:160px!important;font-family:'JetBrains Mono',monospace!important;font-size:.72rem!important;color:#7dd3fc!important;background:#030712!important;border:1px solid rgba(0,240,255,.3)!important;border-radius:8px!important;padding:8px!important;resize:vertical!important;margin-top:4px!important}
    .modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
    .footer-container{margin-top:20px;padding:12px 0;border-top:1px solid rgba(0,240,255,.2);display:flex;flex-direction:column;align-items:center;gap:4px;color:#64748b;font-size:.72rem;text-align:center}
    .toast{position:fixed;bottom:20px;background:var(--neon-green);color:#030712;font-weight:bold;padding:8px 16px;border-radius:20px;font-size:.75rem;display:none;box-shadow:0 0 15px var(--neon-green);z-index:100000}
    #cyberModal{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(3,7,18,.9);backdrop-filter:blur(6px);z-index:110000;align-items:center;justify-content:center;padding:16px}
    #cyberModal.active{display:flex}
    .cyber-alert-box{background:linear-gradient(145deg,#091328 0%,#030712 100%);border:1.5px solid var(--border-cyan);border-radius:12px;width:100%;max-width:360px;padding:18px;box-shadow:0 0 25px rgba(0,240,255,.3);text-align:center}
    .cyber-alert-msg{font-size:.82rem;color:#e2e8f0;margin-bottom:16px;line-height:1.4;word-break:break-word}
    .cyber-alert-actions{display:flex;justify-content:center;gap:8px}
    .uptime-bar-wrap{display:flex;gap:2px;margin-top:4px}
    .uptime-bar{width:8px;height:16px;border-radius:2px;background:#334155;}
    .uptime-bar.up{background:var(--neon-green);}
    .uptime-bar.down{background:var(--neon-warning);}
    @keyframes lockdownPulse{0%,100%{box-shadow:0 0 6px rgba(255,0,127,.3);border-color:rgba(255,0,127,.6)}50%{box-shadow:0 0 20px rgba(255,0,127,.8);border-color:var(--neon-pink)}}
    .lockdown-banner{display:none;background:linear-gradient(135deg,rgba(255,0,127,.12),rgba(7,14,27,.98));border:1.5px solid var(--neon-pink);border-radius:10px;padding:10px 14px;margin-bottom:12px;color:var(--neon-pink);font-family:'Orbitron',sans-serif;font-size:.7rem;font-weight:800;text-align:center;letter-spacing:1px;animation:lockdownPulse 2s infinite ease-in-out}
    
    /* Sprint 1 & 2 CSS */
    body.mode-no-archive .hub-container,
    body.mode-no-archive .search-toolbar,
    body.mode-no-archive .active-filter-badge-anim { display: none !important; }
    body.mode-no-archive #minimalView { display: block !important; }
    #minimalView { display: none; }
    .dev-runtime-card, .dev-preset-card { background: rgba(0,240,255,.03); border: 1.5px solid rgba(0,240,255,.25); border-radius: 8px; padding: 10px 8px; text-align: center; cursor: pointer; transition: all .2s cubic-bezier(.4,0,.2,1); }
    @media (hover:hover){.dev-runtime-card:hover,.dev-preset-card:hover{ border-color: var(--border-cyan); background: rgba(0,240,255,.1); }}
    .dev-runtime-card.selected, .dev-preset-card.selected { border-color: var(--border-cyan); background: rgba(0,240,255,.15); box-shadow: 0 0 12px rgba(0,240,255,.3); }
    .dev-card-title { font-family: 'Orbitron', sans-serif; font-size: .66rem; color: #e2e8f0; font-weight: 700; line-height: 1.25; }
    .dev-cap-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid rgba(0,240,255,.1); }
    .dev-cap-row:last-child { border-bottom: 0; }
    .dev-cap-label { font-size: .75rem; color: #cbd5e1; }
    
    /* Sprint 2: Bulk Actions bar */
    #bulkActionBar { position:sticky; bottom:20px; background:rgba(7,14,27,0.95); border:1.5px solid var(--border-cyan); padding:10px 14px; border-radius:12px; z-index:50; align-items:center; justify-content:space-between; backdrop-filter:blur(8px); box-shadow:0 0 20px rgba(0,240,255,0.3); margin-top:10px; display:none; gap:6px; flex-wrap:wrap; }
    .bulk-checkbox, #bulkSelectAll { cursor:pointer; width:16px; height:16px; accent-color:var(--border-cyan); }

    a.btn-cyber{text-decoration:none;display:inline-flex;align-items:center}
    *{-webkit-tap-highlight-color:transparent}
    .nav-tab{font-family:'Orbitron',sans-serif;font-size:.68rem;font-weight:700;color:var(--border-cyan);background:rgba(0,240,255,.05);border:1px solid rgba(0,240,255,.35);border-radius:8px;padding:8px 14px;text-decoration:none;display:inline-flex;align-items:center;box-shadow:none;animation:none}
    .nav-tab.active{background:rgba(0,240,255,.18);border-color:var(--border-cyan);color:#fff}
    @media (hover:hover){.nav-tab:hover{background:rgba(0,240,255,.14)}}
    .site-nav{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .warn-banner{background:rgba(245,158,11,.12);border:1.5px solid var(--neon-warning);color:var(--neon-warning);border-radius:10px;padding:8px 12px;margin-bottom:10px;font-size:.78rem;font-weight:700}
    .card-thumb{position:relative;width:100%;height:84px;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;border:1px solid rgba(0,240,255,.18);flex-shrink:0}
    .grid-view-wrap.compact_grid .card-thumb{height:56px}
    .grid-view-wrap.panorama .card-thumb{height:150px}
    .card-thumb img.thumb-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
    .card-thumb .thumb-initial{font-family:'Orbitron',sans-serif;font-weight:900;font-size:1.5rem;color:rgba(255,255,255,.55);text-shadow:0 0 12px rgba(0,240,255,.5)}
    #detImageWrap{display:none;margin-bottom:10px}
    #detImage{width:100%;max-height:200px;object-fit:cover;border-radius:10px;border:1px solid rgba(0,240,255,.3);display:block}
    #detDescription img{max-width:100%;height:auto;border-radius:8px;margin:4px 0;display:block}
    #detDescription p{margin:.3em 0}#detDescription h2,#detDescription h3,#detDescription h4{color:var(--border-cyan);margin:.6em 0 .3em;font-size:.9rem}
    #detDescription code{font-family:'JetBrains Mono',monospace;background:rgba(0,240,255,.08);padding:1px 5px;border-radius:4px}
    #detDescription pre{overflow-x:auto;background:#020617;padding:8px;border-radius:8px}
    #detDescription a{color:var(--border-cyan)}#detDescription ul,#detDescription ol{padding-left:1.2em;margin:.3em 0}
    #qrImage svg{width:180px;height:180px;border-radius:8px;border:2px solid var(--border-cyan);box-shadow:0 0 15px rgba(0,240,255,.4);background:#fff}
    .img-row{display:flex;gap:6px;align-items:center;margin-top:5px;flex-wrap:wrap}
    /* Keep the dashboard color-scheme identical to BATCH43. */
    .cyber-alert-box,.cyber-dropdown-content{border-radius:14px;max-height:85dvh;overflow:auto}
    .cyber-alert-msg{line-height:1.5;white-space:pre-wrap}
    .cyber-dropdown-item{min-height:44px;overflow-wrap:anywhere}
    .modal-card input:focus-visible,.modal-card textarea:focus-visible,.cyber-dropdown-item:focus-visible{outline:2px solid var(--border-cyan);outline-offset:2px}
  </style>
</head>
<body class="${!caps.archive ? 'mode-no-archive' : ''}">
  <div class="toast" id="toast">${t.copySuccess}</div>
  ${isLoggedIn ? '<input type="file" id="imgFileInput" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">' : ''}

  <div id="cyberModal">
    <div class="cyber-alert-box">
      <div id="cyberAlertMsg" class="cyber-alert-msg">Pesan sistem...</div>
      <div class="cyber-alert-actions" id="cyberAlertActions">
        <button type="button" class="btn-cyber" id="cyberOkBtn">OK</button>
      </div>
    </div>
  </div>

  <div class="cyber-dropdown-modal" id="cyberDropdownModal">
    <div class="cyber-dropdown-card" id="cyberDropdownCard">
      <div style="font-family:'Orbitron',sans-serif; font-size:0.75rem; color:var(--border-cyan); border-bottom:1px solid rgba(0,240,255,0.2); padding-bottom:6px; margin-bottom:4px;" id="cyberDropdownTitle">PILIH OPSI</div>
      <div id="cyberDropdownOptions" style="display:flex; flex-direction:column; gap:5px;"></div>
      <div style="margin-top:6px;"><button type="button" class="btn-cyber" onclick="closeCyberDropdown()" style="width:100%; justify-content:center; border-color:#64748b; color:#94a3b8;">${t.cancel}</button></div>
    </div>
  </div>

  <div class="main-wrap">
    ${caps.cms ? `<nav class="site-nav" aria-label="Main">
      <a class="nav-tab active" href="/" aria-current="page">${t.navDashboard}</a>
      ${isLoggedIn ? `<a class="nav-tab" href="/notes">${t.navNotes}</a>` : ''}
      ${isLoggedIn ? `<a class="nav-tab" href="/tools">${t.navTools}</a>` : ''}
      <a class="nav-tab" href="/pages">${t.navPages}</a>
    </nav>` : ''}
    ${ctx.passIsDefault ? `<div class="warn-banner">⚠️ ${t.defaultPassWarn}</div>` : ''}
    <div class="header-bar">
      <div class="title-glow"><div class="dot-led"></div><h1 id="mainSiteTitle">${esc(siteTitle)}</h1></div>
      <div class="header-controls">
        <button type="button" class="lang-btn" onclick="toggleLang()">${lang.toUpperCase()}</button>
        ${isLoggedIn ? `
          <button type="button" class="btn-cyber" id="lockdownToggleBtn" onclick="toggleLockdown()" style="border-color:${lockdownMode ? 'var(--neon-pink)' : 'rgba(100,116,139,0.5)'}; color:${lockdownMode ? 'var(--neon-pink)' : '#64748b'}; animation:${lockdownMode ? 'lockdownPulse 2s infinite' : 'none'};">${lockdownMode ? '🔓 ' + t.lockdownBtnOn : '🔒 ' + t.lockdownBtnOff}</button>
          <button type="button" class="btn-cyber" onclick="openModal('backupModal')">${t.backup}</button>
          <button type="button" class="btn-cyber" onclick="openModal('settingsModal')">${t.settings}</button>
          <button type="button" class="btn-cyber" onclick="openModal('addModal')">${t.addNew}</button>
          <button type="button" class="btn-cyber" onclick="doLogout()" style="border-color: var(--neon-warning); color: var(--neon-warning);">${t.logout}</button>
        ` : `<button type="button" class="btn-cyber" onclick="openModal('authModal')">${t.login}</button>`}
      </div>
    </div>

    <div id="lockdownBanner" class="lockdown-banner" style="display:${lockdownMode ? 'block' : 'none'};">⚠️ ${t.lockdownActive}</div>

    <div class="announcement-box">
      <div class="announcement-header">
        <div class="announcement-title"><span class="announcement-icon-anim">🔔</span> ${t.announcement}</div>
        ${isLoggedIn ? `<button type="button" class="btn-cyber" onclick="openModal('editAnnouncementModal')" style="font-size:0.58rem; padding:4px 8px; animation:none; border-color:rgba(192,132,252,0.4); color:#d8b4fe; background:rgba(192,132,252,0.03);">✏️ ${t.edit}</button>` : ''}
      </div>
      <div class="announcement-text-wrap">
        <div class="announcement-content" id="announcementTextContainer">${parseMarkdownLinks(announcementNote)}</div>
        <div class="announcement-gradient" id="announcementGradient"></div>
      </div>
      <button type="button" id="announcementSeeMoreBtn" class="announcement-see-more-btn" onclick="toggleAnnouncementSeeMore()">${t.seeMore}</button>
    </div>

    <div class="search-toolbar">
      <div class="search-input-wrap">
        <span class="search-icon-abs">🔍</span>
        <input type="text" id="searchInput" placeholder="${t.searchPlaceholder}" oninput="handleSearchInput()">
      </div>
      <button type="button" class="btn-cyber" onclick="openModal('filterModal')" style="border-color:var(--border-cyan); color:var(--border-cyan); flex-shrink:0;">🏷️ ${t.filter}</button>
      <button type="button" class="btn-cyber" onclick="openModal('displayConfigModal')" style="border-color:var(--border-cyan); color:var(--border-cyan); flex-shrink:0;">🖥️ ${t.display}</button>
      <button type="button" class="btn-cyber" onclick="openModal('sortModal')" style="border-color:var(--border-cyan); color:var(--border-cyan); flex-shrink:0;">🔄 ${t.sort}</button>
    </div>

    <div class="action-toolbar">
      ${isLoggedIn ? `<button type="button" class="btn-cyber" onclick="openModal('clearAllModal')" style="border-color:var(--neon-warning); color:var(--neon-warning); font-size:0.65rem;">🗑️ ${t.clearAll}</button>` : '<div></div>'}
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn-cyber" onclick="copyAllDomains()" style="font-size:0.65rem;">📋 ${t.copyAll}</button>
        ${caps.ping ? `<button type="button" class="btn-cyber" onclick="triggerPingAll()" style="font-size:0.65rem;">⚡ ${t.pingAll}</button>` : ''}
        ${isLoggedIn && caps.ping ? `<button type="button" class="btn-cyber" onclick="openModal('pingConfigModal')" style="font-size:0.65rem; border-color:var(--text-blue); color:var(--text-blue);">⚙️ Ping</button>` : ''}
      </div>
    </div>

    <div class="active-filter-badge-anim" id="activeFilterBadge">
      <span>📁 <strong id="currentFilterText">${t.allCategories}</strong> | 🔄 <strong id="currentSortText">${currentSort.toUpperCase()}</strong></span>
    </div>

    <!-- Sprint 2: Bulk Action Bar -->
    <div id="bulkActionBar">
      <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn-cyber" style="padding:5px 8px; font-size:0.6rem;" onclick="bulkSelectAllVisible()">${t.bulkSelectAll}</button>
        <button type="button" class="btn-cyber" style="padding:5px 8px; font-size:0.6rem; border-color:#64748b; color:#94a3b8;" onclick="bulkClearSelection()">${t.bulkClear}</button>
        <span style="font-family:'Orbitron',sans-serif; font-size:0.75rem; color:var(--border-cyan);" id="bulkSelectedCount">0</span>
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn-cyber" style="padding:6px 10px; font-size:0.65rem;" onclick="executeBulkAction('pin')">📌 ${t.bulkPin}</button>
        <button type="button" class="btn-cyber" style="padding:6px 10px; font-size:0.65rem;" onclick="executeBulkAction('unpin')">📍 ${t.bulkUnpin}</button>
        <button type="button" class="btn-cyber" style="padding:6px 10px; font-size:0.65rem; border-color:var(--neon-warning); color:var(--neon-warning);" onclick="executeBulkAction('delete')">🗑️ ${t.bulkDelete}</button>
      </div>
    </div>

    <div class="hub-container" id="hubContainer"></div>

    <div id="minimalView"></div>

    ${guideFooter34(lang,true)}
  </div>

  <div class="modal-overlay" id="readmeModal">
    <div class="modal-card" style="border-color: rgba(0, 240, 255, 0.6);">
      <div class="modal-header-flex">
        <h3>📖 ${t.readmeTitle}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('readmeModal')">✕ ${t.close}</button>
      </div>
      <div style="font-size:0.8rem; color:#cbd5e1; line-height:1.6;">
        <p><strong>SYNAPSE GRID 34</strong> - ${t.readmeSubtitle}</p>
        <h4 style="color:var(--border-cyan); margin-bottom:4px;">${t.readmeFeaturesTitle}:</h4>
        <ul style="padding-left:20px; margin-top:0;">
          <li>${t.readmeFeaturePing}</li>
          <li>${t.readmeFeatureWebhook}</li>
          <li>${t.readmeFeatureSort}</li>
          <li>${t.readmeFeatureUptime}</li>
          <li>${t.readmeFeatureFields}</li>
        </ul>
        <h4 style="color:var(--border-cyan); margin-bottom:4px;">${t.readmeGuideTitle}:</h4>
        <ul style="padding-left:20px; margin-top:0;">
          <li>${t.readmeGuideDemo}</li>
          <li>${t.readmeGuideSort}</li>
          <li>${t.readmeGuideWebhook}</li>
        </ul>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-cyber" onclick="closeModal('readmeModal')" style="width:100%; justify-content:center;">OK</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="editAnnouncementModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>📢 ${t.announcement.toUpperCase()}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('editAnnouncementModal')">✕ ${t.close}</button>
      </div>
      <div class="form-group">
        <label>${t.announcementFormat}</label>
        <textarea id="announcementInput" style="width:100%; background:#030712; border:1px solid rgba(192,132,252,0.4); border-radius:8px; padding:10px; color:#fff; font-size:0.85rem; outline:none; min-height:110px; resize:vertical;">${esc(announcementNote)}</textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-cyber" onclick="closeModal('editAnnouncementModal')" style="border-color:#64748b; color:#94a3b8;">${t.cancel}</button>
        <button type="button" class="btn-cyber" onclick="saveAnnouncementNote()" style="border-color:#c084fc; color:#d8b4fe;">${t.save}</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="filterModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>🏷️ ${t.filter.toUpperCase()}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('filterModal')">✕ ${t.close}</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; max-height: 60vh; overflow-y: auto;">
        <button type="button" class="btn-cyber" data-cat="ALL" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center;">🌐 ${t.allCategories}</button>
        <div id="filterCategoryList" style="display:contents;">${manualCategories.map(cat => `<button type="button" class="btn-cyber" data-cat="${esc(cat)}" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center;">📁 ${esc(cat)}</button>`).join('')}</div>
        ${isLoggedIn ? `
          <div style="font-family:'Orbitron',sans-serif; font-size:0.65rem; color:var(--border-cyan); margin: 6px 0 2px 0; border-top:1px solid rgba(0,240,255,0.2); padding-top:6px;">⚡ AUTOMATIC STATUS</div>
          <button type="button" class="btn-cyber" data-cat="[VISIBILITAS: Public]" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center; border-color:var(--neon-green); color:var(--neon-green);">🌐 ${t.autoFilterVisPub}</button>
          <button type="button" class="btn-cyber" data-cat="[VISIBILITAS: Private]" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center; border-color:var(--neon-pink); color:var(--neon-pink);">🔒 ${t.autoFilterVisPriv}</button>
          <button type="button" class="btn-cyber" data-cat="[STATUS: Online]" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center; border-color:var(--border-cyan); color:var(--border-cyan);">🟢 ${t.autoFilterOn}</button>
          <button type="button" class="btn-cyber" data-cat="[STATUS: Down / Offline]" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center; border-color:var(--neon-warning); color:var(--neon-warning);">⚠️ ${t.autoFilterOff}</button>
          <button type="button" class="btn-cyber" data-cat="[STATUS: Restricted]" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center; border-color:var(--neon-pink); color:var(--neon-pink);">🔒 ${t.autoFilterRest}</button>
          <button type="button" class="btn-cyber" data-cat="[STATUS: Maintenance / Purge]" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center; border-color:var(--neon-warning); color:var(--neon-warning);">⚠️ ${t.autoFilterMaint}</button>
        ` : ''}
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="sortModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>🔄 ${t.sort.toUpperCase()}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('sortModal')">✕ ${t.close}</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        <button type="button" class="btn-cyber" data-sort="recently" onclick="saveSortMode('recently')" style="justify-content:center;">🕒 ${t.sortRecently}</button>
        <button type="button" class="btn-cyber" data-sort="oldest" onclick="saveSortMode('oldest')" style="justify-content:center;">⏳ ${t.sortOldest}</button>
        <button type="button" class="btn-cyber" data-sort="az" onclick="saveSortMode('az')" style="justify-content:center;">🔤 ${t.sortAZ}</button>
        <button type="button" class="btn-cyber" data-sort="za" onclick="saveSortMode('za')" style="justify-content:center;">🔤 ${t.sortZA}</button>
        <button type="button" class="btn-cyber" data-sort="manual" onclick="saveSortMode('manual')" style="justify-content:center;">🔧 ${t.sortManual}</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="displayConfigModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>🖥️ ${t.display.toUpperCase()}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('displayConfigModal')">✕ ${t.close}</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        <button type="button" class="btn-cyber" data-display="list" onclick="saveDisplayMode('list')" style="justify-content:center;">📋 ${t.dispList}</button>
        <button type="button" class="btn-cyber" data-display="compact_grid" onclick="saveDisplayMode('compact_grid')" style="justify-content:center;">🔲 ${t.dispCompact}</button>
        <button type="button" class="btn-cyber" data-display="comfortable_grid" onclick="saveDisplayMode('comfortable_grid')" style="justify-content:center;">🔲 ${t.dispComfort}</button>
        <button type="button" class="btn-cyber" data-display="panorama" onclick="saveDisplayMode('panorama')" style="justify-content:center;">📜 ${t.dispPanorama}</button>
      </div>
    </div>
  </div>

  ${isLoggedIn ? `
  <div class="modal-overlay" id="devModal">
    <div class="modal-card" style="max-width: 520px;">
      <div class="modal-header-flex">
        <h3>🛠️ ${t.devTitle}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('devModal')">✕ ${t.close}</button>
      </div>

      <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:var(--border-cyan); margin-bottom:6px;">${t.devRuntimeLabel}</div>
      <input type="hidden" id="devRuntimeProfile" value="${esc(runtimeProfile)}">
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:10px;">
        ${['worker','managed','vps','local'].map(p => {
          const capName = p.charAt(0).toUpperCase() + p.slice(1);
          return `<div class="dev-runtime-card ${runtimeProfile === p ? 'selected' : ''}" data-profile="${p}" onclick="selectRuntime('${p}')">
            <div class="dev-card-title">${t['devRuntime' + capName] || p}</div>
          </div>`;
        }).join('')}
      </div>
      <div style="font-size:0.6rem; color:#94a3b8; margin-bottom:12px; font-style:italic;">${t.devRuntimeNote}</div>

      <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:var(--border-cyan); margin-bottom:6px;">${t.devModeLabel}</div>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:8px;">
        <div class="dev-preset-card" data-preset="ping" onclick="selectPreset('ping')"><div class="dev-card-title">${t.devModePing}</div></div>
        <div class="dev-preset-card" data-preset="archive" onclick="selectPreset('archive')"><div class="dev-card-title">${t.devModeArchive}</div></div>
        <div class="dev-preset-card" data-preset="both" onclick="selectPreset('both')"><div class="dev-card-title">${t.devModeBoth}</div></div>
        <div class="dev-preset-card" data-preset="cms" onclick="selectPreset('cms')"><div class="dev-card-title">${t.devModeCms}</div></div>
        <div class="dev-preset-card" data-preset="api" onclick="selectPreset('api')"><div class="dev-card-title">${t.devModeApi}</div></div>
        <div class="dev-preset-card" data-preset="full" onclick="selectPreset('full')"><div class="dev-card-title">${t.devModeFull}</div></div>
      </div>
      <div style="font-size:0.62rem; color:#94a3b8; margin-bottom:12px;">${t.devPresetHint}</div>

      <div style="background: rgba(0,240,255,0.03); border:1px solid rgba(0,240,255,0.2); border-radius:10px; padding:10px; margin-bottom:12px;">
        <div style="font-family:'Orbitron',sans-serif; font-size:0.65rem; color:var(--border-cyan); margin-bottom:4px;">${t.devActiveCaps}</div>
        <div class="dev-cap-row">
          <span class="dev-cap-label">${t.devCapabilityPing}</span>
          <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
            <input type="checkbox" id="devCapPing" ${caps.ping ? 'checked' : ''} onchange="updateToggleVisual(this)" style="opacity:0; width:0; height:0;">
            <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
            <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
          </label>
        </div>
        <div class="dev-cap-row">
          <span class="dev-cap-label">${t.devCapabilityArchive}</span>
          <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
            <input type="checkbox" id="devCapArchive" ${caps.archive ? 'checked' : ''} onchange="updateToggleVisual(this)" style="opacity:0; width:0; height:0;">
            <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
            <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
          </label>
        </div>
        <div class="dev-cap-row">
          <span class="dev-cap-label">${t.devCapabilityCms}</span>
          <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
            <input type="checkbox" id="devCapCms" ${caps.cms ? 'checked' : ''} onchange="updateToggleVisual(this)" style="opacity:0; width:0; height:0;">
            <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
            <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
          </label>
        </div>
        <div class="dev-cap-row">
          <span class="dev-cap-label">${t.devCapabilityApi}</span>
          <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
            <input type="checkbox" id="devCapApi" ${caps.api ? 'checked' : ''} onchange="updateToggleVisual(this)" style="opacity:0; width:0; height:0;">
            <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
            <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
          </label>
        </div>
      </div>


      <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:var(--border-cyan); margin-bottom:6px;">${t.devPingCacheLabel}</div>
      <select id="devPingCache" style="width:100%; margin-bottom:6px; padding:8px; background:#030712; color:var(--border-cyan); border:1px solid var(--border-cyan); border-radius:8px;">
        <option value="auto" ${pingCacheMode === 'auto' ? 'selected' : ''}>auto</option>
        <option value="memory" ${pingCacheMode === 'memory' ? 'selected' : ''}>memory</option>
        <option value="shared" ${pingCacheMode === 'shared' ? 'selected' : ''}>shared</option>
      </select>
      <div style="font-size:0.6rem; color:#94a3b8; margin-bottom:12px; font-style:italic;">${t.devPingCacheHint}</div>
      <a class="btn-cyber" href="/tools" style="display:flex; justify-content:center; padding:8px; margin-bottom:10px; text-decoration:none;">🧰 ${t.navTools}</a>
      <div style="font-size:0.65rem; color:#f59e0b; margin-bottom:10px; padding:8px; background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.3); border-radius:8px;">ℹ️ ${t.devSprintNote}</div>

      <button type="button" class="btn-cyber" onclick="saveDevConfig()" style="width:100%; justify-content:center; padding:10px;">${t.devSaveBtn}</button>
    </div>
  </div>

  <div class="modal-overlay" id="settingsModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>${t.settings}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('settingsModal')">✕ ${t.close}</button>
      </div>

      <div style="background: rgba(148,163,184,0.05); border: 1px solid rgba(148,163,184,0.3); border-radius: 10px; padding: 10px; margin-bottom: 10px;">
        <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:#94a3b8; margin-bottom:6px; border-bottom:1px solid rgba(148,163,184,0.2); padding-bottom:3px;">🛠️ ${t.devTitle}</div>
        <button type="button" class="btn-cyber" onclick="openDevModal()" style="width:100%; justify-content:center; font-size:0.65rem; border-color:#94a3b8; color:#94a3b8;">⚙️ ${t.devTitle}</button>
      </div>

      <div style="background: rgba(0,240,255,0.03); border: 1px solid rgba(0,240,255,0.2); border-radius: 10px; padding: 10px; margin-bottom: 10px;">
        <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:var(--border-cyan); margin-bottom:6px; border-bottom:1px solid rgba(0,240,255,0.15); padding-bottom:3px;">🌐 ${t.siteTitleLabel}</div>
        <div class="form-group" style="margin-bottom:6px;"><input type="text" id="siteTitleInput" value="${esc(siteTitle)}" placeholder="${t.siteTitlePlaceholder}"></div>
        <button type="button" class="btn-cyber" onclick="saveSiteTitle()" style="width:100%; justify-content:center; font-size:0.65rem; border-color:var(--border-cyan); color:var(--border-cyan);">${t.updateTitleBtn}</button>
      </div>

      <div style="background: rgba(245,158,11,0.03); border: 1px solid rgba(245,158,11,0.2); border-radius: 10px; padding: 10px; margin-bottom: 10px;">
        <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:var(--neon-warning); margin-bottom:6px; border-bottom:1px solid rgba(245,158,11,0.15); padding-bottom:3px;">🚨 ${t.webhookSecTitle}</div>
        <p style="font-size:0.65rem; color:#94a3b8; margin:0 0 6px 0;">${t.webhookDesc}</p>
        <div class="form-group" style="margin-bottom:6px;"><input type="text" id="webhookUrlInput" value="${esc(settings.webhookUrl || '')}" placeholder="${t.webhookPlaceholder}"></div>
        <button type="button" class="btn-cyber" onclick="saveWebhook()" style="width:100%; justify-content:center; font-size:0.65rem; border-color:var(--neon-warning); color:var(--neon-warning);">${t.saveWebhookBtn}</button>
      </div>

      <div style="background: rgba(251,146,60,0.03); border: 1px solid rgba(251,146,60,0.25); border-radius: 10px; padding: 10px; margin-bottom: 10px;">
        <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:#fb923c; margin-bottom:6px; border-bottom:1px solid rgba(251,146,60,0.15); padding-bottom:3px;">🛡️ ${t.turnstileTitle}</div>
        <p style="font-size:0.65rem; color:#94a3b8; margin:0 0 6px 0;">${t.turnstileDesc}</p>
        <div class="form-group" style="margin-bottom:6px;"><label>${t.turnstileSiteKeyLabel}</label><input type="text" id="turnstileSiteKeyInput" value="${esc(settings.turnstileSiteKey || '')}" placeholder="0x4AAAAAAA..."></div>
        <div class="form-group" style="margin-bottom:6px;"><label>${t.turnstileSecretKeyLabel}</label><input type="password" id="turnstileSecretKeyInput" value="" placeholder="${settings.turnstileSecretKey ? t.turnstileSecretSetPlaceholder : t.turnstileSecretPlaceholder}" data-has-secret="${settings.turnstileSecretKey ? 'true' : 'false'}"></div>
        <button type="button" class="btn-cyber" onclick="saveTurnstile()" style="width:100%; justify-content:center; font-size:0.65rem; border-color:#fb923c; color:#fb923c;">${t.saveTurnstileBtn}</button>
      </div>

      <div style="background: rgba(34,197,94,0.03); border: 1px solid rgba(34,197,94,0.25); border-radius: 10px; padding: 10px; margin-bottom: 10px;">
        <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:#22c55e; margin-bottom:6px; border-bottom:1px solid rgba(34,197,94,0.15); padding-bottom:3px;">💾 ${t.backupTitle}</div>
        <p style="font-size:0.65rem; color:#94a3b8; margin:0 0 6px 0;">${t.backupDesc}</p>
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <label style="color:#22c55e; font-size:0.72rem; font-weight:700;">${t.backupEnabledLabel}</label>
          <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
            <input type="checkbox" id="autoBackupEnabledInput" ${settings.autoBackupEnabled !== false ? 'checked' : ''} onchange="updateToggleVisual(this)" style="opacity:0; width:0; height:0;">
            <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid #22c55e; transition:.3s; border-radius:20px;"></span>
            <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:#22c55e; transition:.3s; border-radius:50%;"></span>
          </label>
        </div>
        <div class="form-group" style="margin-bottom:6px;"><label>${t.backupRetentionLabel}</label><input type="number" id="autoBackupRetentionDaysInput" value="${settings.autoBackupRetentionDays || 30}" min="1" max="365"></div>
        <button type="button" class="btn-cyber" onclick="saveAutoBackup()" style="width:100%; justify-content:center; font-size:0.65rem; border-color:#22c55e; color:#22c55e;">${t.saveBackupBtn}</button>
      </div>

      <div style="background: rgba(0,240,255,0.03); border: 1px solid rgba(0,240,255,0.2); border-radius: 10px; padding: 10px; margin-bottom: 10px;">
        <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:var(--border-cyan); margin-bottom:6px; border-bottom:1px solid rgba(0,240,255,0.15); padding-bottom:3px;">🔑 ${t.changePassTitle}</div>
        <div class="form-group" style="margin-bottom:6px;"><label>${t.oldPass}</label>
          <div class="input-pass-wrap"><input type="password" id="oldPassInput" placeholder="${t.oldPassPlaceholder}"><button type="button" class="btn-eye-toggle" onclick="togglePassVisibility('oldPassInput', this)">👁️</button></div>
        </div>
        <div class="form-group" style="margin-bottom:6px;"><label>${t.newPass}</label>
          <div class="input-pass-wrap"><input type="password" id="newPassInput" placeholder="${t.newPassPlaceholder}"><button type="button" class="btn-eye-toggle" onclick="togglePassVisibility('newPassInput', this)">👁️</button></div>
        </div>
        <div class="form-group" style="margin-bottom:8px;"><label>${t.confirmPass}</label>
          <div class="input-pass-wrap"><input type="password" id="confirmPassInput" placeholder="${t.newPassPlaceholder}"><button type="button" class="btn-eye-toggle" onclick="togglePassVisibility('confirmPassInput', this)">👁️</button></div>
        </div>
        <button type="button" class="btn-cyber" onclick="changePassword()" style="width:100%; justify-content:center; font-size:0.65rem; border-color:var(--neon-green); color:var(--neon-green);">${t.updatePass}</button>
      </div>

      <div style="background: rgba(192,132,252,0.03); border: 1px solid rgba(192,132,252,0.3); border-radius: 10px; padding: 10px;">
        <div style="font-family:'Orbitron',sans-serif; font-size:0.7rem; color:#c084fc; margin-bottom:6px; border-bottom:1px solid rgba(192,132,252,0.2); padding-bottom:3px;">✨ ${t.demoSecTitle}</div>
        <p style="font-size:0.7rem; color:#94a3b8; margin:0 0 8px 0;">${servers.length > 0 ? esc(t.demoDescFilled) : esc(t.demoDescEmpty)}</p>
        <button type="button" class="btn-cyber" onclick="loadDemoData()" style="width:100%; justify-content:center; font-size:0.65rem; border-color:#c084fc; color:#c084fc;" ${servers.length > 0 ? 'disabled' : ''}>📥 ${esc(t.demoBtn)}</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="backupModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>📦 ${t.backupRestore}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('backupModal')">✕ ${t.close}</button>
      </div>

      <div class="form-group">
        <label>📥 ${t.dataMgmt}</label>
        <div style="display:flex; flex-direction:column; gap:6px; margin-top:6px;">
          <button type="button" class="btn-cyber" onclick="location.href='/api/export_filtered?type=full'" style="justify-content:center; color:var(--neon-green); border-color:var(--neon-green);">📦 ${t.backupFull}</button>
          <button type="button" class="btn-cyber" onclick="openExportChoiceModal('group')" style="justify-content:center;">📁 ${t.backupGroup}</button>
          <button type="button" class="btn-cyber" onclick="openExportChoiceModal('category')" style="justify-content:center;">📂 ${t.backupCategory}</button>
          <button type="button" class="btn-cyber" onclick="location.href='/api/export_filtered?type=independen'" style="justify-content:center; border-color:var(--text-blue); color:var(--text-blue);">📌 ${t.backupIndependen}</button>
        </div>
      </div>

      <hr style="border:0; border-top:1px solid rgba(0, 240, 255, 0.2); margin: 12px 0;">

      <div class="form-group">
        <label>📤 ${t.restoreUploadOrPaste}</label>
        <div style="margin-bottom: 6px;">
          <input type="file" id="restoreFileInput" accept=".json" onchange="handleFileRestoreUpload(event)" style="background:#030712; border:1px solid var(--border-cyan); border-radius:8px; padding:8px; font-size:0.75rem; color:#fff; width:100%; cursor:pointer;">
        </div>
        <textarea id="restoreJsonInput" class="backup-json-textarea" placeholder="${t.pasteJson}"></textarea>
      </div>
      <div class="modal-actions"><button type="button" class="btn-cyber" onclick="restoreBackupData()" style="width:100%; justify-content:center;">${t.restore}</button></div>
    </div>
  </div>

  <div class="modal-overlay" id="clearAllModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>🗑️ ${t.clearAll.toUpperCase()}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('clearAllModal')">✕ ${t.close}</button>
      </div>
      <div class="form-group">
        <label style="color:var(--neon-warning);">${t.clearMethodLabel}</label>
        <div style="display:flex; flex-direction:column; gap:6px; margin-top:8px;">
          <button type="button" class="btn-cyber" onclick="executeClearFiltered('all')" style="justify-content:center; border-color:var(--neon-warning); color:var(--neon-warning);">⚠️ ${t.clearAllSystem}</button>
          <button type="button" class="btn-cyber" onclick="openClearChoiceModal('group')" style="justify-content:center; border-color:var(--neon-warning); color:var(--neon-warning);">🗑️ ${t.clearByGroup}</button>
          <button type="button" class="btn-cyber" onclick="openClearChoiceModal('category')" style="justify-content:center; border-color:var(--neon-warning); color:var(--neon-warning);">🗑️ ${t.clearByCategory}</button>
          <button type="button" class="btn-cyber" onclick="executeClearFiltered('independen', 'Independen')" style="justify-content:center; border-color:var(--neon-warning); color:var(--neon-warning);">🗑️ ${t.clearIndependen}</button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-cyber" onclick="closeModal('clearAllModal')" style="border-color:#64748b; color:#94a3b8;">${t.cancel}</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="pingConfigModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>${t.pingConfig}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('pingConfigModal')">✕ ${t.close}</button>
      </div>

      <div style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
        <div>
          <label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.75rem;">${t.rule34Title}</label>
          <div style="font-size:0.62rem; color:#94a3b8;" id="rule34Desc">${t.rule34Desc}</div>
        </div>
        <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
          <input type="checkbox" id="cfgPingRule34Active" ${pingRule34Active ? 'checked' : ''} onchange="toggleRule34Mode(this)" style="opacity:0; width:0; height:0;">
          <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
          <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
        </label>
      </div>

      <div style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
        <div>
          <label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.75rem;">${t.autoPingTitle}</label>
          <div style="font-size:0.62rem; color:#94a3b8;">${t.autoPingDesc}</div>
        </div>
        <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
          <input type="checkbox" id="cfgAutoPingIntervalEnabled" ${autoPingIntervalEnabled ? 'checked' : ''} onchange="updateToggleVisual(this)" style="opacity:0; width:0; height:0;">
          <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
          <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
        </label>
      </div>

      <div class="form-group" style="margin-bottom:8px;">
        <label>${t.intervalTimeRange}</label>
        <input type="number" id="cfgAutoPingIntervalSeconds" value="${autoPingIntervalSeconds}" min="10" max="300" style="padding:7px 10px;">
      </div>

      <div style="font-family:'Orbitron',sans-serif; font-size:0.68rem; color:var(--border-cyan); margin-bottom:4px;" id="pingChecklistTitle">${t.selectUrlPing}</div>
      <div id="pingChecklistContainer" style="max-height: 160px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; background: #030712; padding: 8px; border-radius: 8px; border: 1px solid rgba(0,240,255,0.2);">
        ${servers.map(s => (s.host && s.host.trim() !== "" && s.enablePing !== false) ? `
          <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(0,240,255,0.02); padding:6px 8px; border-radius:6px; border:1px solid rgba(0,240,255,0.15);">
            <span style="font-family:'JetBrains Mono'; color:#7dd3fc; font-size:0.72rem; word-break:break-all; max-width:70%;">${esc(s.host)}</span>
            <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
              <input type="checkbox" class="ping-domain-chk" value="${esc(s.host)}" ${pingSelection.includes(s.host) ? 'checked' : ''} onchange="handlePingToggleLimit(this)" style="opacity:0; width:0; height:0;">
              <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
              <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
            </label>
          </div>
        ` : '').join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-cyber" onclick="closeModal('pingConfigModal')" style="border-color:#64748b; color:#94a3b8;">${t.cancel}</button>
        <button type="button" class="btn-cyber" onclick="savePingSelection()">${t.save}</button>
      </div>
    </div>
  </div>

  `: ''}

  <div class="modal-overlay" id="authModal">
    <div class="modal-card">
      <div class="modal-header-flex">
        <h3>🔑 ${t.login.toUpperCase()}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('authModal')">✕ ${t.close}</button>
      </div>
      <div class="form-group"><label>Username</label><input type="text" id="loginUser" placeholder="Username"></div>
      <div class="form-group"><label>Password</label>
        <div class="input-pass-wrap">
          <input type="password" id="loginPass" placeholder="Password" onkeyup="if(event.key==='Enter') doLogin()">
          <button type="button" class="btn-eye-toggle" onclick="togglePassVisibility('loginPass', this)">👁️</button>
        </div>
      </div>
      ${!isLoggedIn && turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${esc(turnstileSiteKey)}" data-theme="dark" style="margin: 8px 0; display:flex; justify-content:center;"></div>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn-cyber" onclick="closeModal('authModal')" style="border-color:#64748b; color:#94a3b8;">${t.cancel}</button>
        <button type="button" class="btn-cyber" onclick="doLogin()">LOGIN</button>
      </div>
    </div>
  </div>

  ${isLoggedIn ? `
  <div class="modal-overlay" id="addModal">
    <div class="modal-card" style="border-color: rgba(0, 240, 255, 0.7); box-shadow: 0 0 30px rgba(0, 240, 255, 0.3);">
      <div class="modal-header-flex" style="background: linear-gradient(90deg, rgba(0,240,255,0.08), transparent); padding: 4px 8px; border-radius: 6px;">
        <h3 style="letter-spacing: 0.8px; text-shadow: 0 0 8px var(--border-cyan);">➕ ${t.addTitle}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('addModal')">✕ ${t.close}</button>
      </div>

      <div class="form-group"><label>${t.nameLabel}</label><input type="text" id="addName" placeholder="Contoh: Node Utama"></div>

      <div class="form-group"><label>${t.catLabel}</label>
        <div class="cyber-select-trigger" onclick="openCategoryDropdown('addCategory')">
          <span id="addCategoryText">General</span><span>▼</span>
        </div>
        <input type="text" id="addCategory" value="General" style="margin-top:5px;">
      </div>

      <div class="form-group"><label>${t.groupLabel}</label>
        <div class="cyber-select-trigger" onclick="openGroupDropdown('addGroupType')">
          <span id="addGroupTypeText">Independen</span><span>▼</span>
        </div>
        <input type="text" id="addGroupType" value="Independen" style="margin-top:5px;">
      </div>

      <div class="form-group"><label>${t.descLabel}</label><textarea id="addDescription" placeholder="..." style="width:100%; background:#030712; border:1px solid rgba(0,240,255,0.3); border-radius:8px; padding:9px 10px; color:#fff; font-size:0.85rem; outline:none; resize:vertical; min-height:45px;"></textarea></div>

      <div class="form-group"><label>${t.hostLabel}</label><input type="text" id="addHost" placeholder="example.domain.com"></div>

      <div class="form-group" style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <div><label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.72rem;">${t.enablePingLbl}</label></div>
        <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
          <input type="checkbox" id="addEnablePing" checked style="opacity:0; width:0; height:0;" onchange="updateToggleVisual(this)">
          <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
          <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
        </label>
      </div>

      <div class="form-group" style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <div>
          <label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.72rem;">${t.displayTableLbl}</label>
          <div style="font-size:0.62rem; color:#94a3b8;" id="addDisplayToggleDesc">Nama (Kolom 1)</div>
        </div>
        <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
          <input type="checkbox" id="addUseHostAsDisplay" onchange="updateDisplayToggleLabel('add'); updateToggleVisual(this);" style="opacity:0; width:0; height:0;">
          <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
          <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
        </label>
      </div>

      <div class="form-group"><label>${t.customLinkLbl}</label><input type="text" id="addCustomLink" placeholder="https://example.domain.com"></div>

      <div class="form-group"><label>${t.imageLbl}</label>
        <div class="img-row"><input type="text" id="addImageUrl" placeholder="https://.../image.jpg" style="flex:1;min-width:140px;"><button type="button" class="btn-cyber" onclick="pickImageUpload('add')" style="font-size:.62rem;padding:7px 9px;">📷 ${t.imageUploadBtn}</button></div>
        <div style="font-size:.6rem;color:#94a3b8;margin-top:3px;">${t.imageHint}</div>
      </div>

      <div class="form-group" style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <div>
          <label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.72rem;" id="lblClickCopyToggle">${t.clickCopyToggleLbl}</label>
        </div>
        <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
          <input type="checkbox" id="addClickCopyMode" onchange="updateToggleVisual(this)" style="opacity:0; width:0; height:0;">
          <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
          <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
        </label>
      </div>

      <div class="form-group" style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
        <div><label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.72rem;">${t.pinTopLbl}</label></div>
        <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
          <input type="checkbox" id="addIsPinned" style="opacity:0; width:0; height:0;" onchange="updateToggleVisual(this)">
          <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
          <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
        </label>
      </div>

      <div class="form-group" style="background: rgba(0,240,255,0.03); border: 1px solid rgba(0,240,255,0.2); border-radius: 10px; padding: 10px;">
        <label style="color:var(--border-cyan); margin-bottom:6px; font-size:0.72rem; font-family:'Orbitron',sans-serif;">${t.customFieldsLbl}</label>
        <div id="addCustomFieldsContainer" style="display:flex; flex-direction:column; gap:6px; margin-bottom:8px;"></div>
        <button type="button" class="btn-cyber" onclick="addCustomFieldInput('addCustomFieldsContainer', '', '')" style="font-size:0.65rem; width:100%; justify-content:center;">${t.addColBtn}</button>
      </div>

      <div class="form-group"><label>${t.visPubLbl}</label>
        <div class="cyber-select-trigger" onclick="openCyberDropdown('addIsPublic', ['${t.visPubOpt}', '${t.visPubPriv}'], ['true', 'false'])">
          <span id="addIsPublicText">${t.visPubOpt}</span><span>▼</span>
        </div>
        <input type="hidden" id="addIsPublic" value="true">
      </div>

      <div class="form-group"><label>${t.statusNodeLbl}</label>
        <div class="cyber-select-trigger" onclick="openCyberDropdown('addMode', ['${t.statusNorm}', '${t.statusRest}', '${t.statusMaint}'], ['normal', 'blur', 'maintenance'])">
          <span id="addModeText">${t.statusNorm}</span><span>▼</span>
        </div>
        <input type="hidden" id="addMode" value="normal">
      </div>

      <div class="modal-actions"><button type="button" class="btn-cyber" onclick="saveServer()" style="width:100%; justify-content:center; padding:10px; font-size:0.78rem;">${t.save}</button></div>
    </div>
  </div>

  `: ''}

  <div class="modal-overlay" id="detailModal">
    <div class="modal-card" style="border-color: rgba(0, 240, 255, 0.6); box-shadow: 0 0 30px rgba(0, 240, 255, 0.25);">
      <div class="modal-header-flex">
        <h3 id="modalTitle" style="letter-spacing: 1px; text-shadow: 0 0 10px var(--border-cyan);">${t.detailTitle}</h3>
        <button type="button" class="btn-modal-close" onclick="closeModal('detailModal')">✕ ${t.close}</button>
      </div>

      <div id="viewMode">
        <div id="detImageWrap"><img id="detImage" alt="" referrerpolicy="no-referrer"></div>
        <div class="det-box-shimmer" style="background: linear-gradient(135deg, rgba(0,240,255,0.08), rgba(7,14,27,0.9), rgba(0,240,255,0.03)); border: 1.5px solid var(--border-cyan); margin-bottom: 12px; box-shadow: inset 0 0 10px rgba(0,240,255,0.1);">
          <span class="det-label-shimmer">${t.itemNameLbl}</span>
          <div id="detName" style="color:#ffffff; font-family:'Orbitron',sans-serif; font-size:1rem; font-weight:800; text-shadow: 0 0 8px rgba(255,255,255,0.4);">-</div>
          <div id="detCreatedTime" style="font-size:0.65rem; color:#94a3b8; margin-top:4px; font-family:'JetBrains Mono';"></div>
        </div>

        <div class="det-box-shimmer" style="padding:10px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">
            <span class="det-label-shimmer">${t.descLabel.toUpperCase()}</span>
            <button type="button" class="btn-icon-svg" onclick="copyDetailText('detDescription')" title="${t.tooltipCopy}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
          </div>
          <div id="detDescriptionContainer" style="position:relative;">
            <div id="detDescription" style="color:#e2e8f0; font-size:0.82rem; line-height:1.5; word-break:break-word; max-height: 4.5em; overflow: hidden; transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1);">-</div>
            <div id="detDescGradient" style="position:absolute; bottom:0; left:0; width:100%; height:20px; background:linear-gradient(transparent, #070e1b); display:none; pointer-events:none;"></div>
          </div>
          <button type="button" id="detDescSeeMoreBtn" onclick="toggleSeeMoreDesc()" style="background:none; border:none; color:var(--border-cyan); font-size:0.68rem; font-weight:bold; cursor:pointer; padding:4px 0 0 0; display:none; font-family:'Orbitron',sans-serif;">${t.seeMore}</button>
        </div>

        <div class="det-box-shimmer" style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px;">
          <div><span class="det-label-shimmer">URL</span><div id="detHost" style="font-family:'JetBrains Mono'; color:#e2e8f0; font-size:0.8rem; font-weight:600;">-</div></div>
          <button type="button" class="btn-icon-svg" onclick="copyDetailText('detHost')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
        </div>

        <div class="det-box-shimmer" id="detUptimeBox" style="display:none; padding:8px 10px;">
          <span class="det-label-shimmer">${t.uptimeTitle}</span>
          <div id="detUptimeBars" class="uptime-bar-wrap"></div>
        </div>

        <div class="det-box-shimmer" id="detGroupCustomLink" style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px;">
          <div><span class="det-label-shimmer">${t.customUrlLbl}</span><div id="detCustomLink" style="font-family:'JetBrains Mono'; color:#e2e8f0; font-size:0.8rem; font-weight:600;">-</div></div>
          <button type="button" class="btn-icon-svg" onclick="copyDetailText('detCustomLink')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
        </div>

        <div id="detCustomFieldsView" style="display:flex; flex-direction:column; gap:6px; margin-top:8px;"></div>

        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px; margin-top:12px;">
          <div class="det-box-shimmer" style="text-align:center; padding:10px; margin-top:0;">
            <div id="detPubBtn" style="font-family:'Orbitron',sans-serif; font-size:0.72rem; font-weight:700; color:var(--border-cyan);">PUBLIC</div>
          </div>
          <div class="det-box-shimmer" style="text-align:center; padding:10px; margin-top:0;">
            <div id="detModeBtn" style="font-family:'Orbitron',sans-serif; font-size:0.72rem; font-weight:700; color:var(--neon-green);">ONLINE</div>
          </div>
        </div>

        <div class="modal-actions" style="margin-top:14px; flex-direction:column; gap:8px;">
          <button type="button" class="btn-cyber" onclick="generateQR()" style="width:100%; justify-content:center; padding:10px; font-size:0.75rem; border-color:var(--text-blue); color:var(--text-blue);">📱 ${t.qrBtn}</button>
          <div id="qrContainer" style="display:none; text-align:center; margin-top:10px;">
            <div id="qrImage" role="img" aria-label="QR Code"></div>
          </div>
          ${isLoggedIn ? `<button type="button" class="btn-cyber" onclick="enableEditMode()" style="width:100%; justify-content:center; padding:10px; font-size:0.75rem;">${t.editDataBtn}</button>` : ''}
        </div>
      </div>

      <div id="editMode" style="display:none;">
        <div class="form-group"><label>${t.nameLabel}</label><input type="text" id="editName"></div>

        <div class="form-group"><label>${t.catLabel}</label>
          <div class="cyber-select-trigger" onclick="openCategoryDropdown('editCategory')">
            <span id="editCategoryText">General</span><span>▼</span>
          </div>
          <input type="text" id="editCategory" style="margin-top:5px;">
        </div>

        <div class="form-group"><label>${t.groupLabel}</label>
          <div class="cyber-select-trigger" onclick="openGroupDropdown('editGroupType')">
            <span id="editGroupTypeText">Independen</span><span>▼</span>
          </div>
          <input type="text" id="editGroupType" style="margin-top:5px;">
        </div>

        <div class="form-group"><label>${t.descLabel}</label><textarea id="editDescription" style="width:100%; background:#030712; border:1px solid rgba(0,240,255,0.3); border-radius:8px; padding:9px 10px; color:#fff; font-size:0.85rem; outline:none; resize:vertical; min-height:45px;"></textarea></div>
        <div class="form-group"><label>${t.hostLabel}</label><input type="text" id="editHost" placeholder="example.domain.com"></div>

        <div class="form-group" style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <div><label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.72rem;">${t.enablePingLbl}</label></div>
          <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
            <input type="checkbox" id="editEnablePing" style="opacity:0; width:0; height:0;" onchange="updateToggleVisual(this)">
            <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
            <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
          </label>
        </div>

        <div class="form-group" style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <div>
            <label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.72rem;">${t.displayTableLbl}</label>
            <div style="font-size:0.62rem; color:#94a3b8;" id="editDisplayToggleDesc">Nama (Kolom 1)</div>
          </div>
          <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
            <input type="checkbox" id="editUseHostAsDisplay" onchange="updateDisplayToggleLabel('edit'); updateToggleVisual(this);" style="opacity:0; width:0; height:0;">
            <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
            <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
          </label>
        </div>

        <div class="form-group"><label>${t.customLinkLbl}</label><input type="text" id="editCustomLink" placeholder="https://example.domain.com"></div>

      <div class="form-group"><label>${t.imageLbl}</label>
        <div class="img-row"><input type="text" id="editImageUrl" placeholder="https://.../image.jpg" style="flex:1;min-width:140px;"><button type="button" class="btn-cyber" onclick="pickImageUpload('edit')" style="font-size:.62rem;padding:7px 9px;">📷 ${t.imageUploadBtn}</button></div>
        <div style="font-size:.6rem;color:#94a3b8;margin-top:3px;">${t.imageHint}</div>
      </div>

        <div class="form-group" style="background: rgba(0,240,255,0.04); border: 1px solid rgba(0,240,255,0.25); border-radius: 10px; padding: 10px 12px; display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <div>
            <label style="color:var(--border-cyan); margin-bottom:2px; font-weight:700; font-size:0.72rem;">${t.clickCopyToggleLbl}</label>
          </div>
          <label style="cursor:pointer; position:relative; display:inline-block; width:40px; height:20px; flex-shrink:0;">
            <input type="checkbox" id="editClickCopyMode" onchange="updateToggleVisual(this)" style="opacity:0; width:0; height:0;">
            <span class="toggle-track" style="position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background-color:#1e293b; border:1px solid var(--border-cyan); transition:.3s; border-radius:20px;"></span>
            <span class="toggle-thumb" style="position:absolute; content:''; height:14px; width:14px; left:3px; bottom:3px; background-color:var(--border-cyan); transition:.3s; border-radius:50%;"></span>
          </label>
        </div>

        <div class="form-group" style="background: rgba(0,240,255,0.03); border: 1px solid rgba(0,240,255,0.2); border-radius: 10px; padding: 10px;">
          <label style="color:var(--border-cyan); margin-bottom:6px; font-size:0.72rem; font-family:'Orbitron',sans-serif;">${t.customFieldsLbl}</label>
          <div id="editCustomFieldsContainer" style="display:flex; flex-direction:column; gap:5px; margin-bottom:6px;"></div>
          <button type="button" class="btn-cyber" onclick="addCustomFieldInput('editCustomFieldsContainer', '', '')" style="font-size:0.6rem; width:100%; justify-content:center;">${t.addColBtn}</button>
        </div>

        <div class="form-group"><label>${t.visPubLbl}</label>
          <div class="cyber-select-trigger" onclick="openCyberDropdown('editIsPublic', ['${t.visPubOpt}', '${t.visPubPriv}'], ['true', 'false'])">
            <span id="editIsPublicText">${t.visPubOpt}</span><span>▼</span>
          </div>
          <input type="hidden" id="editIsPublic" value="true">
        </div>

        <div class="form-group"><label>${t.statusNodeLbl}</label>
          <div class="cyber-select-trigger" onclick="openCyberDropdown('editModeVal', ['${t.statusNorm}', '${t.statusRest}', '${t.statusMaint}'], ['normal', 'blur', 'maintenance'])">
            <span id="editModeValText">${t.statusNorm}</span><span>▼</span>
          </div>
          <input type="hidden" id="editModeVal" value="normal">
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-cyber" onclick="disableEditMode()" style="border-color:#64748b; color:#94a3b8;">${t.cancel}</button>
          <button type="button" class="btn-cyber" onclick="saveEditServer()">${t.save}</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    // ============ CLIENT STATE ============
    const servers = ${serversJson};
    const isLoggedIn = ${isLoggedIn ? 'true' : 'false'};
    const lang = "${lang}";
    const T = ${tJson};
    const caps = ${capsJson};
    const runtimeProfile = ${runtimeProfileJson};
    let pingSelection = ${pingSelectionJson};
    let pingRule34Active = ${pingRule34Active ? 'true' : 'false'};
    const autoPingIntervalEnabled = ${autoPingIntervalEnabled ? 'true' : 'false'};
    const autoPingIntervalSeconds = ${autoPingIntervalSeconds};
    const publicCols = ${publicColsJson};
    let manualCategories = ${manualCategoriesJson};
    let allGroups = ${allGroupsJson};
    const ITEMS_PER_PAGE = ${ITEMS_PER_PAGE};
    let currentSort = "${currentSort}";
    let currentDisplayMode = "${currentDisplayMode}";
    let lockdownMode = ${lockdownMode ? 'true' : 'false'};

    let activeId = null;
    let isDescExpanded = false;
    let isAnnouncementExpanded = false;
    let currentFilterCategory = "ALL";
    let currentPage = 1;
    let currentFilteredRows = [];
    let autoPingTimer = null;
    let draggedRowId = null;

    // ============ HELPERS ============
    function esc(s) {
      return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    var __name = function (f) { return f; }; // esbuild keep-names helper (see NAME_SHIM)
    ${parseMarkdownLinks.toString()}
    const parseMarkdownLinksJS = parseMarkdownLinks;
    ${markdownToHtml.toString()}
    ${makeQrSvg.toString()}

    function safeHttpUrl(u) {
      var s = String(u || '');
      if (s.indexOf('http://') !== 0 && s.indexOf('https://') !== 0) return '';
      for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c <= 32 || c === 34 || c === 39 || c === 60 || c === 62 || c === 92 || c === 127) return '';
      }
      return s;
    }
    function safeImageSrc(u) {
      u = String(u || '');
      if (u.indexOf('/uploads/') === 0) return /^[a-f0-9]{32}[.](png|jpg|gif|webp)$/.test(u.slice(9)) ? u : '';
      return safeHttpUrl(u);
    }
    function gradientFor(seed) {
      let h = 0; seed = String(seed || '');
      for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
      const hue = h % 360;
      return 'linear-gradient(135deg, hsl(' + hue + ',65%,24%), hsl(' + ((hue + 55) % 360) + ',70%,11%))';
    }
    // Works on plain-http VPS installs too (navigator.clipboard only exists in secure contexts).
    function copyText(text, okMsg) {
      const done = () => showToast(okMsg || T.copySuccess);
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
          document.body.appendChild(ta); ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) done(); else showToast(T.copyFailed);
        } catch (e) { showToast(T.copyFailed); }
      };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    }
    // A broken thumbnail must fall back to the gradient, never show a broken-image icon.
    document.addEventListener('error', function (e) {
      const t = e.target;
      if (t && t.tagName === 'IMG' && t.classList && t.classList.contains('thumb-img')) t.remove();
      if (t && t.id === 'detImage') { document.getElementById('detImageWrap').style.display = 'none'; }
    }, true);

    // ============ IMAGE UPLOAD ============
    function pickImageUpload(prefix) {
      const inp = document.getElementById('imgFileInput');
      if (!inp) return;
      inp.onchange = async () => {
        const file = inp.files && inp.files[0];
        inp.value = '';
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { await cyberAlert(T.imageTooBig); return; }
        showToast(T.imageUploading);
        try {
          const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
          const d = await res.json().catch(() => ({}));
          if (res.ok && d.success) { document.getElementById(prefix + 'ImageUrl').value = d.url; showToast(T.imageUploaded); }
          else await cyberAlert(d.message || T.imageFailed);
        } catch (e) { await cyberAlert(T.imageFailed); }
      };
      inp.click();
    }

    function formatCustomDateTimeJS(timestamp) {
      if (!timestamp) return "-";
      const d = new Date(timestamp);
      const day = d.getDate();
      const monthsIndo = ["jan","feb","mar","apr","mei","jun","jul","agu","sep","okt","nov","des"];
      const monthsEng = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
      const mIndex = d.getMonth();
      const monthStr = lang === 'en' ? monthsEng[mIndex] : monthsIndo[mIndex];
      const year = d.getFullYear();
      const hours = String(d.getHours()).padStart(2, '0');
      const minutes = String(d.getMinutes()).padStart(2, '0');
      return day + " " + monthStr + " " + year + ", " + hours + ":" + minutes;
    }

    // ============ SPRINT 2: BULK ACTIONS & QR ============
    function toggleSelectAll(el) {
      document.querySelectorAll('.bulk-checkbox').forEach(cb => {
        const row = cb.closest('tr') || cb.closest('.server-row-item');
        if (row && row.style.display !== 'none') { cb.checked = el.checked; }
      });
      updateBulkBar();
    }
    
    function bulkSelectAllVisible() {
      document.querySelectorAll(".bulk-checkbox").forEach(cb => {
        const row = cb.closest("tr") || cb.closest(".server-row-item");
        if (row && row.style.display !== "none") cb.checked = true;
      });
      updateBulkBar();
    }
    function bulkClearSelection() {
      document.querySelectorAll(".bulk-checkbox").forEach(cb => { cb.checked = false; });
      const sa = document.getElementById("bulkSelectAll");
      if (sa) sa.checked = false;
      updateBulkBar();
    }

    function getSelectedBulkIds() {
      return [...new Set(Array.from(document.querySelectorAll('.bulk-checkbox:checked')).map(cb => cb.value))];
    }

    function updateBulkBar() {
      const ids = getSelectedBulkIds();
      const bar = document.getElementById('bulkActionBar');
      const count = document.getElementById('bulkSelectedCount');
      if (bar && count) {
        if (ids.length > 0) {
          bar.style.display = 'flex';
          count.innerText = ids.length + ' ' + T.bulkSelect;
        } else {
          bar.style.display = 'none';
          const selectAllChk = document.getElementById('bulkSelectAll');
          if (selectAllChk) selectAllChk.checked = false;
        }
      }
    }

    async function executeBulkAction(action) {
      const ids = getSelectedBulkIds();
      if (ids.length === 0) return;
      
      if (action === 'delete') {
        if (!await cyberConfirm(T.bulkConfirmDelete)) return;
      }
      
      const res = await fetch('/api/bulk_action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ids })
      });
      
      if (res.ok) {
        showToast(T.bulkSuccess);
        const selectAll = document.getElementById('bulkSelectAll');
        if (selectAll) selectAll.checked = false;
        document.getElementById('bulkActionBar').style.display = 'none';
        await refreshData();
      } else {
        await cyberAlert(T.bulkFailed);
      }
    }

    const QR_MAX_BYTES = 1000; // encoder verified to 2,300 bytes; decode-tested with zbarimg only (not on real phone cameras); 1,000 is a conservative cap
    function generateQR() {
      const s = servers.find(x => x.id === activeId);
      if (!s) return;
      const targetUrl = s.customLink && s.customLink.trim() !== "" ? s.customLink : (s.host ? "https://" + s.host : "");
      if (!targetUrl) { cyberAlert(T.qrNoUrl); return; }
      if (unescape(encodeURIComponent(targetUrl)).length > QR_MAX_BYTES) { cyberAlert(T.qrTooLong); return; }
      try {
        document.getElementById('qrImage').innerHTML = makeQrSvg(targetUrl);
        document.getElementById('qrContainer').style.display = 'block';
      } catch (e) { cyberAlert(T.qrTooLong); }
    }

    // ============ MINIMAL VIEW (when archive disabled) ============
    function renderMinimalView() {
      if (caps.archive) { return; }
      const container = document.getElementById('minimalView');
      if (!container) { return; }
      if (caps.ping) {
        const pingServers = servers.filter(s => s.host && s.host.trim() !== '' && s.enablePing !== false);
        if (pingServers.length === 0) {
          container.innerHTML = '<div style="padding:24px;text-align:center;color:#64748b;font-family:JetBrains Mono;font-size:0.78rem;background:var(--card-bg);border:1.5px solid rgba(0,240,255,0.25);border-radius:12px;">' +
            (lang === 'en' ? 'No pingable items. Add items with a host URL.' : 'Belum ada item dengan host URL. Tambahkan item dengan host untuk mulai ping.') +
            '</div>';
          return;
        }
        container.innerHTML = '<div class="all-hub-title" style="margin-bottom:8px;"><span style="display:inline-block; animation: bellRingGentle 2s infinite ease-in-out;">⚡</span> PING MONITOR</div>' +
          '<div class="table-card"><table><thead><tr>' +
          '<th style="width:8%;">NO.</th>' +
          '<th style="width:40%; text-align:left; padding-left:8px;">NAME</th>' +
          '<th style="width:37%;">HOST</th>' +
          '<th style="width:15%;">STATUS</th>' +
          '</tr></thead><tbody>' +
          pingServers.map((s, i) =>
            '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td style="text-align:left; padding-left:8px; font-size:0.75rem; color:#e2e8f0;">' + esc(s.name) + '</td>' +
            '<td style="font-family:JetBrains Mono; font-size:0.72rem; color:#7dd3fc; word-break:break-all;">' + esc(s.host) + '</td>' +
            '<td><span class="status-dot-notification status-indicator-node" id="status-' + esc(s.id) + '" data-host="' + esc(s.host) + '" data-id="' + esc(s.id) + '"></span></td>' +
            '</tr>'
          ).join('') +
          '</tbody></table></div>';
        try { triggerPingAll(); } catch(e) {}
      } else {
        const parts = [];
        if (caps.cms) parts.push(T.cmsOnlyMsg);
        if (caps.api) parts.push(T.apiOnlyMsg);
        if (parts.length === 0) parts.push(lang === 'en' ? 'No capabilities enabled. Enable at least one in Developer Options.' : 'Tidak ada capability aktif. Aktifkan minimal satu di Developer Options.');
        container.innerHTML = '<div style="padding:30px; text-align:center; background:var(--card-bg); border:1.5px solid rgba(0,240,255,0.25); border-radius:12px;">' +
          '<div style="font-family:Orbitron,sans-serif; color:var(--border-cyan); margin-bottom:8px; font-size:0.85rem;">MODE DISABLED</div>' +
          '<div style="font-size:0.8rem; color:#94a3b8; line-height:1.5;">' + parts.join('<br>') + '</div></div>';
      }
    }

    // ============ SPA CLIENT RENDERERS ============
    function renderGridCardHtml(s, isPinned) {
      const effectiveHost = s.host && s.host.trim() !== "" ? s.host : "";
      const targetUrl = s.customLink && s.customLink.trim() !== "" ? s.customLink : (effectiveHost ? "https://" + effectiveHost : "#");
      const isBlur = s.mode === 'blur';
      const isMaint = s.mode === 'maintenance';
      const pulseClass = isBlur ? 'pulse-blur' : (isMaint ? 'pulse-maint' : '');
      const displayLabel = s.useHostAsDisplay && effectiveHost ? effectiveHost : s.name;
      const showPingIndicator = effectiveHost !== "" && caps.ping;
      const showCopyButton = s.useHostAsDisplay && effectiveHost !== "";
      const searchKeywords = (s.name + " " + (s.host || "") + " " + (s.category || "") + " " + (s.description || "")).toLowerCase().substring(0, 300);
      const createdDateFormatted = s.createdAt ? formatCustomDateTimeJS(s.createdAt) : '';
      const isDraggable = isLoggedIn && currentSort === 'manual';
      const imgSrc = safeImageSrc(s.imageUrl);
      const thumbHtml = '<div class="card-thumb" style="background:' + gradientFor((s.name || '') + (s.category || '')) + ';">'
        + (imgSrc ? '<img class="thumb-img" src="' + esc(imgSrc) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : '')
        + '<span class="thumb-initial">' + esc(Array.from((s.name || '?').trim())[0] || '?').toUpperCase() + '</span></div>';

      const pinBtn = isLoggedIn ? (isPinned
        ? '<button type="button" class="btn-icon-svg" data-id="' + esc(s.id) + '" onclick="togglePin(this.dataset.id)" title="Unpin" style="padding:4px 6px; font-size:0.55rem; border-color:var(--neon-warning); color:var(--neon-warning);">📌</button>'
        : '<button type="button" class="btn-icon-svg" data-id="' + esc(s.id) + '" onclick="togglePin(this.dataset.id)" title="' + (s.isPinned ? 'Unpin' : 'Pin') + '" style="padding:4px 6px; font-size:0.55rem; border-color:var(--border-cyan);">' + (s.isPinned ? '📌' : '📍') + '</button>'
      ) : '';

      const statusDot = showPingIndicator
        ? '<span class="status-dot-notification status-indicator-node" id="status-' + (isPinned ? 'pin-' : '') + esc(s.id) + '" data-host="' + esc(effectiveHost) + '" data-id="' + esc(s.id) + '" title="Ping"></span>'
        : '<span style="color:#475569; font-size:0.52rem;">-</span>';

      const copyBtn = showCopyButton
        ? '<button type="button" class="btn-icon-svg" title="' + T.tooltipCopy + '" data-url="' + esc(targetUrl) + '" data-mode="' + esc(s.mode || 'normal') + '" onclick="copyHostUrl(this.dataset.url, this.dataset.mode)"' + (isPinned ? ' style="border-color:rgba(245,158,11,0.4); color:var(--neon-warning);"' : '') + '><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>'
        : '';

      const cardClasses = isPinned ? 'grid-card-item pinned-card-special pinned-card-item' : 'grid-card-item server-row-item';
      const topStyle = isPinned ? ' style="border-bottom: 1px solid rgba(245, 158, 11, 0.25);"' : '';
      const groupStyle = isPinned ? ' style="color:var(--neon-warning);"' : '';
      const hostStyle = isPinned ? ' style="max-width:100%; justify-content:center; padding:8px; border-color:rgba(245,158,11,0.5);"' : ' style="max-width:100%; justify-content:center; padding:8px;"';
      const linkStyle = isPinned ? ' style="width:auto; justify-content:center; padding:5px 12px; border-color:rgba(245,158,11,0.5); color:var(--neon-warning); background:rgba(245,158,11,0.08);"' : ' style="width:auto; justify-content:center; padding:5px 12px;"';
      const dateColor = isPinned ? '#94a3b8' : '#64748b';

      return '<div class="' + cardClasses + '" data-category="' + esc(s.category || 'General') + '" data-group="' + esc(s.groupType || 'Independen') + '" data-ispublic="' + (s.isPublic !== false ? 'true' : 'false') + '" data-mode="' + esc(s.mode || 'normal') + '" data-host="' + esc(effectiveHost) + '" data-keywords="' + esc(searchKeywords) + '" data-id="' + esc(s.id) + '"' + (isDraggable ? ' draggable="true" ondragstart="handleDragStart(event, this)" ondragend="handleDragEnd(event, this)" ondragover="handleDragOver(event, this)" ondragleave="handleDragLeave(event, this)" ondrop="handleDrop(event, this)"' : '') + '>'
        + '<div class="grid-card-top"' + topStyle + '>'
        + '<div style="display:flex; align-items:center; gap:5px;">'
        + (isLoggedIn ? '<input type="checkbox" class="bulk-checkbox" value="' + esc(s.id) + '" onchange="updateBulkBar()">' : '')
        + '<span class="grid-card-group"' + groupStyle + '>[' + esc(s.groupType || 'Independen') + ']</span>'
        + '</div>'
        + '<div class="grid-card-meta">' + pinBtn + statusDot + '</div>'
        + '</div>'
        + thumbHtml
        + '<div class="host-badge-btn ' + pulseClass + '" data-id="' + esc(s.id) + '" data-mode="' + esc(s.mode || 'normal') + '" onclick="openDetailModal(this.dataset.id, this.dataset.mode)"' + hostStyle + '>'
        + '<span class="td-host-text" style="text-align:center;">' + esc(displayLabel) + '</span>'
        + (isBlur ? '<div class="frost-glass-overlay">🔒 RESTRICTED</div>' : '')
        + (isMaint ? '<div class="frost-glass-overlay" style="color:var(--neon-warning);">⚠️ PURGE</div>' : '')
        + '</div>'
        + '<div class="grid-card-bottom">'
        + (createdDateFormatted ? '<span style="font-size:0.6rem; color:' + dateColor + ';" title="' + T.createdLbl + '">' + esc(createdDateFormatted) + '</span>' : '<span></span>')
        + '<div style="display:flex; align-items:center; gap:4px; flex:1; justify-content:flex-end;">'
        + '<a href="#" data-url="' + esc(targetUrl) + '" data-mode="' + esc(s.mode || 'normal') + '" data-copy="' + (s.clickCopyMode ? '1' : '0') + '" onclick="handleAnyClick(event, this.dataset.url, this.dataset.mode, this.dataset.copy === \\'1\\')" class="link-btn"' + linkStyle + '><span>' + (isMaint ? 'PURGE' : T.click) + '</span></a>'
        + copyBtn
        + '</div></div></div>';
    }

    function renderListRowHtml(s, index, displayServers) {
      const effectiveHost = s.host && s.host.trim() !== "" ? s.host : "";
      const targetUrl = s.customLink && s.customLink.trim() !== "" ? s.customLink : (effectiveHost ? "https://" + effectiveHost : "#");
      const isBlur = s.mode === 'blur';
      const isMaint = s.mode === 'maintenance';
      const pulseClass = isBlur ? 'pulse-blur' : (isMaint ? 'pulse-maint' : '');
      const displayLabel = s.useHostAsDisplay && effectiveHost ? effectiveHost : s.name;
      const showCopyButton = s.useHostAsDisplay && effectiveHost !== "";
      const searchKeywords = (s.name + " " + (s.host || "") + " " + (s.category || "") + " " + (s.description || "")).toLowerCase().substring(0, 300);
      const createdDateFormatted = s.createdAt ? formatCustomDateTimeJS(s.createdAt) : '-';
      const isDraggable = isLoggedIn && currentSort === 'manual';
      const showPingIndicator = effectiveHost !== "" && caps.ping;

      const reorderBtns = (isLoggedIn && currentSort === 'manual')
        ? '<div class="reorder-btns">'
          + (index > 0 ? '<button type="button" class="btn-arr" data-id="' + esc(s.id) + '" data-dir="up" onclick="moveItem(this.dataset.id, this.dataset.dir)">▲</button>' : '<span style="height:6px;"></span>')
          + (index < displayServers.length - 1 ? '<button type="button" class="btn-arr" data-id="' + esc(s.id) + '" data-dir="down" onclick="moveItem(this.dataset.id, this.dataset.dir)">▼</button>' : '<span style="height:6px;"></span>')
          + '</div>'
        : '';

      const pinBtn = isLoggedIn
        ? '<button type="button" class="btn-icon-svg" data-id="' + esc(s.id) + '" onclick="togglePin(this.dataset.id)" title="' + (s.isPinned ? 'Unpin' : 'Pin') + '" style="padding:4px;"><span style="font-size:0.6rem;">' + (s.isPinned ? '📌' : '📍') + '</span></button>'
        : '';

      const statusCell = showPingIndicator
        ? '<span class="status-dot-notification status-indicator-node" id="status-' + esc(s.id) + '" data-host="' + esc(effectiveHost) + '" data-id="' + esc(s.id) + '" title="Ping"></span>'
        : '<span style="color:#475569; font-size:0.62rem;">-</span>';

      const copyBtn = showCopyButton
        ? '<button type="button" class="btn-icon-svg" title="' + T.tooltipCopy + '" data-url="' + esc(targetUrl) + '" data-mode="' + esc(s.mode || 'normal') + '" onclick="copyHostUrl(this.dataset.url, this.dataset.mode)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>'
        : '';

      const delBtn = isLoggedIn
        ? '<td><button type="button" class="btn-trash-svg" title="' + (lang === 'en' ? 'Delete' : 'Hapus') + '" data-id="' + esc(s.id) + '" data-name="' + esc(s.name) + '" onclick="deleteServer(this.dataset.id, this.dataset.name)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button></td>'
        : '';

      const chk = isLoggedIn ? '<td><input type="checkbox" class="bulk-checkbox" value="' + esc(s.id) + '" onchange="updateBulkBar()"></td>' : '';

      return '<tr class="server-row-item" data-id="' + esc(s.id) + '" data-category="' + esc(s.category || 'General') + '" data-group="' + esc(s.groupType || 'Independen') + '" data-ispublic="' + (s.isPublic !== false ? 'true' : 'false') + '" data-mode="' + esc(s.mode || 'normal') + '" data-host="' + esc(effectiveHost) + '" data-keywords="' + esc(searchKeywords) + '"' + (isDraggable ? ' draggable="true" ondragstart="handleDragStart(event, this)" ondragend="handleDragEnd(event, this)" ondragover="handleDragOver(event, this)" ondragleave="handleDragLeave(event, this)" ondrop="handleDrop(event, this)"' : '') + '>'
        + chk
        + '<td><div style="display:flex; align-items:center; justify-content:center; gap:2px;">' + reorderBtns + '<span>' + (index + 1) + '</span></div></td>'
        + '<td><div class="td-host-wrap">'
        + '<div class="host-badge-btn ' + pulseClass + '" data-id="' + esc(s.id) + '" data-mode="' + esc(s.mode || 'normal') + '" onclick="openDetailModal(this.dataset.id, this.dataset.mode)" title="' + T.tooltipDetail + '">'
        + '<span class="td-host-text">[' + esc(s.groupType || 'Independen') + '] ' + esc(displayLabel) + '</span>'
        + (isBlur ? '<div class="frost-glass-overlay">🔒 RESTRICTED</div>' : '')
        + (isMaint ? '<div class="frost-glass-overlay" style="color:var(--neon-warning);">⚠️ PURGE</div>' : '')
        + '</div>' + pinBtn + copyBtn
        + '</div></td>'
        + '<td><span style="font-size:0.68rem; color:#94a3b8; font-family:\\'JetBrains Mono\\';">' + esc(createdDateFormatted) + '</span></td>'
        + '<td>' + statusCell + '</td>'
        + '<td><a href="#" data-url="' + esc(targetUrl) + '" data-mode="' + esc(s.mode || 'normal') + '" data-copy="' + (s.clickCopyMode ? '1' : '0') + '" onclick="handleAnyClick(event, this.dataset.url, this.dataset.mode, this.dataset.copy === \\'1\\')" class="link-btn"><span>' + (isMaint ? 'PURGE' : T.click) + '</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></a></td>'
        + delBtn
        + '</tr>';
    }

    function renderHubView() {
      if (!caps.archive) { return ''; }
      const list = isLoggedIn ? [...servers] : servers.filter(s => s.isPublic !== false);
      list.sort((a, b) => {
        if (currentSort === 'manual') return 0;
        if (currentSort === 'az') return (a.name || "").localeCompare(b.name || "");
        if (currentSort === 'za') return (b.name || "").localeCompare(a.name || "");
        if (currentSort === 'oldest') return (a.createdAt || 0) - (b.createdAt || 0);
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      const pinnedServers = list.filter(s => s.isPinned);

      let html = '';

      if (pinnedServers.length > 0) {
        html += '<div class="featured-section pinned-always-visible">'
          + '<div class="featured-title"><span style="display:inline-block; animation: bellRingGentle 2s infinite ease-in-out;">📌</span> ' + T.pinnedTitle + '</div>'
          + '<div class="grid-view-wrap comfortable_grid">'
          + pinnedServers.map(s => renderGridCardHtml(s, true)).join('')
          + '</div></div>';
      }

      html += '<div class="all-hub-title"><span style="display:inline-block; animation: bellRingGentle 2s infinite ease-in-out;">⚡</span> ' + T.allHubList + '</div>';

      if (currentDisplayMode === 'list') {
        html += '<div class="table-card"><table><thead><tr>'
          + (isLoggedIn ? '<th style="width: 5%; padding: 0;"><input type="checkbox" id="bulkSelectAll" onchange="toggleSelectAll(this)"></th>' : '')
          + '<th style="width: ' + (isLoggedIn ? '8%' : '9%') + ';">NO.</th>'
          + '<th style="width: ' + (isLoggedIn ? '25%' : '36%') + '; text-align: left; padding-left: 6px;">LIST</th>'
          + '<th style="width: 20%;">' + T.createdLbl.toUpperCase() + '</th>'
          + '<th style="width: 12%;">' + T.status + '</th>'
          + '<th style="width: ' + (isLoggedIn ? '20%' : '19%') + ';">' + T.link + '</th>'
          + (isLoggedIn ? '<th style="width: 10%;"></th>' : '')
          + '</tr></thead><tbody id="dataTableBody">';
        if (list.length === 0) {
          html += '<tr><td colspan="' + (isLoggedIn ? 7 : 5) + '" style="padding: 24px; text-align: center; color: #64748b; font-family: \\'JetBrains Mono\\'; font-size: 0.78rem;">'
            + (lang === 'en' ? 'No items available. Click "ADD NEW" to insert data.' : 'Belum ada data item. Klik tombol "ADD NEW" untuk menambahkan data.')
            + '</td></tr>';
        } else {
          html += list.map((s, i) => renderListRowHtml(s, i, list)).join('');
        }
        html += '</tbody></table></div>';
      } else {
        html += '<div class="grid-view-wrap ' + currentDisplayMode + '">';
        if (list.length === 0) {
          html += '<div style="padding: 24px; text-align: center; color: #64748b; font-family: \\'JetBrains Mono\\'; font-size: 0.78rem; background: var(--card-bg); border: 1.5px solid rgba(0, 240, 255, 0.25); border-radius: 12px;">'
            + (lang === 'en' ? 'No items available. Click "ADD NEW" to insert data.' : 'Belum ada data item. Klik tombol "ADD NEW" untuk menambahkan data.')
            + '</div>';
        } else {
          html += list.map(s => renderGridCardHtml(s, false)).join('');
        }
        html += '</div>';
      }

      html += '<div id="paginationContainer" style="display:none; justify-content:center; align-items:center; gap:6px; margin-top:14px; flex-wrap:wrap;">'
        + '<button type="button" class="btn-cyber" id="pagePrevBtn" onclick="changePage(-1)" style="font-size:0.65rem;">◀ PREV</button>'
        + '<span id="pageInfo" style="font-family:\\'Orbitron\\',sans-serif; font-size:0.68rem; color:var(--border-cyan); padding:0 8px;">PAGE 1 / 1</span>'
        + '<button type="button" class="btn-cyber" id="pageNextBtn" onclick="changePage(1)" style="font-size:0.65rem;">NEXT ▶</button>'
        + '</div>';

      return html;
    }

    async function refreshData() {
      try {
        const res = await fetch('/api/data');
        if (!res.ok) return false;
        const data = await res.json();
        servers.length = 0;
        servers.push(...(data.servers || []));
        if (data.settings) {
          currentDisplayMode = data.settings.displayMode || 'list';
          currentSort = data.settings.activeSort || 'recently';
          lockdownMode = !!data.settings.lockdownMode;
          pingSelection = data.settings.pingSelection || [];
          pingRule34Active = data.settings.pingRule34Active !== false;
          manualCategories = [...new Set(servers.map(s => s.category || "General"))];
          allGroups = [...new Set(servers.map(s => s.groupType || "Independen"))];
          renderFilterCategories();
        }
        if (!caps.archive) {
          renderMinimalView();
        } else {
          const hub = document.getElementById('hubContainer');
          if (hub) { hub.innerHTML = renderHubView(); }
        }
        const bulkBar = document.getElementById('bulkActionBar');
        if (bulkBar) bulkBar.style.display = 'none';
        
        const sortText = document.getElementById('currentSortText');
        if (sortText) sortText.innerText = currentSort.toUpperCase();
        updateLockdownUI();
        renderFiltered();
        try { if (caps.ping) triggerPingAll(); } catch(e) {}
        return true;
      } catch (e) { return false; }
    }

    // ============ LOCKDOWN ============
    function updateLockdownUI() {
      const btn = document.getElementById('lockdownToggleBtn');
      const banner = document.getElementById('lockdownBanner');
      if (btn) {
        if (lockdownMode) {
          btn.style.borderColor = 'var(--neon-pink)';
          btn.style.color = 'var(--neon-pink)';
          btn.style.animation = 'lockdownPulse 2s infinite';
          btn.innerText = '🔓 ' + T.lockdownBtnOn;
        } else {
          btn.style.borderColor = 'rgba(100,116,139,0.5)';
          btn.style.color = '#64748b';
          btn.style.animation = 'none';
          btn.innerText = '🔒 ' + T.lockdownBtnOff;
        }
      }
      if (banner) banner.style.display = lockdownMode ? 'block' : 'none';
    }

    async function toggleLockdown() {
      const res = await fetch('/api/toggle_lockdown', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        lockdownMode = data.lockdownMode;
        updateLockdownUI();
        showToast(lockdownMode ? T.lockdownOn : T.lockdownOff);
      } else {
        await cyberAlert('Failed to toggle lockdown');
      }
    }

    // ============ UI HELPERS ============
    function showToast(msg) {
      const t = document.getElementById('toast');
      if (t) { t.innerText = msg || T.copySuccess; t.style.display = 'block'; setTimeout(() => { t.style.display = 'none'; }, 2000); }
    }

    function checkAnnouncementOverflow() {
      const content = document.getElementById('announcementTextContainer');
      const grad = document.getElementById('announcementGradient');
      const btn = document.getElementById('announcementSeeMoreBtn');
      if (content && grad && btn) {
        if (content.scrollHeight > content.clientHeight || content.textContent.length > 350) {
          grad.style.display = 'block';
          btn.style.display = 'inline-block';
        } else {
          grad.style.display = 'none';
          btn.style.display = 'none';
        }
      }
    }

    function toggleAnnouncementSeeMore() {
      const content = document.getElementById('announcementTextContainer');
      const grad = document.getElementById('announcementGradient');
      const btn = document.getElementById('announcementSeeMoreBtn');
      isAnnouncementExpanded = !isAnnouncementExpanded;
      if (isAnnouncementExpanded) {
        content.classList.add('expanded'); grad.style.display = 'none'; btn.innerText = T.seeLess;
      } else {
        content.classList.remove('expanded'); grad.style.display = 'block'; btn.innerText = T.seeMore;
      }
    }

    function matchesCategory(r) {
      const cat = r.getAttribute('data-category');
      const isPublic = r.getAttribute('data-ispublic') === 'true';
      const mode = r.getAttribute('data-mode');
      const host = r.getAttribute('data-host');
      const statusDot = r.querySelector('.status-indicator-node');
      if (currentFilterCategory === 'ALL') return true;
      if (currentFilterCategory === '[VISIBILITAS: Public]') return isPublic;
      if (currentFilterCategory === '[VISIBILITAS: Private]') return !isPublic;
      if (currentFilterCategory === '[STATUS: Online]') return host && host !== '' && statusDot && statusDot.classList.contains('online');
      if (currentFilterCategory === '[STATUS: Down / Offline]') return host && host !== '' && statusDot && statusDot.classList.contains('offline');
      if (currentFilterCategory === '[STATUS: Restricted]') return mode === 'blur';
      if (currentFilterCategory === '[STATUS: Maintenance / Purge]') return mode === 'maintenance';
      return cat === currentFilterCategory;
    }

    function renderFiltered() {
      const query = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();
      const rows = Array.from(document.querySelectorAll('.server-row-item'));
      currentFilteredRows = rows.filter(r => {
        if (!matchesCategory(r)) return false;
        if (query) {
          const kw = r.getAttribute('data-keywords') || '';
          if (!kw.includes(query)) return false;
        }
        return true;
      });
      const total = currentFilteredRows.length;
      const totalPages = Math.ceil(total / ITEMS_PER_PAGE) || 1;
      if (currentPage > totalPages) currentPage = totalPages;
      if (currentPage < 1) currentPage = 1;
      const start = (currentPage - 1) * ITEMS_PER_PAGE;
      const end = start + ITEMS_PER_PAGE;
      rows.forEach(r => { r.style.display = 'none'; });
      currentFilteredRows.slice(start, end).forEach(r => { r.style.display = ''; });

      const container = document.getElementById('paginationContainer');
      if (container) {
        if (totalPages <= 1) {
          container.style.display = 'none';
        } else {
          container.style.display = 'flex';
          document.getElementById('pageInfo').innerText = 'PAGE ' + currentPage + ' / ' + totalPages + ' (' + total + ' items)';
          document.getElementById('pagePrevBtn').disabled = currentPage <= 1;
          document.getElementById('pageNextBtn').disabled = currentPage >= totalPages;
        }
      }
      updateBulkBar();
    }

    function renderFilterCategories() {
      const box = document.getElementById('filterCategoryList');
      if (!box) return;
      box.innerHTML = manualCategories.map(cat => '<button type="button" class="btn-cyber" data-cat="' + esc(cat) + '" onclick="filterByCategory(this.dataset.cat)" style="justify-content:center;">📁 ' + esc(cat) + '</button>').join('');
      if (currentFilterCategory !== 'ALL' && currentFilterCategory.charAt(0) !== '[' && !manualCategories.includes(currentFilterCategory)) filterByCategory('ALL');
    }
    function changePage(delta) { currentPage += delta; renderFiltered(); }
    function handleSearchInput() { currentPage = 1; renderFiltered(); }

    function filterByCategory(categoryName) {
      currentFilterCategory = categoryName;
      const textEl = document.getElementById('currentFilterText');
      if (textEl) textEl.innerText = categoryName === 'ALL' ? T.allCategories : categoryName;
      currentPage = 1;
      closeModal('filterModal');
      renderFiltered();
    }

    // ============ DRAG & DROP ============
    function handleDragStart(e, row) {
      draggedRowId = row.getAttribute('data-id');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedRowId);
      row.style.opacity = '0.5';
    }
    function handleDragEnd(e, row) { row.style.opacity = ''; document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over')); }
    function handleDragOver(e, row) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    }
    function handleDragLeave(e, row) {
      row.classList.remove('drag-over');
    }
    async function handleDrop(e, targetRow) {
      e.preventDefault();
      targetRow.classList.remove('drag-over');
      const targetId = targetRow.getAttribute('data-id');
      const sourceId = e.dataTransfer.getData('text/plain');
      if (sourceId && sourceId !== targetId) {
        const res = await fetch('/api/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: sourceId, targetId: targetId }) });
        if (res.ok) await refreshData();
        else location.reload();
      }
    }

    async function togglePin(itemId) {
      const res = await fetch('/api/toggle_pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: itemId }) });
      if (res.ok) await refreshData(); else await cyberAlert(T.msgFailedPin);
    }

    async function saveAnnouncementNote() {
      const noteVal = document.getElementById('announcementInput')?.value || '';
      const res = await fetch('/api/save_settings_general', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ announcementNote: noteVal }) });
      if (res.ok) {
        const container = document.getElementById('announcementTextContainer');
        if (container) container.innerHTML = parseMarkdownLinksJS(noteVal);
        isAnnouncementExpanded = false;
        const contentEl = document.getElementById('announcementTextContainer');
        if (contentEl) contentEl.classList.remove('expanded');
        checkAnnouncementOverflow();
        closeModal('editAnnouncementModal');
        showToast(lang === 'en' ? 'Announcement saved!' : 'Pengumuman disimpan!');
      } else { await cyberAlert(T.msgFailedAnnouncement); }
    }

    async function saveSiteTitle() {
      const titleVal = document.getElementById('siteTitleInput')?.value || '';
      if (!titleVal.trim()) { await cyberAlert(lang === 'en' ? 'Website title cannot be empty!' : 'Judul website tidak boleh kosong!'); return; }
      const res = await fetch('/api/save_settings_general', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteTitle: titleVal }) });
      if (res.ok) {
        document.title = titleVal;
        const h1 = document.getElementById('mainSiteTitle');
        if (h1) h1.innerText = titleVal;
        closeModal('settingsModal');
        showToast(lang === 'en' ? 'Title updated!' : 'Judul website diperbarui!');
      } else { await cyberAlert(T.msgFailedTitle); }
    }

    async function saveWebhook() {
      const urlVal = document.getElementById('webhookUrlInput')?.value || '';
      const res = await fetch('/api/save_settings_general', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhookUrl: urlVal }) });
      if (res.ok) { showToast(lang === 'en' ? 'Webhook saved!' : 'Webhook disimpan!'); closeModal('settingsModal'); }
      else { await cyberAlert(T.msgFailedWebhook); }
    }

    async function saveTurnstile() {
      const siteKey = (document.getElementById('turnstileSiteKeyInput')?.value || '').trim();
      const secretInput = document.getElementById('turnstileSecretKeyInput');
      const secretKey = (secretInput?.value || '').trim();
      const hasExisting = secretInput?.dataset.hasSecret === 'true';

      if (!siteKey) {
        if (!await cyberConfirm(lang === 'en' ? 'Disable Turnstile CAPTCHA?' : 'Nonaktifkan Turnstile CAPTCHA?')) return;
        const res = await fetch('/api/save_settings_general', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnstileSiteKey: '', turnstileSecretKey: '' })
        });
        if (res.ok) {
          showToast(lang === 'en' ? 'Turnstile disabled. Reloading...' : 'Turnstile dinonaktifkan. Memuat ulang...');
          setTimeout(() => location.reload(), 1000);
        }
        return;
      }

      if (!secretKey && !hasExisting) {
        await cyberAlert(lang === 'en' ? 'Secret key is required when Turnstile is enabled!' : 'Secret key wajib diisi saat Turnstile diaktifkan!');
        return;
      }

      const body = { turnstileSiteKey: siteKey };
      if (secretKey) body.turnstileSecretKey = secretKey;

      const res = await fetch('/api/save_settings_general', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        showToast(lang === 'en' ? 'Turnstile settings saved. Reloading...' : 'Pengaturan Turnstile disimpan. Memuat ulang...');
        setTimeout(() => location.reload(), 1000);
      } else {
        await cyberAlert(T.msgFailedTurnstile);
      }
    }

    async function saveAutoBackup() {
      const enabled = document.getElementById('autoBackupEnabledInput')?.checked ?? true;
      const retention = parseInt(document.getElementById('autoBackupRetentionDaysInput')?.value) || 30;
      const res = await fetch('/api/save_settings_general', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoBackupEnabled: enabled, autoBackupRetentionDays: retention })
      });
      if (res.ok) showToast(lang === 'en' ? 'Backup settings saved!' : 'Pengaturan backup disimpan!');
      else await cyberAlert(T.msgFailedBackup);
    }

    async function saveDisplayMode(mode) {
      const res = await fetch('/api/save_display_mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ displayMode: mode }) });
      if (res.ok) {
        currentDisplayMode = mode;
        refreshDisplayModalActive();
        closeModal('displayConfigModal');
        await refreshData();
      } else { await cyberAlert(T.msgFailedDisplayMode); }
    }

    async function saveSortMode(sortMode) {
      const res = await fetch('/api/save_sort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sortMode }) });
      if (res.ok) {
        currentSort = sortMode;
        refreshSortModalActive();
        closeModal('sortModal');
        await refreshData();
      } else { await cyberAlert(T.msgFailedSortMode); }
    }

    async function changePassword() {
      const oldPassword = document.getElementById('oldPassInput')?.value || '';
      const newPassword = document.getElementById('newPassInput')?.value || '';
      const confirmPassword = document.getElementById('confirmPassInput')?.value || '';
      if (!oldPassword || !newPassword || !confirmPassword) { await cyberAlert(lang === 'en' ? 'Please fill all password fields!' : 'Mohon lengkapi semua kolom password!'); return; }
      if (newPassword !== confirmPassword) { await cyberAlert(lang === 'en' ? 'New passwords do not match!' : 'Konfirmasi password baru tidak cocok!'); return; }
      const res = await fetch('/api/change_password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword, newPassword, confirmPassword }) });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(lang === 'en' ? 'Password updated successfully!' : 'Password berhasil diperbarui!');
        closeModal('settingsModal');
        setTimeout(() => location.reload(), 1000);
      } else {
        await cyberAlert(data.message || (lang === 'en' ? 'Failed to update password!' : 'Gagal memperbarui password!'));
      }
    }

    async function loadDemoData() {
      if (!await cyberConfirm(lang === 'en' ? 'Load the original 50 items plus CMS examples? Item list must be empty. Public-host ping stays live; existing CMS data is preserved.' : 'Muat 50 item lama plus contoh CMS? Daftar item harus kosong. Ping host publik tetap live; data CMS lama dipertahankan.')) return;
      const res = await fetch('/api/seed_demo', { method: 'POST' });
      if (res.ok) { showToast(T.msgDemoLoaded); await refreshData(); }
      else { const d = await res.json(); await cyberAlert(d.message || T.msgError); }
    }

    function updateToggleVisual(checkboxEl) {
      const thumb = checkboxEl.parentElement.querySelector('.toggle-thumb');
      const track = checkboxEl.parentElement.querySelector('.toggle-track');
      if (checkboxEl.checked) {
        if (thumb) thumb.style.transform = 'translateX(20px)';
        if (track) track.style.backgroundColor = 'rgba(0, 240, 255, 0.35)';
      } else {
        if (thumb) thumb.style.transform = 'translateX(0px)';
        if (track) track.style.backgroundColor = '#1e293b';
      }
    }

    // ============ DEVELOPER OPTIONS ============
    function selectRuntime(profile) {
      document.getElementById('devRuntimeProfile').value = profile;
      document.querySelectorAll('.dev-runtime-card').forEach(el => {
        el.classList.toggle('selected', el.dataset.profile === profile);
      });
    }

    function selectPreset(preset) {
      const presets = {
        ping:    { ping: true,  archive: false, cms: false, api: false },
        archive: { ping: false, archive: true,  cms: false, api: false },
        both:    { ping: true,  archive: true,  cms: false, api: false },
        cms:     { ping: false, archive: false, cms: true,  api: false },
        api:     { ping: false, archive: false, cms: false, api: true  },
        full:    { ping: true,  archive: true,  cms: true,  api: true  }
      };
      const p = presets[preset];
      if (!p) return;
      const map = { ping: 'devCapPing', archive: 'devCapArchive', cms: 'devCapCms', api: 'devCapApi' };
      Object.keys(p).forEach(k => {
        const el = document.getElementById(map[k]);
        if (el) { el.checked = !!p[k]; updateToggleVisual(el); }
      });
      document.querySelectorAll('.dev-preset-card').forEach(el => {
        el.classList.toggle('selected', el.dataset.preset === preset);
      });
    }

    function openDevModal() {
      closeModal('settingsModal');
      const currentProfile = document.getElementById('devRuntimeProfile').value || runtimeProfile || 'worker';
      selectRuntime(currentProfile);
      document.querySelectorAll('.dev-preset-card').forEach(el => el.classList.remove('selected'));
      ['devCapPing','devCapArchive','devCapCms','devCapApi'].forEach(id => {
        const el = document.getElementById(id);
        if (el) updateToggleVisual(el);
      });
      openModal('devModal');
    }

    async function saveDevConfig() {
      const body = {
        runtimeProfile: document.getElementById('devRuntimeProfile').value,
        pingCacheMode: (document.getElementById('devPingCache') || { value: 'auto' }).value,
        capabilities: {
          ping: document.getElementById('devCapPing').checked,
          archive: document.getElementById('devCapArchive').checked,
          cms: document.getElementById('devCapCms').checked,
          api: document.getElementById('devCapApi').checked
        }
      };
      const res = await fetch('/api/save_dev_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        showToast(T.devSaved);
        setTimeout(() => location.reload(), 900);
      } else {
        await cyberAlert(T.devSaveFailed);
      }
    }

    function toggleRule34Mode(checkboxEl) {
      pingRule34Active = checkboxEl.checked;
      updateToggleVisual(checkboxEl);
      const desc = document.getElementById('rule34Desc');
      if (desc) desc.innerText = pingRule34Active ? T.rule34Desc : (lang === 'en' ? 'No maximum limit for active URLs' : 'Tanpa batas maksimal URL aktif');
      if (pingRule34Active) {
        const checkedBoxes = document.querySelectorAll('.ping-domain-chk:checked');
        if (checkedBoxes.length > 34) {
          Array.from(checkedBoxes).slice(34).forEach(cb => { cb.checked = false; updateToggleVisual(cb); });
          cyberAlert(lang === 'en' ? 'Exceeded Rule 34 limit! Excess toggles disabled.' : 'Melebihi batas Rule 34! Toggle ke-35 dan seterusnya otomatis dinonaktifkan.');
        }
      }
    }

    function handlePingToggleLimit(checkboxEl) {
      updateToggleVisual(checkboxEl);
      if (pingRule34Active) {
        const checkedBoxes = document.querySelectorAll('.ping-domain-chk:checked');
        if (checkedBoxes.length > 34) {
          checkboxEl.checked = false; updateToggleVisual(checkboxEl);
          cyberAlert(lang === 'en' ? 'Maximum 34 toggles can be activated when Rule 34 is active!' : 'Maksimal hanya 34 toggle yang dapat diaktifkan saat Rule 34 aktif!');
        }
      }
    }

    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll('input[type="checkbox"]').forEach(chk => {
        if (chk.parentElement.querySelector('.toggle-thumb')) updateToggleVisual(chk);
      });
      checkAnnouncementOverflow();
      if (!caps.archive) {
        renderMinimalView();
      } else {
        const hub = document.getElementById('hubContainer');
        if (hub) hub.innerHTML = renderHubView();
        renderFiltered();
        try { if (caps.ping) triggerPingAll(); } catch(e){}
      }
      if (autoPingIntervalEnabled && caps.ping) {
        const intervalMs = Math.max(10, autoPingIntervalSeconds) * 1000;
        autoPingTimer = setInterval(() => {
          if (!lockdownMode) { try { triggerPingAll(); } catch(e){} }
        }, intervalMs);
      }
      updateLockdownUI();
    });

    function copyDetailText(elementId) {
      const el = document.getElementById(elementId);
      if (el) {
        const text = el.innerText || el.textContent;
        if (text && text !== '-') { copyText(text, T.copySuccess); }
        else { showToast(T.msgNoData); }
      }
    }

    function toggleSeeMoreDesc() {
      const descEl = document.getElementById('detDescription'), gradEl = document.getElementById('detDescGradient'), seeMoreBtn = document.getElementById('detDescSeeMoreBtn');
      isDescExpanded = !isDescExpanded;
      if (isDescExpanded) { descEl.style.maxHeight = 'none'; gradEl.style.display = 'none'; seeMoreBtn.innerText = T.seeLess; }
      else { descEl.style.maxHeight = '4.5em'; gradEl.style.display = 'block'; seeMoreBtn.innerText = T.seeMore; }
    }

    function cyberAlert(msg) {
      return new Promise((resolve) => {
        const m = document.getElementById('cyberModal'), txt = document.getElementById('cyberAlertMsg'), acts = document.getElementById('cyberAlertActions');
        txt.innerText = msg;
        acts.innerHTML = '<button type="button" class="btn-cyber" id="cyberOkBtn">OK</button>';
        m.classList.add('active');
        document.getElementById('cyberOkBtn').onclick = () => { m.classList.remove('active'); resolve(true); };
      });
    }

    function cyberConfirm(msg) {
      return new Promise((resolve) => {
        const m = document.getElementById('cyberModal'), txt = document.getElementById('cyberAlertMsg'), acts = document.getElementById('cyberAlertActions');
        txt.innerText = msg;
        acts.innerHTML = '<button type="button" class="btn-cyber" id="cyberCancelBtn" style="border-color:#64748b; color:#94a3b8;">' + T.cancel + '</button><button type="button" class="btn-cyber" id="cyberOkBtn" style="border-color:var(--neon-warning); color:var(--neon-warning);">' + T.yes + '</button>';
        m.classList.add('active');
        document.getElementById('cyberOkBtn').onclick = () => { m.classList.remove('active'); resolve(true); };
        document.getElementById('cyberCancelBtn').onclick = () => { m.classList.remove('active'); resolve(false); };
      });
    }

    function openCyberDropdown(targetInputId, labels, values) {
      const modal = document.getElementById('cyberDropdownModal');
      const optContainer = document.getElementById('cyberDropdownOptions');
      document.getElementById('cyberDropdownTitle').innerText = lang === 'en' ? 'SELECT OPTION' : 'PILIH OPSI';
      optContainer.innerHTML = '';
      labels.forEach((lbl, idx) => {
        const val = values[idx];
        const btn = document.createElement('div');
        btn.className = 'cyber-dropdown-item';
        btn.innerText = lbl;
        const currentVal = document.getElementById(targetInputId).value;
        if (currentVal === val) btn.classList.add('selected');
        btn.onclick = () => {
          document.getElementById(targetInputId).value = val;
          const textSpan = document.getElementById(targetInputId + 'Text');
          if (textSpan) textSpan.innerText = lbl;
          closeCyberDropdown();
        };
        optContainer.appendChild(btn);
      });
      modal.classList.add('active');
    }

    function openCategoryDropdown(targetInputId) {
      const modal = document.getElementById('cyberDropdownModal');
      const optContainer = document.getElementById('cyberDropdownOptions');
      document.getElementById('cyberDropdownTitle').innerText = lang === 'en' ? 'SELECT CATEGORY' : 'PILIH KATEGORI';
      optContainer.innerHTML = '';
      manualCategories.forEach(cat => {
        const btn = document.createElement('div');
        btn.className = 'cyber-dropdown-item';
        btn.innerText = cat;
        const currentVal = document.getElementById(targetInputId).value;
        if (currentVal === cat) btn.classList.add('selected');
        btn.onclick = () => {
          document.getElementById(targetInputId).value = cat;
          const textSpan = document.getElementById(targetInputId + 'Text');
          if (textSpan) textSpan.innerText = cat;
          closeCyberDropdown();
        };
        optContainer.appendChild(btn);
      });
      modal.classList.add('active');
    }

    function openGroupDropdown(targetInputId) {
      const modal = document.getElementById('cyberDropdownModal');
      const optContainer = document.getElementById('cyberDropdownOptions');
      document.getElementById('cyberDropdownTitle').innerText = lang === 'en' ? 'SELECT GROUP' : 'PILIH GROUP';
      optContainer.innerHTML = '';
      const uniqueGroups = [...new Set(['Independen', ...allGroups])];
      uniqueGroups.forEach(g => {
        const btn = document.createElement('div');
        btn.className = 'cyber-dropdown-item';
        btn.innerText = g;
        const currentVal = document.getElementById(targetInputId).value;
        if (currentVal === g) btn.classList.add('selected');
        btn.onclick = () => {
          document.getElementById(targetInputId).value = g;
          const textSpan = document.getElementById(targetInputId + 'Text');
          if (textSpan) textSpan.innerText = g;
          closeCyberDropdown();
        };
        optContainer.appendChild(btn);
      });
      modal.classList.add('active');
    }

    function openExportChoiceModal(exportType) {
      const modal = document.getElementById('cyberDropdownModal');
      const optContainer = document.getElementById('cyberDropdownOptions');
      document.getElementById('cyberDropdownTitle').innerText = exportType === 'group' ? (lang === 'en' ? 'SELECT GROUP FOR BACKUP' : 'PILIH GROUP UNTUK BACKUP') : (lang === 'en' ? 'SELECT CATEGORY FOR BACKUP' : 'PILIH KATEGORI UNTUK BACKUP');
      optContainer.innerHTML = '';
      const items = exportType === 'group' ? [...new Set(servers.map(s => s.groupType || 'Independen'))] : manualCategories;
      items.forEach(item => {
        const btn = document.createElement('div');
        btn.className = 'cyber-dropdown-item';
        btn.innerText = item;
        btn.onclick = () => { closeCyberDropdown(); location.href = '/api/export_filtered?type=' + exportType + '&val=' + encodeURIComponent(item); };
        optContainer.appendChild(btn);
      });
      modal.classList.add('active');
    }

    function openClearChoiceModal(clearType) {
      const modal = document.getElementById('cyberDropdownModal');
      const optContainer = document.getElementById('cyberDropdownOptions');
      document.getElementById('cyberDropdownTitle').innerText = clearType === 'group' ? (lang === 'en' ? 'SELECT GROUP TO CLEAR' : 'PILIH GROUP UNTUK DIHAPUS') : (lang === 'en' ? 'SELECT CATEGORY TO CLEAR' : 'PILIH KATEGORI UNTUK DIHAPUS');
      optContainer.innerHTML = '';
      const items = clearType === 'group' ? [...new Set(servers.map(s => s.groupType || 'Independen'))] : manualCategories;
      items.forEach(item => {
        const btn = document.createElement('div');
        btn.className = 'cyber-dropdown-item';
        btn.style.borderColor = 'var(--neon-warning)';
        btn.style.color = 'var(--neon-warning)';
        btn.innerText = item;
        btn.onclick = async () => {
          closeCyberDropdown();
          if (await cyberConfirm(lang === 'en' ? 'Are you sure to clear all items in ' + clearType + ' "' + item + '"?' : 'Yakin ingin menghapus semua item dalam ' + clearType + ' "' + item + '"?')) {
            executeClearFiltered(clearType, item);
          }
        };
        optContainer.appendChild(btn);
      });
      modal.classList.add('active');
    }

    async function executeClearFiltered(targetType, targetValue) {
      targetValue = targetValue || '';
      if (targetType === 'all') { if (!await cyberConfirm(lang === 'en' ? 'WARNING: All system data will be permanently cleared! Proceed?' : 'PERINGATAN: Seluruh data sistem akan dihapus permanen! Lanjutkan?')) return; }
      const res = await fetch('/api/clear_filtered', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetType, targetValue }) });
      if (res.ok) { closeModal('clearAllModal'); await refreshData(); }
      else await cyberAlert(T.clearFailed);
    }

    function handleFileRestoreUpload(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(e) {
        const txtArea = document.getElementById('restoreJsonInput');
        if (txtArea) txtArea.value = e.target.result;
        showToast(lang === 'en' ? 'File successfully loaded to editor!' : 'File berhasil dimuat ke editor!');
      };
      reader.readAsText(file);
    }

    function closeCyberDropdown() { document.getElementById('cyberDropdownModal').classList.remove('active'); }

    // BUG FIX: Modal Active State Refresh
    function refreshSortModalActive() {
      document.querySelectorAll("#sortModal [data-sort]").forEach(btn => {
        const isActive = btn.dataset.sort === currentSort;
        btn.classList.toggle("active-option", isActive);
      });
    }
    function refreshDisplayModalActive() {
      document.querySelectorAll("#displayConfigModal [data-display]").forEach(btn => {
        const isActive = btn.dataset.display === currentDisplayMode;
        btn.classList.toggle("active-option", isActive);
      });
    }

    function openModal(modalId) {
      if (modalId === 'backupModal') { const txt = document.getElementById('restoreJsonInput'); if (txt) txt.value = ""; const fileInp = document.getElementById('restoreFileInput'); if (fileInp) fileInp.value = ""; }
      if (modalId === 'addModal') {
        document.getElementById('addCustomFieldsContainer').innerHTML = '';
        document.getElementById('addUseHostAsDisplay').checked = false;
        document.getElementById('addClickCopyMode').checked = false;
        document.getElementById('addEnablePing').checked = true;
        document.getElementById('addIsPinned').checked = false;
        document.getElementById('addCategory').value = 'General';
        document.getElementById('addCategoryText').innerText = 'General';
        document.getElementById('addGroupType').value = 'Independen';
        document.getElementById('addGroupTypeText').innerText = 'Independen';
        document.getElementById('addName').value = '';
        document.getElementById('addDescription').value = '';
        document.getElementById('addHost').value = '';
        document.getElementById('addCustomLink').value = '';
        document.getElementById('addImageUrl').value = '';
        document.getElementById('addIsPublic').value = 'true';
        document.getElementById('addIsPublicText').innerText = T.visPubOpt;
        document.getElementById('addMode').value = 'normal';
        document.getElementById('addModeText').innerText = T.statusNorm;
        updateToggleVisual(document.getElementById('addUseHostAsDisplay'));
        updateToggleVisual(document.getElementById('addClickCopyMode'));
        updateToggleVisual(document.getElementById('addEnablePing'));
        updateToggleVisual(document.getElementById('addIsPinned'));
        updateDisplayToggleLabel('add');
      }
      if (modalId === "sortModal") refreshSortModalActive();
      if (modalId === "displayConfigModal") refreshDisplayModalActive();
      const el = document.getElementById(modalId); if (el) el.classList.add('active');
      if (modalId === 'authModal' && window.turnstile) {
        setTimeout(function() {
          try {
            document.querySelectorAll('.cf-turnstile').forEach(function(tse) {
              if (!tse.querySelector('iframe')) window.turnstile.render(tse);
            });
          } catch(e) {}
        }, 100);
      }
    }
    function closeModal(modalId) { const el = document.getElementById(modalId); if (el) el.classList.remove('active'); }

    function updateDisplayToggleLabel(prefix) {
      const chk = document.getElementById(prefix + 'UseHostAsDisplay');
      const desc = document.getElementById(prefix + 'DisplayToggleDesc');
      if (chk && desc) {
        if (chk.checked) desc.innerHTML = lang === 'en' ? 'URL (Column 3)' : 'URL (Kolom 3)';
        else desc.innerHTML = lang === 'en' ? 'Name (Column 1)' : 'Nama (Kolom 1)';
      }
    }

    function addCustomFieldInput(containerId, labelVal, valueVal) {
      labelVal = labelVal || ''; valueVal = valueVal || '';
      const container = document.getElementById(containerId);
      if (!container) return;
      if (container.querySelectorAll('.custom-field-row').length >= 5) { cyberAlert(T.msgMaxCustomFields); return; }
      const row = document.createElement('div');
      row.className = 'custom-field-row';
      row.style.cssText = 'display:flex; gap:5px; align-items:center;';
      const lblInput = document.createElement('input');
      lblInput.type = 'text'; lblInput.placeholder = 'Label'; lblInput.className = 'cf-label'; lblInput.value = labelVal; lblInput.style.flex = '1';
      const valInput = document.createElement('input');
      valInput.type = 'text'; valInput.placeholder = 'Value'; valInput.className = 'cf-value'; valInput.value = valueVal; valInput.style.flex = '1.5';
      const delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.className = 'btn-trash-svg'; delBtn.style.padding = '6px';
      delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      delBtn.onclick = () => row.remove();
      row.appendChild(lblInput); row.appendChild(valInput); row.appendChild(delBtn);
      container.appendChild(row);
    }

    function collectCustomFields(containerId) {
      const container = document.getElementById(containerId);
      if (!container) return [];
      const rows = container.querySelectorAll('.custom-field-row');
      const fields = [];
      rows.forEach((r, idx) => {
        if (idx < 5) {
          const l = r.querySelector('.cf-label')?.value.trim();
          const v = r.querySelector('.cf-value')?.value.trim();
          if (l && v) fields.push({ label: l, value: v });
        }
      });
      return fields;
    }

    function toggleLang() {
      const nextLang = lang === 'id' ? 'en' : 'id';
      document.cookie = "pref_lang=" + nextLang + "; Path=/; SameSite=Lax; Max-Age=31536000;";
      const u = new URL(location.href);
      u.searchParams.set("lang", nextLang);
      location.href = u.toString();
    }

    function togglePassVisibility(inputId, btnEl) {
      const inp = document.getElementById(inputId);
      if (inp) { inp.type = inp.type === "password" ? "text" : "password"; btnEl.innerText = inp.type === "password" ? "👁️" : "🙈"; }
    }

    async function copyHostUrl(targetUrl, mode) {
      if (!isLoggedIn && (mode === 'blur' || mode === 'maintenance')) { await cyberAlert('Access Denied!'); return; }
      copyText(targetUrl, T.msgCopiedPrefix + targetUrl);
    }

    async function handleAnyClick(event, targetUrl, mode, isCopy) {
      event.preventDefault();
      if (!isLoggedIn && (mode === 'blur' || mode === 'maintenance')) { await cyberAlert('Access Denied!'); return; }
      if (!targetUrl || targetUrl === '#') { showToast(lang === 'en' ? 'No target URL!' : 'Tidak ada URL target!'); return; }
      if (isCopy) {
        copyText(targetUrl, T.msgUrlCopiedPrefix + targetUrl);
      } else if (!safeHttpUrl(targetUrl)) {
        await cyberAlert(T.invalidUrl);
      } else {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
    }

    function copyAllDomains() {
      const validServers = isLoggedIn ? servers : servers.filter(s => s.isPublic !== false && s.mode !== 'blur' && s.mode !== 'maintenance');
      const activeHosts = validServers.map(s => s.host).filter(h => h && h.trim() !== "");
      if (!activeHosts.length) { showToast(lang === 'en' ? 'No active URL!' : 'No active URL!'); return; }
      copyText(activeHosts.join('\\n'), 'All Active URLs Copied (' + activeHosts.length + ')');
    }

    async function savePingSelection() {
      let selectedHosts = Array.from(document.querySelectorAll('.ping-domain-chk:checked')).map(cb => cb.value);
      const pingRule34ActiveVal = document.getElementById('cfgPingRule34Active')?.checked ?? true;
      if (pingRule34ActiveVal && selectedHosts.length > 34) selectedHosts = selectedHosts.slice(0, 34);
      const autoPingIntervalEnabledVal = document.getElementById('cfgAutoPingIntervalEnabled')?.checked ?? false;
      const autoPingIntervalSecondsVal = parseInt(document.getElementById('cfgAutoPingIntervalSeconds')?.value) || 30;
      const res = await fetch('/api/save_ping_selection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selection: selectedHosts, pingRule34Active: pingRule34ActiveVal, autoPingIntervalEnabled: autoPingIntervalEnabledVal, autoPingIntervalSeconds: autoPingIntervalSecondsVal })
      });
      if (res.ok) {
        pingSelection = selectedHosts;
        pingRule34Active = pingRule34ActiveVal;
        closeModal('pingConfigModal');
        showToast(lang === 'en' ? 'Ping settings saved!' : 'Pengaturan ping disimpan!');
      } else await cyberAlert('Failed!');
    }

    let pingSkipped = 0, pingSkipReason = '';
    function checkSinglePing(host, itemId) {
      if (!host || lockdownMode || !caps.ping) return Promise.resolve();
      return fetch('/api/check?host=' + encodeURIComponent(host)).then(res => res.json()).then(data => {
        if (data.lockdown || data.disabled) return;
        if (data.throttled || data.ignored) { pingSkipped++; pingSkipReason = data.reason || (data.throttled ? 'rate_limited' : 'host_not_in_items'); document.querySelectorAll('.status-indicator-node[data-id="' + itemId + '"]').forEach(el => { el.title = 'skipped: ' + pingSkipReason; }); return; }
        document.querySelectorAll('.status-indicator-node[data-id="' + itemId + '"]').forEach(elItem => {
          elItem.className = 'status-dot-notification status-indicator-node ' + (data.online ? 'online' : 'offline');
        });
        try {
          let hist = JSON.parse(localStorage.getItem('uptime_' + itemId) || '[]');
          hist.push(data.online ? 1 : 0);
          if (hist.length > 20) hist = hist.slice(hist.length - 20);
          localStorage.setItem('uptime_' + itemId, JSON.stringify(hist));
        } catch(e) {}
      }).catch(() => {
        if (lockdownMode || !caps.ping) return;
        document.querySelectorAll('.status-indicator-node[data-id="' + itemId + '"]').forEach(elItem => {
          elItem.className = 'status-dot-notification status-indicator-node offline';
        });
        try {
          let hist = JSON.parse(localStorage.getItem('uptime_' + itemId) || '[]');
          hist.push(0);
          if (hist.length > 20) hist = hist.slice(hist.length - 20);
          localStorage.setItem('uptime_' + itemId, JSON.stringify(hist));
        } catch(e) {}
      });
    }

    async function triggerPingAll() {
      if (!caps.ping) { return; }
      if (lockdownMode) {
        showToast(T.pingDisabledLockdown);
        return;
      }
      pingSkipped = 0;
      let targets = servers.filter(s => s.enablePing !== false && s.host && s.host.trim() !== "");
      if (pingRule34Active) {
        if (pingSelection.length > 0) targets = targets.filter(s => pingSelection.includes(s.host));
        else targets = targets.slice(0, 34);
      }
      for (let i = 0; i < targets.length; i += 5) {
        await Promise.all(targets.slice(i, i + 5).map(s => checkSinglePing(s.host, s.id)));
        await new Promise(r => setTimeout(r, 80));
      }
      try { renderFiltered(); } catch(e) {}
      if (pingSkipped > 0) showToast((lang === 'en' ? 'Ping done, skipped: ' : 'Ping selesai, dilewati: ') + pingSkipped + ' (' + pingSkipReason + ')');
      else showToast(lang === 'en' ? 'Ping Complete!' : 'Ping Selesai!');
    }

    async function doLogin() {
      const uEl = document.getElementById('loginUser'), pEl = document.getElementById('loginPass');
      if (!uEl || !pEl) return;

      const turnstileTokenEl = document.querySelector('[name="cf-turnstile-response"]');
      const turnstileToken = turnstileTokenEl ? turnstileTokenEl.value : '';
      if (${turnstileSiteKey ? 'true' : 'false'} && !turnstileToken) {
        await cyberAlert(lang === 'en' ? 'Please complete the CAPTCHA first!' : 'Silakan selesaikan CAPTCHA terlebih dahulu!');
        return;
      }

      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uEl.value.trim(), password: pEl.value.trim(), turnstileToken })
      });
      if (res.ok) {
        location.reload();
      } else {
        const d = await res.json();
        if (window.turnstile) { try { window.turnstile.reset(); } catch(e) {} }
        await cyberAlert(d.message || T.msgError);
      }
    }

    async function doLogout() {
      try { await fetch('/api/logout', { method: 'POST' }); } catch(e){}
      document.cookie = "auth_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT;";
      location.reload();
    }

    async function restoreBackupData() {
      const inp = document.getElementById('restoreJsonInput');
      if (!inp || !inp.value.trim()) return;
      try {
        const parsed = JSON.parse(inp.value.trim());
        if (!await cyberConfirm(lang === 'en' ? 'Restore / merge this backup data?' : 'Pulihkan / gabungkan data backup ini?')) return;
        const res = await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) });
        if (res.ok) { closeModal('backupModal'); location.reload(); }
        else await cyberAlert(lang === 'en' ? 'Restore failed!' : 'Restore gagal!');
      } catch (e) { await cyberAlert(lang === 'en' ? 'Invalid JSON format!' : 'Format JSON tidak valid!'); }
    }

    async function saveServer() {
      const name = (document.getElementById('addName')?.value || '').trim();
      if (!name) { await cyberAlert(T.msgNameRequired); return; }
      const category = (document.getElementById('addCategory')?.value || '').trim() || 'General';
      const groupType = (document.getElementById('addGroupType')?.value || '').trim() || 'Independen';
      const description = (document.getElementById('addDescription')?.value || '').trim();
      const host = (document.getElementById('addHost')?.value || '').trim();
      const customLink = (document.getElementById('addCustomLink')?.value || '').trim();
      const imageUrl = (document.getElementById('addImageUrl')?.value || '').trim();
      const enablePing = document.getElementById('addEnablePing')?.checked ?? true;
      const useHostAsDisplay = document.getElementById('addUseHostAsDisplay')?.checked ?? false;
      const clickCopyMode = document.getElementById('addClickCopyMode')?.checked ?? false;
      const isPublic = document.getElementById('addIsPublic')?.value === 'true';
      const mode = document.getElementById('addMode')?.value || 'normal';
      const isPinned = document.getElementById('addIsPinned')?.checked ?? false;
      const customFields = collectCustomFields('addCustomFieldsContainer');
      const res = await fetch('/api/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, category, groupType, description, host, customLink, imageUrl, enablePing, useHostAsDisplay, clickCopyMode, isPublic, mode, isPinned, customFields }) });
      if (res.ok) { closeModal('addModal'); await refreshData(); }
      else { const d = await res.json(); await cyberAlert(d.message || T.msgError); }
    }

    async function openDetailModal(itemId, mode) {
      if (!isLoggedIn && (mode === 'blur' || mode === 'maintenance')) { await cyberAlert('Access Denied!'); return; }
      const s = servers.find(x => x.id === itemId);
      if (!s) return;
      activeId = itemId;
      
      document.getElementById('qrContainer').style.display = 'none';
      document.getElementById('qrImage').innerHTML = '';
      
      document.getElementById('detName').innerText = s.name || '-';
      document.getElementById('detCreatedTime').innerText = s.createdAt ? formatCustomDateTimeJS(s.createdAt) : '-';
      const descEl = document.getElementById('detDescription'), gradEl = document.getElementById('detDescGradient'), seeMoreBtn = document.getElementById('detDescSeeMoreBtn');
      const descText = s.description || '-';
      if (descText === '-') descEl.textContent = '-'; else descEl.innerHTML = markdownToHtml(descText);
      const dImg = safeImageSrc(s.imageUrl), dWrap = document.getElementById('detImageWrap');
      if (dImg) { document.getElementById('detImage').src = dImg; dWrap.style.display = 'block'; } else { document.getElementById('detImage').removeAttribute('src'); dWrap.style.display = 'none'; }
      isDescExpanded = false;
      descEl.style.maxHeight = '4.5em';
      setTimeout(() => {
        if (descEl.scrollHeight > descEl.clientHeight || descText.length > 150) {
          gradEl.style.display = 'block'; seeMoreBtn.style.display = 'inline-block'; seeMoreBtn.innerText = T.seeMore;
        } else { gradEl.style.display = 'none'; seeMoreBtn.style.display = 'none'; }
      }, 50);
      document.getElementById('detHost').innerText = s.host || '-';
      document.getElementById('detCustomLink').innerText = (s.customLink && s.customLink.trim() !== '') ? s.customLink : (s.host ? ('https://' + s.host) : '-');

      const uptimeBox = document.getElementById('detUptimeBox');
      const uptimeBars = document.getElementById('detUptimeBars');
      if (s.host && caps.ping) {
        uptimeBox.style.display = 'block';
        uptimeBars.innerHTML = '';
        try {
          const hist = JSON.parse(localStorage.getItem('uptime_' + s.id) || '[]');
          if (hist.length === 0) {
            uptimeBars.innerHTML = '<span style="font-size:0.65rem; color:#64748b;">' + T.noHistory + '</span>';
          } else {
            hist.forEach(status => {
              const bar = document.createElement('div');
              bar.className = 'uptime-bar ' + (status === 1 ? 'up' : 'down');
              bar.title = status === 1 ? 'Online' : 'Offline';
              uptimeBars.appendChild(bar);
            });
          }
        } catch(e) {}
      } else {
        uptimeBox.style.display = 'none';
      }

      const pubBtn = document.getElementById('detPubBtn');
      if (pubBtn) { pubBtn.innerText = (s.isPublic !== false) ? T.labelPublic : T.labelPrivate; pubBtn.style.color = (s.isPublic !== false) ? 'var(--border-cyan)' : 'var(--neon-pink)'; }
      const modeBtn = document.getElementById('detModeBtn');
      if (modeBtn) {
        let mText = T.labelOnline; let mColor = 'var(--neon-green)';
        if (s.mode === 'blur') { mText = T.labelRestricted; mColor = 'var(--neon-pink)'; }
        else if (s.mode === 'maintenance') { mText = T.labelPurge; mColor = 'var(--neon-warning)'; }
        modeBtn.innerText = mText; modeBtn.style.color = mColor;
      }
      const customFieldsView = document.getElementById('detCustomFieldsView');
      customFieldsView.innerHTML = '';
      if (Array.isArray(s.customFields)) {
        s.customFields.forEach((cf, cIdx) => {
          if (!isLoggedIn && publicCols.customFields && publicCols.customFields[cf.label] === false) return;
          const row = document.createElement('div');
          row.className = 'det-box-shimmer';
          row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 10px;';
          const leftWrap = document.createElement('div');
          const lblSpan = document.createElement('span');
          lblSpan.className = 'det-label-shimmer'; lblSpan.textContent = cf.label;
          const valDiv = document.createElement('div');
          valDiv.id = 'detCf_' + cIdx;
          valDiv.style.cssText = "font-family:'JetBrains Mono'; color:#e2e8f0; font-size:0.8rem; font-weight:600;";
          valDiv.textContent = cf.value;
          leftWrap.appendChild(lblSpan); leftWrap.appendChild(valDiv);
          const copyBtn = document.createElement('button');
          copyBtn.type = 'button'; copyBtn.className = 'btn-icon-svg';
          copyBtn.onclick = () => copyDetailText('detCf_' + cIdx);
          copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
          row.appendChild(leftWrap); row.appendChild(copyBtn);
          customFieldsView.appendChild(row);
        });
      }
      document.getElementById('detGroupCustomLink').style.display = isLoggedIn || publicCols.showCustomLink ? 'flex' : 'none';
      disableEditMode();
      openModal('detailModal');
    }

    function enableEditMode() {
      const s = servers.find(x => x.id === activeId);
      if (!s) return;
      document.getElementById('editName').value = s.name || '';
      document.getElementById('editCategory').value = s.category || '';
      document.getElementById('editCategoryText').innerText = s.category || 'General';
      document.getElementById('editGroupType').value = s.groupType || '';
      document.getElementById('editGroupTypeText').innerText = s.groupType || 'Independen';
      document.getElementById('editDescription').value = s.description || '';
      document.getElementById('editHost').value = s.host || '';
      document.getElementById('editCustomLink').value = s.customLink || '';
      document.getElementById('editImageUrl').value = s.imageUrl || '';
      const enablePingChk = document.getElementById('editEnablePing');
      enablePingChk.checked = s.enablePing !== false; updateToggleVisual(enablePingChk);
      const useHostChk = document.getElementById('editUseHostAsDisplay');
      useHostChk.checked = !!s.useHostAsDisplay; updateToggleVisual(useHostChk); updateDisplayToggleLabel('edit');
      const clickCopyChk = document.getElementById('editClickCopyMode');
      clickCopyChk.checked = !!s.clickCopyMode; updateToggleVisual(clickCopyChk);
      const editContainer = document.getElementById('editCustomFieldsContainer');
      editContainer.innerHTML = '';
      if (Array.isArray(s.customFields)) s.customFields.forEach(cf => addCustomFieldInput('editCustomFieldsContainer', cf.label, cf.value));
      document.getElementById('editIsPublic').value = s.isPublic !== false ? 'true' : 'false';
      document.getElementById('editIsPublicText').innerText = s.isPublic !== false ? T.visPubOpt : T.visPubPriv;
      const modeVal = s.mode || 'normal';
      document.getElementById('editModeVal').value = modeVal;
      document.getElementById('editModeValText').innerText = modeVal === 'blur' ? T.statusRest : (modeVal === 'maintenance' ? T.statusMaint : T.statusNorm);
      document.getElementById('modalTitle').innerText = T.editDataBtn;
      document.getElementById('viewMode').style.display = 'none';
      document.getElementById('editMode').style.display = 'block';
    }

    function disableEditMode() {
      document.getElementById('modalTitle').innerText = T.detailTitle;
      document.getElementById('viewMode').style.display = 'block';
      document.getElementById('editMode').style.display = 'none';
    }

    async function saveEditServer() {
      const name = (document.getElementById('editName')?.value || '').trim();
      if (!name) { await cyberAlert(T.msgNameRequired); return; }
      const category = (document.getElementById('editCategory')?.value || '').trim() || 'General';
      const groupType = (document.getElementById('editGroupType')?.value || '').trim() || 'Independen';
      const description = (document.getElementById('editDescription')?.value || '').trim();
      const host = (document.getElementById('editHost')?.value || '').trim();
      const customLink = (document.getElementById('editCustomLink')?.value || '').trim();
      const imageUrl = (document.getElementById('editImageUrl')?.value || '').trim();
      const enablePing = document.getElementById('editEnablePing')?.checked ?? true;
      const useHostAsDisplay = document.getElementById('editUseHostAsDisplay')?.checked ?? false;
      const clickCopyMode = document.getElementById('editClickCopyMode')?.checked ?? false;
      const isPublic = document.getElementById('editIsPublic')?.value === 'true';
      const mode = document.getElementById('editModeVal')?.value || 'normal';
      const customFields = collectCustomFields('editCustomFieldsContainer');
      const res = await fetch('/api/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: activeId, name, category, groupType, description, host, customLink, imageUrl, enablePing, useHostAsDisplay, clickCopyMode, isPublic, mode, customFields }) });
      if (res.ok) { closeModal('detailModal'); await refreshData(); }
      else { const d = await res.json(); await cyberAlert(d.message || T.msgError); }
    }

    async function moveItem(itemId, direction) {
      const res = await fetch('/api/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, direction }) });
      if (res.ok) await refreshData();
    }

    async function deleteServer(itemId, itemName) {
      const delMsg = lang === 'en'
        ? 'Delete "' + (itemName || itemId) + '"?'
        : 'Hapus "' + (itemName || itemId) + '"?';
      if (!await cyberConfirm(delMsg)) return;
      const res = await fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: itemId }) });
      if (res.ok) await refreshData();
    }

  </script>
</body>
</html>`;
}


// ============================================================
// NODE.JS SHIM — run with: node worker.js
// ============================================================
if (typeof addEventListener === "undefined" && typeof module !== "undefined" && typeof require === "function") {
  try {
    if (typeof globalThis.crypto === "undefined") globalThis.crypto = require("crypto").webcrypto;
    const http = require("http");
    const PORT = process.env.PORT || 8787;
    const env = Object.assign({ RUNTIME_PROFILE: "vps" }, process.env);
    const TRUST_PROXY = String(process.env.TRUST_PROXY || "") === "1";
    const BODY_LIMIT = MAX_BODY_JSON_BYTES;
    const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "proxy-authenticate", "content-length", "expect", "x-real-ip", "cf-connecting-ip"]);

    // Stops reading as soon as the limit is crossed so a huge upload cannot exhaust memory.
    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = []; let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > BODY_LIMIT) { reject(Object.assign(new Error("Payload too large"), { status: 413 })); req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      });
    }

    const server = http.createServer(async (req, res) => {
      try {
        const proto = (TRUST_PROXY && req.headers["x-forwarded-proto"]) || "http";
        const host = req.headers.host || ("localhost:" + PORT);
        const url = new URL(req.url, proto + "://" + host);
        let body;
        if (req.method !== "GET" && req.method !== "HEAD") body = await readBody(req);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined || HOP.has(k)) continue;
          headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        }
        headers.delete("cf-connecting-ip"); // Never trust a client-supplied Cloudflare identity on Node.
        const fwd = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
        headers.set("x-real-ip", fwd || (req.socket && req.socket.remoteAddress) || "unknown");
        const webReq = new Request(url.toString(), { method: req.method, headers, body: body && body.length ? body : undefined });
        const webRes = await handleRequest(webReq, env, null);
        const out = {};
        webRes.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
        const cookies = typeof webRes.headers.getSetCookie === "function" ? webRes.headers.getSetCookie() : (webRes.headers.get("set-cookie") ? [webRes.headers.get("set-cookie")] : []);
        if (cookies.length) out["set-cookie"] = cookies;
        res.writeHead(webRes.status, out);
        if (req.method === "HEAD") { res.end(); return; }
        // Binary-safe (uploaded images); V38 used .text() which corrupted them.
        res.end(Buffer.from(await webRes.arrayBuffer()));
      } catch (err) {
        const status = err && err.status === 413 ? 413 : 500;
        if (status === 500) console.error("[Node] Request error:", err);
        if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(status === 413 ? "Payload Too Large" : "Internal Server Error");
      }
    });
    server.listen(PORT, () => {
      console.log(`[Synapse] ${APP_VERSION} running on http://localhost:${PORT}`);
      console.log(`[Synapse] Data dir: ${process.env.DATA_DIR || "./.data"}`);
    });

    const uptimeTimer=setInterval(()=>{handleScheduledUptime({},env).catch(e=>console.error('[Uptime]',e));},300000);
    if(uptimeTimer.unref)uptimeTimer.unref();
    const timer = setInterval(() => { handleScheduledBackup({}, env).catch((e) => console.error("[Cron]", e)); }, 24 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    process.on("unhandledRejection", (e) => console.error("[Node] Unhandled rejection:", e));
    const stop = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    console.log("[Synapse] Auto-backup scheduled (24h interval)");
  } catch (e) {
    console.error("[Node Shim] Failed to start:", e);
  }
}
