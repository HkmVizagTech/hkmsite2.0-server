import fs from "node:fs";
import crypto from "node:crypto";
import nock from "nock";
import { respond, serviceFor } from "./services.mjs";

const LOCAL = /^https?:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$)/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const SECRET_FIELDS = new Set(["token", "access_token", "apikey", "api_key", "password", "secret", "authorization"]);
const SECRET_HEADERS = new Set(["authorization", "apikey", "dcc-api-key", "x-internal-secret", "x-api-key", "api-key"]);
const KEEP_HEADERS = new Set(["content-type", "accept", "cache-control", "x-amz-acl", "x-amz-meta-source"]);

const logPath = () => process.env.MOCK_LOG || "";

const redactDeep = (value) => {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_FIELDS.has(k.toLowerCase()) ? "<redacted>" : redactDeep(v)]));
  }
  return value;
};

const parseMultipart = (buf, contentType) => {
  const boundary = /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
  if (!boundary) return null;
  const fields = {};
  const files = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delimiter);
  while (pos !== -1) {
    const start = pos + delimiter.length;
    if (buf.slice(start, start + 2).toString() === "--") break;
    const next = buf.indexOf(delimiter, start);
    if (next === -1) break;
    const part = buf.slice(start + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.slice(0, headEnd).toString("utf8");
    const content = part.slice(headEnd + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename !== undefined) {
      files.push({ field: name, filename, contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? null, size: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex").slice(0, 16) });
    } else {
      fields[name] = SECRET_FIELDS.has(name.toLowerCase()) ? "<redacted>" : content.toString("utf8");
    }
    pos = next;
  }
  return { fields, files };
};

const parseBody = (raw, contentType) => {
  const ct = String(contentType || "").toLowerCase();
  const out = { raw };
  if (!raw.length) return out;
  if (ct.includes("json")) {
    try {
      out.json = JSON.parse(raw.toString("utf8"));
      out.logged = redactDeep(out.json);
    } catch {
      out.logged = { unparsed: raw.toString("utf8").slice(0, 500) };
    }
  } else if (ct.includes("x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw.toString("utf8"));
    const form = {};
    for (const [k, v] of params) form[k] = SECRET_FIELDS.has(k.toLowerCase()) ? "<redacted>" : v;
    out.form = form;
    out.logged = { form };
  } else if (ct.includes("multipart/form-data")) {
    out.multipart = parseMultipart(raw, contentType);
    out.logged = { multipart: out.multipart };
  } else {
    out.logged = { bytes: raw.length, sha256: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16) };
  }
  return out;
};

const cleanHeaders = (headers, url) => {
  const out = {};
  for (const [k, v] of headers.entries()) {
    const key = k.toLowerCase();
    if (key === "authorization") {
      const basic = /^Basic\s+(.+)$/i.exec(v);
      out.authorization = basic ? `basic:${Buffer.from(basic[1], "base64").toString().split(":")[0]}` : /^AWS4/.test(v) ? "<aws-sigv4>" : "<set>";
    } else if (SECRET_HEADERS.has(key)) out[key] = "<set>";
    else if (KEEP_HEADERS.has(key)) out[key] = key === "content-type" ? v.replace(/;\s*boundary=.*/i, "; boundary=<b>") : v;
  }
  return out;
};

const record = (entry) => {
  const file = logPath();
  if (file) fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
};

const queryOf = (url) => {
  const q = {};
  for (const [k, v] of url.searchParams) {
    if (SECRET_FIELDS.has(k.toLowerCase())) q[k] = "<redacted>";
    else q[k] = k in q ? [].concat(q[k], v) : v;
  }
  return q;
};

const handle = async (request) => {
  const url = new URL(request.url);
  const raw = Buffer.from(await request.arrayBuffer());
  const body = parseBody(raw, request.headers.get("content-type"));
  const service = serviceFor(url.host);
  const ctx = {
    method: request.method,
    host: url.host,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(request.headers.entries()),
    body,
  };
  let result;
  let error = null;
  try {
    result = respond(service, ctx);
  } catch (err) {
    error = err.message;
  }
  record({
    ts: new Date().toISOString(),
    service,
    method: request.method,
    host: url.host,
    path: url.pathname,
    query: queryOf(url),
    headers: cleanHeaders(request.headers, url),
    body: body.logged ?? null,
    response: error ? { error } : { status: result.status },
    ...(service === "unmocked" ? { unmocked: true } : {}),
  });
  if (error) throw new Error(error);
  const payload = result.body;
  const responseBody = payload !== null && typeof payload === "object" && !Buffer.isBuffer(payload) ? JSON.stringify(payload) : payload;
  return [result.status, responseBody, result.headers];
};

nock.disableNetConnect();
nock.enableNetConnect((host) => LOCAL_HOST.test(host));

const scope = nock(LOCAL).persist();
for (const method of ["get", "post", "put", "delete", "head", "patch", "options"]) scope[method](/.*/).reply(handle);
