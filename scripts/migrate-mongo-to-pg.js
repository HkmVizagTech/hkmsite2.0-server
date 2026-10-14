#!/usr/bin/env node
/*
 * One-way, re-runnable migration: MongoDB -> Postgres (schema in docs/postgres-migration/schema.sql).
 *
 *   SRC_MONGO_URI=mongodb://127.0.0.1:27018/test \
 *   DEST_PG_URL=postgres://hkm@localhost:5433/hkm_local \
 *   node scripts/migrate-mongo-to-pg.js [--truncate]
 *
 * - Reads only from Mongo. Writes only to the DEST_PG_URL database.
 * - Ids are preserved: a row's primary key is the Mongo _id (24-hex string), and FK
 *   columns hold the same strings. Inserted with ON CONFLICT (id) DO NOTHING, so a
 *   second run adds only documents that are new since the last run.
 * - --truncate wipes the destination tables first (use for clean local re-runs).
 * - Tables are filled in foreign-key order. Dangling references are set NULL and counted.
 * - Deliberately does NOT read process.env.MONGO_URI so it can never be pointed at
 *   production by accident.
 */
import { MongoClient } from "mongodb";
import _pg from "pg";
import * as repos from "../src/db/tables.js";
const { Client } = _pg;

const SRC = process.env.SRC_MONGO_URI;
const DEST = process.env.DEST_PG_URL;
if (!SRC || !DEST) {
  console.error("Set SRC_MONGO_URI and DEST_PG_URL.");
  process.exit(1);
}

// ── coercers ────────────────────────────────────────────────────────────────
const get = (d, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), d);
const nn = (v) => (v === undefined ? null : v);
const tag = (fn, path) => Object.assign(fn, { path });
const S = (path, dflt = null) =>
  tag((d) => {
    const v = get(d, path);
    return v == null ? dflt : String(v);
  }, path);
const N = (path, dflt = null) =>
  tag((d) => {
    const v = get(d, path);
    if (v == null || v === "") return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }, path);
const I = (path, dflt = null) =>
  tag((d) => {
    const n = N(path, dflt)(d);
    return n == null ? n : Math.trunc(n);
  }, path);
const B = (path, dflt = false) =>
  tag((d) => {
    const v = get(d, path);
    return v == null ? dflt : Boolean(v);
  }, path);
const T = (path, dflt = null) =>
  tag((d) => {
    const v = get(d, path);
    if (v == null || v === "") return dflt;
    const t = v instanceof Date ? v : new Date(v);
    return Number.isNaN(t.getTime()) ? dflt : t;
  }, path);
const TS = (path) => tag((d) => T(path)(d) || new Date(), path);
const A = (path) =>
  tag((d) => {
    const v = get(d, path);
    return Array.isArray(v) ? v.filter((x) => x != null).map(String) : [];
  }, path);
const J = (path, dflt) =>
  tag((d) => {
    const v = get(d, path);
    return JSON.stringify(v == null ? dflt : v);
  }, path);
const JN = (path) =>
  tag((d) => {
    const v = get(d, path);
    return v == null ? null : JSON.stringify(v);
  }, path);
const OID = (d) => String(d._id);

const stats = { orphans: {}, bad: [] };
const maps = {}; // collection -> Set of migrated ids (to detect dangling references)
const FK = (mapName, path) => {
  const fn = (d) => {
    const v = get(d, path);
    return v == null ? null : String(v);
  };
  return tag(fn, path);
};

const base = [
  ["id", OID],
  ["created_at", TS("createdAt")],
  ["updated_at", TS("updatedAt")],
];

// ── table specs: [mongoCollection, pgTable, mapName|null, columns[]] ───────
const validVariants = (v) => Array.isArray(v) && v.every((x) => x !== null && typeof x === "object");

const REPO_OF = {
  users: "users",
  donors: "donors",
  donorissues: "donorIssues",
  donations: "donations",
  events: "events",
  registrations: "registrations",
  festivaldonations: "festivalDonations",
  festivalshowcases: "festivalShowcases",
  templedevotees: "templeDevotees",
  campaigners: "campaigners",
  plans: "plans",
  shopcategories: "shopCategories",
  products: "products",
  shoporders: "shopOrders",
  blogs: "blogs",
  contactmessages: "contactMessages",
  darshans: "darshans",
  donationpages: "donationPages",
  sitecontents: "siteContent",
  galleries: "galleries",
  herobanners: "heroBanners",
  importantdates: "importantDates",
  media: "media",
  volunteerevents: "volunteerEvents",
  volunteerregistrations: "volunteerRegistrations",
  paymentdowntimes: "paymentDowntimes",
  shopsettings: "shopSettings",
};

