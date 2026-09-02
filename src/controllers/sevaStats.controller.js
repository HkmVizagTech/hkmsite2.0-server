const { donationModel } = require("../models/donation.model");
const { cacheWrap, cacheKeys } = require("../redis/redisClient");

// How long a public stats payload may be stale. These numbers are "raised so
// far" totals and donor walls — a minute of lag is invisible to a donor, and
// completing a donation busts the relevant keys anyway (see
// paymentCompletion.service.js), so the TTL is only the backstop for
// donations that land through a path that doesn't invalidate.
const OVERVIEW_TTL = Number(process.env.STATS_CACHE_TTL_SECONDS || 60);
const SQFT_TTL = Number(process.env.STATS_CACHE_TTL_SECONDS || 60);
const SEVA_TTL = Number(process.env.STATS_CACHE_TTL_SECONDS || 60);

// The per-seva donor wall accepts ?limit=1..50. Caching per limit would create
// a separate entry for every value a caller happens to pass, and they would
// all invalidate independently. Instead we always fetch and cache the widest
// allowed slice and cut it down per request — one entry per seva, and a
// smaller limit becomes free.
const MAX_DONOR_WALL = 50;

// First name + last initial only, e.g. "Ramesh K." — never expose full PII
// (email/phone/full surname) on a public donor wall.
const toDisplayName = (fullName) => {
  const parts = String(fullName || "A devotee").trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
};

// NOTE: this runs on the way OUT of the cache, never on the way in. Caching a
// rendered "3 min ago" would freeze it for the life of the entry, so a donor
// refreshing the page would watch the clock stand still. Cached payloads carry
// raw dates and are rendered per request.
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
      const { sevaName, category, limit = 5 } = req.query;
      if (!sevaName && !category) {
        return res.status(400).json({ message: "sevaName or category is required" });
      }

      const filter = { status: "completed" };
      const or = [];
      if (sevaName) or.push({ sevaName });
      if (category) or.push({ type: category });
      if (or.length) filter.$or = or;

      // One cache entry per seva OR category. A request naming both is rare
      // and would need a combined key, so it skips the cache rather than
      // risking a key that invalidation doesn't know how to name.
      const cacheKey =
        sevaName && category
          ? null
          : sevaName
            ? cacheKeys.statsSeva(sevaName)
            : cacheKeys.statsCategory(category);

      const load = async () => {
        const [recent, agg] = await Promise.all([
          donationModel
            .find(filter)
            .sort({ date: -1 })
            .limit(MAX_DONOR_WALL)
            .select("donorName amount date")
            .lean(),
          donationModel.aggregate([
            { $match: filter },
            { $group: { _id: null, totalAmount: { $sum: "$amount" }, donorCount: { $sum: 1 } } },
          ]),
        ]);

        // Redact here, before anything is written to Redis — the cache must
        // never hold a full donor name. `date` stays raw so timeAgo() can be
        // recomputed per request.
        return {
          donors: recent.map((d) => ({
            name: toDisplayName(d.donorName),
            amount: d.amount,
            date: d.date,
          })),
          totalAmount: agg[0]?.totalAmount || 0,
          donorCount: agg[0]?.donorCount || 0,
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

  // PUBLIC - Square Foot Seva campaign stats for /sqft-seva-campaign.
  // Returns live goal progress + Latest / Largest donor walls (VCM-style).
  // Goal is configurable via SQFT_CAMPAIGN_GOAL env var (in square feet).
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
      // renders the two per-request fields: the sqft conversion (which depends
      // on an env var that can change without the cache knowing) and the
      // relative time.
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
      // ones drop off as new donations arrive), "Largest" = top 5 amounts.
      //
      // The `largest` sort has no supporting index — { amount: -1, date: -1 }
      // is an in-memory sort of every matching donation — which is most of why
      // this endpoint is worth caching at all.
      const { latest, largest, totalAmount, donorCount } = await cacheWrap(
        cacheKeys.statsSqft(),
        SQFT_TTL,
        async () => {
          const [latestDocs, largestDocs, agg] = await Promise.all([
            donationModel
              .find(filter)
              .sort({ date: -1 })
              .limit(5)
              .select("donorName amount date")
              .lean(),
            donationModel
              .find(filter)
              .sort({ amount: -1, date: -1 })
              .limit(5)
              .select("donorName amount date")
              .lean(),
            donationModel.aggregate([
              { $match: filter },
              { $group: { _id: null, totalAmount: { $sum: "$amount" }, donorCount: { $sum: 1 } } },
            ]),
          ]);

          // Redact before caching; keep raw dates for per-request timeAgo.
          const redact = (d) => ({ name: toDisplayName(d.donorName), amount: d.amount, date: d.date });
          return {
            latest: latestDocs.map(redact),
            largest: largestDocs.map(redact),
            totalAmount: agg[0]?.totalAmount || 0,
            donorCount: agg[0]?.donorCount || 0,
          };
        }
      );

      const sqftRaised = Math.floor(totalAmount / PRICE_PER_SQFT);
      const goalAmount = GOAL_SQFT * PRICE_PER_SQFT;
      const percent = goalAmount > 0
        ? Math.min(100, Math.round((totalAmount / goalAmount) * 10000) / 100)
        : 0;

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
  // hub page: overall total raised, overall donor count, per-seva subtotal
  // (to badge each card with real progress), and a recent-donors wall
  // spanning all sevas combined.
  overview: async (req, res) => {
    try {
      const filter = { status: "completed" };

      // The most expensive endpoint on the site, and the reason this whole
      // cache exists. Two $group stages over { status: "completed" } with no
      // other constraint — every completed donation ever recorded, twice, per
      // request. `status` is indexed but it is low-cardinality, so the index
      // barely narrows anything; this is effectively a collection scan that
      // gets slower every month. It backs /donate, the busiest landing page.
      const { totalAmount, donorCount, bySeva, donors } = await cacheWrap(
        cacheKeys.statsOverview(),
        OVERVIEW_TTL,
        async () => {
          const [totals, perSeva, recent] = await Promise.all([
            donationModel.aggregate([
              { $match: filter },
              { $group: { _id: null, totalAmount: { $sum: "$amount" }, donorCount: { $sum: 1 } } },
            ]),
            donationModel.aggregate([
              { $match: filter },
              {
                $group: {
                  _id: { $ifNull: ["$sevaName", "$type"] },
                  totalAmount: { $sum: "$amount" },
                  donorCount: { $sum: 1 },
                },
              },
            ]),
            donationModel
              .find(filter)
              .sort({ date: -1 })
              .limit(15)
              .select("donorName amount date sevaName type")
              .lean(),
          ]);

          const grouped = {};
          perSeva.forEach((s) => {
            if (s._id) grouped[s._id] = { totalAmount: s.totalAmount, donorCount: s.donorCount };
          });

          // Redact before caching; keep raw dates for per-request timeAgo.
          return {
            totalAmount: totals[0]?.totalAmount || 0,
            donorCount: totals[0]?.donorCount || 0,
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

module.exports = { sevaStatsController };
