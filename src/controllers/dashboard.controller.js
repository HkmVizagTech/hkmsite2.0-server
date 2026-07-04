const { donationModel } = require("../models/donation.model");
const { eventModel } = require("../models/event.model");
const { galleryModel } = require("../models/gallery.model");
const { blogModel } = require("../models/blog.model");
const { contactMessageModel } = require("../models/contactMessage.model");

const dashboardController = {
  // ADMIN - real dashboard summary stats (replaces hardcoded numbers)
  stats: async (req, res) => {
    try {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const startOfLastMonth = new Date(startOfMonth);
      startOfLastMonth.setMonth(startOfLastMonth.getMonth() - 1);

      const [
        donationAgg,
        lastMonthDonationAgg,
        eventsThisMonth,
        galleryCount,
        galleryLastMonthCount,
        blogCount,
        distinctDonorsAgg,
        newMessagesCount,
      ] = await Promise.all([
        donationModel.aggregate([
          { $match: { status: "completed" } },
          { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        donationModel.aggregate([
          { $match: { status: "completed", date: { $gte: startOfLastMonth, $lt: startOfMonth } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]),
        eventModel.countDocuments({ date: { $gte: startOfMonth } }),
        galleryModel.countDocuments({}),
        galleryModel.countDocuments({ createdAt: { $lt: startOfMonth } }),
        blogModel.countDocuments({ status: "published" }),
        donationModel.aggregate([
          { $match: { status: "completed" } },
          {
            $group: {
              _id: { $ifNull: ["$donorEmail", "$donorMobile"] },
            },
          },
          { $count: "distinctDonors" },
        ]),
        contactMessageModel.countDocuments({ status: "new" }),
      ]);

      const totalDonations = donationAgg[0]?.total || 0;
      const lastMonthDonations = lastMonthDonationAgg[0]?.total || 0;
      const donationChangePct = lastMonthDonations > 0
        ? Math.round(((totalDonations - lastMonthDonations) / lastMonthDonations) * 100)
        : null;

      const galleryNewThisMonth = galleryCount - galleryLastMonthCount;
      const distinctDonors = distinctDonorsAgg[0]?.distinctDonors || 0;

      // Monthly trend for the last 6 months — real aggregation, not fabricated
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
      sixMonthsAgo.setDate(1);
      sixMonthsAgo.setHours(0, 0, 0, 0);

      const monthlyDonations = await donationModel.aggregate([
        { $match: { status: "completed", date: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: { year: { $year: "$date" }, month: { $month: "$date" } },
            donations: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]);

      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const monthlyData = monthlyDonations.map((m) => ({
        month: monthNames[m._id.month - 1],
        donations: m.donations,
        count: m.count,
      }));

      res.status(200).json({
        stats: {
          totalDonations,
          donationCount: donationAgg[0]?.count || 0,
          donationChangePct,
          eventsThisMonth,
          galleryImages: galleryCount,
          galleryNewThisMonth,
          devoteesCount: distinctDonors,
          publishedBlogs: blogCount,
          newMessages: newMessagesCount,
        },
        monthlyData,
      });
    } catch (err) {
      console.error("Dashboard stats error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { dashboardController };
