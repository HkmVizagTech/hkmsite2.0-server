import { many } from "../db/pg.js";
import { compilePcre, regexMatches } from "../domain/pcre.js";

// A devotee is a donor identity aggregated from completed donations.
const devoteeController = {
  list: async (req, res) => {
    try {
      const { q, status, page = 1, limit = 50 } = req.query;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      let all = await many(
        `SELECT
           COALESCE(donor_email, donor_mobile) AS "_id",
           (array_agg(donor_name ORDER BY id DESC))[1] AS name,
           (array_agg(donor_email ORDER BY id DESC))[1] AS email,
           (array_agg(donor_mobile ORDER BY id DESC))[1] AS phone,
           (array_agg(prasadam_city ORDER BY id DESC))[1] AS city,
           count(*)::int AS donations,
           SUM(amount) AS "totalAmount",
           MIN(date) AS "firstDonation",
           MAX(date) AS "lastDonation",
           CASE WHEN SUM(amount) >= 100000 THEN 'patron'
                WHEN MIN(date) >= $1 THEN 'new'
                ELSE 'active' END AS status
         FROM donations
         WHERE status = 'completed'
         GROUP BY COALESCE(donor_email, donor_mobile)
         ORDER BY "totalAmount" DESC, "_id"`,
        [thirtyDaysAgo]
      );

      if (q) {
        const re = compilePcre(q);
        all = all.filter((d) => regexMatches(d.name, re) || regexMatches(d.email, re) || regexMatches(d.phone, re));
      }
      if (status && status !== "all") all = all.filter((d) => d.status === status);

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const start = (pageNum - 1) * lim;

      res.status(200).json({
        devotees: all.slice(start, start + lim),
        total: all.length,
        page: pageNum,
        totalPages: Math.ceil(all.length / lim),
      });
    } catch (err) {
      console.error("Devotees list error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

export { devoteeController };
