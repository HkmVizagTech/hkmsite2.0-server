const { donationModel } = require("../models/donation.model");
const { eventModel } = require("../models/event.model");
const { galleryModel } = require("../models/gallery.model");
const { blogModel } = require("../models/blog.model");
const { contactMessageModel } = require("../models/contactMessage.model");

const timeAgo = (date) => {
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
};

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

      // Real seva-type breakdown (was a hardcoded pie chart before)
      const sevaAgg = await donationModel.aggregate([
        { $match: { status: "completed" } },
        {
          $group: {
            _id: { $ifNull: ["$sevaName", "$type"] },
            value: { $sum: 1 },
          },
        },
        { $sort: { value: -1 } },
        { $limit: 6 },
      ]);
      const sevaBreakdown = sevaAgg.map((s) => ({ name: s._id || "Other", value: s.value }));

      // Status breakdown (completed / pending / failed) - real data for Analytics page
      const statusAgg = await donationModel.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
      ]);
      const statusBreakdown = statusAgg.map((s) => ({ status: s._id, count: s.count, amount: s.amount }));

      // Daily donation count for the last 30 days - finer-grained trend for Analytics
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      const dailyAgg = await donationModel.aggregate([
        { $match: { status: "completed", date: { $gte: thirtyDaysAgo } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
            donations: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);
      const dailyData = dailyAgg.map((d) => ({ date: d._id, donations: d.donations, count: d.count }));

      // Real recent-activity feed merged across collections (was hardcoded before)
      const [recentDonation, recentEvent, recentGallery, recentBlog, recentMessage] = await Promise.all([
        donationModel.findOne({ status: "completed" }).sort({ createdAt: -1 }).select("amount sevaName type createdAt").lean(),
        eventModel.findOne().sort({ createdAt: -1 }).select("title createdAt").lean(),
        galleryModel.findOne().sort({ createdAt: -1 }).select("title images createdAt").lean(),
        blogModel.findOne({ status: "published" }).sort({ createdAt: -1 }).select("title createdAt").lean(),
        contactMessageModel.findOne().sort({ createdAt: -1 }).select("name subject createdAt").lean(),
      ]);
      const recentActivity = [
        recentDonation && {
          action: "New donation received",
          detail: `₹${recentDonation.amount?.toLocaleString("en-IN")} — ${recentDonation.sevaName || recentDonation.type || "General"}`,
          time: timeAgo(recentDonation.createdAt),
          at: recentDonation.createdAt,
        },
        recentEvent && {
          action: "Event created",
          detail: recentEvent.title,
          time: timeAgo(recentEvent.createdAt),
          at: recentEvent.createdAt,
        },
        recentGallery && {
          action: "Gallery updated",
          detail: `${recentGallery.images?.length || 1} photo(s) — ${recentGallery.title}`,
          time: timeAgo(recentGallery.createdAt),
          at: recentGallery.createdAt,
        },
        recentBlog && {
          action: "Blog published",
          detail: recentBlog.title,
          time: timeAgo(recentBlog.createdAt),
          at: recentBlog.createdAt,
        },
        recentMessage && {
          action: "New contact message",
          detail: `${recentMessage.name} — ${recentMessage.subject}`,
          time: timeAgo(recentMessage.createdAt),
          at: recentMessage.createdAt,
        },
      ].filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at));

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
        sevaBreakdown,
        statusBreakdown,
        dailyData,
        recentActivity,
      });
    } catch (err) {
      console.error("Dashboard stats error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { dashboardController };
