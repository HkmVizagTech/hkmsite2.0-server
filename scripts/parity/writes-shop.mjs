// Replays the same shop mutations against baseline (Mongo) and new (Postgres) servers and compares
// every response plus the resulting product/order/category/settings state.
//   SRC_MONGO_URI=... DATABASE_URL=... node scripts/parity/writes-shop.mjs http://localhost:9300 http://localhost:9301
// Run `scripts/parity/env.sh reset shop` before each run.
import crypto from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import pg from "pg";
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
import { sign, call, normalize, diff, discover } from "./lib.mjs";

const [A, B] = [process.argv[2], process.argv[3]];
const mongoUri = process.env.SRC_MONGO_URI;
const mongoClient = new MongoClient(mongoUri);
await mongoClient.connect();
const mdb = mongoClient.db();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ctx = await discover(mongoUri);

const adminTok = sign({ userId: ctx.admin, role: "admin" });
const shopTok = sign({ userId: ctx.shopAdmin || ctx.admin, role: ctx.shopAdmin ? "shop_admin" : "admin" });
const donorTok = sign({ donorId: ctx.donorWithDonations, type: "donor" });
const donorUser = await mdb.collection("donors").findOne({ _id: new ObjectId(ctx.donorWithDonations) });
const RZP_SECRET = "local-razorpay-secret";
const RUN = Date.now();
const hex = () => new ObjectId().toHexString();

