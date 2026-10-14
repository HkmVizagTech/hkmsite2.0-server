import { donations } from "../db/tables.js";
import { cacheWrap, cacheKeys } from "../cache/memoryCache.js";
import { IST } from "../config/timezone.js";
import { aggregate, sumCount } from "../domain/donationQuery.js";

// How long a public stats payload may be stale. These numbers are "raised so
const OVERVIEW_TTL = Number(process.env.STATS_CACHE_TTL_SECONDS || 60);
const SQFT_TTL = Number(process.env.STATS_CACHE_TTL_SECONDS || 60);
const SEVA_TTL = Number(process.env.STATS_CACHE_TTL_SECONDS || 60);

// The per-seva donor wall accepts ?limit=1..50. Caching per limit would create
const MAX_DONOR_WALL = 50;

// First name + last initial only, e.g. "Ramesh K." — never expose full PII
// (email/phone/full surname) on a public donor wall.
const toDisplayName = (fullName) => {
  const parts = String(fullName || "A devotee")
    .trim()
    .split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
};

// NOTE: this runs on the way OUT of the cache, never on the way in. Caching a
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
  // Explicit zone: this falls back to a human-readable calendar date
  return new Date(date).toLocaleDateString("en-IN", { timeZone: IST, month: "short", day: "numeric" });
};

const sevaStatsController = {
  get: async (req, res) => {
    try {
      const { sevaName, category, limit = 5 } = req.query;
      if (!sevaName && !category) {
        return res.status(400).json({ message: "sevaName or category is required" });
      }

      const filter = { status: "completed" };
      const or = [];
      if (sevaName) or.push({ sevaName });
      if (category) or.push({ type: category });
      if (or.length) filter.$or = or;

      const cacheKey =
        sevaName && category ? null : sevaName ? cacheKeys.statsSeva(sevaName) : cacheKeys.statsCategory(category);

      const load = async () => {
        const [recent, agg] = await Promise.all([
          donations.find(filter, {
            sort: { date: -1, _id: 1 },
            limit: MAX_DONOR_WALL,
            fields: ["donorName", "amount", "date"],
            lean: true,
          }),
          sumCount(filter),
        ]);

        return {
          donors: recent.map((d) => ({
            name: toDisplayName(d.donorName),
            amount: d.amount,
            date: d.date,
          })),
          totalAmount: agg.total,
          donorCount: agg.count,
        };
      };

      const data = cacheKey ? await cacheWrap(cacheKey, SEVA_TTL, load) : await load();

      const wanted = Math.min(MAX_DONOR_WALL, Math.max(1, parseInt(limit, 10) || 5));

      res.status(200).json({
        donors: data.donors.slice(0, wanted).map((d) => ({
          name: d.name,
          amount: d.amount,
          time: timeAgo(d.date),
        })),
        totalAmount: data.totalAmount,
        donorCount: data.donorCount,
      });
    } catch (err) {
      console.error("sevaStats.get error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },

  sqftCampaign: async (req, res) => {
    try {
      const PRICE_PER_SQFT = Number(process.env.SQFT_PRICE_PER_UNIT) || 6000;
      const GOAL_SQFT = Number(process.env.SQFT_CAMPAIGN_GOAL) || 67000;

      // Match the same donations the Square Foot Seva page records:
      // type "SQFT" or sevaName "Square Foot Seva" (covers both flows).
      const filter = {
        status: "completed",
        $or: [{ type: "SQFT" }, { sevaName: "Square Foot Seva" }],
      };

      // Consumes an already-redacted cached row ({ name, amount, date }) and
      const toEntry = (d) => {
        const sqft = Math.floor((d.amount || 0) / PRICE_PER_SQFT);
        return {
          name: d.name,
          amount: d.amount,
          sqft, // 0 when below one square foot — client falls back to ₹ display
          time: timeAgo(d.date),
        };
      };

      // Both walls show exactly 5 entries: "Latest" = 5 most recent (older
      const { latest, largest, totalAmount, donorCount } = await cacheWrap(
        cacheKeys.statsSqft(),
        SQFT_TTL,
        async () => {
          const [latestDocs, largestDocs, agg] = await Promise.all([
            donations.find(filter, {
              sort: { date: -1, _id: 1 },
              limit: 5,
              fields: ["donorName", "amount", "date"],
              lean: true,
            }),
            donations.find(filter, {
              sort: { amount: -1, date: -1, _id: 1 },
              limit: 5,
              lean: true,
              fields: ["donorName", "amount", "date"],
            }),
            sumCount(filter),
          ]);

          // Redact before caching; keep raw dates for per-request timeAgo.
          const redact = (d) => ({ name: toDisplayName(d.donorName), amount: d.amount, date: d.date });
          return {
            latest: latestDocs.map(redact),
            largest: largestDocs.map(redact),
            totalAmount: agg.total,
            donorCount: agg.count,
          };
        }
      );

      const sqftRaised = Math.floor(totalAmount / PRICE_PER_SQFT);
      const goalAmount = GOAL_SQFT * PRICE_PER_SQFT;
      const percent = goalAmount > 0 ? Math.min(100, Math.round((totalAmount / goalAmount) * 10000) / 100) : 0;

      res.status(200).json({
        pricePerSqft: PRICE_PER_SQFT,
        goalSqft: GOAL_SQFT,
        sqftRaised,
        totalAmount,
        donorCount,
        percent,
        latest: latest.map(toEntry),
        largest: largest.map(toEntry),
      });
    } catch (err) {
      console.error("sevaStats.sqftCampaign error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
  // PUBLIC - aggregate stats across every seva, for the centralized /donate
  overview: async (req, res) => {
    try {
      const filter = { status: "completed" };

      // The most expensive endpoint on the site, and the reason this whole
      const { totalAmount, donorCount, bySeva, donors } = await cacheWrap(
        cacheKeys.statsOverview(),
        OVERVIEW_TTL,
        async () => {
          const [totals, perSeva, recent] = await Promise.all([
            sumCount(filter),
            aggregate(filter, "COALESCE(seva_name, type) AS k, SUM(amount) AS total_amount, COUNT(*) AS donor_count", {
              groupBy: "k",
              orderBy: `k COLLATE "C"`,
            }),
            donations.find(filter, {
              sort: { date: -1, _id: 1 },
              limit: 15,
              lean: true,
              fields: ["donorName", "amount", "date", "sevaName", "type"],
            }),
          ]);

          const grouped = {};
          perSeva.forEach((s) => {
            if (s.k) grouped[s.k] = { totalAmount: s.total_amount, donorCount: s.donor_count };
          });

          // Redact before caching; keep raw dates for per-request timeAgo.
          return {
            totalAmount: totals.total,
            donorCount: totals.count,
            bySeva: grouped,
            donors: recent.map((d) => ({
              name: toDisplayName(d.donorName),
              amount: d.amount,
              seva: d.sevaName || d.type || "General",
              date: d.date,
            })),
          };
        }
      );

      res.status(200).json({
        totalAmount,
        donorCount,
        bySeva,
        donors: donors.map((d) => ({
          name: d.name,
          amount: d.amount,
          seva: d.seva,
          time: timeAgo(d.date),
        })),
      });
    } catch (err) {
      console.error("sevaStats.overview error:", err);
      res.status(500).json({ message: "Server error" });
    }
  },
};

export { sevaStatsController };
