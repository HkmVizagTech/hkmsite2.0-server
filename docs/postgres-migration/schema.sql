-- DRAFT Postgres schema for hkmsite2.0 (generated from src/models/*.js).
-- Foreign keys are deliberately absent (except the two CASCADEs that mirror embedded arrays): MongoDB never enforced
-- references, so deletes must keep succeeding and leave dangling ids exactly as before.
-- `seq` remembers insertion order: unsorted reads return rows in the order MongoDB returned documents (natural order).
-- `extra` holds any top-level field the old MongoDB documents had that the schema does not model (kept lossless).
-- Columns that have a DEFAULT are nullable on purpose: NULL means "field was absent in the old MongoDB document",
-- which keeps lean reads byte-identical. The repository fills defaults on normal reads like Mongoose did.
-- Conventions:
--   * id            text PK holding a 24-hex Mongo-style ObjectId. Migrated rows keep
--                   their original Mongo _id; new rows get one from new_object_id() (or
--                   from the app). So API ids, DRM/DCC cross-references and every FK
--                   value are identical before and after the migration - no id mapping.
--   * money         numeric(12,2) (Mongo stored JS doubles)
--   * timestamps    timestamptz; created_at / updated_at mirror Mongoose timestamps
--   * enums         text + CHECK (easier to evolve than CREATE TYPE)
--   * free-form     jsonb (dcc_payload, dcc_response, registration form, etc.)
-- Review before use: nothing here is applied to any database.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 24-hex id: 4-byte unix time + 8 random bytes, so ids sort roughly by creation time
-- exactly like Mongo ObjectIds (the app relies on `ORDER BY id` for recency ties).
CREATE FUNCTION new_object_id() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT lpad(to_hex(extract(epoch FROM clock_timestamp())::bigint), 8, '0')
      || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)
$$;

-- array_to_string is only STABLE, which Postgres refuses in generated columns;
-- this wrapper is safe because text[] -> text with a constant separator is deterministic.
CREATE FUNCTION immutable_join(text[], text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, $2) $$;

-- ───────────── counters (replaces `counters` collection / getNextSequence) ─────────────
CREATE TABLE counters (
  name text PRIMARY KEY,
  seq  bigint NOT NULL DEFAULT 0
);
-- next value: INSERT .. ON CONFLICT (name) DO UPDATE SET seq = counters.seq + 1 RETURNING seq;

CREATE TABLE bootstrap_runs (            -- raw collection used by blogDraftsBootstrap
  name   text PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── users / staff ─────────────
CREATE TABLE users (
  id text PRIMARY KEY DEFAULT new_object_id(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password text NOT NULL,                       -- bcrypt hash, copy as-is
  role text DEFAULT 'user'
    CHECK (role IN ('user','donations_admin','blogs_admin','shop_admin','preacher','admin')),
  allowed_modules text[] DEFAULT '{}',
  status text DEFAULT 'active' CHECK (status IN ('active','inactive')),
  must_change_password boolean DEFAULT false,
  pref_new_donation boolean DEFAULT true,
  pref_new_devotee boolean DEFAULT true,
  pref_event_reminders boolean DEFAULT true,
  pref_weekly_report boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

-- ───────────── donors ─────────────
CREATE TABLE donors (
  id text PRIMARY KEY DEFAULT new_object_id(),
  donor_id text NOT NULL UNIQUE,                -- human id (DONOR-xxxx), from counters
  dcc_donor_number text,
  mobile text NOT NULL UNIQUE,
  name text NOT NULL,
  email text,
  pan_number text,
  saved_street text, saved_city text, saved_state text, saved_pincode text, saved_country text,
  created_via text DEFAULT 'donation' CHECK (created_via IN ('donation','shop')),
  assigned_preacher_id text,
  first_raised_by_preacher_id text,
  otp_code_hash text, otp_expires_at timestamptz,
  otp_attempts int DEFAULT 0,
  otp_last_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX donors_dcc_idx ON donors(dcc_donor_number) WHERE dcc_donor_number IS NOT NULL;
CREATE INDEX donors_name_idx ON donors(name);
CREATE INDEX donors_created_via_idx ON donors(created_via);

CREATE TABLE donor_issues (
  id text PRIMARY KEY DEFAULT new_object_id(),
  donor_id text NOT NULL,
  subject text NOT NULL, message text NOT NULL,
  status text DEFAULT 'open' CHECK (status IN ('open','in-progress','resolved')),
  admin_response text, responded_at timestamptz,
  responded_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX donor_issues_status_idx ON donor_issues(status, created_at DESC);

-- ───────────── events / festivals (referenced by donations) ─────────────
CREATE TABLE events (
  id text PRIMARY KEY DEFAULT new_object_id(),
  title text NOT NULL, description text NOT NULL,
  date timestamptz NOT NULL,
  banner_image text, registration_link text,
  images text[] DEFAULT '{}',
  registration_form jsonb,
  category text DEFAULT 'General',
  status text DEFAULT 'upcoming' CHECK (status IN ('upcoming','completed','cancelled')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE event_registrations (
  id text PRIMARY KEY DEFAULT new_object_id(),
  event_id text NOT NULL,
  token text NOT NULL UNIQUE,
  data jsonb DEFAULT '{}',
  files text[] DEFAULT '{}',
  paid boolean DEFAULT false,
  attendance_present boolean DEFAULT false,
  attendance_at timestamptz,
  attendance_scanned_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX event_registrations_event_idx ON event_registrations(event_id);

CREATE TABLE festival_donations (
  id text PRIMARY KEY DEFAULT new_object_id(),
  title text NOT NULL, slug text NOT NULL UNIQUE, description text,
  images text[] DEFAULT '{}',
  active boolean DEFAULT true,
  donation_options jsonb DEFAULT '[]',   -- [{label, amount, description}]
  event_id text,
  meta jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE festival_showcases (
  id text PRIMARY KEY DEFAULT new_object_id(),
  title text NOT NULL, slug text NOT NULL UNIQUE, subtitle text,
  hero_image text, card_image text, event_date timestamptz, location text, description text,
  status text DEFAULT 'upcoming' CHECK (status IN ('upcoming','completed','annual')),
  featured boolean DEFAULT false, featured_order int DEFAULT 0,
  active boolean DEFAULT true,
  cta_label text DEFAULT 'Donate Now', cta_href text,
  donate_enabled boolean DEFAULT true,
  custom_link text DEFAULT '',
  gallery text[] DEFAULT '{}',
  schedule jsonb DEFAULT '[]',
  details jsonb DEFAULT '[]',
  testimonials jsonb DEFAULT '[]',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

-- ───────────── campaigners ─────────────
CREATE TABLE temple_devotees (
  id text PRIMARY KEY DEFAULT new_object_id(),
  name text NOT NULL,
  dcc_enrolled_by_id int,
  status text DEFAULT 'active' CHECK (status IN ('active','hidden')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE campaigners (
  id text PRIMARY KEY DEFAULT new_object_id(),
  name text NOT NULL, email text NOT NULL, mobile text NOT NULL,
  slug text NOT NULL UNIQUE,
  campaign_type text DEFAULT 'SQFT' CHECK (campaign_type IN ('SQFT','JANMASHTAMI')),
  referred_by_devotee_id text,
  goal_sqft int DEFAULT 0 CHECK (goal_sqft BETWEEN 0 AND 100000),
  message text CHECK (char_length(message) <= 300),
  status text DEFAULT 'pending' CHECK (status IN ('pending','active','hidden')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX campaigners_email_idx ON campaigners(email);
CREATE INDEX campaigners_type_idx ON campaigners(campaign_type);

-- ───────────── plans (Razorpay subscription plans) ─────────────
CREATE TABLE plans (
  id text PRIMARY KEY DEFAULT new_object_id(),
  amount numeric(12,2) NOT NULL,
  account text DEFAULT 'default',
  plan_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (amount, account),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

-- ───────────── donations (the critical table) ─────────────
CREATE TABLE donations (
  id text PRIMARY KEY DEFAULT new_object_id(),
  donor_name text NOT NULL, donor_email text, donor_mobile text,
  amount numeric(12,2) NOT NULL,
  date timestamptz DEFAULT now(),
  type text DEFAULT 'General',
  status text DEFAULT 'pending'
    CHECK (status IN ('pending','active','completed','failed','cancelled')),
  message text, source_page text, seva_name text, seva_slug text, banner_image text,
  legacy_seva_id int, payment_account text, transaction_id text,
  festival_id text,
  festival_slug text, campaigner_slug text,
  dcc_enrolled_by_id int,
  utm_source text DEFAULT '', utm_medium text DEFAULT '',
  utm_campaign text DEFAULT '', utm_content text DEFAULT '', utm_term text DEFAULT '',
  pan_number text, certificate boolean DEFAULT false,
  sevak_name text, seva_date text, dob text,
  -- prasadam
  want_prasadam boolean DEFAULT false,
  prasadam_door_no text, prasadam_house text, prasadam_street text, prasadam_area text,
  prasadam_country text DEFAULT 'India', prasadam_state text, prasadam_city text, prasadam_pincode text,
  prasadam_status text CHECK (prasadam_status IN ('pending','dispatched','delivered','cancelled')),
  prasadam_courier text, prasadam_tracking_number text,
  prasadam_dispatched_at timestamptz, prasadam_delivered_at timestamptz, prasadam_notes text,
  -- razorpay
  razorpay_order_id text, razorpay_payment_id text,
  failed_attempts int DEFAULT 0,
  pe_payment_id text, pe_code text, pe_description text, pe_source text, pe_step text, pe_reason text,
  pe_method text, pe_bank text, pe_wallet text, pe_upi_flow text, pe_card_network text, pe_at timestamptz,
  -- manual entry
  manual_entry boolean DEFAULT false,
  utr_number text,
  manual_payment_mode text CHECK (manual_payment_mode IN ('upi','bank','cash','cheque')),
  manual_entry_note text,
  manual_entered_by text,
  -- upi fallback
  upi_status text CHECK (upi_status IN ('opened','claimed','matched','dismissed')),
  upi_app text, upi_via text, upi_opened_at timestamptz, upi_claimed_at timestamptz,
  upi_payer_name text, upi_matched_at timestamptz, upi_matched_by text,
  upi_matched_payment_id text, upi_note text,
  donor_record_id text,
  donor_id text,                                  -- denormalised DONOR-xxxx
  subscription_id text, is_recurring boolean DEFAULT false, last_payment_date timestamptz,
  -- receipt / DCC
  receipt_number text, receipt_generated_at timestamptz,
  dcc_sync_status text DEFAULT 'pending' CHECK (dcc_sync_status IN ('pending','syncing','synced','failed')),
  last_reconcile_check_at timestamptz, closed_as_not_paid_at timestamptz,
  dcc_synced_at timestamptz, dcc_last_attempt_at timestamptz,
  dcc_attempts int DEFAULT 0, dcc_recovered_at timestamptz, dcc_sync_error text,
  dcc_payload jsonb, dcc_response jsonb,
  -- whatsapp
  whatsapp_receipt_sent_at timestamptz,
  whatsapp_send_status text CHECK (whatsapp_send_status IN ('sending')),
  whatsapp_receipt_error text, whatsapp_provider text, whatsapp_thank_you_sent_at timestamptz,
  whatsapp_message_id text,
  whatsapp_delivery_status text CHECK (whatsapp_delivery_status IN ('submitted','enqueued','sent','delivered','read','failed')),
  whatsapp_delivered_at timestamptz,
  whatsapp_pending_reminder_sent boolean DEFAULT false,
  whatsapp_pending_reminder_attempts int DEFAULT 0,
  whatsapp_pending_reminder_error text,
  -- meta capi
  meta_event_id text, meta_fbp text, meta_fbc text, meta_client_ip text, meta_user_agent text,
  meta_purchase_sent_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX donations_festival_idx    ON donations(festival_id);
CREATE INDEX donations_date_idx        ON donations(date DESC);
CREATE INDEX donations_status_idx      ON donations(status);
CREATE INDEX donations_order_idx       ON donations(razorpay_order_id);
CREATE INDEX donations_payment_idx     ON donations(razorpay_payment_id);   -- webhook idempotency lookups
CREATE INDEX donations_mobile_idx      ON donations(donor_mobile);
CREATE INDEX donations_utr_idx         ON donations(utr_number);
CREATE INDEX donations_upi_idx         ON donations(upi_status, upi_claimed_at DESC);
CREATE INDEX donations_donor_idx       ON donations(donor_record_id);
CREATE INDEX donations_prasadam_idx    ON donations(want_prasadam, status, prasadam_pincode);
CREATE INDEX donations_manual_by_idx   ON donations(manual_entered_by);
CREATE INDEX donations_campaigner_idx  ON donations(campaigner_slug);
CREATE INDEX donations_wa_msg_idx      ON donations(whatsapp_message_id);
CREATE INDEX donations_subscription_idx ON donations(subscription_id) WHERE subscription_id IS NOT NULL;
-- NEW integrity guards (Mongo had none). Enable AFTER data is verified clean:
-- CREATE UNIQUE INDEX donations_receipt_uq ON donations(receipt_number) WHERE receipt_number IS NOT NULL;
-- CREATE UNIQUE INDEX donations_payment_uq ON donations(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL AND is_recurring = false;

-- ───────────── shop ─────────────
CREATE TABLE shop_categories (
  id text PRIMARY KEY DEFAULT new_object_id(),
  name text NOT NULL, slug text NOT NULL UNIQUE, description text, image text,
  sort_order int DEFAULT 0,
  status text DEFAULT 'active' CHECK (status IN ('active','hidden')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE products (
  id text PRIMARY KEY DEFAULT new_object_id(),
  name text NOT NULL, slug text NOT NULL UNIQUE,
  short_description text, description text, product_info text DEFAULT '',
  category text,                                  -- holds a category slug/name today; consider FK later
  images text[] DEFAULT '{}',
  has_variants boolean DEFAULT false,
  price numeric(12,2) CHECK (price >= 0), mrp numeric(12,2) CHECK (mrp >= 0),
  stock int DEFAULT 0 CHECK (stock >= 0),
  weight_grams int,
  status text DEFAULT 'draft' CHECK (status IN ('active','draft')),
  featured boolean DEFAULT false, free_shipping boolean DEFAULT false,
  tags text[] DEFAULT '{}', sort_order int DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name,'')||' '||coalesce(short_description,'')||' '||immutable_join(tags,' '))
  ) STORED,
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX products_search_idx ON products USING gin(search);
CREATE INDEX products_name_idx ON products(name);
CREATE INDEX products_list_idx ON products(status, category, sort_order);

CREATE TABLE product_variants (                   -- was embedded variants[] (had its own _id)
  id text PRIMARY KEY DEFAULT new_object_id(),                          -- variant ObjectId; shop_order_items.variant_id refs this
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label text NOT NULL, sku text,
  price numeric(12,2) NOT NULL CHECK (price >= 0), mrp numeric(12,2) CHECK (mrp >= 0),
  stock int DEFAULT 0 CHECK (stock >= 0),
  weight_grams int, position int DEFAULT 0
);
CREATE INDEX product_variants_product_idx ON product_variants(product_id);

CREATE TABLE shop_orders (
  id text PRIMARY KEY DEFAULT new_object_id(),
  order_number text NOT NULL UNIQUE,
  donor_record_id text,
  customer_name text NOT NULL, customer_mobile text NOT NULL, customer_email text,
  subtotal numeric(12,2) NOT NULL, shipping_charge numeric(12,2) DEFAULT 0, total numeric(12,2) NOT NULL,
  shipping_rule_flat numeric(12,2), shipping_rule_free_above numeric(12,2),
  ship_street text, ship_city text, ship_state text, ship_pincode text, ship_country text DEFAULT 'India',
  customer_note text,
  payment_status text DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded')),
  razorpay_order_id text, razorpay_payment_id text, payment_account text, paid_at timestamptz,
  fulfilment_status text DEFAULT 'placed' CHECK (fulfilment_status IN ('placed','packed','shipped','delivered','cancelled')),
  tracking_courier text, tracking_number text, tracking_url text, shipped_at timestamptz,
  admin_note text,
  status_history jsonb DEFAULT '[]',     -- [{status,note,at,byUserId}] append-only log
  stock_committed boolean DEFAULT false,
  stock_shortfall jsonb DEFAULT '[]',
  needs_attention boolean DEFAULT false,
  whatsapp_confirmation_sent_at timestamptz, whatsapp_confirmation_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX shop_orders_donor_idx ON shop_orders(donor_record_id);
CREATE INDEX shop_orders_mobile_idx ON shop_orders(customer_mobile);
CREATE INDEX shop_orders_pay_idx ON shop_orders(payment_status);
CREATE INDEX shop_orders_ful_idx ON shop_orders(fulfilment_status);
CREATE INDEX shop_orders_rzp_idx ON shop_orders(razorpay_order_id);
CREATE INDEX shop_orders_created_idx ON shop_orders(created_at DESC);

CREATE TABLE shop_order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id text NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  product_id text,
  variant_id text,
  product_name text NOT NULL, slug text, image text, variant_label text,   -- snapshots, keep
  unit_price numeric(12,2) NOT NULL, mrp numeric(12,2),
  quantity int NOT NULL CHECK (quantity >= 1),
  line_total numeric(12,2) NOT NULL, free_shipping boolean DEFAULT false
);
CREATE INDEX shop_order_items_order_idx ON shop_order_items(order_id);

CREATE TABLE shop_settings (                      -- single row
  id text PRIMARY KEY DEFAULT 'default',
  shop_enabled boolean DEFAULT true,
  flat_shipping_charge numeric(12,2) DEFAULT 60,
  free_shipping_above numeric(12,2) DEFAULT 1000,
  announcement text, support_mobile text,
  delivery_estimate text DEFAULT 'Usually dispatched in 3–5 working days',
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

-- ───────────── content / CMS ─────────────
CREATE TABLE blogs (
  id text PRIMARY KEY DEFAULT new_object_id(),
  title text NOT NULL, slug text NOT NULL UNIQUE, excerpt text DEFAULT '',
  content text NOT NULL, cover_image text DEFAULT '',
  images text[] DEFAULT '{}',
  category text DEFAULT 'Spiritual Knowledge',   -- 13 fixed values; CHECK optional
  tags text[] DEFAULT '{}',
  author_name text DEFAULT 'Admin', author_avatar text DEFAULT '',
  author_bio text DEFAULT '', author_slug text DEFAULT '',
  status text DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at timestamptz, read_time int DEFAULT 0, views int DEFAULT 0,
  featured boolean DEFAULT false,
  deletion_requested boolean DEFAULT false,
  deletion_requested_by text, deletion_requested_at timestamptz,
  meta_title text DEFAULT '', meta_description text DEFAULT '',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'')||' '||coalesce(excerpt,'')||' '||coalesce(content,''))
  ) STORED,
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX blogs_search_idx ON blogs USING gin(search);
CREATE INDEX blogs_status_pub_idx ON blogs(status, published_at DESC);
CREATE INDEX blogs_cat_idx ON blogs(category, status, published_at DESC);
CREATE INDEX blogs_featured_idx ON blogs(featured);
CREATE INDEX blogs_delreq_idx ON blogs(deletion_requested);
-- read_time / published_at were maintained by a Mongoose pre-save hook; move that
-- logic into the service layer (or a trigger) — it will NOT happen automatically.

CREATE TABLE contact_messages (
  id text PRIMARY KEY DEFAULT new_object_id(),
  name text NOT NULL, email text NOT NULL, phone text DEFAULT '',
  subject text DEFAULT 'General Enquiry', message text NOT NULL,
  "authorization" boolean DEFAULT false,
  status text DEFAULT 'new' CHECK (status IN ('new','read','responded')),
  source text DEFAULT 'contact-page',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX contact_messages_created_idx ON contact_messages(created_at DESC);

CREATE TABLE darshans (
  id text PRIMARY KEY DEFAULT new_object_id(),
  vaikuntham_id int NOT NULL UNIQUE, image_url text NOT NULL,
  position int DEFAULT 0, status text DEFAULT 'active' CHECK (status IN ('active')),
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX darshans_position_idx ON darshans(position);

CREATE TABLE donation_pages (                     -- singleton CMS doc keyed by `key`
  id text PRIMARY KEY DEFAULT new_object_id(),
  key text DEFAULT 'donations' UNIQUE,
  hero_title text, hero_subtitle text, hero_eyebrow text,
  banner_image text, banner_mobile_image text, trustee_banner_image text,
  annadaan_image text, go_seva_image text,
  annadaan_title text, annadaan_description text, go_seva_title text, go_seva_description text,
  donation_options jsonb DEFAULT '[]',
  gallery_images text[] DEFAULT '{}',
  impact_items jsonb DEFAULT '[]',
  bank_details jsonb, contact jsonb,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE site_content (                       -- singleton; nested blocks kept as jsonb
  id text PRIMARY KEY DEFAULT new_object_id(),
  key text DEFAULT 'main' UNIQUE,
  hero jsonb DEFAULT '{}', about jsonb DEFAULT '{}',
  contact jsonb DEFAULT '{}', navbar jsonb DEFAULT '{}',
  festival jsonb DEFAULT '{}', construction jsonb DEFAULT '{}',
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE galleries (
  id text PRIMARY KEY DEFAULT new_object_id(),
  title text NOT NULL, description text, images text[] NOT NULL,
  date timestamptz NOT NULL, category text DEFAULT 'General',
  type text DEFAULT 'darshan' CHECK (type IN ('darshan','festival','seva','community','other')),
  status text DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE hero_banners (
  id text PRIMARY KEY DEFAULT new_object_id(),
  title text NOT NULL, desktop_image text NOT NULL, mobile_image text NOT NULL,
  link_url text DEFAULT '', "order" int DEFAULT 0, active boolean DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX hero_banners_idx ON hero_banners(active, "order");

CREATE TABLE important_dates (
  id text PRIMARY KEY DEFAULT new_object_id(),
  title text NOT NULL, date timestamptz NOT NULL, description text,
  type text DEFAULT 'Other' CHECK (type IN ('Ekadashi','Festival','Other')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE media (
  id text PRIMARY KEY DEFAULT new_object_id(),
  name text NOT NULL, url text NOT NULL, public_id text NOT NULL,
  format text, width int, height int, bytes bigint,
  folder text DEFAULT 'media-library', tags text,
  uploaded_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX media_created_idx ON media(created_at DESC);
CREATE INDEX media_name_trgm ON media USING gin(name gin_trgm_ops);

-- ───────────── volunteers ─────────────
CREATE TABLE volunteer_events (
  id text PRIMARY KEY DEFAULT new_object_id(),
  title text NOT NULL, description text NOT NULL,
  date timestamptz NOT NULL, end_date timestamptz,
  location text DEFAULT '', image text DEFAULT '',
  slots int DEFAULT 0, filled_slots int DEFAULT 0,
  category text DEFAULT 'festival' CHECK (category IN ('festival','weekly','special','outreach')),
  requirements text DEFAULT '',
  status text DEFAULT 'active' CHECK (status IN ('active','closed','completed')),
  form_fields jsonb DEFAULT '[]',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX volunteer_events_idx ON volunteer_events(status, date);

CREATE TABLE volunteer_registrations (
  id text PRIMARY KEY DEFAULT new_object_id(),
  event_id text NOT NULL,
  responses jsonb DEFAULT '{}',
  status text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','completed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX volunteer_registrations_event_idx ON volunteer_registrations(event_id);

-- ───────────── payment downtime alerts (paymentFailure.service.js, inline model) ─────────────
-- Mongo expired these with a TTL index (30 days). Postgres has no TTL: the app must
-- run `DELETE FROM payment_downtimes WHERE received_at < now() - interval '30 days'` periodically.
CREATE TABLE payment_downtimes (
  id text PRIMARY KEY DEFAULT new_object_id(),
  downtime_id text, event text, method text,
  instrument jsonb,
  severity text, status text,
  "begin" timestamptz, "end" timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  extra jsonb,
  seq bigint GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX payment_downtimes_dtid_idx ON payment_downtimes(downtime_id);
CREATE INDEX payment_downtimes_recv_idx ON payment_downtimes(received_at);

-- ───────────── Mongoose-compatible relaxations (shop): store every value Mongoose accepted ─────────────
ALTER TABLE products
  ALTER COLUMN price TYPE numeric, ALTER COLUMN mrp TYPE numeric, ALTER COLUMN stock TYPE numeric,
  ALTER COLUMN weight_grams TYPE numeric, ALTER COLUMN sort_order TYPE numeric;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_price_check, DROP CONSTRAINT IF EXISTS products_mrp_check,
  DROP CONSTRAINT IF EXISTS products_stock_check;

ALTER TABLE product_variants
  ALTER COLUMN price TYPE numeric, ALTER COLUMN mrp TYPE numeric, ALTER COLUMN stock TYPE numeric,
  ALTER COLUMN weight_grams TYPE numeric;
ALTER TABLE product_variants ALTER COLUMN label DROP NOT NULL, ALTER COLUMN price DROP NOT NULL;
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_price_check,
  DROP CONSTRAINT IF EXISTS product_variants_mrp_check, DROP CONSTRAINT IF EXISTS product_variants_stock_check;
-- Mongo allowed the same variant _id twice (inside one product or across products).
ALTER TABLE product_variants DROP CONSTRAINT product_variants_pkey;
ALTER TABLE product_variants ALTER COLUMN id DROP NOT NULL;
ALTER TABLE product_variants ALTER COLUMN position SET NOT NULL;
ALTER TABLE product_variants ADD PRIMARY KEY (product_id, position);
CREATE INDEX IF NOT EXISTS product_variants_id_idx ON product_variants(id);

ALTER TABLE shop_categories ALTER COLUMN name DROP NOT NULL, ALTER COLUMN sort_order TYPE numeric;
ALTER TABLE shop_categories DROP CONSTRAINT IF EXISTS shop_categories_status_check;

ALTER TABLE shop_orders
  ALTER COLUMN subtotal TYPE numeric, ALTER COLUMN shipping_charge TYPE numeric, ALTER COLUMN total TYPE numeric,
  ALTER COLUMN shipping_rule_flat TYPE numeric, ALTER COLUMN shipping_rule_free_above TYPE numeric;
ALTER TABLE shop_order_items
  ALTER COLUMN unit_price TYPE numeric, ALTER COLUMN mrp TYPE numeric, ALTER COLUMN line_total TYPE numeric;
ALTER TABLE shop_settings
  ALTER COLUMN flat_shipping_charge TYPE numeric, ALTER COLUMN free_shipping_above TYPE numeric;

-- ───────────── Mongoose-compatible relaxations (content): store every value Mongoose accepted ─────────────
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE festival_showcases DROP CONSTRAINT IF EXISTS festival_showcases_status_check;
ALTER TABLE galleries DROP CONSTRAINT IF EXISTS galleries_status_check;
ALTER TABLE galleries DROP CONSTRAINT IF EXISTS galleries_type_check;
ALTER TABLE important_dates DROP CONSTRAINT IF EXISTS important_dates_type_check;
ALTER TABLE volunteer_events DROP CONSTRAINT IF EXISTS volunteer_events_category_check;
ALTER TABLE volunteer_events DROP CONSTRAINT IF EXISTS volunteer_events_status_check;
ALTER TABLE volunteer_registrations DROP CONSTRAINT IF EXISTS volunteer_registrations_status_check;
ALTER TABLE donor_issues DROP CONSTRAINT IF EXISTS donor_issues_status_check;
ALTER TABLE events ALTER COLUMN title DROP NOT NULL, ALTER COLUMN description DROP NOT NULL, ALTER COLUMN date DROP NOT NULL;
ALTER TABLE galleries ALTER COLUMN title DROP NOT NULL, ALTER COLUMN images DROP NOT NULL, ALTER COLUMN date DROP NOT NULL;
ALTER TABLE important_dates ALTER COLUMN title DROP NOT NULL, ALTER COLUMN date DROP NOT NULL;
ALTER TABLE volunteer_events ALTER COLUMN title DROP NOT NULL, ALTER COLUMN description DROP NOT NULL, ALTER COLUMN date DROP NOT NULL;
ALTER TABLE festival_showcases ALTER COLUMN title DROP NOT NULL, ALTER COLUMN slug DROP NOT NULL;
ALTER TABLE festival_donations ALTER COLUMN title DROP NOT NULL, ALTER COLUMN slug DROP NOT NULL;
ALTER TABLE volunteer_events ALTER COLUMN slots TYPE double precision, ALTER COLUMN filled_slots TYPE double precision;
ALTER TABLE festival_showcases ALTER COLUMN featured_order TYPE double precision;
ALTER TABLE hero_banners ALTER COLUMN "order" TYPE double precision;
ALTER TABLE temple_devotees ALTER COLUMN dcc_enrolled_by_id TYPE double precision;
ALTER TABLE darshans ALTER COLUMN vaikuntham_id TYPE double precision, ALTER COLUMN position TYPE double precision;
ALTER TABLE media ALTER COLUMN width TYPE double precision, ALTER COLUMN height TYPE double precision, ALTER COLUMN bytes TYPE double precision;

-- ───────────── Mongoose-compatible relaxations (donations/plans): doubles, no rounding ─────────────
ALTER TABLE donations ALTER COLUMN amount TYPE numeric, ALTER COLUMN legacy_seva_id TYPE double precision,
  ALTER COLUMN dcc_enrolled_by_id TYPE double precision;
ALTER TABLE plans ALTER COLUMN amount TYPE numeric;