async function seedOrder(side, o) {
  const now = Date.now();
  if (side === "mongo") {
    await mdb.collection("shoporders").insertOne({
      _id: new ObjectId(o.id),
      orderNumber: o.orderNumber,
      donorRecordId: donorUser._id,
      customerName: "ZZ Tester",
      customerMobile: donorUser.mobile || "9999999999",
      items: o.items.map((i) => ({
        productId: new ObjectId(i.productId),
        productName: i.productName,
        slug: i.slug,
        image: i.image,
        variantId: i.variantId ? new ObjectId(i.variantId) : null,
        variantLabel: i.variantLabel || null,
        unitPrice: i.unitPrice,
        quantity: i.quantity,
        lineTotal: i.unitPrice * i.quantity,
        freeShipping: false,
      })),
      subtotal: o.subtotal,
      shippingCharge: 0,
      total: o.subtotal,
      shippingAddress: { street: "1 Test St", city: "Vizag", state: "AP", pincode: "530001", country: "India" },
      paymentStatus: "pending",
      razorpayOrderId: o.rzp,
      paymentAccount: "shop",
      fulfilmentStatus: "placed",
      statusHistory: [{ status: "placed", note: "Order created", at: new Date(now - o.age * 60000) }],
      stockCommitted: false,
      stockShortfall: [],
      needsAttention: false,
      createdAt: new Date(now - o.age * 60000),
      updatedAt: new Date(now - o.age * 60000),
    });
  } else {
    await pool.query(
      `INSERT INTO shop_orders (id, order_number, donor_record_id, customer_name, customer_mobile, subtotal, shipping_charge, total,
         ship_street, ship_city, ship_state, ship_pincode, ship_country, razorpay_order_id, payment_account, status_history, created_at, updated_at)
       VALUES ($1,$2,$3,'ZZ Tester',$4,$5,0,$5,'1 Test St','Vizag','AP','530001','India',$6,'shop',$7,$8,$8)`,
      [
        o.id,
        o.orderNumber,
        String(donorUser._id),
        donorUser.mobile || "9999999999",
        o.subtotal,
        o.rzp,
        JSON.stringify([{ status: "placed", note: "Order created", at: new Date(now - o.age * 60000) }]),
        new Date(now - o.age * 60000),
      ]
    );
    for (const i of o.items) {
      await pool.query(
        `INSERT INTO shop_order_items (order_id, product_id, variant_id, product_name, slug, image, variant_label, unit_price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          o.id,
          i.productId,
          i.variantId || null,
          i.productName,
          i.slug,
          i.image,
          i.variantLabel || null,
          i.unitPrice,
          i.quantity,
          i.unitPrice * i.quantity,
        ]
      );
    }
  }
}

async function scenario(base, side, orderIds) {
  const out = [];
  const ids = {};
  const req = async (label, o) => {
    const r = await call(base, o);
    out.push({ label, ...r });
    return r;
  };
  const admin = (label, method, path, body, token = shopTok) => req(label, { method, path, body, token });

  // ---- auth ----
  await req("no token", { path: "/shop-admin/products" });
  await req("donor token on admin", { path: "/shop-admin/products", token: donorTok });
  await req("bad token", { path: "/shop-admin/orders", token: "nope" });

  // ---- categories ----
  await admin("cat create missing name", "POST", "/shop-admin/categories", {});
  let r = await admin("cat create", "POST", "/shop-admin/categories", {
    name: "  ZZ Test Cat ",
    description: " desc ",
    sortOrder: 5,
  });
  ids.cat = r.data?.category?._id;
  await admin("cat create dup", "POST", "/shop-admin/categories", { name: "ZZ Test Cat" });
  r = await admin("cat create 2", "POST", "/shop-admin/categories", { name: "ZZ Another", sortOrder: 5 });
  ids.cat2 = r.data?.category?._id;
  await admin("cat update", "PATCH", `/shop-admin/categories/${ids.cat}`, {
    name: " ZZ Renamed ",
    description: "d2",
    sortOrder: "7",
    image: "http://x/c.png",
  });
  await admin("cat update hide", "PATCH", `/shop-admin/categories/${ids.cat2}`, { status: "hidden" });
  await admin("cat update unknown", "PATCH", `/shop-admin/categories/${hex()}`, { name: "x" });
  await admin("cat update bad id", "PATCH", "/shop-admin/categories/nope", { name: "x" });
  await admin("cat list", "GET", "/shop-admin/categories");
  await req("public categories", { path: "/shop/categories" });

  // ---- settings ----
  await admin("settings get", "GET", "/shop-admin/settings");
  await admin("settings bad charge", "PATCH", "/shop-admin/settings", { flatShippingCharge: -1 });
  await admin("settings bad free", "PATCH", "/shop-admin/settings", { freeShippingAbove: "abc" });
  await admin("settings update", "PATCH", "/shop-admin/settings", {
    flatShippingCharge: 50,
    freeShippingAbove: 500,
    announcement: "  Sale  ",
    supportMobile: " 9876543210 ",
    deliveryEstimate: "2 days",
  });
  await req("public settings", { path: "/shop/settings" });

  // ---- products ----
  await admin("prod create no name", "POST", "/shop-admin/products", { price: 5 });
  await admin("prod create bad price", "POST", "/shop-admin/products", { name: "ZZ x", price: "5" });
  await admin("prod create variants none", "POST", "/shop-admin/products", {
    name: "ZZ x",
    hasVariants: true,
    variants: [],
  });
  await admin("prod create variant no label", "POST", "/shop-admin/products", {
    name: "ZZ x",
    hasVariants: true,
    variants: [{ price: 1 }],
  });
  await admin("prod create variant bad price", "POST", "/shop-admin/products", {
    name: "ZZ x",
    hasVariants: true,
    variants: [{ label: "a", price: "1" }],
  });
  r = await admin("prod create simple", "POST", "/shop-admin/products", {
    name: "  ZZ Test Agarbatti  ",
    shortDescription: " soft scent ",
    description: "<p>d</p>",
    category: "zz-test-cat",
    price: 120,
    mrp: 150,
    stock: 10,
    tags: ["Incense", "zz"],
    images: ["http://x/1.jpg", "", "http://x/2.jpg"],
    status: "active",
    weightGrams: 100,
    featured: true,
    sortOrder: 3,
  });
  ids.p1 = r.data?.product?._id;
  r = await admin("prod create variants", "POST", "/shop-admin/products", {
    name: "ZZ Test Mala",
    category: "zz-test-cat",
    hasVariants: true,
    status: "active",
    tags: ["japa"],
    freeShipping: true,
    variants: [
      { label: " Small ", price: 80, stock: 5, sku: " S1 " },
      { label: "Large", price: 330, mrp: 400, stock: 2, weightGrams: 50 },
    ],
  });
  ids.p2 = r.data?.product?._id;
  ids.p2v = (r.data?.product?.variants || []).map((v) => v._id);
  r = await admin("prod create dup name", "POST", "/shop-admin/products", {
    name: "ZZ Test Agarbatti",
    price: 0,
    stock: 0,
    status: "active",
    category: "zz-test-cat",
  });
  ids.p3 = r.data?.product?._id;
  r = await admin("prod create draft", "POST", "/shop-admin/products", {
    name: "ZZ Draft Book",
    price: 10,
    stock: 4,
    category: "other-cat",
    tags: ["50% off_deal"],
  });
  ids.p4 = r.data?.product?._id;
  await admin("prod create explicit slug", "POST", "/shop-admin/products", {
    name: "ZZ Slugged",
    slug: "My Custom Slug!",
    price: 7,
    status: "active",
  });

  await admin("admin list", "GET", "/shop-admin/products");
  await admin("admin list search", "GET", "/shop-admin/products?search=zz");
  await admin("admin list search tag", "GET", "/shop-admin/products?search=JAPA");
  await admin("admin list search pct", "GET", "/shop-admin/products?search=50%25");
  await admin("admin list status", "GET", "/shop-admin/products?status=draft");
  await admin("admin list category", "GET", "/shop-admin/products?category=zz-test-cat&status=active");

  // updates
  await admin("prod update unknown", "PATCH", `/shop-admin/products/${hex()}`, { name: "x" });
  await admin("prod update bad id", "PATCH", "/shop-admin/products/nope", { name: "x" });
  await admin("prod update basic", "PATCH", `/shop-admin/products/${ids.p1}`, {
    name: " ZZ Test Agarbatti Deluxe ",
    shortDescription: "  new  ",
    price: 130,
    mrp: 0,
    stock: 12,
    tags: ["a"],
    featured: false,
    status: "draft",
    sortOrder: 1,
  });
  await admin("prod update regen slug", "PATCH", `/shop-admin/products/${ids.p1}`, {
    name: "ZZ Test Mala",
    regenerateSlug: true,
    status: "active",
  });
  await admin("prod update variants empty", "PATCH", `/shop-admin/products/${ids.p1}`, {
    hasVariants: true,
    variants: [],
  });
  await admin("prod update to variants", "PATCH", `/shop-admin/products/${ids.p1}`, {
    hasVariants: true,
    variants: [
      { label: "100g", price: 10, stock: 3 },
      { label: "250g", price: 20, stock: 0 },
    ],
  });
  await admin("prod update back to simple", "PATCH", `/shop-admin/products/${ids.p1}`, {
    hasVariants: false,
    price: 120,
    stock: 10,
  });
  const v = ids.p2v;
  await admin("prod update keep variant ids", "PATCH", `/shop-admin/products/${ids.p2}`, {
    hasVariants: true,
    variants: [
      { _id: v[1], label: "Large", price: 340, stock: 2 },
      { _id: v[0], label: "Small", price: 85, stock: 5 },
      { label: "Medium", price: 200, stock: 1 },
    ],
  });
  ids.p2vAfter = (
    await admin("prod get after reorder", "GET", `/shop-admin/products?search=ZZ%20Test%20Mala`)
  ).data?.products
    ?.find((p) => p._id === ids.p2)
    ?.variants?.map((x) => x._id);
  await admin("prod update to original variants", "PATCH", `/shop-admin/products/${ids.p2}`, {
    variants: [
      { _id: v[0], label: "Small", price: 80, stock: 5 },
      { _id: v[1], label: "Large", price: 330, mrp: 400, stock: 2, weightGrams: 50 },
    ],
  });

  // stock
  await admin("stock bad", "PATCH", `/shop-admin/products/${ids.p1}/stock`, { stock: -1 });
  await admin("stock nan", "PATCH", `/shop-admin/products/${ids.p1}/stock`, { stock: "x" });
  await admin("stock unknown", "PATCH", `/shop-admin/products/${hex()}/stock`, { stock: 1 });
  await admin("stock bad id", "PATCH", "/shop-admin/products/nope/stock", { stock: 1 });
  await admin("stock simple", "PATCH", `/shop-admin/products/${ids.p1}/stock`, { stock: 10 });
  await admin("stock variant missing", "PATCH", `/shop-admin/products/${ids.p2}/stock`, { stock: 4 });
  await admin("stock variant unknown", "PATCH", `/shop-admin/products/${ids.p2}/stock`, { stock: 4, variantId: hex() });
  await admin("stock variant bad id", "PATCH", `/shop-admin/products/${ids.p2}/stock`, { stock: 4, variantId: "zz" });
  await admin("stock variant ok", "PATCH", `/shop-admin/products/${ids.p2}/stock`, { stock: 2, variantId: v[1] });

  // ---- public catalog ----
  for (const q of [
    "",
    "?search=agar",
    "?search=ZZ",
    "?search=incense",
    "?search=japa",
    "?search=50%25",
    "?search=a_b",
    "?sort=price-asc",
    "?sort=price-desc",
    "?sort=newest",
    "?inStockOnly=true",
    "?category=zz-test-cat",
    "?category=zz-test-cat&limit=1&page=2",
    "?limit=2&page=2&sort=price-asc",
    `?ids=${ids.p1},${ids.p2},zz`,
    "?ids=zz",
    `?ids=${String(ids.p1).toUpperCase()}`,
    "?limit=1000",
    "?page=-3",
    "?search=%20%20",
  ]) {
    await req(`public list ${q}`, { path: `/shop/products${q}` });
  }
  const slugOf = async (id) =>
    (await admin("slug lookup", "GET", "/shop-admin/products")).data?.products?.find((p) => p._id === id)?.slug;
  for (const id of [ids.p1, ids.p2, ids.p3, ids.p4]) {
    const slug = await slugOf(id);
    await req(`public product ${slug}`, { path: `/shop/products/${slug}` });
  }
  await req("public product missing", { path: "/shop/products/does-not-exist" });

  // ---- cart quote ----
  const q = (label, items) => req(label, { method: "POST", path: "/shop/cart/quote", body: { items } });
  await q("quote empty", []);
  await req("quote no body items", { method: "POST", path: "/shop/cart/quote", body: {} });
  await q("quote ok", [
    { productId: ids.p1, quantity: 2 },
    { productId: ids.p2, variantId: v[1], quantity: 1 },
  ]);
  await q("quote variant missing", [{ productId: ids.p2, quantity: 1 }]);
  await q("quote qty bad", [
    { productId: ids.p1, quantity: 0 },
    { productId: ids.p1, quantity: 100 },
  ]);
  await q("quote stock", [
    { productId: ids.p1, quantity: 11 },
    { productId: ids.p2, variantId: v[1], quantity: 9 },
  ]);
  await q("quote draft+unknown", [
    { productId: ids.p4, quantity: 1 },
    { productId: hex(), quantity: 1 },
    { quantity: 1 },
  ]);
  await q("quote bad id", [{ productId: "zzz", quantity: 1 }]);
  await q("quote free ship", [{ productId: ids.p2, variantId: v[0], quantity: 1 }]);
  await q("quote above threshold", [{ productId: ids.p1, quantity: 5 }]);
  await q(
    "quote too many",
    Array.from({ length: 51 }, () => ({ productId: ids.p1, quantity: 1 }))
  );

  // ---- checkout validation (stops before Razorpay) ----
  const co = (label, body, token = donorTok) => req(label, { method: "POST", path: "/shop/orders", body, token });
  await co("order no auth", {}, undefined);
  await co("order no address", { items: [{ productId: ids.p1, quantity: 1 }] });
  await co("order bad pin", {
    items: [{ productId: ids.p1, quantity: 1 }],
    shippingAddress: { street: "a", city: "b", state: "c", pincode: "123" },
  });
  await co("order empty cart", {
    items: [],
    shippingAddress: { street: "a", city: "b", state: "c", pincode: "530001" },
  });
  await co("order problems", {
    items: [{ productId: ids.p1, quantity: 99 }],
    shippingAddress: { street: "a", city: "b", state: "c", pincode: "530001" },
  });
  await admin("shop close", "PATCH", "/shop-admin/settings", { shopEnabled: false });
  await co("order shop closed", {});
  await admin("shop reopen", "PATCH", "/shop-admin/settings", { shopEnabled: true });

  // ---- order lifecycle on seeded orders ----
  const [o1, o2, o3] = orderIds;
  const pay = (label, order, sig) =>
    req(label, {
      method: "POST",
      path: "/shop/orders/verify",
      body: {
        razorpay_order_id: order.rzp,
        razorpay_payment_id: `pay_${order.rzp}`,
        razorpay_signature:
          sig ?? crypto.createHmac("sha256", RZP_SECRET).update(`${order.rzp}|pay_${order.rzp}`).digest("hex"),
      },
    });
  await req("verify missing", { method: "POST", path: "/shop/orders/verify", body: {} });
  await req("verify unknown order", {
    method: "POST",
    path: "/shop/orders/verify",
    body: { razorpay_order_id: "order_none", razorpay_payment_id: "p", razorpay_signature: "s" },
  });
  await pay("verify bad sig", o1, "deadbeef");
  await pay("verify o1", o1);
  await pay("verify o1 again", o1);
  await admin("products after o1", "GET", "/shop-admin/products?search=ZZ");
  await pay("verify o2 (shortfall)", o2);
  await pay("verify o2 again", o2);
  await admin("products after o2", "GET", "/shop-admin/products?search=ZZ");
  await req("my orders", { path: "/shop/my-orders", token: donorTok });
  await req("my order o1", { path: `/shop/my-orders/${o1.orderNumber}`, token: donorTok });
  await req("my order unknown", { path: "/shop/my-orders/NOPE", token: donorTok });
  await req("my orders no auth", { path: "/shop/my-orders" });

  const up = (label, order, body) => admin(label, "PATCH", `/shop-admin/orders/${order.id}`, body);
  await admin("order patch unknown", "PATCH", `/shop-admin/orders/${hex()}`, { adminNote: "x" });
  await admin("order patch bad id", "PATCH", "/shop-admin/orders/nope", { adminNote: "x" });
  await up("order bad status", o1, { fulfilmentStatus: "teleported" });
  await up("order packed", o1, { fulfilmentStatus: "packed", note: "boxed" });
  await up("order cancel (restore)", o1, { fulfilmentStatus: "cancelled", note: "customer asked" });
  await up("order cancel again", o1, { fulfilmentStatus: "cancelled" });
  await admin("products after cancel", "GET", "/shop-admin/products?search=ZZ");
  await up("order ship + tracking", o2, {
    fulfilmentStatus: "shipped",
    tracking: { trackingNumber: "1234567890123" },
    adminNote: "  hi  ",
  });
  await up("order tracking url", o2, {
    tracking: { courier: "Delhivery", trackingNumber: "ABC123", url: "http://t/x" },
  });
  await up("order payment refunded", o2, { paymentStatus: "refunded", needsAttention: false });
  await up("order payment bogus (ignored)", o2, { paymentStatus: "bogus" });
  await up("order delivered", o2, { fulfilmentStatus: "delivered" });
  await up("order empty patch", o3, {});
  await up("order needs attention", o3, { needsAttention: true, adminNote: "look" });
  await admin("orders list", "GET", "/shop-admin/orders");
  for (const qs of [
    "?paymentStatus=paid",
    "?fulfilmentStatus=cancelled",
    "?needsAttention=true",
    "?search=HKMS-TEST",
    "?search=zz%20tester",
    "?limit=2&page=2",
    "?paymentStatus=all&fulfilmentStatus=all",
    "?search=%25",
  ]) {
    await admin(`orders list ${qs}`, "GET", `/shop-admin/orders${qs}`);
  }

  // ---- deletes ----
  await admin("cat delete in use", "DELETE", `/shop-admin/categories/${ids.cat}`);
  await admin("cat delete hidden", "DELETE", `/shop-admin/categories/${ids.cat2}`);
  await admin("cat delete again", "DELETE", `/shop-admin/categories/${ids.cat2}`);
  await admin("cat delete bad id", "DELETE", "/shop-admin/categories/nope");
  await admin("prod delete p3", "DELETE", `/shop-admin/products/${ids.p3}`);
  await admin("prod delete p3 again", "DELETE", `/shop-admin/products/${ids.p3}`);
  await admin("prod delete bad id", "DELETE", "/shop-admin/products/nope");
  await admin("final products", "GET", "/shop-admin/products");
  await admin("final categories", "GET", "/shop-admin/categories");
  await admin("final settings", "GET", "/shop-admin/settings");
  return out;
}

const mask = (s) => {
  const seen = new Map();
  return s
    .replace(/[0-9a-f]{24}/g, (m) => {
      if (!seen.has(m)) seen.set(m, `<id${seen.size}>`);
      return seen.get(m);
    })
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<ts>");
};
const prep = (r) => JSON.parse(mask(JSON.stringify(normalize(r.data) ?? null)));

function makeOrders(prods) {
  const [p1, p2] = prods;
  const item = (p, qty, variantIdx) => ({
    productId: p.id,
    productName: p.name,
    slug: p.slug,
    image: "http://x/1.jpg",
    unitPrice: variantIdx == null ? p.price : p.variants[variantIdx].price,
    variantId: variantIdx == null ? null : p.variants[variantIdx].id,
    variantLabel: variantIdx == null ? null : p.variants[variantIdx].label,
    quantity: qty,
  });
  const mk = (n, items, age) => ({
    id: hex(),
    orderNumber: `HKMS-TEST-0000${n}`,
    rzp: `order_zz${n}${RUN}`,
    age,
    items,
    subtotal: items.reduce((s, i) => s + i.unitPrice * i.quantity, 0),
  });
  return [mk(1, [item(p1, 3)], 30), mk(2, [item(p2, 2, 1), item(p1, 20)], 20), mk(3, [item(p2, 1, 0)], 10)];
}

async function snapshot(side) {
  if (side === "mongo") {
    const prods = await mdb.collection("products").find({}).sort({ slug: 1 }).toArray();
    const orders = await mdb.collection("shoporders").find({}).sort({ orderNumber: 1 }).toArray();
    const cats = await mdb.collection("shopcategories").find({}).sort({ slug: 1 }).toArray();
    const settings = await mdb.collection("shopsettings").find({}).toArray();
    return {
      products: prods.map((p) => ({
        slug: p.slug,
        name: p.name,
        stock: p.stock,
        price: p.price,
        hasVariants: p.hasVariants,
        status: p.status,
        tags: p.tags,
        images: p.images,
        variants: (p.variants || []).map((x) => ({
          _id: String(x._id),
          label: x.label,
          sku: x.sku,
          price: x.price,
          mrp: x.mrp,
          stock: x.stock,
          weightGrams: x.weightGrams,
        })),
      })),
      orders: orders.map((o) => ({
        orderNumber: o.orderNumber,
        paymentStatus: o.paymentStatus,
        fulfilmentStatus: o.fulfilmentStatus,
        stockCommitted: o.stockCommitted,
        needsAttention: !!o.needsAttention,
        shortfall: (o.stockShortfall || []).map((x) => ({ ...x, productId: String(x.productId) })),
        tracking: o.tracking,
        adminNote: o.adminNote,
        shippedAt: !!o.shippedAt,
        paidAt: !!o.paidAt,
        history: (o.statusHistory || []).map((h) => `${h.status}:${h.note || ""}`),
        items: (o.items || []).map((i) => `${i.productName}|${i.variantLabel || ""}|${i.quantity}|${i.lineTotal}`),
      })),
      categories: cats.map((c) => ({
        slug: c.slug,
        name: c.name,
        status: c.status,
        sortOrder: c.sortOrder,
        description: c.description,
      })),
      settings: settings.map((s) => ({
        ...s,
        _id: String(s._id),
        createdAt: 0,
        updatedAt: 0,
        updatedBy: s.updatedBy ? "u" : undefined,
      })),
    };
  }
  const q = async (s) => (await pool.query(s)).rows;
  const prods = await q("SELECT * FROM products ORDER BY slug");
  const vars = await q("SELECT * FROM product_variants ORDER BY product_id, position, id");
  const orders = await q("SELECT * FROM shop_orders ORDER BY order_number");
  const items = await q("SELECT * FROM shop_order_items ORDER BY order_id, id");
  const cats = await q("SELECT * FROM shop_categories ORDER BY slug");
  const settings = await q("SELECT * FROM shop_settings");
  const nn = (v) => (v === null ? undefined : v);
  const num = (v) => (v === null || v === undefined ? undefined : Number(v));
  return {
    products: prods.map((p) => ({
      slug: p.slug,
      name: p.name,
      stock: p.stock,
      price: num(p.price),
      hasVariants: p.has_variants,
      status: p.status,
      tags: p.tags,
      images: p.images,
      variants: vars
        .filter((x) => x.product_id === p.id)
        .map((x) => ({
          _id: x.id,
          label: x.label,
          sku: nn(x.sku),
          price: Number(x.price),
          mrp: num(x.mrp),
          stock: x.stock,
          weightGrams: nn(x.weight_grams),
        })),
    })),
    orders: orders.map((o) => ({
      orderNumber: o.order_number,
      paymentStatus: o.payment_status,
      fulfilmentStatus: o.fulfilment_status,
      stockCommitted: o.stock_committed,
      needsAttention: o.needs_attention,
      shortfall: o.stock_shortfall,
      tracking:
        o.tracking_courier || o.tracking_number || o.tracking_url
          ? { courier: nn(o.tracking_courier), trackingNumber: nn(o.tracking_number), url: nn(o.tracking_url) }
          : undefined,
      adminNote: nn(o.admin_note),
      shippedAt: !!o.shipped_at,
      paidAt: !!o.paid_at,
      history: o.status_history.map((h) => `${h.status}:${h.note || ""}`),
      items: items
        .filter((i) => i.order_id === o.id)
        .map((i) => `${i.product_name}|${i.variant_label || ""}|${i.quantity}|${Number(i.line_total)}`),
    })),
    categories: cats.map((c) => ({
      slug: c.slug,
      name: c.name,
      status: c.status,
      sortOrder: c.sort_order,
      description: nn(c.description),
    })),
    settings: settings.map((s) => ({
      _id: s.id,
      shopEnabled: s.shop_enabled,
      flatShippingCharge: Number(s.flat_shipping_charge),
      freeShippingAbove: Number(s.free_shipping_above),
      announcement: nn(s.announcement),
      supportMobile: nn(s.support_mobile),
      deliveryEstimate: s.delivery_estimate,
      createdAt: 0,
      updatedAt: 0,
      updatedBy: s.updated_by ? "u" : undefined,
    })),
  };
}

// Seeded orders need real product ids, so the seed products are created through the API first.
async function runSide(base, side) {
  const seeded = await createSeedProducts(base);
  const orders = makeOrders(seeded);
  for (const o of orders) await seedOrder(side, o);
  return scenario(base, side, orders);
}

async function createSeedProducts(base) {
  const post = (body) => call(base, { method: "POST", path: "/shop-admin/products", token: shopTok, body });
  const a = await post({
    name: "ZZ Seed Simple",
    category: "zz-seed",
    price: 100,
    mrp: 120,
    stock: 10,
    status: "active",
  });
  const b = await post({
    name: "ZZ Seed Variant",
    category: "zz-seed",
    hasVariants: true,
    status: "active",
    variants: [
      { label: "Small", price: 80, stock: 5 },
      { label: "Large", price: 330, stock: 2 },
    ],
  });
  const doc = (r) => ({
    id: r.data.product._id,
    name: r.data.product.name,
    slug: r.data.product.slug,
    price: r.data.product.price,
    variants: (r.data.product.variants || []).map((x) => ({ id: x._id, label: x.label, price: x.price })),
  });
  return [doc(a), doc(b)];
}

const results = {};
for (const [name, base, side] of [
  ["A", A, "mongo"],
  ["B", B, "pg"],
]) {
  results[name] = { out: await runSide(base, side), snap: await snapshot(side) };
}

let failures = 0;
const a = results.A.out,
  b = results.B.out;
if (a.length !== b.length) {
  console.log(`step count differs ${a.length} vs ${b.length}`);
  failures++;
}
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  const sa = a[i],
    sb = b[i];
  const problems = [];
  if (sa.status !== sb.status) problems.push(`status ${sa.status} != ${sb.status}`);
  const d = diff(prep(sa), prep(sb));
  if (d.length) problems.push(...d);
  if (problems.length) {
    failures++;
    console.log(`DIFF [${i}] ${sa.label}`);
    problems.slice(0, 6).forEach((p) => console.log("   ", p));
  }
}
const sd = diff(
  JSON.parse(mask(JSON.stringify(normalize(results.A.snap)))),
  JSON.parse(mask(JSON.stringify(normalize(results.B.snap))))
);
if (sd.length) {
  failures++;
  console.log("DB STATE DIFF");
  sd.forEach((p) => console.log("   ", p));
}
console.log(`${a.length} steps compared, ${failures} difference group(s)`);
await mongoClient.close();
await pool.end();
process.exit(failures ? 1 : 0);
