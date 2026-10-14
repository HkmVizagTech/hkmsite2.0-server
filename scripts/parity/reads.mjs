import { discover, sign, call, normalize, diff, orderOnly } from "./lib.mjs";

const [A, B] = [process.argv[2], process.argv[3]];
const only = process.argv[4];
const ctx = await discover(process.env.SRC_MONGO_URI || "mongodb://127.0.0.1:27018/test");
const tok = {
  admin: sign({ userId: ctx.admin, role: "admin" }),
  donationsAdmin: sign({ userId: ctx.donationsAdmin || ctx.admin, role: "donations_admin" }),
  preacher: sign({ userId: ctx.preacher || ctx.admin, role: "preacher" }),
  donor: sign({ donorId: ctx.donorWithDonations, type: "donor" }),
};
const d = ctx.donation, pd = ctx.prasadamDonation;
const id = (x) => x && String(x._id);

const R = (auth, path, extra = {}) => ({ auth, path, ...extra });
const reads = [
  // public
  R(null, "/health", { skip: true }),
  R(null, "/seva-stats"), R(null, "/seva-stats/overview"), R(null, "/seva-stats/sqft-campaign"),
  R(null, "/blogs"), R(null, "/blogs?page=2&limit=5"), R(null, "/blogs?category=Krishna%20Katha"), R(null, "/blogs?search=krishna"),
  R(null, "/blogs/landing"), R(null, "/blogs/categories"),
  ctx.blog && R(null, `/blogs/${ctx.blog.slug}`), ctx.blog && R(null, `/blogs/${id(ctx.blog)}/related`),
  R(null, "/events"), ctx.event && R(null, `/events/${id(ctx.event)}`),
  R(null, "/gallery"), ctx.gallery && R(null, `/gallery/${id(ctx.gallery)}`),
  R(null, "/darshan"), R(null, "/hero-banners"), R(null, "/important-dates"), R(null, "/site-content"),
  R(null, "/donation-page"), R(null, "/festival-donations/all"), ctx.festival && R(null, `/festival-donations/${ctx.festival.slug}`),
  R(null, "/festival-showcases/public"), ctx.showcase && R(null, `/festival-showcases/${ctx.showcase.slug}`),
  R(null, "/ekadashi-campaign"), R(null, "/temple-devotees"), ctx.campaigner && R(null, `/campaigners/${ctx.campaigner.slug}`),
  R(null, "/volunteers"), ctx.volunteerEvent && R(null, `/volunteers/${id(ctx.volunteerEvent)}`),
  R(null, "/shop/products"), R(null, "/shop/products?category=books"), R(null, "/shop/categories"), R(null, "/shop/settings"),
  ctx.product && R(null, `/shop/products/${ctx.product.slug}`),
  d && R(null, `/payments/status/${d.razorpayOrderId}`),
  // admin
  R("admin", "/dashboard/stats"), R("admin", "/devotees"), R("admin", "/users"), R("admin", "/users/profile"),
  R("admin", "/donations"), R("admin", "/donations?status=completed&limit=20&page=2"), R("admin", "/donations?search=a&limit=10"),
  R("admin", "/donations?status=failed"), R("admin", "/donations?type=Donation&limit=5"),
  R("admin", "/donations/stats"), R("admin", "/donations/audit-pending"), R("admin", "/donations/utm-stats"), R("admin", "/donations/utm-transactions"),
  R("admin", "/donations/report"), R("admin", "/donations/report?from=2026-01-01&to=2026-12-31"),
  R("admin", "/donations/whatsapp-audit"), R("admin", "/donations/needs-manual-receipt"), R("admin", "/donations/needs-whatsapp"),
  R("admin", "/donations/dcc-status"), R("admin", "/donations/prasadam-requests"), R("admin", "/donations/prasadam-export"),
  R("admin", "/donations/payment-failures"), R("admin", "/donations/upi-claims"), R("admin", "/donations/upi-qr-payments"),
  d && R("admin", `/donations/${id(d)}`), pd && R("admin", `/donations/${id(pd)}`), ctx.failed && R("admin", `/donations/${id(ctx.failed)}`),
  ctx.manual && R("admin", `/donations/${id(ctx.manual)}`),
  R("admin", "/payments/audit-subscriptions"),
  R("donationsAdmin", "/donations-admin/dashboard-stats"), R("donationsAdmin", "/donations-admin/report"), R("donationsAdmin", "/donations-admin/transactions"),
  R("donationsAdmin", "/donations-admin/transactions?status=completed&limit=15"), d && R("donationsAdmin", `/donations-admin/transactions/${id(d)}`),
  R("donationsAdmin", "/donations-admin/dcc-status"), R("donationsAdmin", "/donations-admin/utm-stats"), R("donationsAdmin", "/donations-admin/utm-transactions"),
  R("donationsAdmin", "/donations-admin/export"),
  R("admin", "/blogs/deletion-requests"), R("admin", "/campaigners/admin/list"), R("admin", "/contact-messages"),
  R("admin", "/festival-donations"), R("admin", "/festival-showcases"), R("admin", "/temple-devotees/admin/list"),
  R("admin", "/volunteers/admin/all"), ctx.volunteerEvent && R("admin", `/volunteers/admin/${id(ctx.volunteerEvent)}/registrations`),
  ctx.event && R("admin", `/events/${id(ctx.event)}/registrations`), R("admin", "/media"), R("admin", "/donor-issues"),
  R("admin", "/shop-admin/products"), R("admin", "/shop-admin/categories"), R("admin", "/shop-admin/orders"), R("admin", "/shop-admin/settings"),
  // preacher
  R("preacher", "/preacher/my-donors"), R("preacher", "/preacher/my-reports"), ctx.donorMobile && R("preacher", `/preacher/search-donor?mobile=${ctx.donorMobile}`),
  R("preacher", `/preacher/my-donors/${ctx.donorWithDonations}/donations`),
  // donor portal
  R("donor", "/donor/me"), R("donor", "/donor/my-donations"), R("donor", "/donor/stats"), R("donor", "/donor/subscriptions"),
  R("donor", "/donor/my-summary"), R("donor", "/donor/issues"), d && R("donor", `/donor/receipt/${id(d)}`),
  R("donor", "/shop/my-orders"), ctx.order && R("donor", `/shop/my-orders/${ctx.order.orderNumber}`),
  // internal (DRM)
  R("internal", "/api/internal/drm/donors"), R("internal", "/api/internal/drm/donors?limit=20&page=2"),
  ctx.donorMobile && R("internal", `/api/internal/drm/donors/by-mobile/${ctx.donorMobile}`), R("internal", "/api/internal/drm/abandoned"),
  d && R("internal", `/api/internal/drm/donations/${id(d)}/receipt.pdf`),
].filter(Boolean).filter((r) => !r.skip && (!only || r.path.includes(only)));

