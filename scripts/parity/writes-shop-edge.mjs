// Edge-value matrix for the shop write endpoints: same requests to baseline and new, compares status + body and
// the stored state (via the raw admin listings).
//   SRC_MONGO_URI=... DATABASE_URL=... node scripts/parity/writes-shop-edge.mjs http://localhost:9310 http://localhost:9311 [group]
import crypto from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import pg from "pg";
import { sign, call, normalize, diff, discover } from "./lib.mjs";

const [A, B, only] = [process.argv[2], process.argv[3], process.argv[4]];
const ctx = await discover(process.env.SRC_MONGO_URI);
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
const mclient = new MongoClient(process.env.SRC_MONGO_URI);
await mclient.connect();
const mdb = mclient.db();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const tok = sign({ userId: ctx.admin, role: "admin" });
const hex = () => "6" + Math.random().toString(16).slice(2, 25).padEnd(23, "0");

const VALUES = [
  null,
  "",
  "  pad  ",
  0,
  -1,
  1.5,
  2.5,
  1e21,
  "12",
  " 7 ",
  "abc",
  "1e3",
  "0x10",
  "Infinity",
  true,
  false,
  [],
  ["a"],
  [1, 2],
  {},
  { a: 1 },
  "x".repeat(300),
];

const mask = (s) => {
  const seen = new Map();
  return s
    .replace(/[0-9a-f]{24}/g, (m) => {
      if (!seen.has(m)) seen.set(m, `<id${seen.size}>`);
      return seen.get(m);
    })
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<ts>");
};
// List order depends on same-millisecond timestamps, which differ run to run; compare lists by slug.
const prep = (data) => {
  const d = normalize(data);
  if (d && Array.isArray(d.products)) d.products = [...d.products].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  if (d && Array.isArray(d.categories)) d.categories = [...d.categories].sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return JSON.parse(mask(JSON.stringify(d ?? null)));
};

const PRODUCT_FIELDS = [
  "name", "slug", "shortDescription", "description", "productInfo", "category", "images", "hasVariants", "price", "mrp",
  "stock", "weightGrams", "status", "featured", "freeShipping", "tags", "sortOrder",
];
const VARIANT_FIELDS = ["label", "sku", "price", "mrp", "stock", "weightGrams", "_id", "extra"];
const VARIANT_VALUES = [...VALUES, "6aaa64c9a669e4e9df6564b7", "zz"];

