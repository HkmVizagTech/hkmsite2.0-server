import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = path.resolve(HERE, "../../../../.localdb");

export const envDir = (envName) => path.join(LOCAL, "envs", envName);
const tagsOf = (tag) => (tag === "both" ? ["baseline", "new"] : [tag]);
export const statePath = (envName, tag) => path.join(envDir(envName), `${tag}-mock-state.json`);
export const storePath = (envName, tag) => statePath(envName, tag).replace(/\.json$/, ".store.json");
export const logPath = (envName, tag) => path.join(envDir(envName), `${tag}-outbound.jsonl`);

const isPlain = (v) => v && typeof v === "object" && !Array.isArray(v);
const merge = (target, patch) => {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isPlain(v) && isPlain(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
};

export const getState = (envName, serverTag) => {
  try {
    return JSON.parse(fs.readFileSync(statePath(envName, serverTag), "utf8"));
  } catch {
    return {};
  }
};

// Deep-merges patch into the mock state (null deletes a key, arrays replace). serverTag: baseline | new | both.
export const setState = (envName, serverTag, patch) => {
  for (const tag of tagsOf(serverTag)) {
    const file = statePath(envName, tag);
    const next = merge(getState(envName, tag), patch);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
};

// Restores defaults: empty scripted state, and forgets counters/created entities so ids restart.
export const resetMocks = (envName, serverTag = "both") => {
  for (const tag of tagsOf(serverTag)) {
    fs.writeFileSync(statePath(envName, tag), "{}");
    fs.rmSync(storePath(envName, tag), { force: true });
    fs.writeFileSync(logPath(envName, tag), "");
  }
};

export const readLog = (envName, serverTag) => {
  try {
    return fs
      .readFileSync(logPath(envName, serverTag), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

export const clearLog = (envName, serverTag = "both") => {
  for (const tag of tagsOf(serverTag)) fs.writeFileSync(logPath(envName, tag), "");
};

export const payOrder = (envName, serverTag, orderId, payment = {}) => {
  const entry = { id: "pay_MockPaid001", status: "captured", method: "upi", ...payment };
  for (const tag of tagsOf(serverTag)) {
    const cur = getState(envName, tag).razorpay?.orderPayments?.[orderId] || [];
    setState(envName, tag, { razorpay: { orderPayments: { [orderId]: [...cur.filter((p) => p.id !== entry.id), entry] } } });
  }
};

export const failNext = (envName, serverTag, service, n = 1, extra = {}) => setState(envName, serverTag, { [service]: { failNext: n, ...extra } });

export const signWebhook = (secret, rawBody) => crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

export const waitFor = async (fn, { timeoutMs = 15000, intervalMs = 250, label = "condition" } = {}) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

// ---------- comparison ----------
const OID = /(?<![0-9a-f])[0-9a-f]{24}(?![0-9a-f])/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const VOLATILE_KEYS = /^(transactionDate|event_time|created_at|timestamp|ts)$/;

const makeNormalizer = ({ strictBytes = false } = {}) => {
  const ids = new Map();
  const idLabel = (id) => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
    return ids.get(id);
  };
  const str = (s) =>
    s
      .replace(OID, idLabel)
      .replace(ISO, "<ts>")
      .replace(/receipt_\d{10,}/g, "receipt_<ts>")
      .replace(/(?<!\d)\d{13}(?!\d)/g, "<ts>");
  const walk = (v, key = "") => {
    if (typeof v === "string") return VOLATILE_KEYS.test(key) ? "<volatile>" : str(v);
    if (typeof v === "number") return VOLATILE_KEYS.test(key) ? "<volatile>" : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === "sha256" && !strictBytes) continue;
        out[k] = walk(v[k], k);
      }
      return out;
    }
    return v;
  };
  return (entry) => {
    const body = JSON.parse(JSON.stringify(entry.body ?? null));
    // OTP codes are random per run.
    const isOtp = (s) => /otp/i.test(String(s));
    if (body?.template_name && isOtp(body.template_name)) {
      for (const c of body.components || []) for (const p of c.parameters || []) p.text = "<otp>";
    }
    return walk({
      service: entry.service,
      method: entry.method,
      host: entry.host,
      path: entry.path,
      query: entry.query,
      headers: entry.headers,
      body,
      status: entry.response?.status ?? entry.response?.error ?? null,
    });
  };
};

const canon = (v) => JSON.stringify(v);

export const fieldDiff = (a, b, prefix = "") => {
  const out = [];
  if (canon(a) === canon(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) out.push(...fieldDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k));
    return out;
  }
  out.push(`${prefix || "(root)"}: baseline=${canon(a)} new=${canon(b)}`);
  return out;
};

const describe = (e) => `${e.method} ${e.host}${e.path}${Object.keys(e.query || {}).length ? `?${new URLSearchParams(e.query)}` : ""}`;

// Compares two request logs. Order is enforced only within a service; interleaving between services is ignored.
export const compareLogs = (baselineEntries, newEntries, opts = {}) => {
  const norm = (entries) => {
    const n = makeNormalizer(opts);
    return entries.map((e) => n(e));
  };
  const a = norm(baselineEntries);
  const b = norm(newEntries);
  const services = [...new Set([...a, ...b].map((e) => e.service))].sort();
  const differences = [];

  for (const svc of services) {
    const sa = a.filter((e) => e.service === svc);
    const sb = b.filter((e) => e.service === svc);
    const ca = sa.map(canon);
    const cb = sb.map(canon);
    if (ca.length === cb.length && ca.every((c, i) => c === cb[i])) continue;

    const pool = cb.map((c, i) => ({ c, i }));
    const onlyBase = [];
    for (const [i, c] of ca.entries()) {
      const at = pool.findIndex((p) => p.c === c);
      if (at === -1) onlyBase.push(sa[i]);
      else pool.splice(at, 1);
    }
    const onlyNew = pool.map((p) => sb[p.i]);

    if (!onlyBase.length && !onlyNew.length) {
      differences.push({ service: svc, type: "order", detail: `same ${sa.length} requests but in a different order` });
      continue;
    }
    for (const x of onlyBase) {
      const idx = onlyNew.findIndex((y) => y.method === x.method && y.path === x.path);
      if (idx !== -1) {
        const [y] = onlyNew.splice(idx, 1);
        differences.push({ service: svc, type: "changed", request: describe(x), fields: fieldDiff(x, y) });
      } else differences.push({ service: svc, type: "missing-in-new", request: describe(x), body: x.body });
    }
    for (const y of onlyNew) differences.push({ service: svc, type: "extra-in-new", request: describe(y), body: y.body });
  }

  const lines = [`outbound requests: baseline=${a.length} new=${b.length}`];
  if (!differences.length) lines.push("no differences");
  for (const d of differences) {
    lines.push(`[${d.service}] ${d.type}${d.request ? `: ${d.request}` : ""}${d.detail ? `: ${d.detail}` : ""}`);
    for (const f of d.fields || []) lines.push(`    ${f}`);
    if (d.body && d.type !== "changed") lines.push(`    body=${canon(d.body).slice(0, 300)}`);
  }
  return { equal: differences.length === 0, differences, report: lines.join("\n") };
};

export const summarize = (entries) => {
  const counts = {};
  for (const e of entries) counts[e.service] = (counts[e.service] || 0) + 1;
  return counts;
};
