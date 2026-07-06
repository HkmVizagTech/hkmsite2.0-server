const { donationModel } = require("../models/donation.model");

// First name + last initial only, e.g. "Ramesh K." — never expose full PII
// (email/phone/full surname) on a public donor wall.
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

const sevaStatsController = {
  // PUBLIC - recent donors + totals for a specific seva, by sevaName or type.
  // Used for the "live donor wall" and progress display on /donate/[seva].
  // Returns only first-name + last-initial, never email/phone.
  get: async (req, res) => {
    try {
      const { sevaName, category, limit = 12 } = req.query;
      if (!sevaName && !category) {
        return res.status(400).json({ message: "sevaName or category is required" });
      }

      const filter = { status: "completed" };
      const or = [];
      if (sevaName) or.push({ sevaName });
      if (category) or.push({ type: category });
      if (or.length) filter.$or = or;

      const [recent, agg] = await Promise.all([
        donationModel
          .find(filter)
          .sort({ date: -1 })
          .limit(Math.min(50, Math.max(1, parseInt(limit, 10) || 12)))
          .select("donorName amount date")
          .lean(),
        donationModel.aggregate([
          { $match: filter },
          { $group: { _id: null, totalAmount: { $sum: "$amount" }, donorCount: { $sum: 1 } } },
        ]),
      ]);

      const donors = recent.map((d) => ({
        name: toDisplayName(d.donorName),
        amount: d.amount,
        time: timeAgo(d.date),
      }));

      res.status(200).json({
        donors,
        totalAmount: agg[0]?.totalAmount || 0,
        donorCount: agg[0]?.donorCount || 0,
      });
    } catch (err) {
      console.error("sevaStats.get error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

module.exports = { sevaStatsController };