async function run(base) {
  const side = base === A ? "mongo" : "pg";
  const out = [];
  let hop = 0;
  const step = async (label, method, path, body, token = tok) => {
    // checkout is rate limited per IP; every request pretends to come from a different one
    const headers = { "x-forwarded-for": `10.${(++hop >> 16) & 255}.${(hop >> 8) & 255}.${hop & 255}` };
    const r = await call(base, { method, path, body, token, headers });
    out.push({ label, status: r.status, data: r.data });
    return r;
  };
  const snapshot = async (label) => {
    const r = await step(`snapshot ${label}`, "GET", "/shop-admin/products");
    const c = await step(`snapshot cats ${label}`, "GET", "/shop-admin/categories");
    const s = await step(`snapshot settings ${label}`, "GET", "/shop-admin/settings");
    return [r, c, s];
  };
  const groups = {
    async createSimple() {
      for (const f of PRODUCT_FIELDS)
        for (const v of VALUES)
          await step(`create simple ${f}=${JSON.stringify(v)?.slice(0, 25)}`, "POST", "/shop-admin/products", {
            name: `EQ ${f} ${out.length}`,
            price: 10,
            ...{ [f]: v },
          });
      await snapshot("createSimple");
    },
    async createVariants() {
      const vb = { label: "L", price: 5 };
      for (const f of PRODUCT_FIELDS)
        for (const v of VALUES)
          await step(`create var ${f}=${JSON.stringify(v)?.slice(0, 25)}`, "POST", "/shop-admin/products", {
            name: `EQV ${f} ${out.length}`,
            hasVariants: true,
            variants: [vb],
            ...{ [f]: v },
          });
      for (const f of VARIANT_FIELDS)
        for (const v of VARIANT_VALUES)
          await step(`create variant.${f}=${JSON.stringify(v)?.slice(0, 25)}`, "POST", "/shop-admin/products", {
            name: `EQVF ${f} ${out.length}`,
            hasVariants: true,
            variants: [{ ...vb, [f]: v }],
          });
      for (const v of [null, 5, "a", [], [null], [5], ["x"], {}, [[]], [{}], {a: 1}, "", [{ label: "a", price: 1 }, null]])
        await step(`create variants=${JSON.stringify(v)}`, "POST", "/shop-admin/products", { name: `EQVV ${out.length}`, hasVariants: true, variants: v });
      await snapshot("createVariants");
    },
    async updateSimple() {
      const p = await step("seed", "POST", "/shop-admin/products", { name: "EQ Upd", price: 10, stock: 3, status: "active" });
      const id = p.data?.product?._id;
      for (const f of PRODUCT_FIELDS)
        for (const v of VALUES) {
          await step(`update ${f}=${JSON.stringify(v)?.slice(0, 25)}`, "PATCH", `/shop-admin/products/${id}`, { [f]: v });
          await step(`read`, "GET", "/shop-admin/products");
        }
      await step("update regenerate", "PATCH", `/shop-admin/products/${id}`, { name: "EQ Upd 2", regenerateSlug: true });
      for (const v of VALUES) await step(`regen name=${JSON.stringify(v)}`, "PATCH", `/shop-admin/products/${id}`, { name: v, regenerateSlug: true });
      await snapshot("updateSimple");
    },
    async updateVariants() {
      const p = await step("seed", "POST", "/shop-admin/products", {
        name: "EQ UpdV", hasVariants: true, status: "active", variants: [{ label: "a", price: 1, stock: 1 }, { label: "b", price: 2 }],
      });
      const id = p.data?.product?._id;
      const vids = (p.data?.product?.variants || []).map((v) => v._id);
      for (const f of VARIANT_FIELDS)
        for (const v of VARIANT_VALUES) {
          await step(`upd variant.${f}=${JSON.stringify(v)?.slice(0, 25)}`, "PATCH", `/shop-admin/products/${id}`, {
            hasVariants: true,
            variants: [{ _id: vids[0], label: "a", price: 1, [f]: v }, { _id: vids[1], label: "b", price: 2 }],
          });
          await step("read", "GET", "/shop-admin/products");
        }
      for (const v of [null, 5, "a", [], [null], [5], ["x"], {}, [[]], [{}], {a: 1}, "", [{ label: "a", price: 1 }, null]]) {
        await step(`upd variants=${JSON.stringify(v)}`, "PATCH", `/shop-admin/products/${id}`, { variants: v });
        await step("read", "GET", "/shop-admin/products");
        await step(`upd hasVariants+variants=${JSON.stringify(v)}`, "PATCH", `/shop-admin/products/${id}`, { hasVariants: true, variants: v });
        await step("read", "GET", "/shop-admin/products");
      }
      for (const hv of VALUES) {
        await step(`upd hasVariants=${JSON.stringify(hv)}`, "PATCH", `/shop-admin/products/${id}`, { hasVariants: hv, variants: [{ label: "z", price: 3 }] });
        await step("read", "GET", "/shop-admin/products");
      }
      await snapshot("updateVariants");
    },
    async stock() {
      const s = await step("seed s", "POST", "/shop-admin/products", { name: "EQ Stock", price: 10, stock: 3 });
      const v = await step("seed v", "POST", "/shop-admin/products", { name: "EQ StockV", hasVariants: true, variants: [{ label: "a", price: 1, stock: 1 }] });
      const sid = s.data?.product?._id,
        vid = v.data?.product?._id,
        vv = v.data?.product?.variants?.[0]?._id;
      for (const x of VALUES) {
        await step(`stock simple ${JSON.stringify(x)}`, "PATCH", `/shop-admin/products/${sid}/stock`, { stock: x });
        await step(`stock variant ${JSON.stringify(x)}`, "PATCH", `/shop-admin/products/${vid}/stock`, { stock: x, variantId: vv });
        await step(`stock variantId ${JSON.stringify(x)}`, "PATCH", `/shop-admin/products/${vid}/stock`, { stock: 4, variantId: x });
        await step(`stock simple variantId ${JSON.stringify(x)}`, "PATCH", `/shop-admin/products/${sid}/stock`, { stock: 4, variantId: x });
        await step("read", "GET", "/shop-admin/products");
      }
      for (const b of [undefined, {}, [], null, "x"]) await step(`stock body ${JSON.stringify(b)}`, "PATCH", `/shop-admin/products/${sid}/stock`, b);
      await snapshot("stock");
    },
    async categories() {
      for (const f of ["name", "description", "image", "sortOrder", "status", "slug", "extra"])
        for (const v of VALUES)
          await step(`cat create ${f}=${JSON.stringify(v)?.slice(0, 25)}`, "POST", "/shop-admin/categories", { name: `EQ Cat ${out.length}`, [f]: v });
      const c = await step("cat seed", "POST", "/shop-admin/categories", { name: "EQ Cat Upd" });
      const id = c.data?.category?._id;
      for (const f of ["name", "description", "image", "sortOrder", "status", "slug", "extra"])
        for (const v of [...VALUES, "active", "hidden", "ACTIVE", "weird"]) {
          await step(`cat update ${f}=${JSON.stringify(v)?.slice(0, 25)}`, "PATCH", `/shop-admin/categories/${id}`, { [f]: v });
          await step("read", "GET", "/shop-admin/categories");
        }
      for (const b of [undefined, {}, [], null, "x"]) {
        await step(`cat update body ${JSON.stringify(b)}`, "PATCH", `/shop-admin/categories/${id}`, b);
        await step(`cat create body ${JSON.stringify(b)}`, "POST", "/shop-admin/categories", b);
      }
      await snapshot("categories");
    },
    async settings() {
      for (const f of ["shopEnabled", "flatShippingCharge", "freeShippingAbove", "announcement", "supportMobile", "deliveryEstimate", "updatedBy", "_id"])
        for (const v of VALUES) {
          await step(`settings ${f}=${JSON.stringify(v)?.slice(0, 25)}`, "PATCH", "/shop-admin/settings", { [f]: v });
          await step("read", "GET", "/shop-admin/settings");
          await step("read public", "GET", "/shop/settings");
        }
      for (const b of [undefined, {}, [], null, "x"]) await step(`settings body ${JSON.stringify(b)}`, "PATCH", "/shop-admin/settings", b);
    },
    // Public/admin catalog reads over a seeded catalog: search, sorts, paging, filters, injection-shaped params.
    async catalog() {
      const mk = (b) => step(`seed ${b.name}`, "POST", "/shop-admin/products", b);
      const seeds = [
        { name: "Agarbatti Rose", price: 50, stock: 10, featured: true, tags: ["incense", "Rose"], category: "zz-a", sortOrder: 2, status: "active", shortDescription: "Rose scent", images: ["http://x/r.jpg"] },
        { name: "Agarbatti Sandal", price: 60, stock: 0, tags: ["incense"], category: "zz-a", sortOrder: 1, status: "active" },
        { name: "Mala Tulasi", hasVariants: true, variants: [{ label: "S", price: 80, stock: 5 }, { label: "L", price: 330, stock: 0, mrp: 400 }], tags: ["japa"], category: "zz-a", status: "active", featured: true },
        { name: "Dhoop 50% off_deal", price: 20, stock: 5, tags: ["50%", "a_b"], category: "zz-b", status: "active", shortDescription: "100% pure" },
        { name: "Éclair Café", price: 15, stock: 2, shortDescription: "ÉCLAIR au chocolat", category: "zz-b", status: "active", tags: ["Ünï"] },
        { name: "Fractional", price: 12.345, stock: 1.5, status: "active", category: "zz-b", sortOrder: -1 },
        { name: "Draft one", price: 5, stock: 5, category: "zz-a" },
        { name: "Free ship", price: 1000, stock: 3, freeShipping: true, status: "active", category: "zz-a", sortOrder: 2 },
        { name: "A.B*C(D)[E]\\ regex", price: 9, stock: 9, status: "active", category: "zz-b", shortDescription: "x.y" },
        { name: "Var Out", hasVariants: true, variants: [{ label: "a", price: 5, stock: 0 }], status: "active", category: "zz-a" },
        { name: "Var Cheap", hasVariants: true, variants: [{ label: "a", price: 5, stock: 1 }, { label: "b", price: 7, stock: 1 }], status: "active", category: "zz-a", sortOrder: 2 },
        { name: "Same Price A", price: 50, stock: 1, status: "active", category: "zz-c" },
        { name: "Same Price B", price: 50, stock: 1, status: "active", category: "zz-c" },
      ];
      const ids = [];
      for (const b of seeds) {
        const r = await mk(b);
        ids.push(r.data?.product?._id);
        await new Promise((r2) => setTimeout(r2, 3));
      }
      await step("seed cat a", "POST", "/shop-admin/categories", { name: "ZZ A", sortOrder: 5 });
      await step("seed cat b", "POST", "/shop-admin/categories", { name: "ZZ B", sortOrder: 5 });
      await step("seed cat c", "POST", "/shop-admin/categories", { name: "ZZ C", status: "hidden" });
      const search = ["", " ", "agar", "AGAR", "Agarbatti Rose", "a.b", ".*", "(", "[", "\\", "%", "_", "a_b", "50%", "É", "é", "ÉCLAIR", "éclair", "café", "CAFÉ", "TULASI", "japa", "Rose", "ünï", "x".repeat(300), "'", '"', "a b", "  agar  ", "A.B*C", "\\ regex", "100%", "x.y", "xy", "ß", "İ", "ǅ", "\u00a0agar", "agar\u00a0", "agar\n", "\n", "a\tb", "^", "$", "|", "?", "+", "{", "}", "[a-z]", "(?i)", "\\d", "💥", "తెలుగు", "Gita", "gita", "BHAGAVAD", "Telugu", "Books", "books"];
      const q = (path) => step(`GET ${path.slice(0, 100)}`, "GET", path);
      const qa = (path) => step(`ADMIN ${path.slice(0, 100)}`, "GET", path);
      for (const t of search) {
        await q(`/shop/products?search=${encodeURIComponent(t)}`);
        await qa(`/shop-admin/products?search=${encodeURIComponent(t)}`);
      }
      await q("/shop/products?search=%00");
      await qa("/shop-admin/products?search=%00");
      await q("/shop/products?search=a&search=b");
      await q("/shop/products?search[x]=1");
      await q("/shop/products?search[$ne]=1");
      for (const sort of ["featured", "price-asc", "price-desc", "newest", "bogus", "", "PRICE-ASC"])
        for (const extra of ["", "&inStockOnly=true", "&category=zz-a", "&limit=3", "&limit=3&page=2", "&limit=2&page=3&inStockOnly=true", "&category=zz-b&limit=2&page=2"])
          await q(`/shop/products?sort=${sort}${extra}`);
      const pv = ["", "0", "-1", "1", "2", "3", "1.5", "2.5", "0.5", "1e2", "1e9", "1e21", "1e300", "Infinity", "-Infinity", "NaN", "abc", " 2 ", "0x10", "0b1", "5abc", "٣", "1,2", "[]", "null", "true", "007", "-0", "99999999999999999999", "60", "61", "100", "1000"];
      for (const v of pv) {
        await q(`/shop/products?page=${encodeURIComponent(v)}`);
        await q(`/shop/products?limit=${encodeURIComponent(v)}`);
        await q(`/shop/products?limit=2&page=${encodeURIComponent(v)}`);
        await q(`/shop/products?limit=${encodeURIComponent(v)}&page=2`);
        await q(`/shop/products?sort=price-asc&limit=${encodeURIComponent(v)}&page=${encodeURIComponent(v)}`);
        await qa(`/shop-admin/orders?limit=${encodeURIComponent(v)}&page=${encodeURIComponent(v)}`);
      }
      for (const p of ["page", "limit", "page[]", "page[a]", "limit[$gt]"]) await q(`/shop/products?${p}=1&${p}=2`);
      await q("/shop/products?page[a]=1");
      await q("/shop/products?limit[$gt]=1");
      for (const cat of ["zz-a", "ZZ-A", "all", "ALL", "", "zz-a&category=zz-b", "zz-a,zz-b", "%25", "zz-", "[$ne]=zz-a"]) {
        await q(`/shop/products?category=${cat}`);
        await qa(`/shop-admin/products?category=${cat}`);
      }
      for (const qs of ["category[$ne]=zz-a", "category[$in]=zz-a", "category[$in][]=zz-a&category[$in][]=zz-b", "category[$regex]=^zz-a", "category[$regex]=zz&category[$options]=i", "category[$gt]=zz-a", "category[$exists]=true", "category[a]=1", "category[$ne]=", "category[$nin]=zz-a", "category[$foo]=1", "category[]=zz-a", "category[]=zz-a&category[]=zz-b", "category=zz-a&category=zz-b", "category[$eq]=zz-a", "category[$not][$eq]=zz-a", "category[$in]=", "category[$ne][]=a", "category[$ne][a]=1"]) {
        await q(`/shop/products?${qs}`);
        await qa(`/shop-admin/products?${qs}`);
      }
      for (const qs of ["status=draft", "status=active", "status=all", "status=DRAFT", "status[$ne]=draft", "status[]=draft&status[]=active", "status=draft&status=active", "status[$regex]=^d", "status[a]=1", "status=", "status[$in]=draft"]) await qa(`/shop-admin/products?${qs}`);
      for (const qs of ["inStockOnly=true", "inStockOnly=false", "inStockOnly=TRUE", "inStockOnly=1", "inStockOnly[]=true", "inStockOnly=true&inStockOnly=true"]) await q(`/shop/products?${qs}`);
      const real = ["6aaa64c9a669e4e9df6564b7", "6aacecaca9aa7da5475068ce"];
      const idq = [real.join(","), real.join(",").toUpperCase(), `${real[0]},,zz, ${real[1]} `, "zz", "", " ", ",", real[0] + "x", `${real[0]}&ids=${real[1]}`, "[]", `${ids.filter(Boolean).join(",")}`, `${ids.filter(Boolean).slice(0, 3).join(",")}&sort=price-asc`];
      for (const v of idq) await q(`/shop/products?ids=${v}`);
      await q(`/shop/products?ids[]=${real[0]}`);
      await q(`/shop/products?ids[$ne]=${real[0]}`);
      await q("/shop/categories");
      await qa("/shop-admin/categories");
      await qa("/shop-admin/products");
      const list = (await call(base, { path: "/shop-admin/products", token: tok })).data?.products || [];
      for (const p of list) await q(`/shop/products/${encodeURIComponent(p.slug)}`);
      for (const slug of ["", "x", "ZZ-A", "agarbatti-rose".toUpperCase(), "agarbatti-rose%20", "%00", "a/b", "..", "agarbatti-rose?x=1", "[$ne]", "bhagavad-gita"]) await q(`/shop/products/${slug}`);
      await q("/shop/products/agarbatti-rose?slug[$ne]=x");
      await q("/shop/settings");
      await q("/shop/products/draft-one");
      await snapshot("catalog");
    },
    // Checkout, payment confirmation, customer views, admin order updates (needs MOCKS=1 for Razorpay).
    async orders() {
      const donorTok = sign({ donorId: ctx.donorWithDonations, type: "donor" });
      const donor = await mdb.collection("donors").findOne({ _id: new ObjectId(ctx.donorWithDonations) });
      const SECRET = "local-razorpay-secret";
      const addr = { street: "1 Test St", city: "Vizag", state: "AP", pincode: "530001" };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const prod = async (b) => (await step(`seed ${b.name}`, "POST", "/shop-admin/products", b)).data?.product;
      const p1 = await prod({ name: "EQ Ord Simple", price: 100, stock: 10, status: "active", category: "zz-o" });
      const p2 = await prod({ name: "EQ Ord Var", hasVariants: true, status: "active", category: "zz-o", variants: [{ label: "S", price: 80, stock: 5 }, { label: "L", price: 330, stock: 2 }] });
      const p3 = await prod({ name: "EQ Ord Last", price: 40, stock: 1, status: "active", category: "zz-o", freeShipping: true });
      const p4 = await prod({ name: "EQ Ord Free", price: 2000, stock: 5, status: "active", category: "zz-o" });
      const cart = (...items) => items;
      const buy = (label, extra = {}, items = cart({ productId: p1._id, quantity: 1 })) =>
        step(label, "POST", "/shop/orders", { items, shippingAddress: addr, ...extra }, donorTok);
      const created = [];
      const mk = async (label, extra, items) => {
        const r = await buy(label, extra, items);
        if (r.data?.orderNumber) created.push(r.data);
        await sleep(3);
        return r;
      };
      const pay = (label, ord, over = {}) => {
        const oid = over.razorpay_order_id ?? ord.razorpayOrderId;
        const pid = over.razorpay_payment_id ?? `pay_${ord.razorpayOrderId}`;
        const sig = over.razorpay_signature ?? crypto.createHmac("sha256", SECRET).update(`${oid}|${pid}`).digest("hex");
        const r = step(label, "POST", "/shop/orders/verify", { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig });
        return r.then(async (x) => (await sleep(150), x)); // let the fire-and-forget WhatsApp confirmation settle
      };
      const products = () => step("products", "GET", "/shop-admin/products?search=EQ%20Ord");

      // checkout success and body variations
      const o1 = (await mk("order ok simple", {}, cart({ productId: p1._id, quantity: 2 }))).data;
      const o2 = (await mk("order ok variant", { customerEmail: "a@b.c", customerNote: "  careful  " }, cart({ productId: p2._id, variantId: p2.variants[1]._id, quantity: 2 }, { productId: p1._id, quantity: 1 }))).data;
      const oa = (await mk("order last unit A", {}, cart({ productId: p3._id, quantity: 1 }))).data;
      const ob = (await mk("order last unit B", {}, cart({ productId: p3._id, quantity: 1 }))).data;
      await mk("order free ship all", {}, cart({ productId: p3._id, quantity: 1 }));
      await mk("order above threshold", {}, cart({ productId: p4._id, quantity: 1 }));
      for (const [f, vals] of Object.entries({
        customerEmail: [null, "", 5, true, false, {}, [], ["x"], { _id: "idx" }, { a: 1 }, "x".repeat(300), " pad "],
        customerNote: [null, "", "  note ", 5, true, {}, [], ["n"], "x".repeat(600), "   "],
        customerName: [null, "", " Name ", 5, true, {}, [], ["a"], { _id: "idx" }, "x".repeat(300)],
      }))
        for (const v of vals) await mk(`order ${f}=${JSON.stringify(v)?.slice(0, 20)}`, { [f]: v });
      for (const sa of [null, "x", 5, [], {}, { ...addr, street: 5 }, { ...addr, pincode: 530001 }, { ...addr, pincode: " 530001 " }, { ...addr, pincode: "53000a" }, { ...addr, extra: "x", country: "US" }, { ...addr, street: ["a"] }, { ...addr, city: {} }])
        await step(`order shippingAddress=${JSON.stringify(sa)?.slice(0, 30)}`, "POST", "/shop/orders", { items: cart({ productId: p1._id, quantity: 1 }), shippingAddress: sa }, donorTok);
      for (const pid of [[p1._id], { _id: p1._id }, p1._id.toUpperCase(), 5, true, 0, "", null, {}, "zz", undefined, false, [p1._id, p1._id]])
        await mk(`order productId=${JSON.stringify(pid)?.slice(0, 30)}`, {}, cart({ productId: pid, quantity: 1 }));
      for (const q of [0, -1, 1.5, "2", "abc", null, true, [], {}, 99, 100, 1e9, "1e1"])
        await mk(`order quantity=${JSON.stringify(q)}`, {}, cart({ productId: p1._id, quantity: q }));
      for (const vid of [p2.variants[0]._id.toUpperCase(), [p2.variants[0]._id], { _id: p2.variants[0]._id }, 5, "zz", null, undefined, p2.variants[0]._id])
        await mk(`order variantId=${JSON.stringify(vid)?.slice(0, 30)}`, {}, cart({ productId: p2._id, variantId: vid, quantity: 1 }));
      for (const items of [null, 5, "x", {}, [null], [5], ["x"], [{}], [[]], [{ productId: p1._id, quantity: 1 }, null], Array.from({ length: 50 }, () => ({ productId: p1._id, quantity: 1 })), Array.from({ length: 51 }, () => ({ productId: p1._id, quantity: 1 })), [{ productId: p1._id, quantity: 1 }, { productId: p1._id, quantity: 1 }]])
        await mk(`order items=${JSON.stringify(items)?.slice(0, 40)}`, {}, items);
      for (const b of [undefined, null, [], "x", {}])
        await step(`order body=${JSON.stringify(b)}`, "POST", "/shop/orders", b, donorTok);
      const badDonor = [sign({ donorId: "zz", type: "donor" }), sign({ donorId: 5, type: "donor" }), sign({ donorId: "6AAA64C9A669E4E9DF6564B7", type: "donor" }), sign({ donorId: "000000000000000000000000", type: "donor" }), sign({ type: "donor" }), sign({ donorId: "123456789012", type: "donor" })];
      for (const t of badDonor) {
        await step("order bad donor", "POST", "/shop/orders", { items: cart({ productId: p1._id, quantity: 1 }), shippingAddress: addr }, t);
        await step("myOrders bad donor", "GET", "/shop/my-orders", undefined, t);
        await step("getMyOrder bad donor", "GET", `/shop/my-orders/${o1.orderNumber}`, undefined, t);
      }
      await products();

      // verify: bad input, then confirmation
      await pay("verify missing", o1, { razorpay_signature: "" });
      await pay("verify bad sig", o1, { razorpay_signature: "deadbeef" });
      await pay("verify unknown order", o1, { razorpay_order_id: "order_nope" });
      for (const v of [5, true, {}, { $ne: "" }, { $regex: ".*" }, { $in: [o1.razorpayOrderId] }, [o1.razorpayOrderId], [o1.razorpayOrderId, "x"], { a: 1 }, { $ne: "" }, "x".repeat(300), "%", o1.razorpayOrderId.toUpperCase(), ` ${o1.razorpayOrderId}`, "\u0000"])
        await pay(`verify order_id=${JSON.stringify(v)?.slice(0, 30)}`, o1, { razorpay_order_id: v });
      await pay("verify o1", o1);
      await pay("verify o1 again", o1);
      await products();
      await step("webhook-free orders list", "GET", "/shop-admin/orders");
      await pay("verify o2", o2);
      await pay("verify oa", oa);
      await pay("verify ob (shortfall)", ob);
      await products();
      // payment id types on fresh orders
      const idv = [5, true, {}, [], ["a"], { _id: "idx" }, { a: 1 }, "x".repeat(300), "pay with space", 0];
      for (const v of idv) {
        const o = (await mk(`order for pid ${JSON.stringify(v)?.slice(0, 20)}`)).data;
        if (o) await pay(`verify payment_id=${JSON.stringify(v)?.slice(0, 20)}`, o, { razorpay_payment_id: v });
        await step("orders after", "GET", "/shop-admin/orders?limit=3");
      }
      // webhook confirmation
      const ow = (await mk("order for webhook")).data;
      const evt = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_wh1", order_id: ow.razorpayOrderId, amount: 10000, status: "captured" } } } });
      const wh = (label, raw, secret = "local-webhook-secret") =>
        step(label, "POST", "/payments/webhook/shop", raw, undefined).then(() => null);
      const whCall = async (label, raw) => {
        const sig = crypto.createHmac("sha256", "local-webhook-secret").update(raw).digest("hex");
        const res = await fetch(base + "/payments/webhook/shop", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body: raw });
        out.push({ label, status: res.status, data: await res.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }) });
        await sleep(300);
      };
      await whCall("webhook shop paid", evt);
      await whCall("webhook shop paid again", evt);
      await step("orders after webhook", "GET", "/shop-admin/orders?limit=3");
      await products();

      // customer views
      await step("my orders", "GET", "/shop/my-orders", undefined, donorTok);
      for (const on of [o1.orderNumber, o1.orderNumber.toLowerCase(), "NOPE", "%00", encodeURIComponent(" " + o1.orderNumber), "[$ne]", "a/b"])
        await step(`my order ${on}`, "GET", `/shop/my-orders/${on}`, undefined, donorTok);
      await step("my order qs injection", "GET", `/shop/my-orders/${o1.orderNumber}?orderNumber[$ne]=x`, undefined, donorTok);

      // admin list battery
      for (const qs of ["", "?paymentStatus=paid", "?paymentStatus=pending", "?paymentStatus=PAID", "?paymentStatus[$ne]=paid", "?paymentStatus[]=paid&paymentStatus[]=pending", "?paymentStatus=paid&paymentStatus=pending", "?paymentStatus[a]=1", "?paymentStatus[$regex]=^p", "?fulfilmentStatus=placed", "?fulfilmentStatus=cancelled", "?fulfilmentStatus=all&paymentStatus=all", "?needsAttention=true", "?needsAttention=false", "?needsAttention=TRUE", "?limit=2&page=2", "?limit=1&page=3", "?limit=0", "?page=0", "?search=hkms", "?search=HKMS-2026", "?search=00002", "?search=%25", "?search=_", "?search=chaitanya", "?search=CHAITANYA", "?search=9951", "?search=%20", "?search=.*", "?search=(", "?search=é", "?search=%00", "?search=a&search=b", "?search[$ne]=x", "?search=Chaitanya%20Dasari", `?search=${encodeURIComponent(donor?.mobile || "9")}`, "?paymentStatus=paid&search=hkms&limit=1"])
        await step(`admin orders ${qs}`, "GET", `/shop-admin/orders${qs}`);

      // admin updates
      const find = async (num) => (await call(base, { path: `/shop-admin/orders?search=${num}`, token: tok })).data?.orders?.[0];
      const oid = async (o) => (await find(o.orderNumber))._id;
      const o1id = await oid(o1), o2id = await oid(o2), oaid = await oid(oa);
      const up = async (label, id, body) => {
        await step(label, "PATCH", `/shop-admin/orders/${id}`, body);
        await step("order after", "GET", `/shop-admin/orders?search=${encodeURIComponent(created.find((c) => true).orderNumber.slice(0, 5))}&limit=100`);
        await products();
      };
      for (const b of [undefined, null, [], {}, { fulfilmentStatus: "packed", note: "boxed" }, { fulfilmentStatus: "packed" }, { fulfilmentStatus: "PACKED" }, { fulfilmentStatus: ["packed"] }, { fulfilmentStatus: {} }, { fulfilmentStatus: 5 }, { fulfilmentStatus: "shipped", note: 5 }, { fulfilmentStatus: "shipped" }, { tracking: "abc" }, { tracking: {} }, { tracking: { trackingNumber: 1234567890123 } }, { tracking: { trackingNumber: "1234567890123" } }, { tracking: { courier: "Delhivery", trackingNumber: "ABC123", url: "http://t/x" } }, { tracking: { courier: 5 } }, { tracking: { url: ["a"] } }, { tracking: { trackingNumber: {} } }, { tracking: { courier: {} } }, { tracking: [] }, { tracking: 5 }, { tracking: true }, { tracking: { courier: "Delhivery" } }, { adminNote: "  a  " }, { adminNote: "  a  " }, { adminNote: 5 }, { adminNote: {} }, { adminNote: ["a"] }, { adminNote: null }, { adminNote: "" }, { needsAttention: true }, { needsAttention: true }, { needsAttention: "false" }, { needsAttention: 0 }, { needsAttention: null }, { paymentStatus: "refunded" }, { paymentStatus: "refunded", note: "n" }, { paymentStatus: "bogus" }, { paymentStatus: ["paid"] }, { paymentStatus: "paid", note: {} }, { note: "x" }, { fulfilmentStatus: "delivered", note: ["a"] }, { extra: 1 }])
        await up(`o1 patch ${JSON.stringify(b)?.slice(0, 60)}`, o1id, b);
      await up("o2 cancel with object note", o2id, { fulfilmentStatus: "cancelled", note: {} });
      await up("o2 cancel", o2id, { fulfilmentStatus: "cancelled", note: "ok" });
      await up("o2 cancel again", o2id, { fulfilmentStatus: "cancelled" });
      await up("o2 reopen", o2id, { fulfilmentStatus: "placed" });
      await up("oa cancel with bad adminNote", oaid, { fulfilmentStatus: "cancelled", adminNote: {} });
      await up("oa cancel again", oaid, { fulfilmentStatus: "cancelled" });
      await up("oa ship", oaid, { fulfilmentStatus: "shipped", tracking: { trackingNumber: "ZZ9999999999", courier: "Delhivery" } });

      // fractional money: prices, shipping rule, revenue sums
      await step("settings fractional", "PATCH", "/shop-admin/settings", { flatShippingCharge: 12.345, freeShippingAbove: 99.5, shopEnabled: true });
      const pf = await prod({ name: "EQ Ord Frac", price: 33.333, mrp: 40.005, stock: 7.5, status: "active", category: "zz-o", weightGrams: 12.5 });
      const pv2 = await prod({ name: "EQ Ord FracVar", hasVariants: true, status: "active", category: "zz-o", variants: [{ label: "x", price: 0.1, stock: 3.25 }, { label: "y", price: 0.2, stock: 100 }] });
      const fq = await step("quote frac", "POST", "/shop/cart/quote", { items: [{ productId: pf._id, quantity: 3 }, { productId: pv2._id, variantId: pv2.variants[0]._id, quantity: 3 }] });
      const f1 = (await mk("order frac", {}, cart({ productId: pf._id, quantity: 3 }))).data;
      const f2 = (await mk("order frac var", {}, cart({ productId: pv2._id, variantId: pv2.variants[0]._id, quantity: 3 }))).data;
      const f3 = (await mk("order frac var2", {}, cart({ productId: pv2._id, variantId: pv2.variants[1]._id, quantity: 7 }))).data;
      for (const f of [f1, f2, f3]) if (f) await pay("verify frac", f);
      await products();
      await step("orders frac", "GET", "/shop-admin/orders?limit=5");
      await up("cancel frac", await oid(f1), { fulfilmentStatus: "cancelled" });
      await step("settings back", "PATCH", "/shop-admin/settings", { flatShippingCharge: 60, freeShippingAbove: 1000 });

      // identical timestamps: ties
      const day = new Date("2026-01-01T10:00:00.000Z");
      const tid = [0, 1, 2].map((i) => new ObjectId(`6a00000000000000000000${i}0`));
      for (const [i, id] of tid.entries()) {
        const orderNumber = `HKMS-TIE-0000${i}`;
        if (side === "mongo")
          await mdb.collection("shoporders").insertOne({ _id: id, orderNumber, donorRecordId: donor._id, customerName: "Tie", customerMobile: donor.mobile || "9", items: [{ productId: new ObjectId(p1._id), productName: "EQ Ord Simple", unitPrice: 100, quantity: 1, lineTotal: 100, freeShipping: false }], subtotal: 100, shippingCharge: 0, total: 100, paymentStatus: "pending", fulfilmentStatus: "placed", statusHistory: [], stockCommitted: false, stockShortfall: [], needsAttention: false, createdAt: day, updatedAt: day });
        else {
          await pool.query("INSERT INTO shop_orders (id, order_number, donor_record_id, customer_name, customer_mobile, subtotal, shipping_charge, total, created_at, updated_at, ship_country) VALUES ($1,$2,$3,'Tie',$4,100,0,100,$5,$5,NULL)", [String(id), orderNumber, String(donor._id), donor.mobile || "9", day]);
          await pool.query("INSERT INTO shop_order_items (order_id, product_id, product_name, unit_price, quantity, line_total) VALUES ($1,$2,'EQ Ord Simple',100,1,100)", [String(id), p1._id]);
        }
      }
      await step("ties admin", "GET", "/shop-admin/orders?search=TIE");
      await step("ties mine", "GET", "/shop/my-orders", undefined, donorTok);
      await step("ties paged", "GET", "/shop-admin/orders?search=TIE&limit=1&page=2");
      await snapshot("orders");
    },
    // Whether a write moves updatedAt (Mongoose save() on an unchanged value does not).
    async stamps() {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const watch = async (label, id, fn) => {
        const before = (await call(base, { path: "/shop-admin/products", token: tok })).data.products.find((p) => p._id === id);
        await sleep(15);
        const r = await fn();
        const after = (await call(base, { path: "/shop-admin/products", token: tok })).data.products.find((p) => p._id === id);
        out.push({ label, status: r.status, data: { moved: before?.updatedAt !== after?.updatedAt, respMoved: r.data?.product?.updatedAt !== before?.updatedAt } });
      };
      const s = await step("seed s", "POST", "/shop-admin/products", { name: "EQ Stamp", price: 10, stock: 3 });
      const v = await step("seed v", "POST", "/shop-admin/products", { name: "EQ StampV", hasVariants: true, variants: [{ label: "a", price: 1, stock: 1 }, { label: "b", price: 2 }] });
      const sid = s.data?.product?._id, vid = v.data?.product?._id, vv = v.data?.product?.variants;
      const P = (id, b) => () => call(base, { method: "PATCH", path: `/shop-admin/products/${id}/stock`, body: b, token: tok });
      await watch("stock same", sid, P(sid, { stock: 3 }));
      await watch("stock same str", sid, P(sid, { stock: "3" }));
      await watch("stock diff", sid, P(sid, { stock: 4 }));
      await watch("variant stock same", vid, P(vid, { stock: 1, variantId: vv[0]._id }));
      await watch("variant stock diff", vid, P(vid, { stock: 2, variantId: vv[0]._id }));
      await watch("variant stock default same", vid, P(vid, { stock: 0, variantId: vv[1]._id }));
      await watch("variant by upper id", vid, P(vid, { stock: 5, variantId: vv[1]._id.toUpperCase() }));
      await watch("variant by array id", vid, P(vid, { stock: 6, variantId: [vv[1]._id] }));
      await watch("variant by object id", vid, P(vid, { stock: 7, variantId: { _id: vv[1]._id } }));
      await watch("variant by junk id", vid, P(vid, { stock: 8, variantId: [vv[1]._id, vv[0]._id] }));
      await watch("empty update", sid, () => call(base, { method: "PATCH", path: `/shop-admin/products/${sid}`, body: {}, token: tok }));
      await watch("same name update", sid, () => call(base, { method: "PATCH", path: `/shop-admin/products/${sid}`, body: { name: "EQ Stamp" }, token: tok }));
      await watch("variants same update", vid, () => call(base, { method: "PATCH", path: `/shop-admin/products/${vid}`, body: { variants: vv }, token: tok }));
    },
    async ids() {
      const p = await step("seed", "POST", "/shop-admin/products", { name: "EQ Ids", price: 10 });
      const bad = ["abc", "123", "12345678901234567890123", "123456789012", "6aaa64c9a669e4e9df6564bg", "6AAA64C9A669E4E9DF6564B7", "%20", "null", "undefined", "0".repeat(24), "-1", "ab cd"];
      for (const id of bad)
        for (const [m, p, b] of [
          ["PATCH", "/shop-admin/products/ID", { name: "x" }],
          ["PATCH", "/shop-admin/products/ID/stock", { stock: 1 }],
          ["DELETE", "/shop-admin/products/ID"],
          ["PATCH", "/shop-admin/categories/ID", { name: "x" }],
          ["DELETE", "/shop-admin/categories/ID"],
          ["PATCH", "/shop-admin/orders/ID", { adminNote: "x" }],
        ])
          await step(`${m} ${p} ${id}`, m, p.replace("ID", encodeURIComponent(id)), b);
      await snapshot("ids");
    },
  };
  for (const [name, fn] of Object.entries(groups)) if (!only || only === name) await fn();
  return out;
}

