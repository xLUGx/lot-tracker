/* Lot Tracker / Car Count — shared Supabase cloud sync (PIN-gated RPCs). */
(function (global) {
"use strict";

const SUPABASE_URL = "https://umjexzorjqayhkicsetd.supabase.co";
const SUPABASE_KEY = "sb_publishable_2IBy5h5-wqzXU6_BAPQ2tg_iz_D2l64";
const PIN_KEY = "lot-sync-pin-v1";
const VERSIONS_KEY = "lot-sync-versions-v1";

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function isEmptyTracker(doc) {
  if (!doc || typeof doc !== "object") return true;
  const o = doc.overrides || {};
  const a = doc.added || [];
  return Object.keys(o).length === 0 && (!Array.isArray(a) || a.length === 0);
}

function isEmptyCarcount(doc) {
  if (!doc || typeof doc !== "object") return true;
  const e = doc.entries || [];
  const r = doc.removed || [];
  const act = doc.active || {};
  return (!Array.isArray(e) || e.length === 0)
    && (!Array.isArray(r) || r.length === 0)
    && Object.keys(act).length === 0;
}

/** Stamp missing per-field timestamps so existing local edits win over empty cloud. */
function ensureTrackerTimestamps(doc, stamp) {
  const out = deepClone(doc || { overrides: {}, added: [] });
  if (!out.overrides) out.overrides = {};
  if (!Array.isArray(out.added)) out.added = [];
  const now = stamp || Date.now();
  for (const stock of Object.keys(out.overrides)) {
    const o = out.overrides[stock];
    if (!o || typeof o !== "object") continue;
    if (!o._ts) o._ts = {};
    for (const k of Object.keys(o)) {
      if (k === "_ts") continue;
      if (o._ts[k] == null) o._ts[k] = now;
    }
  }
  for (const car of out.added) {
    if (!car || typeof car !== "object") continue;
    if (car._addedAt == null) car._addedAt = now;
    if (!car._ts) car._ts = {};
    for (const k of Object.keys(car)) {
      if (k === "_ts" || k === "_addedAt" || k === "stock") continue;
      if (car._ts[k] == null) car._ts[k] = now;
    }
  }
  return out;
}

function mergeOverrideFields(a, b) {
  // Last-write-wins per field using _ts; missing ts treated as 0.
  const aa = a || {};
  const bb = b || {};
  const ats = aa._ts || {};
  const bts = bb._ts || {};
  const fields = new Set(
    [...Object.keys(aa), ...Object.keys(bb)].filter((k) => k !== "_ts")
  );
  const merged = {};
  const mts = {};
  for (const f of fields) {
    const ta = ats[f] || 0;
    const tb = bts[f] || 0;
    const inA = Object.prototype.hasOwnProperty.call(aa, f);
    const inB = Object.prototype.hasOwnProperty.call(bb, f);
    if (inA && inB) {
      if (ta >= tb) { merged[f] = aa[f]; mts[f] = ta; }
      else { merged[f] = bb[f]; mts[f] = tb; }
    } else if (inA) { merged[f] = aa[f]; mts[f] = ta; }
    else { merged[f] = bb[f]; mts[f] = tb; }
  }
  if (Object.keys(merged).length) merged._ts = mts;
  return Object.keys(merged).length ? merged : null;
}

function mergeTrackerDocs(local, server) {
  const L = ensureTrackerTimestamps(local || { overrides: {}, added: [] });
  const S = ensureTrackerTimestamps(server || { overrides: {}, added: [] }, 0);
  // Server missing timestamps stay 0 so local stamped data wins on first upload.
  const result = { overrides: {}, added: [] };
  const stocks = new Set([
    ...Object.keys(L.overrides || {}),
    ...Object.keys(S.overrides || {})
  ]);
  for (const stock of stocks) {
    const m = mergeOverrideFields(L.overrides[stock], S.overrides[stock]);
    if (m) result.overrides[stock] = m;
  }
  const byStock = new Map();
  for (const car of [...(S.added || []), ...(L.added || [])]) {
    if (!car || !car.stock) continue;
    const prev = byStock.get(car.stock);
    if (!prev) { byStock.set(car.stock, car); continue; }
    // Merge fields LWW; prefer higher _addedAt as base
    const base = (car._addedAt || 0) >= (prev._addedAt || 0) ? car : prev;
    const other = base === car ? prev : car;
    const fields = mergeOverrideFields(
      Object.assign({}, other, { _ts: other._ts || {} }),
      Object.assign({}, base, { _ts: base._ts || {} })
    );
    const out = Object.assign({}, other, base, fields || {});
    out.stock = car.stock;
    out._addedAt = Math.max(car._addedAt || 0, prev._addedAt || 0);
    byStock.set(car.stock, out);
  }
  result.added = [...byStock.values()];
  return result;
}

function entryKey(stock, date) { return String(stock) + "|" + date; }

function mergeCarcountDocs(local, server) {
  const L = local || { v: 1, entries: [], active: {}, removed: [] };
  const S = server || { v: 1, entries: [], active: {}, removed: [] };
  const byId = new Map();
  for (const e of [...(S.entries || []), ...(L.entries || [])]) {
    if (!e || !e.id) continue;
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  // Dedupe by stock+date (keep earliest loggedAt, stable id)
  const bySD = new Map();
  for (const e of byId.values()) {
    const k = entryKey(e.stock, e.date);
    const prev = bySD.get(k);
    if (!prev) bySD.set(k, e);
    else {
      const a = prev.loggedAt || "";
      const b = e.loggedAt || "";
      bySD.set(k, b && a && b < a ? e : prev);
    }
  }
  const removed = [...new Set([...(S.removed || []), ...(L.removed || [])])];
  const removedSet = new Set(removed);
  const entries = [...bySD.values()].filter(
    (e) => !removedSet.has(entryKey(e.stock, e.date))
  );
  const active = {};
  for (const src of [S.active || {}, L.active || {}]) {
    for (const stock of Object.keys(src)) {
      const cur = active[stock];
      const next = src[stock];
      if (!next) continue;
      if (!cur) active[stock] = next;
      else {
        const cs = cur.since || cur.date || "";
        const ns = next.since || next.date || "";
        active[stock] = ns >= cs ? next : cur;
      }
    }
  }
  return { v: 1, entries, active, removed };
}

async function rpc(name, body) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error_description || data.error)) || ("HTTP " + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function getSavedPin() {
  try { return localStorage.getItem(PIN_KEY) || ""; } catch (e) { return ""; }
}
function savePin(pin) {
  try { localStorage.setItem(PIN_KEY, pin); } catch (e) {}
}
function clearPin() {
  try { localStorage.removeItem(PIN_KEY); } catch (e) {}
}

function loadVersions() {
  try {
    const raw = localStorage.getItem(VERSIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { tracker: 0, carcount: 0 };
}
function saveVersions(v) {
  try { localStorage.setItem(VERSIONS_KEY, JSON.stringify(v)); } catch (e) {}
}

function formatSyncTime(d) {
  try {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    return d.toISOString().slice(11, 16);
  }
}

/**
 * SyncEngine: pull/merge/push for tracker + carcount docs.
 * Apps provide getLocal(key)/setLocal(key, data) and optional onStatus(msg, kind).
 */
function SyncEngine(opts) {
  this.getLocal = opts.getLocal;
  this.setLocal = opts.setLocal;
  this.onStatus = opts.onStatus || function () {};
  this.pin = getSavedPin();
  this.versions = loadVersions();
  this.syncing = false;
  this.pending = false;
  this.debounceTimer = null;
  this.lastSyncAt = null;
  this.online = true;
}

SyncEngine.prototype.setStatus = function (msg, kind) {
  this.onStatus(msg, kind || "ok");
};

SyncEngine.prototype.hasPin = function () {
  return !!(this.pin && /^\d{6}$/.test(this.pin));
};

SyncEngine.prototype.verifyPin = async function (pin) {
  const data = await rpc("sync_verify", { pin: String(pin) });
  if (!data || !data.ok) throw new Error("BAD_PIN");
  this.pin = String(pin);
  savePin(this.pin);
  return true;
};

SyncEngine.prototype.pullAll = async function () {
  const rows = await rpc("sync_get", { pin: this.pin });
  const map = {};
  if (Array.isArray(rows)) {
    for (const r of rows) map[r.key] = r;
  }
  return map;
};

SyncEngine.prototype.mergeAndStore = function (key, serverDoc) {
  const local = this.getLocal(key);
  let merged;
  if (key === "tracker") {
    if (isEmptyTracker(local) && !isEmptyTracker(serverDoc)) merged = deepClone(serverDoc);
    else if (!isEmptyTracker(local) && isEmptyTracker(serverDoc)) merged = deepClone(local);
    else merged = mergeTrackerDocs(local, serverDoc);
  } else {
    if (isEmptyCarcount(local) && !isEmptyCarcount(serverDoc)) merged = deepClone(serverDoc);
    else if (!isEmptyCarcount(local) && isEmptyCarcount(serverDoc)) merged = deepClone(local);
    else merged = mergeCarcountDocs(local, serverDoc);
  }
  this.setLocal(key, merged);
  return merged;
};

SyncEngine.prototype.putDoc = async function (key, data, baseVersion) {
  // Client-side empty guard (server also guards)
  const empty = key === "tracker" ? isEmptyTracker(data) : isEmptyCarcount(data);
  if (empty) {
    // Still try — server may return guarded non-empty
  }
  const result = await rpc("sync_put", {
    pin: this.pin,
    key: key,
    data: data,
    base_version: baseVersion | 0
  });
  return result;
};

SyncEngine.prototype.syncOnce = async function () {
  if (!this.hasPin()) {
    this.setStatus("Enter Lot code to sync", "warn");
    return false;
  }
  if (this.syncing) { this.pending = true; return false; }
  this.syncing = true;
  this.setStatus("Syncing…", "ok");
  try {
    let remote = await this.pullAll();
    this.online = true;
    for (const key of ["tracker", "carcount"]) {
      const row = remote[key] || { data: key === "tracker" ? { overrides: {}, added: [] } : { v: 1, entries: [], active: {}, removed: [] }, version: 0 };
      this.mergeAndStore(key, row.data || {});
      this.versions[key] = row.version | 0;
    }
    saveVersions(this.versions);

    // Push both docs (merged local)
    for (const key of ["tracker", "carcount"]) {
      let attempts = 0;
      while (attempts < 4) {
        attempts++;
        const local = this.getLocal(key);
        // Guard: don't push empty over known non-empty version without intent
        const empty = key === "tracker" ? isEmptyTracker(local) : isEmptyCarcount(local);
        if (empty && (this.versions[key] | 0) > 0) {
          // Re-pull only for this key by full pull
          remote = await this.pullAll();
          const row = remote[key];
          if (row) {
            this.mergeAndStore(key, row.data || {});
            this.versions[key] = row.version | 0;
            saveVersions(this.versions);
          }
          break;
        }
        const result = await this.putDoc(key, local, this.versions[key] | 0);
        if (result && result.conflict) {
          this.mergeAndStore(key, result.data || {});
          this.versions[key] = result.version | 0;
          saveVersions(this.versions);
          continue; // retry put
        }
        if (result && result.ok) {
          if (result.guarded && result.data) {
            this.setLocal(key, result.data);
          }
          this.versions[key] = result.version | 0;
          saveVersions(this.versions);
        }
        break;
      }
    }
    this.lastSyncAt = new Date();
    this.setStatus("Synced " + formatSyncTime(this.lastSyncAt), "ok");
    this.syncing = false;
    if (this.pending) { this.pending = false; return this.syncOnce(); }
    return true;
  } catch (err) {
    this.syncing = false;
    this.online = false;
    const msg = String(err && err.message || err);
    if (/BAD_PIN|TOO_MANY|P0001/i.test(msg)) {
      clearPin();
      this.pin = "";
      this.setStatus("Lot code rejected — unlock again", "err");
      throw err;
    }
    this.setStatus("Offline, will sync", "warn");
    return false;
  }
};

SyncEngine.prototype.scheduleSync = function (ms) {
  const self = this;
  if (this.debounceTimer) clearTimeout(this.debounceTimer);
  this.debounceTimer = setTimeout(function () {
    self.syncOnce().catch(function () {});
  }, ms == null ? 1000 : ms);
};

SyncEngine.prototype.startAutoSync = function () {
  const self = this;
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && self.hasPin()) {
      self.syncOnce().catch(function () {});
    }
  });
  setInterval(function () {
    if (self.hasPin() && document.visibilityState === "visible") {
      self.syncOnce().catch(function () {});
    }
  }, 60000);
};

/** Append a Lot 1 move into carcount doc (dedupe by stock+date). */
function appendLot1Move(carcount, car, date) {
  const log = deepClone(carcount || { v: 1, entries: [], active: {}, removed: [] });
  if (!Array.isArray(log.entries)) log.entries = [];
  if (!log.active) log.active = {};
  if (!Array.isArray(log.removed)) log.removed = [];
  const stock = String(car.stock || "").trim();
  if (!stock || !date) return log;
  const k = entryKey(stock, date);
  if (log.removed.indexOf(k) >= 0) return log;
  if (log.entries.some(function (e) { return e.stock === stock && e.date === date; })) {
    log.active[stock] = { date: date, since: date };
    return log;
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  log.entries.push({
    id: id,
    stock: stock,
    year: String(car.year ?? ""),
    make: String(car.make ?? ""),
    model: String(car.model ?? ""),
    vin: String(car.vin ?? ""),
    color: String(car.color ?? ""),
    date: date,
    source: "tracker",
    loggedAt: new Date().toISOString()
  });
  log.active[stock] = { date: date, since: date };
  return log;
}

/** Stamp _ts on override fields that changed. */
function stampOverride(prev, nextFields) {
  const now = Date.now();
  const out = deepClone(nextFields);
  const pts = (prev && prev._ts) || {};
  const nts = {};
  for (const k of Object.keys(out)) {
    if (k === "_ts") continue;
    if (!prev || String(prev[k]) !== String(out[k])) nts[k] = now;
    else nts[k] = pts[k] || now;
  }
  out._ts = nts;
  return out;
}

// PIN unlock UI helpers
function injectPinStyles() {
  if (document.getElementById("lot-sync-styles")) return;
  const css = document.createElement("style");
  css.id = "lot-sync-styles";
  css.textContent = [
    "#pinGate{position:fixed;inset:0;z-index:100;background:#12171cf2;display:flex;align-items:center;justify-content:center;padding:20px;}",
    "#pinGate[hidden]{display:none!important;}",
    "#pinGate .box{width:min(360px,100%);background:#1c242c;border:1px solid #2c3842;border-radius:16px;padding:20px;}",
    "#pinGate h2{margin:0 0 6px;font-size:18px;}",
    "#pinGate p{color:#9aabb6;font-size:13px;margin:0 0 12px;}",
    "#pinGate input{width:100%;font-size:28px;letter-spacing:0.35em;text-align:center;padding:14px;border-radius:10px;border:1px solid #2c3842;background:#10161b;color:#eef3f6;}",
    "#pinGate .err{color:#e2b15a;font-size:13px;min-height:1.2em;margin:8px 0;}",
    "#pinGate button{width:100%;margin-top:8px;padding:12px;border-radius:10px;border:1px solid #1f6f6a;background:#1f6f6a;color:#fff;font-weight:650;font-size:16px;}",
    "#syncStatus{color:#9aabb6;font-size:12px;margin:4px 0 0;min-height:1.2em;}",
    "#syncStatus.warn{color:#e2b15a;}",
    "#syncStatus.err{color:#d45a5a;}"
  ].join("");
  document.head.appendChild(css);
}

function showPinGate(opts) {
  injectPinStyles();
  let gate = document.getElementById("pinGate");
  if (!gate) {
    gate = document.createElement("div");
    gate.id = "pinGate";
    gate.innerHTML = '<div class="box"><h2>Enter your 6-digit Lot code</h2><p>Unlocks cloud sync so Lot Tracker and Car Count share data across phones.</p><input id="pinInput" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="••••••"><div class="err" id="pinErr"></div><button type="button" id="pinUnlock">Unlock</button></div>';
    document.body.appendChild(gate);
  }
  gate.hidden = false;
  const input = document.getElementById("pinInput");
  const err = document.getElementById("pinErr");
  const btn = document.getElementById("pinUnlock");
  err.textContent = "";
  input.value = "";
  function finish(pin) {
    return opts.onUnlock(pin).then(function () {
      gate.hidden = true;
    }).catch(function (e) {
      const m = String(e && e.message || e);
      if (/TOO_MANY/i.test(m)) err.textContent = "Too many tries — wait a few minutes.";
      else err.textContent = "Wrong code. Try again.";
      input.value = "";
      input.focus();
    });
  }
  btn.onclick = function () {
    const pin = String(input.value || "").replace(/\D/g, "").slice(0, 6);
    if (pin.length !== 6) { err.textContent = "Enter all 6 digits."; return; }
    btn.disabled = true;
    finish(pin).finally(function () { btn.disabled = false; });
  };
  input.onkeydown = function (ev) {
    if (ev.key === "Enter") btn.click();
  };
  setTimeout(function () { input.focus(); }, 50);
}

function ensureSyncStatusEl(parent) {
  injectPinStyles();
  let el = document.getElementById("syncStatus");
  if (!el) {
    el = document.createElement("p");
    el.id = "syncStatus";
    el.className = "";
    (parent || document.querySelector("header") || document.body).appendChild(el);
  }
  return el;
}

global.LotSync = {
  SUPABASE_URL: SUPABASE_URL,
  PIN_KEY: PIN_KEY,
  SyncEngine: SyncEngine,
  mergeTrackerDocs: mergeTrackerDocs,
  mergeCarcountDocs: mergeCarcountDocs,
  ensureTrackerTimestamps: ensureTrackerTimestamps,
  stampOverride: stampOverride,
  appendLot1Move: appendLot1Move,
  isEmptyTracker: isEmptyTracker,
  isEmptyCarcount: isEmptyCarcount,
  getSavedPin: getSavedPin,
  savePin: savePin,
  clearPin: clearPin,
  showPinGate: showPinGate,
  ensureSyncStatusEl: ensureSyncStatusEl,
  formatSyncTime: formatSyncTime,
  rpc: rpc,
  entryKey: entryKey
};
})(typeof window !== "undefined" ? window : globalThis);
