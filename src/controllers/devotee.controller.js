const { donationModel } = require("../models/donation.model");

const devoteeController = {
  // ADMIN - real devotee list, aggregated from completed donations
  // (there is no separate "devotee" collection; a devotee IS a donor)
  list: async (req, res) => {
    try {
      const { q, status, page = 1, limit = 50 } = req.query;

      const pipeline = [
        { $match: { status: "completed" } },
        {
          $group: {
            _id: { $ifNull: ["$donorEmail", "$donorMobile"] },
            name: { $last: "$donorName" },
            email: { $last: "$donorEmail" },
            phone: { $last: "$donorMobile" },
            city: { $last: "$prasadamAddress.city" },
            donations: { $sum: 1 },
            totalAmount: { $sum: "$amount" },
            firstDonation: { $min: "$date" },
            lastDonation: { $max: "$date" },
          },
        },
        {
          $addFields: {
            status: {
              $switch: {
                branches: [
                  { case: { $gte: ["$totalAmount", 100000] }, then: "patron" },
                  {
                    case: {
                      $gte: [
                        "$firstDonation",
                        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                      ],
                    },
                    then: "new",
                  },
                ],
                default: "active",
              },
            },
          },
        },
        { $sort: { totalAmount: -1 } },
      ];

      if (q) {
        pipeline.push({
          $match: {
            $or: [
              { name: { $regex: q, $options: "i" } },
              { email: { $regex: q, $options: "i" } },
              { phone: { $regex: q, $options: "i" } },
            ],
          },
        });
      }
      if (status && status !== "all") {
        pipeline.push({ $match: { status } });
      }

      const allResults = await donationModel.aggregate(pipeline);
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const start = (pageNum - 1) * lim;
      const devotees = allResults.slice(start, start + lim);

      res.status(200).json({
        devotees,
        total: allResults.length,
        page: pageNum,
        totalPages: Math.ceil(allResults.length / lim),
      });
    } catch (err) {
      console.error("Devotees list error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { devoteeController };