const a = await run(A);
const b = await run(B);
let failures = 0;
if (a.length !== b.length) {
  console.log(`step count differs ${a.length} vs ${b.length}`);
  failures++;
}
const seenKinds = new Map();
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  const problems = [];
  if (a[i].status !== b[i].status) problems.push(`status ${a[i].status} != ${b[i].status}`);
  problems.push(...diff(prep(a[i].data), prep(b[i].data)));
  if (problems.length) {
    failures++;
    if (process.env.LIST) console.log("  *", a[i].label);
    const kind = a[i].label.replace(/=.*/, "") + "|" + problems[0].replace(/\d+/g, "N").slice(0, 60);
    const n = seenKinds.get(kind) || 0;
    seenKinds.set(kind, n + 1);
    if (n < 2) {
      console.log(`DIFF [${i}] ${a[i].label}`);
      problems.slice(0, 3).forEach((p) => console.log("   ", p));
      if (a[i].status !== b[i].status) console.log("    A", JSON.stringify(a[i].data)?.slice(0, 200), "\n    B", JSON.stringify(b[i].data)?.slice(0, 200));
    }
  }
}
if (process.env.SHOW) for (const x of a) console.log(x.label, JSON.stringify(x.data).slice(0,80));
console.log(`${a.length} steps compared, ${failures} differing steps`);
process.exit(failures ? 1 : 0);
