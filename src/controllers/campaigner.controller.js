const { campaignerModel } = require("../models/campaigner.model");
const { donationModel } = require("../models/donation.model");

const PRICE_PER_SQFT = () => Number(process.env.SQFT_PRICE_PER_UNIT) || 6000;

// Privacy-safe display name for public donor lists: "Ramesh K."
const toDisplayName = (fullName) => {
  const parts = String(fullName || "A devotee").trim().split(/\s+/);
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
  return new Date(date).toLocaleDateString("en-IN", { month: "short", day: "numeric" });
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
  // PUBLIC — register as a campaigner (SQFT or JANMASHTAMI).
  // APPROVAL-FIRST: new registrations are created with status "pending";
  // the campaign link only goes live after an admin approves. Idempotent
  // on email+campaignType: re-registering returns the existing record's
  // state (pending → "awaiting approval", active → the live link).
  register: async (req, res) => {
    try {
      const name = String(req.body.name || "").trim();
      const email = String(req.body.email || "").trim().toLowerCase();
      const mobile = String(req.body.mobile || "").trim();
      const message = String(req.body.message || "").trim().slice(0, 300);
      const campaignType = req.body.campaignType === "JANMASHTAMI" ? "JANMASHTAMI" : "SQFT";
      const devoteeId = String(req.body.devoteeId || "").trim();
      let goalSqft = Number(req.body.goalSqft) || 0;
      goalSqft = Math.max(0, Math.min(100000, Math.floor(goalSqft)));

      if (!name || name.length < 2) return res.status(400).json({ message: "Please provide your name." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ message: "Please provide a valid email address." });
      if (!/^[0-9+\-\s]{8,15}$/.test(mobile))
        return res.status(400).json({ message: "Please provide a valid mobile number." });

      // Validate the selected devotee (required for new registrations —
      // it drives DCC receipt attribution).
      let referredByDevotee = null;
      if (devoteeId) {
        const { templeDevoteeModel } = require("../models/templeDevotee.model");
        const devotee = await templeDevoteeModel.findOne({ _id: devoteeId, status: "active" }).lean();
        if (!devotee) return res.status(400).json({ message: "Please select a valid devotee from the list." });
        referredByDevotee = devotee._id;
      } else {
        return res.status(400).json({ message: "Please select the devotee you know from the list." });
      }

      const existing = await campaignerModel.findOne({ email, campaignType }).lean();
      if (existing) {
        return res.status(200).json({
          existing: true,
          status: existing.status,
          campaigner: { name: existing.name, slug: existing.slug, goalSqft: existing.goalSqft, status: existing.status },
        });
      }

      // Generate a unique slug from the name.
      const base = slugify(name);
      let slug = base;
      let n = 1;
      // eslint-disable-next-line no-await-in-loop
      while (await campaignerModel.exists({ slug })) {
        n += 1;
        slug = `${base}-${n}`;
      }

      const campaigner = await campaignerModel.create({
        name, email, mobile, slug, goalSqft, message, campaignType, referredByDevotee,
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

  // PUBLIC — campaigner page data: profile + live stats for their campaign.
  // Never exposes the campaigner's email/mobile or donor PII.
  getBySlug: async (req, res) => {
    try {
      const slug = String(req.params.slug || "").toLowerCase();
      const campaigner = await campaignerModel.findOne({ slug, status: "active" }).lean();
      if (!campaigner) return res.status(404).json({ message: "Campaigner not found" });

      const filter = { status: "completed", campaignerSlug: slug };
      const [recent, agg] = await Promise.all([
        donationModel.find(filter).sort({ date: -1 }).limit(20).select("donorName amount date").lean(),
        donationModel.aggregate([
          { $match: filter },
          { $group: { _id: null, totalAmount: { $sum: "$amount" }, donorCount: { $sum: 1 } } },
        ]),
      ]);

      const price = PRICE_PER_SQFT();
      const totalAmount = agg[0]?.totalAmount || 0;

      res.status(200).json({
        name: campaigner.name,
        slug: campaigner.slug,
        goalSqft: campaigner.goalSqft || 0,
        message: campaigner.message || "",
        raisedAmount: totalAmount,
        sqftRaised: Math.floor(totalAmount / price),
        donorCount: agg[0]?.donorCount || 0,
        donors: recent.map((d) => ({
          name: toDisplayName(d.donorName),
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

  // ADMIN — list all campaigners with their raised totals for management.
  list: async (req, res) => {
    try {
      const price = PRICE_PER_SQFT();
      const [campaigners, totals] = await Promise.all([
        campaignerModel.find().sort({ createdAt: -1 }).populate("referredByDevotee", "name dccEnrolledById").lean(),
        donationModel.aggregate([
          { $match: { status: "completed", campaignerSlug: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: "$campaignerSlug",
              totalAmount: { $sum: "$amount" },
              donorCount: { $sum: 1 },
            },
          },
        ]),
      ]);

      const bySlug = Object.fromEntries(totals.map((t) => [t._id, t]));

      res.status(200).json({
        campaigners: campaigners.map((c) => ({
          _id: c._id,
          name: c.name,
          email: c.email,
          mobile: c.mobile,
          slug: c.slug,
          campaignType: c.campaignType || "SQFT",
          referredByDevotee: c.referredByDevotee ? { _id: c.referredByDevotee._id, name: c.referredByDevotee.name } : null,
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

  // ADMIN — approve (pending→active), hide, or re-activate a campaigner.
  updateStatus: async (req, res) => {
    try {
      const allowed = ["pending", "active", "hidden"];
      const status = allowed.includes(req.body.status) ? req.body.status : "active";
      const campaigner = await campaignerModel.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true }
      );
      if (!campaigner) return res.status(404).json({ message: "Campaigner not found" });
      res.status(200).json({ message: "Updated", status: campaigner.status });
    } catch (err) {
      console.error("campaigner.updateStatus error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { campaignerController };
