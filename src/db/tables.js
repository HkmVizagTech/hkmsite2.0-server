import { defineTable, prefix } from "./table.js";

export const users = defineTable({
  table: "users",
  nests: {
    preferences: {
      newDonation: "pref_new_donation",
      newDevotee: "pref_new_devotee",
      eventReminders: "pref_event_reminders",
      weeklyReport: "pref_weekly_report",
    },
  },
});

export const donors = defineTable({
  table: "donors",
  nests: { savedAddress: prefix("saved_", ["street", "city", "state", "pincode", "country"]) },
});

export const donorIssues = defineTable({ table: "donor_issues", renames: { donorRecordId: "donor_id" } });

export const donations = defineTable({
  table: "donations",
  nests: {
    utm: prefix("utm_", ["source", "medium", "campaign", "content", "term"]),
    prasadamAddress: prefix("prasadam_", ["doorNo", "house", "street", "area", "country", "state", "city", "pincode"]),
    paymentError: prefix("pe_", [
      "paymentId",
      "code",
      "description",
      "source",
      "step",
      "reason",
      "method",
      "bank",
      "wallet",
      "upiFlow",
      "cardNetwork",
      "at",
    ]),
    upiFallback: prefix("upi_", [
      "status",
      "app",
      "via",
      "openedAt",
      "claimedAt",
      "payerName",
      "matchedAt",
      "matchedBy",
      "matchedPaymentId",
      "note",
    ]),
  },
  json: ["dccPayload", "dccResponse"],
  keepNull: ["dccEnrolledById", "lastReconcileCheckAt"],
});

export const events = defineTable({ table: "events", json: ["registrationForm"] });

export const registrations = defineTable({
  table: "event_registrations",
  nests: { attendance: { present: "attendance_present", at: "attendance_at", scannedBy: "attendance_scanned_by" } },
  json: ["data"],
});

export const festivalDonations = defineTable({ table: "festival_donations", json: ["donationOptions", "meta"] });
export const festivalShowcases = defineTable({
  table: "festival_showcases",
  json: ["schedule", "details", "testimonials"],
});
export const templeDevotees = defineTable({ table: "temple_devotees" });
export const campaigners = defineTable({
  table: "campaigners",
  renames: { referredByDevotee: "referred_by_devotee_id" },
});
export const plans = defineTable({ table: "plans" });

export const shopCategories = defineTable({ table: "shop_categories" });
export const products = defineTable({ table: "products", hidden: ["search"] });
export const productVariants = defineTable({ table: "product_variants", timestamps: false });
export const shopSettings = defineTable({ table: "shop_settings" });
export const shopOrders = defineTable({
  table: "shop_orders",
  nests: {
    shippingRuleSnapshot: { flatCharge: "shipping_rule_flat", freeAbove: "shipping_rule_free_above" },
    shippingAddress: prefix("ship_", ["street", "city", "state", "pincode", "country"]),
    tracking: { courier: "tracking_courier", trackingNumber: "tracking_number", url: "tracking_url" },
  },
  json: ["statusHistory", "stockShortfall"],
});
export const shopOrderItems = defineTable({ table: "shop_order_items", timestamps: false, serialId: true });

export const blogs = defineTable({
  table: "blogs",
  hidden: ["search"],
  nests: { author: { name: "author_name", avatar: "author_avatar", bio: "author_bio", slug: "author_slug" } },
});
export const contactMessages = defineTable({ table: "contact_messages" });
export const darshans = defineTable({ table: "darshans" });
export const donationPages = defineTable({
  table: "donation_pages",
  json: ["donationOptions", "impactItems", "bankDetails", "contact"],
});
export const siteContent = defineTable({
  table: "site_content",
  json: ["hero", "about", "contact", "navbar", "festival", "construction"],
});
export const galleries = defineTable({ table: "galleries" });
export const heroBanners = defineTable({ table: "hero_banners" });
export const importantDates = defineTable({ table: "important_dates" });
export const media = defineTable({ table: "media" });
export const volunteerEvents = defineTable({ table: "volunteer_events", json: ["formFields"] });
export const volunteerRegistrations = defineTable({ table: "volunteer_registrations", json: ["responses"] });
export const paymentDowntimes = defineTable({ table: "payment_downtimes", timestamps: false, json: ["instrument"] });