const explicitNulls = (coll, d, knownRoots) => {
  const nests = repos[REPO_OF[coll]]?.nests ?? {};
  const out = [];
  for (const [k, v] of Object.entries(d)) {
    if (v === null && knownRoots.has(k)) out.push(k);
    else if (v && typeof v === "object" && nests[k])
      for (const [sk, sv] of Object.entries(v)) if (sv === null && nests[k][sk]) out.push(`${k}.${sk}`);
  }
  return out;
};

const CHILD_ARRAYS = { products: ["variants"], shoporders: ["items"] };

const SPECS = [
  [
    "users",
    "users",
    "users",
    [
      ...base,
      ["name", S("name", "")],
      ["email", S("email", "")],
      ["password", S("password", "")],
      ["role", S("role", "user")],
      ["allowed_modules", A("allowedModules")],
      ["status", S("status", "active")],
      ["must_change_password", B("mustChangePassword")],
      ["pref_new_donation", B("preferences.newDonation", true)],
      ["pref_new_devotee", B("preferences.newDevotee", true)],
      ["pref_event_reminders", B("preferences.eventReminders", true)],
      ["pref_weekly_report", B("preferences.weeklyReport", false)],
    ],
  ],
  [
    "donors",
    "donors",
    "donors",
    [
      ...base,
      ["donor_id", S("donorId", "")],
      ["dcc_donor_number", S("dccDonorNumber")],
      ["mobile", S("mobile", "")],
      ["name", S("name", "")],
      ["email", S("email")],
      ["pan_number", S("panNumber")],
      ["saved_street", S("savedAddress.street")],
      ["saved_city", S("savedAddress.city")],
      ["saved_state", S("savedAddress.state")],
      ["saved_pincode", S("savedAddress.pincode")],
      ["saved_country", S("savedAddress.country")],
      ["created_via", S("createdVia", "donation")],
      ["assigned_preacher_id", FK("users", "assignedPreacherId")],
      ["first_raised_by_preacher_id", FK("users", "firstRaisedByPreacherId")],
      ["otp_code_hash", S("otpCodeHash")],
      ["otp_expires_at", T("otpExpiresAt")],
      ["otp_attempts", I("otpAttempts", 0)],
      ["otp_last_requested_at", T("otpLastRequestedAt")],
    ],
  ],
  [
    "donorissues",
    "donor_issues",
    null,
    [
      ...base,
      ["donor_id", FK("donors", "donorRecordId")],
      ["subject", S("subject", "")],
      ["message", S("message", "")],
      ["status", S("status", "open")],
      ["admin_response", S("adminResponse")],
      ["responded_at", T("respondedAt")],
      ["responded_by", FK("users", "respondedBy")],
    ],
  ],
  [
    "events",
    "events",
    "events",
    [
      ...base,
      ["title", S("title", "")],
      ["description", S("description", "")],
      ["date", TS("date")],
      ["banner_image", S("bannerImage")],
      ["registration_link", S("registrationLink")],
      ["images", A("images")],
      ["registration_form", JN("registrationForm")],
      ["category", S("category", "General")],
      ["status", S("status", "upcoming")],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "registrations",
    "event_registrations",
    null,
    [
      ...base,
      ["event_id", FK("events", "eventId")],
      ["token", S("token", "")],
      ["data", J("data", {})],
      ["files", A("files")],
      ["paid", B("paid")],
      ["attendance_present", B("attendance.present")],
      ["attendance_at", T("attendance.at")],
      ["attendance_scanned_by", FK("users", "attendance.scannedBy")],
    ],
  ],
  [
    "festivaldonations",
    "festival_donations",
    "festivaldonations",
    [
      ...base,
      ["title", S("title", "")],
      ["slug", S("slug", "")],
      ["description", S("description")],
      ["images", A("images")],
      ["active", B("active", true)],
      ["donation_options", J("donationOptions", [])],
      ["event_id", FK("events", "eventId")],
      ["meta", JN("meta")],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "festivalshowcases",
    "festival_showcases",
    null,
    [
      ...base,
      ["title", S("title", "")],
      ["slug", S("slug", "")],
      ["subtitle", S("subtitle")],
      ["hero_image", S("heroImage")],
      ["card_image", S("cardImage")],
      ["event_date", T("eventDate")],
      ["location", S("location")],
      ["description", S("description")],
      ["status", S("status", "upcoming")],
      ["featured", B("featured")],
      ["featured_order", I("featuredOrder", 0)],
      ["active", B("active", true)],
      ["cta_label", S("ctaLabel", "Donate Now")],
      ["cta_href", S("ctaHref")],
      ["donate_enabled", B("donateEnabled", true)],
      ["custom_link", S("customLink", "")],
      ["gallery", A("gallery")],
      ["schedule", J("schedule", [])],
      ["details", J("details", [])],
      ["testimonials", J("testimonials", [])],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "templedevotees",
    "temple_devotees",
    "templedevotees",
    [...base, ["name", S("name", "")], ["dcc_enrolled_by_id", I("dccEnrolledById")], ["status", S("status", "active")]],
  ],
  [
    "campaigners",
    "campaigners",
    null,
    [
      ...base,
      ["name", S("name", "")],
      ["email", S("email", "")],
      ["mobile", S("mobile", "")],
      ["slug", S("slug", "")],
      ["campaign_type", S("campaignType", "SQFT")],
      ["referred_by_devotee_id", FK("templedevotees", "referredByDevotee")],
      ["goal_sqft", I("goalSqft", 0)],
      ["message", S("message")],
      ["status", S("status", "pending")],
    ],
  ],
  [
    "plans",
    "plans",
    null,
    [...base, ["amount", N("amount", 0)], ["account", S("account", "default")], ["plan_id", S("planId", "")]],
  ],
  [
    "donations",
    "donations",
    "donations",
    [
      ...base,
      ["donor_name", S("donorName", "")],
      ["donor_email", S("donorEmail")],
      ["donor_mobile", S("donorMobile")],
      ["amount", N("amount", 0)],
      ["date", TS("date")],
      ["type", S("type", "General")],
      ["status", S("status", "pending")],
      ["message", S("message")],
      ["source_page", S("sourcePage")],
      ["seva_name", S("sevaName")],
      ["seva_slug", S("sevaSlug")],
      ["banner_image", S("bannerImage")],
      ["legacy_seva_id", I("legacySevaId")],
      ["payment_account", S("paymentAccount")],
      ["transaction_id", S("transactionId")],
      ["festival_id", FK("festivaldonations", "festivalId")],
      ["festival_slug", S("festivalSlug")],
      ["campaigner_slug", S("campaignerSlug")],
      ["dcc_enrolled_by_id", I("dccEnrolledById")],
      ["utm_source", S("utm.source", "")],
      ["utm_medium", S("utm.medium", "")],
      ["utm_campaign", S("utm.campaign", "")],
      ["utm_content", S("utm.content", "")],
      ["utm_term", S("utm.term", "")],
      ["pan_number", S("panNumber")],
      ["certificate", B("certificate")],
      ["sevak_name", S("sevakName")],
      ["seva_date", S("sevaDate")],
      ["dob", S("dob")],
      ["want_prasadam", B("wantPrasadam")],
      ["prasadam_door_no", S("prasadamAddress.doorNo")],
      ["prasadam_house", S("prasadamAddress.house")],
      ["prasadam_street", S("prasadamAddress.street")],
      ["prasadam_area", S("prasadamAddress.area")],
      ["prasadam_country", S("prasadamAddress.country")],
      ["prasadam_state", S("prasadamAddress.state")],
      ["prasadam_city", S("prasadamAddress.city")],
      ["prasadam_pincode", S("prasadamAddress.pincode")],
      ["prasadam_status", S("prasadamStatus")],
      ["prasadam_courier", S("prasadamCourier")],
      ["prasadam_tracking_number", S("prasadamTrackingNumber")],
      ["prasadam_dispatched_at", T("prasadamDispatchedAt")],
      ["prasadam_delivered_at", T("prasadamDeliveredAt")],
      ["prasadam_notes", S("prasadamNotes")],
      ["razorpay_order_id", S("razorpayOrderId")],
      ["razorpay_payment_id", S("razorpayPaymentId")],
      ["failed_attempts", I("failedAttempts", 0)],
      ["pe_payment_id", S("paymentError.paymentId")],
      ["pe_code", S("paymentError.code")],
      ["pe_description", S("paymentError.description")],
      ["pe_source", S("paymentError.source")],
      ["pe_step", S("paymentError.step")],
      ["pe_reason", S("paymentError.reason")],
      ["pe_method", S("paymentError.method")],
      ["pe_bank", S("paymentError.bank")],
      ["pe_wallet", S("paymentError.wallet")],
      ["pe_upi_flow", S("paymentError.upiFlow")],
      ["pe_card_network", S("paymentError.cardNetwork")],
      ["pe_at", T("paymentError.at")],
      ["manual_entry", B("manualEntry")],
      ["utr_number", S("utrNumber")],
      ["manual_payment_mode", S("manualPaymentMode")],
      ["manual_entry_note", S("manualEntryNote")],
      ["manual_entered_by", FK("users", "manualEnteredBy")],
      ["upi_status", S("upiFallback.status")],
      ["upi_app", S("upiFallback.app")],
      ["upi_via", S("upiFallback.via")],
      ["upi_opened_at", T("upiFallback.openedAt")],
      ["upi_claimed_at", T("upiFallback.claimedAt")],
      ["upi_payer_name", S("upiFallback.payerName")],
      ["upi_matched_at", T("upiFallback.matchedAt")],
      ["upi_matched_by", FK("users", "upiFallback.matchedBy")],
      ["upi_matched_payment_id", S("upiFallback.matchedPaymentId")],
      ["upi_note", S("upiFallback.note")],
      ["donor_record_id", FK("donors", "donorRecordId")],
      ["donor_id", S("donorId")],
      ["subscription_id", S("subscriptionId")],
      ["is_recurring", B("isRecurring")],
      ["last_payment_date", T("lastPaymentDate")],
      ["receipt_number", S("receiptNumber")],
      ["receipt_generated_at", T("receiptGeneratedAt")],
      ["dcc_sync_status", S("dccSyncStatus", "pending")],
      ["last_reconcile_check_at", T("lastReconcileCheckAt")],
      ["closed_as_not_paid_at", T("closedAsNotPaidAt")],
      ["dcc_synced_at", T("dccSyncedAt")],
      ["dcc_last_attempt_at", T("dccLastAttemptAt")],
      ["dcc_attempts", I("dccAttempts", 0)],
      ["dcc_recovered_at", T("dccRecoveredAt")],
      ["dcc_sync_error", S("dccSyncError")],
      ["dcc_payload", JN("dccPayload")],
      ["dcc_response", JN("dccResponse")],
      ["whatsapp_receipt_sent_at", T("whatsappReceiptSentAt")],
      ["whatsapp_send_status", S("whatsappSendStatus")],
      ["whatsapp_receipt_error", S("whatsappReceiptError")],
      ["whatsapp_provider", S("whatsappProvider")],
      ["whatsapp_thank_you_sent_at", T("whatsappThankYouSentAt")],
      ["whatsapp_message_id", S("whatsappMessageId")],
      ["whatsapp_delivery_status", S("whatsappDeliveryStatus")],
      ["whatsapp_delivered_at", T("whatsappDeliveredAt")],
      ["whatsapp_pending_reminder_sent", B("whatsappPendingReminderSent")],
      ["whatsapp_pending_reminder_attempts", I("whatsappPendingReminderAttempts", 0)],
      ["whatsapp_pending_reminder_error", S("whatsappPendingReminderError")],
      ["meta_event_id", S("metaEventId")],
      ["meta_fbp", S("metaFbp")],
      ["meta_fbc", S("metaFbc")],
      ["meta_client_ip", S("metaClientIp")],
      ["meta_user_agent", S("metaUserAgent")],
      ["meta_purchase_sent_at", T("metaPurchaseSentAt")],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "shopcategories",
    "shop_categories",
    null,
    [
      ...base,
      ["name", S("name", "")],
      ["slug", S("slug", "")],
      ["description", S("description")],
      ["image", S("image")],
      ["sort_order", I("sortOrder", 0)],
      ["status", S("status", "active")],
    ],
  ],
  [
    "products",
    "products",
    "products",
    [
      ...base,
      ["name", S("name", "")],
      ["slug", S("slug", "")],
      ["short_description", S("shortDescription")],
      ["description", S("description")],
      ["product_info", S("productInfo", "")],
      ["category", S("category")],
      ["images", A("images")],
      ["has_variants", B("hasVariants")],
      ["price", N("price")],
      ["mrp", N("mrp")],
      ["stock", I("stock", 0)],
      ["weight_grams", I("weightGrams")],
      ["status", S("status", "draft")],
      ["featured", B("featured")],
      ["free_shipping", B("freeShipping")],
      ["tags", A("tags")],
      ["sort_order", I("sortOrder", 0)],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "shoporders",
    "shop_orders",
    "shoporders",
    [
      ...base,
      ["order_number", S("orderNumber", "")],
      ["donor_record_id", FK("donors", "donorRecordId")],
      ["customer_name", S("customerName", "")],
      ["customer_mobile", S("customerMobile", "")],
      ["customer_email", S("customerEmail")],
      ["subtotal", N("subtotal", 0)],
      ["shipping_charge", N("shippingCharge", 0)],
      ["total", N("total", 0)],
      ["shipping_rule_flat", N("shippingRuleSnapshot.flatCharge")],
      ["shipping_rule_free_above", N("shippingRuleSnapshot.freeAbove")],
      ["ship_street", S("shippingAddress.street")],
      ["ship_city", S("shippingAddress.city")],
      ["ship_state", S("shippingAddress.state")],
      ["ship_pincode", S("shippingAddress.pincode")],
      ["ship_country", S("shippingAddress.country")],
      ["customer_note", S("customerNote")],
      ["payment_status", S("paymentStatus", "pending")],
      ["razorpay_order_id", S("razorpayOrderId")],
      ["razorpay_payment_id", S("razorpayPaymentId")],
      ["payment_account", S("paymentAccount")],
      ["paid_at", T("paidAt")],
      ["fulfilment_status", S("fulfilmentStatus", "placed")],
      ["tracking_courier", S("tracking.courier")],
      ["tracking_number", S("tracking.trackingNumber")],
      ["tracking_url", S("tracking.url")],
      ["shipped_at", T("shippedAt")],
      ["admin_note", S("adminNote")],
      ["status_history", J("statusHistory", [])],
      ["stock_committed", B("stockCommitted")],
      ["stock_shortfall", J("stockShortfall", [])],
      ["needs_attention", B("needsAttention")],
      ["whatsapp_confirmation_sent_at", T("whatsappConfirmationSentAt")],
      ["whatsapp_confirmation_error", S("whatsappConfirmationError")],
    ],
  ],
  [
    "shopsettings",
    "shop_settings",
    null,
    [
      ["id", OID],
      ["created_at", TS("createdAt")],
      ["updated_at", TS("updatedAt")],
      ["shop_enabled", B("shopEnabled", true)],
      ["flat_shipping_charge", N("flatShippingCharge", 60)],
      ["free_shipping_above", N("freeShippingAbove", 1000)],
      ["announcement", S("announcement")],
      ["support_mobile", S("supportMobile")],
      ["delivery_estimate", S("deliveryEstimate", "Usually dispatched in 3–5 working days")],
      ["updated_by", FK("users", "updatedBy")],
    ],
  ],
  [
    "blogs",
    "blogs",
    null,
    [
      ...base,
      ["title", S("title", "")],
      ["slug", S("slug", "")],
      ["excerpt", S("excerpt", "")],
      ["content", S("content", "")],
      ["cover_image", S("coverImage", "")],
      ["images", A("images")],
      ["category", S("category", "Spiritual Knowledge")],
      ["tags", A("tags")],
      ["author_name", S("author.name", "Admin")],
      ["author_avatar", S("author.avatar", "")],
      ["author_bio", S("author.bio", "")],
      ["author_slug", S("author.slug", "")],
      ["status", S("status", "draft")],
      ["published_at", T("publishedAt")],
      ["read_time", I("readTime", 0)],
      ["views", I("views", 0)],
      ["featured", B("featured")],
      ["deletion_requested", B("deletionRequested")],
      ["deletion_requested_by", FK("users", "deletionRequestedBy")],
      ["deletion_requested_at", T("deletionRequestedAt")],
      ["meta_title", S("metaTitle", "")],
      ["meta_description", S("metaDescription", "")],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "contactmessages",
    "contact_messages",
    null,
    [
      ...base,
      ["name", S("name", "")],
      ["email", S("email", "")],
      ["phone", S("phone", "")],
      ["subject", S("subject", "General Enquiry")],
      ["message", S("message", "")],
      ["authorization", B("authorization")],
      ["status", S("status", "new")],
      ["source", S("source", "contact-page")],
    ],
  ],
  [
    "darshans",
    "darshans",
    null,
    [
      ...base,
      ["vaikuntham_id", I("vaikunthamId", 0)],
      ["image_url", S("imageUrl", "")],
      ["position", I("position", 0)],
      ["status", S("status", "active")],
      ["synced_at", TS("syncedAt")],
    ],
  ],
  [
    "donationpages",
    "donation_pages",
    null,
    [
      ...base,
      ["key", S("key", "donations")],
      ["hero_title", S("heroTitle")],
      ["hero_subtitle", S("heroSubtitle")],
      ["hero_eyebrow", S("heroEyebrow")],
      ["banner_image", S("bannerImage")],
      ["banner_mobile_image", S("bannerMobileImage")],
      ["trustee_banner_image", S("trusteeBannerImage")],
      ["annadaan_image", S("annadaanImage")],
      ["go_seva_image", S("goSevaImage")],
      ["annadaan_title", S("annadaanTitle")],
      ["annadaan_description", S("annadaanDescription")],
      ["go_seva_title", S("goSevaTitle")],
      ["go_seva_description", S("goSevaDescription")],
      ["donation_options", J("donationOptions", [])],
      ["gallery_images", A("galleryImages")],
      ["impact_items", J("impactItems", [])],
      ["bank_details", JN("bankDetails")],
      ["contact", JN("contact")],
      ["updated_by", FK("users", "updatedBy")],
    ],
  ],
  [
    "sitecontents",
    "site_content",
    null,
    [
      ...base,
      ["key", S("key", "main")],
      ["hero", J("hero", {})],
      ["about", J("about", {})],
      ["contact", J("contact", {})],
      ["navbar", J("navbar", {})],
      ["festival", J("festival", {})],
      ["construction", J("construction", {})],
      ["updated_by", FK("users", "updatedBy")],
    ],
  ],
  [
    "galleries",
    "galleries",
    null,
    [
      ...base,
      ["title", S("title", "")],
      ["description", S("description")],
      ["images", A("images")],
      ["date", TS("date")],
      ["category", S("category", "General")],
      ["type", S("type", "darshan")],
      ["status", S("status", "active")],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "herobanners",
    "hero_banners",
    null,
    [
      ...base,
      ["title", S("title", "")],
      ["desktop_image", S("desktopImage", "")],
      ["mobile_image", S("mobileImage", "")],
      ["link_url", S("linkUrl", "")],
      ["order", I("order", 0)],
      ["active", B("active", true)],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "importantdates",
    "important_dates",
    null,
    [
      ...base,
      ["title", S("title", "")],
      ["date", TS("date")],
      ["description", S("description")],
      ["type", S("type", "Other")],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "media",
    "media",
    null,
    [
      ...base,
      ["name", S("name", "")],
      ["url", S("url", "")],
      ["public_id", S("publicId", "")],
      ["format", S("format")],
      ["width", I("width")],
      ["height", I("height")],
      ["bytes", N("bytes")],
      ["folder", S("folder", "media-library")],
      ["tags", S("tags")],
      ["uploaded_by", FK("users", "uploadedBy")],
    ],
  ],
  [
    "volunteerevents",
    "volunteer_events",
    "volunteerevents",
    [
      ...base,
      ["title", S("title", "")],
      ["description", S("description", "")],
      ["date", TS("date")],
      ["end_date", T("endDate")],
      ["location", S("location", "")],
      ["image", S("image", "")],
      ["slots", I("slots", 0)],
      ["filled_slots", I("filledSlots", 0)],
      ["category", S("category", "festival")],
      ["requirements", S("requirements", "")],
      ["status", S("status", "active")],
      ["form_fields", J("formFields", [])],
      ["created_by", FK("users", "createdBy")],
    ],
  ],
  [
    "volunteerregistrations",
    "volunteer_registrations",
    null,
    [
      ...base,
      ["event_id", FK("volunteerevents", "eventId")],
      ["responses", J("responses", {})],
      ["status", S("status", "pending")],
    ],
  ],
  [
    "paymentdowntimes",
    "payment_downtimes",
    null,
    [
      ["id", OID],
      ["downtime_id", S("downtimeId")],
      ["event", S("event")],
      ["method", S("method")],
      ["instrument", JN("instrument")],
      ["severity", S("severity")],
      ["status", S("status")],
      ["begin", T("begin")],
      ["end", T("end")],
      ["received_at", TS("receivedAt")],
    ],
  ],
];

const q = (id) => `"${id}"`;

async function insertBatch(pg, table, cols, rows) {
  if (!rows.length) return;
  const per = Math.max(1, Math.floor(60000 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params = [];
    const tuples = chunk.map(
      (r) =>
        `(${r
          .map((v) => {
            params.push(v);
            return `$${params.length}`;
          })
          .join(",")})`
    );
    await pg.query(
      `INSERT INTO ${q(table)} (${cols.map(q).join(",")}) VALUES ${tuples.join(",")} ON CONFLICT (id) DO NOTHING`,
      params
    );
  }
}

async function loadMap(pg, table) {
  const r = await pg.query(`SELECT id FROM ${q(table)}`);
  return new Set(r.rows.map((x) => x.id));
}

async function main() {
  const mongo = new MongoClient(SRC);
  await mongo.connect();
  const mdb = mongo.db();
  const pg = new Client({ connectionString: DEST });
  await pg.connect();

  const existing = new Set((await mdb.listCollections().toArray()).map((c) => c.name));

  if (process.argv.includes("--truncate")) {
    const tables = SPECS.map((s) => q(s[1])).concat([
      q("product_variants"),
      q("shop_order_items"),
      q("counters"),
      q("bootstrap_runs"),
    ]);
    await pg.query(`TRUNCATE ${tables.join(",")} RESTART IDENTITY CASCADE`);
    console.log("truncated destination tables");
  }

  const nullable = new Set(
    (
      await pg.query(`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default IS NOT NULL AND is_nullable = 'YES'
        AND column_name NOT IN ('id', 'created_at', 'updated_at')`)
    ).rows.map((r) => `${r.table_name}.${r.column_name}`)
  );

  const report = [];
  for (const [coll, table, mapName, cols] of SPECS) {
    if (!existing.has(coll)) {
      report.push([table, 0, 0, "(no source collection)"]);
      continue;
    }
    const docs = await mdb.collection(coll).find({}).toArray();
    const colNames = [...cols.map((c) => c[0]), "extra"];
    const knownRoots = new Set([
      "_id",
      "__v",
      "createdAt",
      "updatedAt",
      ...cols.map(([, fn]) => fn.path?.split(".")[0]).filter(Boolean),
      ...(CHILD_ARRAYS[coll] ?? []),
    ]);
    const rows = [];
    for (const d of docs) {
      try {
        const unknown = Object.fromEntries(Object.entries(d).filter(([k]) => !knownRoots.has(k)));
        if (coll === "products" && d.variants !== undefined && !validVariants(d.variants))
          unknown.variants = d.variants;
        rows.push([
          ...cols.map(([col, fn]) =>
            nullable.has(`${table}.${col}`) && fn.path !== undefined && get(d, fn.path) === undefined ? null : nn(fn(d))
          ),
          (() => {
            const nulls = explicitNulls(coll, d, knownRoots);
            const extra = nulls.length ? { ...unknown, $nulls: nulls } : unknown;
            return Object.keys(extra).length ? JSON.stringify(extra) : null;
          })(),
        ]);
      } catch (e) {
        stats.bad.push(`${coll} ${d._id}: ${e.message}`);
        if (stats.bad.length === 1) console.error("first unmappable document:", stats.bad[0]);
      }
    }
    try {
      await insertBatch(pg, table, colNames, rows);
    } catch (e) {
      console.error(
        `\nFAILED on ${table}: ${e.message}${e.detail ? " — " + e.detail : ""}${e.constraint ? " [" + e.constraint + "]" : ""}`
      );
      throw e;
    }
    if (mapName) maps[mapName] = await loadMap(pg, table);
    // child tables fed from embedded arrays
    if (coll === "products") {
      const vcols = ["id", "product_id", "label", "sku", "price", "mrp", "stock", "weight_grams", "position"];
      const vrows = [];
      for (const p of docs) {
        const pid = String(p._id);
        (validVariants(p.variants) ? p.variants : []).forEach((v, i) =>
          vrows.push([
            String(v._id),
            pid,
            v.label ?? "",
            nn(v.sku),
            N("price", 0)(v),
            N("mrp")(v),
            I("stock", 0)(v),
            I("weightGrams")(v),
            i,
          ])
        );
      }
      await insertBatch(pg, "product_variants", vcols, vrows);
      maps.variants = await loadMap(pg, "product_variants");
      report.push(["product_variants", vrows.length, vrows.length, ""]);
    }
    if (coll === "shoporders") {
      const icols = [
        "order_id",
        "product_id",
        "variant_id",
        "product_name",
        "slug",
        "image",
        "variant_label",
        "unit_price",
        "mrp",
        "quantity",
        "line_total",
        "free_shipping",
      ];
      const irows = [];
      for (const o of docs) {
        const oid = String(o._id);
        for (const it of o.items || []) {
          const pid = it.productId ? String(it.productId) : null;
          const vid = it.variantId ? String(it.variantId) : null;
          irows.push([
            oid,
            pid,
            vid,
            it.productName ?? "",
            nn(it.slug),
            nn(it.image),
            nn(it.variantLabel),
            N("unitPrice", 0)(it),
            N("mrp")(it),
            I("quantity", 1)(it),
            N("lineTotal", 0)(it),
            Boolean(it.freeShipping),
          ]);
        }
      }
      // shop_order_items has no legacy_id: skip rows already present for these orders (idempotent)
      const have = await pg.query("SELECT DISTINCT order_id FROM shop_order_items");
      const done = new Set(have.rows.map((r) => r.order_id));
      const todo = irows.filter((r) => !done.has(r[0]));
      const per = Math.floor(60000 / icols.length);
      for (let i = 0; i < todo.length; i += per) {
        const chunk = todo.slice(i, i + per);
        const params = [];
        const tuples = chunk.map(
          (r) =>
            `(${r
              .map((v) => {
                params.push(v);
                return `$${params.length}`;
              })
              .join(",")})`
        );
        await pg.query(`INSERT INTO shop_order_items (${icols.join(",")}) VALUES ${tuples.join(",")}`, params);
      }
      report.push(["shop_order_items", irows.length, todo.length, ""]);
    }
    report.push([table, docs.length, rows.length, ""]);
  }

  // counters & bootstrap_runs have string _ids, no legacy_id
  if (existing.has("counters")) {
    for (const c of await mdb.collection("counters").find({}).toArray()) {
      await pg.query(
        "INSERT INTO counters(name, seq) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET seq = GREATEST(counters.seq, EXCLUDED.seq)",
        [String(c._id), Number(c.seq) || 0]
      );
    }
  }
  if (existing.has("bootstrap_runs")) {
    for (const r of await mdb.collection("bootstrap_runs").find({}).toArray()) {
      await pg.query("INSERT INTO bootstrap_runs(name, ran_at) VALUES ($1,$2) ON CONFLICT DO NOTHING", [
        String(r._id ?? r.name),
        r.ranAt || r.at || new Date(),
      ]);
    }
  }

  console.log("\ntable                       mongo  rows-built");
  for (const [t, a, b, note] of report) console.log(t.padEnd(26), String(a).padStart(6), String(b).padStart(10), note);
  if (Object.keys(stats.orphans).length) console.log("\nDANGLING REFERENCES (set NULL):", stats.orphans);
  if (stats.bad.length) console.log("\nUNMAPPABLE DOCS:", stats.bad.slice(0, 20));
  await pg.end();
  await mongo.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
