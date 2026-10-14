import { campaigners, donations, templeDevotees } from "../db/tables.js";
import { many, one } from "../db/pg.js";
import { cacheWrap, cacheKeys } from "../cache/memoryCache.js";
import { campaignerSchema } from "../domain/schemas.js";
import { makeStore, castQueryId } from "../domain/store.js";
import { IST } from "../config/timezone.js";

const store = makeStore(campaigners, campaignerSchema);

const CAMPAIGNER_TTL = Number(process.env.CAMPAIGNER_CACHE_TTL_SECONDS || 20);

const PRICE_PER_SQFT = () => Number(process.env.SQFT_PRICE_PER_UNIT) || 6000;

const toDisplayName = (fullName) => {
  const parts = String(fullName || "A devotee")
    .trim()
    .split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
};

const timeAgo = (date) => {
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(date).toLocaleDateString("en-IN", { timeZone: IST, month: "short", day: "numeric" });
};

const slugify = (name) =>
  String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60) || "campaigner";

const campaignerController = {
  register: async (req, res) => {
    try {
      const name = String(req.body.name || "").trim();
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();
      const mobile = String(req.body.mobile || "").trim();
      const message = String(req.body.message || "")
        .trim()
        .slice(0, 300);
      const campaignType = req.body.campaignType === "JANMASHTAMI" ? "JANMASHTAMI" : "SQFT";
      const devoteeId = String(req.body.devoteeId || "").trim();
      let goalSqft = Number(req.body.goalSqft) || 0;
      goalSqft = Math.max(0, Math.min(100000, Math.floor(goalSqft)));

      if (!name || name.length < 2) return res.status(400).json({ message: "Please provide your name." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ message: "Please provide a valid email address." });
      if (!/^[0-9+\-\s]{8,15}$/.test(mobile))
        return res.status(400).json({ message: "Please provide a valid mobile number." });

      let referredByDevotee = null;
      if (devoteeId) {
        const devotee = await templeDevotees.findOne(
          { _id: castQueryId(devoteeId, "templeDevotee"), status: "active" },
          { lean: true }
        );
        if (!devotee) return res.status(400).json({ message: "Please select a valid devotee from the list." });
        referredByDevotee = devotee._id;
      } else {
        return res.status(400).json({ message: "Please select the devotee you know from the list." });
      }

      const existing = await campaigners.findOne({ email, campaignType }, { lean: true });
      if (existing) {
        return res.status(200).json({
          existing: true,
          status: existing.status,
          campaigner: {
            name: existing.name,
            slug: existing.slug,
            goalSqft: existing.goalSqft,
            status: existing.status,
          },
        });
      }

      const base = slugify(name);
      let slug = base;
      let n = 1;
      // eslint-disable-next-line no-await-in-loop
      while (await campaigners.exists({ slug })) {
        n += 1;
        slug = `${base}-${n}`;
      }

      const campaigner = await store.create({
        name,
        email,
        mobile,
        slug,
        goalSqft,
        message,
        campaignType,
        referredByDevotee,
        status: "pending",
      });

      res.status(201).json({
        existing: false,
        status: "pending",
        campaigner: { name: campaigner.name, slug: campaigner.slug, goalSqft: campaigner.goalSqft, status: "pending" },
      });
    } catch (err) {
      console.error("campaigner.register error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  getBySlug: async (req, res) => {
    try {
      const slug = String(req.params.slug || "").toLowerCase();

      const cached = await cacheWrap(cacheKeys.campaigner(slug), CAMPAIGNER_TTL, async () => {
        const campaigner = await campaigners.findOne({ slug, status: "active" }, { lean: true });
        if (!campaigner) return null;

        const filter = { status: "completed", campaignerSlug: slug };
        const [recent, agg] = await Promise.all([
          donations.find(filter, {
            sort: { date: -1, _id: -1 },
            limit: 20,
            fields: ["donorName", "amount", "date"],
            lean: true,
          }),
          one(
            `SELECT COALESCE(SUM(amount), 0) AS "totalAmount", count(*)::int AS "donorCount"
               FROM donations WHERE status = 'completed' AND campaigner_slug = $1`,
            [slug]
          ),
        ]);

        return {
          name: campaigner.name,
          slug: campaigner.slug,
          goalSqft: campaigner.goalSqft || 0,
          message: campaigner.message || "",
          totalAmount: agg?.totalAmount || 0,
          donorCount: agg?.donorCount || 0,
          donors: recent.map((d) => ({
            name: toDisplayName(d.donorName),
            amount: d.amount,
            date: d.date,
          })),
        };
      });

      if (!cached) return res.status(404).json({ message: "Campaigner not found" });

      const price = PRICE_PER_SQFT();

      res.status(200).json({
        name: cached.name,
        slug: cached.slug,
        goalSqft: cached.goalSqft,
        message: cached.message,
        raisedAmount: cached.totalAmount,
        sqftRaised: Math.floor(cached.totalAmount / price),
        donorCount: cached.donorCount,
        donors: cached.donors.map((d) => ({
          name: d.name,
          amount: d.amount,
          sqft: Math.floor((d.amount || 0) / price),
          time: timeAgo(d.date),
        })),
      });
    } catch (err) {
      console.error("campaigner.getBySlug error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  list: async (req, res) => {
    try {
      const price = PRICE_PER_SQFT();
      const [rows, totals] = await Promise.all([
        many(
          `SELECT c.*, d.id AS dev_id, d.name AS dev_name
             FROM campaigners c LEFT JOIN temple_devotees d ON d.id = c.referred_by_devotee_id
            ORDER BY c.created_at DESC, c.id DESC`
        ),
        many(
          `SELECT campaigner_slug AS "_id", COALESCE(SUM(amount), 0) AS "totalAmount", count(*)::int AS "donorCount"
             FROM donations WHERE status = 'completed' AND campaigner_slug IS NOT NULL
            GROUP BY campaigner_slug`
        ),
      ]);
      const list = rows.map(({ dev_id, dev_name, ...row }) => ({
        ...campaigners.fromRow(row, { lean: true }),
        devoteeName: dev_name,
        devoteeFound: Boolean(dev_id),
      }));

      const bySlug = Object.fromEntries(totals.map((t) => [t._id, t]));

      res.status(200).json({
        campaigners: list.map((c) => ({
          _id: c._id,
          name: c.name,
          email: c.email,
          mobile: c.mobile,
          slug: c.slug,
          campaignType: c.campaignType || "SQFT",
          referredByDevotee: c.referredByDevotee && c.devoteeFound ? { _id: c.referredByDevotee, name: c.devoteeName } : null,
          goalSqft: c.goalSqft || 0,
          message: c.message || "",
          status: c.status,
          createdAt: c.createdAt,
          raisedAmount: bySlug[c.slug]?.totalAmount || 0,
          sqftRaised: Math.floor((bySlug[c.slug]?.totalAmount || 0) / price),
          donorCount: bySlug[c.slug]?.donorCount || 0,
        })),
      });
    } catch (err) {
      console.error("campaigner.list error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  updateStatus: async (req, res) => {
    try {
      const allowed = ["pending", "active", "hidden"];
      const status = allowed.includes(req.body.status) ? req.body.status : "active";
      const campaigner = await store.updateById(castQueryId(req.params.id, "campaigner"), { status });
      if (!campaigner) return res.status(404).json({ message: "Campaigner not found" });
      res.status(200).json({ message: "Updated", status: campaigner.status });
    } catch (err) {
      console.error("campaigner.updateStatus error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { campaignerController };