let pass = 0; const fails = []; const soft = [];
for (const r of reads) {
  const headers = r.auth === "internal" ? { "x-internal-secret": process.env.INTERNAL_SECRET || "local-internal-secret" } : {};
  const token = r.auth && r.auth !== "internal" ? tok[r.auth] : undefined;
  const [a, b] = await Promise.all([call(A, { path: r.path, token, headers }), call(B, { path: r.path, token, headers })]);
  const na = normalize(a.data), nb = normalize(b.data);
  orderOnly.length = 0;
  const problems = a.status !== b.status ? [`status ${a.status} != ${b.status}`] : diff(na, nb);
  if (orderOnly.length) soft.push(`${r.path}  (${orderOnly.join(", ")})`);
  if (problems.length) fails.push({ path: r.path, problems }); else pass++;
  if (process.env.VERBOSE) console.log(problems.length ? "FAIL" : "ok  ", a.status, r.path);
}
console.log(`\nparity reads: ${pass}/${reads.length} identical`);
if (soft.length) console.log(`order-only differences (same rows, different order): ${soft.length}\n  ${soft.join("\n  ")}`);
for (const f of fails) console.log(`\nFAIL ${f.path}\n  ${f.problems.join("\n  ")}`);
process.exit(fails.length ? 1 : 0);
