const mongoose = require("mongoose");

// A line on the order. Every display field is SNAPSHOTTED at purchase time
// (name, variant label, image, unit price) rather than looked up live from
// the product later. If the shop admin later renames a product, changes its
// price or deletes it outright, this order must still show exactly what the
// devotee bought and what they paid — an order is a financial record, not a
// live view of the catalog.
const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "product" },
    productName: { type: String, required: true },
    slug: { type: String },
    image: { type: String },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantLabel: { type: String, default: null },
    unitPrice: { type: Number, required: true },
    mrp: { type: Number },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true },
    // Whether "free delivery" applied to this line at purchase time —
    // snapshotted like the rest, so an admin later un-flagging a product
    // never rewrites the shipping maths an old order displays.
    freeShipping: { type: Boolean, default: false },
  },
  { _id: false, versionKey: false }
);

const shopOrderSchema = new mongoose.Schema(
  {
    // Human-friendly reference given to the devotee and used by staff:
    // "HKMS-2026-00001". Generated from the shared atomic counter.
    orderNumber: { type: String, required: true, unique: true, index: true },

    // The customer's identity record — the same Donor record the donor
    // portal uses, so somebody who has both donated and bought books is one
    // person with one login, one saved address and one mobile number.
    donorRecordId: { type: mongoose.Schema.Types.ObjectId, ref: "donor", index: true },
    customerName: { type: String, required: true },
    customerMobile: { type: String, required: true, index: true },
    customerEmail: { type: String },

    items: { type: [orderItemSchema], required: true },

    // All money is recomputed server-side from the catalog at order time —
    // nothing here is ever taken from the browser's copy of the cart.
    subtotal: { type: Number, required: true },
    shippingCharge: { type: Number, default: 0 },
    total: { type: Number, required: true },
    // Snapshot of the shipping rule applied, so a later settings change
    // never makes an old order's maths look wrong.
    shippingRuleSnapshot: {
      flatCharge: { type: Number },
      freeAbove: { type: Number },
    },

    shippingAddress: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
      country: { type: String, default: "India" },
    },
    customerNote: { type: String, trim: true },

    // ---- Payment ----
    // Deliberately separate from fulfilment: "paid but not yet shipped" and
    // "delivered but payment failed to reconcile" are both real states, and
    // one enum can't express them.
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
      index: true,
    },
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: { type: String },
    // Which Razorpay account took the money. Shop orders run on the same
    // account as donations, but this is recorded per-order because that's a
    // runtime choice, not a permanent fact — the same reason
    // donation.paymentAccount exists.
    paymentAccount: { type: String },
    paidAt: { type: Date },

    // ---- Fulfilment ----
    fulfilmentStatus: {
      type: String,
      enum: ["placed", "packed", "shipped", "delivered", "cancelled"],
      default: "placed",
      index: true,
    },
    tracking: {
      courier: { type: String },
      trackingNumber: { type: String },
      url: { type: String },
    },
    // When the parcel actually left. Set by the admin PATCH the first time
    // the order moves to "shipped"; the auto-tracking job uses it to decide
    // how long to keep polling the courier for this order.
    shippedAt: { type: Date },
    adminNote: { type: String },
    statusHistory: {
      type: [
        {
          _id: false,
          status: String,
          note: String,
          at: { type: Date, default: Date.now },
          byUserId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
        },
      ],
      default: [],
    },

    // ---- Stock bookkeeping ----
    // Stock is committed (decremented) exactly once, when payment is
    // confirmed — never at checkout-start, or every abandoned cart would
    // quietly hold inventory hostage. This flag is what makes that "exactly
    // once" true even though BOTH the verify call and the Razorpay webhook
    // can race to confirm the same payment.
    stockCommitted: { type: Boolean, default: false },
    // If a confirmed payment couldn't fully decrement a line (the last unit
    // sold to someone else in the seconds between checkout and payment),
    // the shortfall is recorded here and the order is flagged for staff
    // rather than silently shipping something that isn't on the shelf.
    stockShortfall: {
      type: [
        {
          _id: false,
          productId: mongoose.Schema.Types.ObjectId,
          productName: String,
          variantLabel: String,
          requested: Number,
          available: Number,
        },
      ],
      default: [],
    },
    needsAttention: { type: Boolean, default: false },

    whatsappConfirmationSentAt: { type: Date },
    whatsappConfirmationError: { type: String },
  },
  { timestamps: true, versionKey: false }
);

shopOrderSchema.index({ createdAt: -1 });

const shopOrderModel = mongoose.model("shopOrder", shopOrderSchema);
module.exports = { shopOrderModel };
