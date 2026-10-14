import crypto from "node:crypto";
import { readState, writeState, nextCounter, putEntity, getEntity, listEntities, padId } from "./store.mjs";

const BASE_EPOCH = 1780000000;
const b64 = (s) => Buffer.from(s, "base64");
const IMAGES = {
  jpeg: b64(
    "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABv/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKQAI2f/2Q=="
  ),
  webp: b64("UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoQABAAAUAmJaACdLoB+AADsAD+pNf/TSPGkeNI+Yt/84ljqd3aAAAA"),
  png: b64(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGM4UaFBEmIY1VAxGkonhmvSAAADaGgQygMFTQAAAABJRU5ErkJggg=="
  ),
};
const MIN_PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

const json = (status, body, headers = {}) => ({ status, body, headers: { "content-type": "application/json", ...headers } });
const text = (status, body, type = "text/plain") => ({ status, body, headers: { "content-type": type } });
const bin = (status, body, type) => ({ status, body, headers: { "content-type": type } });

const imageFor = (pathname) => {
  const ext = (pathname.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  if (ext === "webp") return bin(200, IMAGES.webp, "image/webp");
  if (ext === "png") return bin(200, IMAGES.png, "image/png");
  if (ext === "pdf") return bin(200, MIN_PDF, "application/pdf");
  return bin(200, IMAGES.jpeg, "image/jpeg");
};

const hostOf = (value) => {
  try {
    return new URL(/^https?:\/\//.test(value) ? value : `https://${value}`).host;
  } catch {
    return "";
  }
};

export const serviceFor = (host) => {
  const h = host.toLowerCase();
  const drm = hostOf(process.env.DRM_API_URL || "");
  const dcc = hostOf(process.env.DCC_API_URL || "");
  const pub = hostOf(process.env.R2_PUBLIC_URL || "");
  if (h === "api.razorpay.com") return "razorpay";
  if (h.endsWith(".r2.cloudflarestorage.com")) return "r2";
  if ((pub && h === pub) || h.endsWith(".r2.dev")) return "r2public";
  if (h === "vhkmsurabhi.com" || (dcc && h === dcc)) return "dcc";
  if (h === "wapi.flaxxa.com") return "flaxxa";
  if (h === "api.gupshup.io") return "gupshup";
  if (h.endsWith(".gupshup.io")) return "gupshupmedia";
  if (h === "graph.facebook.com") return "meta";
  if (drm && h === drm) return "drm";
  if (h === "track.delhivery.com") return "delhivery";
  if (h === "trackapi.thirdutc.com") return "dtdc";
  if (h === "netconnect.bluedart.com") return "bluedart";
  if (h === "clsapi.indiapost.gov.in") return "indiapost";
  if (h.endsWith("harekrishnavizag.org")) return "site";
  if (h === "api.cloudinary.com" || h === "res.cloudinary.com") return "cloudinary";
  return "unmocked";
};

const failureResponse = (service, cfg) => {
  if (cfg.networkError) throw new Error(`mock network error (${service})`);
  const status = Number(cfg.status || 500);
  if (cfg.body !== undefined) return typeof cfg.body === "string" ? text(status, cfg.body) : json(status, cfg.body);
  if (service === "razorpay") {
    return json(status, { error: { code: "SERVER_ERROR", description: "Mock scripted failure", source: "NA", step: "NA", reason: "NA", metadata: {} } });
  }
  return json(status, { message: "Mock scripted failure" });
};

// ---------- Razorpay ----------
const rzpError = (status, description, code = "BAD_REQUEST_ERROR") =>
  json(status, { error: { code, description, source: "NA", step: "NA", reason: "NA", metadata: {} } });

const asPayment = (p, order) => ({
  entity: "payment",
  amount: order?.amount ?? 0,
  currency: "INR",
  status: "captured",
  order_id: order?.id ?? null,
  invoice_id: null,
  international: false,
  method: "upi",
  amount_refunded: 0,
  refund_status: null,
  captured: true,
  description: "Mock payment",
  email: "payer@example.com",
  contact: "+919999999999",
  notes: order?.notes ?? [],
  fee: 0,
  tax: 0,
  created_at: BASE_EPOCH + 100,
  acquirer_data: { rrn: `RRN${String(p.id).replace(/\D/g, "").padStart(9, "0")}` },
  ...p,
});

const orderView = (order, state) => {
  const items = paymentsForOrder(order.id, order, state);
  const paid = items.filter((p) => p.status === "captured").reduce((s, p) => s + Number(p.amount || 0), 0);
  return { ...order, amount_paid: paid, amount_due: Math.max(0, order.amount - paid), status: paid >= order.amount && paid > 0 ? "paid" : order.status, attempts: items.length };
};

const paymentsForOrder = (orderId, order, state) => {
  const rz = state.razorpay || {};
  const listed = rz.orderPayments?.[orderId] ?? rz.defaultOrderPayments ?? [];
  const overrides = getEntity("capturedPayments", "all") || {};
  return listed.map((p) => asPayment({ ...p, ...(overrides[p.id] ? { status: "captured", captured: true } : {}) }, order));
};

const collection = (items, query) => {
  const skip = Number(query.skip || 0);
  const count = query.count ? Number(query.count) : items.length;
  const page = items.slice(skip, skip + count);
  return { entity: "collection", count: page.length, items: page };
};

const razorpay = (ctx, state) => {
  const rz = state.razorpay || {};
  const [, , resource, id, sub, sub2] = ctx.path.split("/");
  const { method, body, query } = ctx;
  const data = body.json || {};

  if (resource === "orders") {
    if (method === "POST" && !id) {
      const n = nextCounter("rzp_order");
      const order = {
        id: `order_Mock${padId(n, 8)}`,
        entity: "order",
        amount: data.amount,
        amount_paid: 0,
        amount_due: data.amount,
        currency: data.currency || "INR",
        receipt: data.receipt ?? null,
        offer_id: null,
        status: "created",
        attempts: 0,
        notes: data.notes ?? [],
        created_at: BASE_EPOCH + n,
      };
      putEntity("orders", order.id, order);
      return json(200, order);
    }
    const order = getEntity("orders", id) || (rz.orders && rz.orders[id]);
    if (!order) return rzpError(400, "The id provided does not exist");
    if (method === "GET" && !sub) return json(200, orderView(order, state));
    if (method === "GET" && sub === "payments") return json(200, collection(paymentsForOrder(id, order, state), query));
  }

  if (resource === "payments") {
    if (id === "qr_codes" && sub && sub2 === "payments") {
      return json(200, collection((rz.qrPayments || []).map((p) => asPayment(p)), query));
    }
    if (method === "GET" && !id) return json(200, collection((rz.allPayments || []).map((p) => asPayment(p)), query));
    const known = rz.payments?.[id];
    if (method === "GET" && !sub) return known ? json(200, asPayment({ id, ...known })) : rzpError(400, "The id provided does not exist");
    if (method === "POST" && sub === "capture") {
      if (rz.captureFail) return rzpError(Number(rz.captureFail.status || 400), rz.captureFail.description || "This payment has already been captured");
      const overrides = getEntity("capturedPayments", "all") || {};
      overrides[id] = true;
      putEntity("capturedPayments", "all", overrides);
      return json(200, asPayment({ id, ...(known || {}), amount: data.amount, currency: data.currency || "INR", status: "captured" }));
    }
  }

  if (resource === "plans") {
    if (method === "POST") {
      const n = nextCounter("rzp_plan");
      const plan = { id: `plan_Mock${padId(n, 8)}`, entity: "plan", interval: data.interval, period: data.period, item: { id: `item_Mock${padId(n, 8)}`, active: true, name: data.item?.name, description: null, amount: data.item?.amount, unit_amount: data.item?.amount, currency: data.item?.currency || "INR", type: "plan", unit: null, tax_inclusive: false, hsn_code: null, sac_code: null, tax_rate: null, tax_id: null, tax_group_id: null, created_at: BASE_EPOCH + n, updated_at: BASE_EPOCH + n }, notes: data.notes ?? [], created_at: BASE_EPOCH + n };
      putEntity("plans", plan.id, plan);
      return json(200, plan);
    }
    const plan = getEntity("plans", id) || rz.plans?.[id];
    return plan ? json(200, plan) : rzpError(400, "The id provided does not exist");
  }

  if (resource === "subscriptions") {
    const view = (s) => ({ ...s, ...(rz.subscriptions?.[s.id] || {}) });
    if (method === "POST" && !id) {
      const n = nextCounter("rzp_sub");
      const sub = { id: `sub_Mock${padId(n, 8)}`, entity: "subscription", plan_id: data.plan_id, customer_id: null, status: "created", current_start: null, current_end: null, ended_at: null, quantity: data.quantity ?? 1, notes: data.notes ?? [], charge_at: BASE_EPOCH + 86400, start_at: BASE_EPOCH + 86400, end_at: null, auth_attempts: 0, total_count: data.total_count, paid_count: 0, customer_notify: Boolean(data.customer_notify), created_at: BASE_EPOCH + n, expire_by: null, short_url: `https://rzp.io/i/mock${n}`, has_scheduled_changes: false, change_scheduled_at: null, source: "api", remaining_count: data.total_count };
      putEntity("subscriptions", sub.id, sub);
      return json(200, sub);
    }
    if (method === "GET" && !id) {
      const merged = new Map(listEntities("subscriptions").map((s) => [s.id, view(s)]));
      for (const [sid, extra] of Object.entries(rz.subscriptions || {})) if (!merged.has(sid)) merged.set(sid, { id: sid, entity: "subscription", plan_id: "plan_MockUnknown", status: "active", total_count: 120, paid_count: 0, created_at: BASE_EPOCH, notes: [], ...extra });
      return json(200, collection([...merged.values()], query));
    }
    const base = getEntity("subscriptions", id) || (rz.subscriptions?.[id] && { id, entity: "subscription", plan_id: "plan_MockUnknown", status: "active", total_count: 120, paid_count: 0, created_at: BASE_EPOCH, notes: [] });
    if (!base) return rzpError(400, "The id provided does not exist");
    if (method === "GET") return json(200, view(base));
    if (method === "POST" && sub === "cancel") {
      const cur = view(base);
      if (cur.status === "cancelled") return rzpError(400, "Subscription is not cancellable in cancelled status");
      const next = { ...base, status: "cancelled", ended_at: BASE_EPOCH + 200 };
      putEntity("subscriptions", id, next);
      return json(200, next);
    }
  }

  if (resource === "invoices" && method === "GET") {
    return json(200, collection(rz.invoices?.[query.subscription_id] ?? [], query));
  }

  return rzpError(404, `Mock: unsupported Razorpay endpoint ${method} ${ctx.path}`, "NOT_FOUND");
};

// ---------- DCC ----------
const dcc = (ctx, state) => {
  const cfg = state.dcc || {};
  const data = ctx.body.json || {};
  if (!/\/addDonation$/i.test(ctx.path)) return json(404, { Message: "Mock: unknown DCC endpoint" });
  const txn = data.gatewayPaymentId;
  const seen = txn ? getEntity("dccTransactions", String(txn)) : null;
  if (seen) {
    if (cfg.duplicate === "create") {
      /* fall through and issue a new receipt */
    } else if (cfg.duplicate === "error") {
      return json(400, { Message: "Transaction details exist for this gatewayPaymentId" });
    } else {
      return json(200, { ...seen, Message: `Donation already exists - Receipt Number: ${seen.ReceiptNumber}` });
    }
  }
  const n = nextCounter("dcc_donation");
  const receipt = `HKMI|2026|D/VSP|${9000 + n}`;
  const existing = cfg.existingDonorNumber;
  let donorNumber = existing;
  let donorId = 700000;
  if (!existing) {
    const d = nextCounter("dcc_donor");
    donorNumber = `D${90000 + d}`;
    donorId = 700000 + d;
  }
  const out = {
    DonationId: 800000 + n,
    ReceiptNumber: receipt,
    DonorId: donorId,
    DonorNumber: donorNumber,
    IsNewDonor: !existing,
    Message: `${existing ? "" : `Donor Created Successfully - Donor ID: ${donorNumber} - `}Donation Receipt Created Successfully - Receipt Number: ${receipt}`,
  };
  if (txn) putEntity("dccTransactions", String(txn), out);
  return json(200, out);
};

// ---------- WhatsApp ----------
const flaxxa = (ctx, state) => {
  const cfg = state.flaxxa || {};
  if (!/^\/api\/v1\/(sendtemplatemessage|sendmessage|sendtemplatemessage_withattachment)$/.test(ctx.path)) return json(404, { status: "error", message: "Mock: unknown Flaxxa endpoint" });
  if (cfg.nullWamid) return json(200, { status: "error", message: "Meta rejected the send", message_wamid: null });
  const n = nextCounter("flaxxa_msg");
  return json(200, { status: "success", message: "Message sent successfully", message_wamid: `wamid.MOCK${padId(n)}`, wamid: `wamid.MOCK${padId(n)}` });
};

const gupshup = (ctx, state) => {
  const cfg = state.gupshup || {};
  if (ctx.path !== "/wa/api/v1/template/msg") return json(404, { status: "error", message: "Mock: unknown Gupshup endpoint" });
  if (cfg.rejected) return json(200, { status: "error", message: "Template Params doesn't match" });
  const n = nextCounter("gupshup_msg");
  return json(200, { status: "submitted", messageId: `gs-mock-${padId(n)}` });
};

const meta = (ctx) => {
  if (!/\/events$/.test(ctx.path)) return json(404, { error: { message: "Mock: unknown Graph endpoint" } });
  const n = nextCounter("meta_event");
  return json(200, { events_received: (ctx.body.json?.data || []).length || 1, messages: [], fbtrace_id: `MOCKTRACE${padId(n)}` });
};

const drm = (ctx) => (ctx.path === "/api/webhooks/hkmv/donor-updated" ? json(200, { ok: true }) : json(404, { message: "Mock: unknown DRM endpoint" }));

// ---------- couriers ----------
const courierStatus = (state, awb) => {
  const cfg = state.couriers || {};
  return cfg.byTracking?.[awb] ?? cfg.default ?? "In Transit";
};

const delhivery = (ctx, state) => {
  const awb = ctx.query.waybill;
  const status = courierStatus(state, awb);
  return json(200, { DeliveryData: [{ Waybill: awb, Status: status, StatusText: status }], PackageList: [] });
};
const dtdc = (ctx, state) => json(200, { consignmentStatus: courierStatus(state, ctx.query.cnno), trackDetails: [] });
const bluedart = (ctx, state) => {
  const awb = ctx.body.json?.data?.WaybillNums?.[0]?.WaybillNo;
  return text(200, `<?xml version="1.0"?><ShipmentData><Shipment WaybillNo="${awb}"><Status>${courierStatus(state, awb)}</Status></Shipment></ShipmentData>`, "text/xml");
};
const indiapost = (ctx, state) =>
  json(200, { TrackConsignmentTrackDetails: { TrackDetail: [{ EventDescription: courierStatus(state, ctx.query.cnno) }] } });

// ---------- storage / media ----------
const r2 = (ctx, state) => {
  const bucket = process.env.R2_BUCKET_NAME;
  const key = decodeURIComponent(ctx.path.replace(/^\//, "")).replace(bucket ? new RegExp(`^${bucket}/`) : /^$/, "");
  const cfg = state.r2 || {};
  if (ctx.method === "PUT") {
    const etag = `"${crypto.createHash("md5").update(ctx.body.raw).digest("hex")}"`;
    putEntity("r2objects", key, { size: ctx.body.raw.length, contentType: ctx.headers["content-type"] || null });
    return { status: 200, body: "", headers: { etag } };
  }
  if (ctx.method === "DELETE") {
    const store = getEntity("r2objects", key);
    if (store) putEntity("r2objects", key, null);
    return { status: 204, body: "", headers: {} };
  }
  if (ctx.method === "HEAD" || ctx.method === "GET") {
    const obj = getEntity("r2objects", key);
    if (!obj || (cfg.missing || []).includes(key)) {
      return ctx.method === "HEAD" ? { status: 404, body: "", headers: {} } : text(404, '<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>', "application/xml");
    }
    return ctx.method === "HEAD" ? { status: 200, body: "", headers: { "content-length": String(obj.size), "content-type": obj.contentType || "application/octet-stream" } } : imageFor(key);
  }
  return json(405, { message: "Mock: unsupported S3 call" });
};

const r2public = (ctx) => {
  const pubHost = hostOf(process.env.R2_PUBLIC_URL || "");
  const key = decodeURIComponent(ctx.path.replace(/^\//, ""));
  if (ctx.method === "HEAD") {
    const uploaded = getEntity("r2objects", key);
    if (ctx.host === pubHost) return { status: uploaded ? 200 : 404, body: "", headers: uploaded ? { "content-type": uploaded.contentType || "image/jpeg" } : {} };
    return { status: 200, body: "", headers: { "content-type": "image/jpeg" } };
  }
  return imageFor(ctx.path);
};

const media = (ctx) => (ctx.method === "HEAD" ? { status: 200, body: "", headers: { "content-type": "image/jpeg" } } : imageFor(ctx.path));

const site = (ctx) => {
  if (/\.(jpe?g|png|webp)$/i.test(ctx.path)) return imageFor(ctx.path);
  const og = `https://${ctx.host}/og${ctx.path.replace(/[^a-z0-9]+/gi, "-")}.jpg`;
  return text(200, `<!doctype html><html><head><meta property="og:image" content="${og}"></head><body>mock</body></html>`, "text/html");
};

const cloudinary = (ctx) => {
  if (ctx.method === "GET") return imageFor(ctx.path);
  if (/\/destroy$/.test(ctx.path)) return json(200, { result: "ok" });
  const n = nextCounter("cloudinary_asset");
  const id = `mock/asset_${padId(n)}`;
  return json(200, { public_id: id, version: 1, format: "jpg", resource_type: "image", width: 16, height: 16, bytes: IMAGES.jpeg.length, url: `http://res.cloudinary.com/mock/image/upload/v1/${id}.jpg`, secure_url: `https://res.cloudinary.com/mock/image/upload/v1/${id}.jpg` });
};

const HANDLERS = { razorpay, dcc, flaxxa, gupshup, meta, drm, delhivery, dtdc, bluedart, indiapost, r2, r2public, gupshupmedia: media, site, cloudinary };

export const respond = (service, ctx) => {
  const state = readState();
  const handler = HANDLERS[service];
  if (!handler) {
    return ctx.method === "GET" && /\.(jpe?g|png|webp)$/i.test(ctx.path) ? imageFor(ctx.path) : text(404, `Mock: no handler for ${ctx.host}`);
  }
  const cfg = state[service];
  if (cfg && (cfg.failAll || Number(cfg.failNext) > 0)) {
    if (!cfg.failAll) {
      cfg.failNext -= 1;
      writeState(state);
    }
    return failureResponse(service, cfg);
  }
  return handler(ctx, state);
};
