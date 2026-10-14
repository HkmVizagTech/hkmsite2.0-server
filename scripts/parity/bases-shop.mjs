// Valid base bodies for fuzz.mjs on the shop prefixes.
import { discover } from "./lib.mjs";
const ctx = await discover(process.env.SRC_MONGO_URI);
const pid = String(ctx.product?._id);
const address = { street: "1 Test St", city: "Vizag", state: "AP", pincode: "530001" };
const P = "6aaa64c9a669e4e9df6564b7";
const bases = {
  "POST /shop-admin/products": { name: "Fuzz Product", price: 10 },
  "PATCH /shop-admin/products/:id": { name: "Fuzz Renamed" },
  "PATCH /shop-admin/products/:id/stock": { stock: 5 },
  "POST /shop-admin/categories": { name: "Fuzz Category" },
  "PATCH /shop-admin/categories/:id": { description: "d" },
  "PATCH /shop-admin/orders/:id": { adminNote: "n" },
  "PATCH /shop-admin/settings": { announcement: "hello" },
  "POST /shop/cart/quote": { items: [{ productId: pid, quantity: 1 }] },
  "POST /shop/orders": { items: [{ productId: pid, quantity: 1 }], shippingAddress: address },
  "POST /shop/orders/verify": { razorpay_order_id: "order_x", razorpay_payment_id: "pay_x", razorpay_signature: "sig" },
};

// Fuzz runs against a routes file may bake real ids into the paths (FUZZ_REAL_IDS=product,category,order).
const [, category, order] = (process.env.FUZZ_REAL_IDS || "").split(",");
for (const [k, v] of Object.entries({ ...bases })) {
  if (k.includes("/shop-admin/products/:id")) bases[k.replace(":id", P)] = v;
  if (k.includes("/shop-admin/categories/:id") && category) bases[k.replace(":id", category)] = v;
  if (k.includes("/shop-admin/orders/:id") && order) bases[k.replace(":id", order)] = v;
}
export default bases;
