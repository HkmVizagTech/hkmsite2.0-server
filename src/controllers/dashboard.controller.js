import { donations, events, galleries, blogs, contactMessages } from "../db/tables.js";
import { aggregate, sumCount, sumTotal, countGroups, istDay, IST_ZONE } from "../domain/donationQuery.js";

// The standalone /donations page (sourcePage === "donations") has its own admin and is excluded here.
const EXCLUDE_DONATIONS_PAGE = { sourcePage: { $ne: "donations" } };

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

      const completed = { status: "completed", ...EXCLUDE_DONATIONS_PAGE };

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
      sixMonthsAgo.setDate(1);
      sixMonthsAgo.setHours(0, 0, 0, 0);

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
      thirtyDaysAgo.setHours(0, 0, 0, 0);

      const [
        donationAgg,
        lastMonthDonations,
        eventsThisMonth,
        galleryCount,
        galleryLastMonthCount,
        blogCount,
        distinctDonors,
        newMessagesCount,
        monthlyDonations,
        sevaAgg,
        statusAgg,
        dailyAgg,
      ] = await Promise.all([
        sumCount(completed),
        sumTotal({ ...completed, date: { $gte: startOfLastMonth, $lt: startOfMonth } }),
        events.count({ date: { $gte: startOfMonth } }),
        galleries.count({}),
        galleries.count({ createdAt: { $lt: startOfMonth } }),
        blogs.count({ status: "published" }),
        countGroups(completed, "COALESCE(donor_email, donor_mobile)"),
        contactMessages.count({ status: "new" }),
        aggregate(
          { ...completed, date: { $gte: sixMonthsAgo } },
          `EXTRACT(YEAR FROM "date" AT TIME ZONE '${IST_ZONE}') AS y, EXTRACT(MONTH FROM "date" AT TIME ZONE '${IST_ZONE}') AS m, SUM(amount) AS donations, COUNT(*) AS count`,
          { groupBy: "y, m", orderBy: "y, m" }
        ),
        aggregate(completed, "COALESCE(seva_name, type) AS k, COUNT(*) AS value", {
          groupBy: "k",
          orderBy: `value DESC, k COLLATE "C" NULLS FIRST`,
          limit: 6,
        }),
        aggregate(EXCLUDE_DONATIONS_PAGE, "status AS k, COUNT(*) AS count, SUM(amount) AS amount", {
          groupBy: "k",
          orderBy: `k COLLATE "C"`,
        }),
        aggregate(
          { ...completed, date: { $gte: thirtyDaysAgo } },
          `${istDay('"date"')} AS k, SUM(amount) AS donations, COUNT(*) AS count`,
          { groupBy: "k", orderBy: "k" }
        ),
      ]);

      const totalDonations = donationAgg.total;
      const donationChangePct =
        lastMonthDonations > 0 ? Math.round(((totalDonations - lastMonthDonations) / lastMonthDonations) * 100) : null;

      const galleryNewThisMonth = galleryCount - galleryLastMonthCount;

      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const monthlyData = monthlyDonations.map((m) => ({
        month: monthNames[m.m - 1],
        donations: m.donations,
        count: m.count,
      }));

      const sevaBreakdown = sevaAgg.map((s) => ({ name: s.k || "Other", value: s.value }));
      const statusBreakdown = statusAgg.map((s) => ({ status: s.k, count: s.count, amount: s.amount }));
      const dailyData = dailyAgg.map((d) => ({ date: d.k, donations: d.donations, count: d.count }));

      // Real recent-activity feed merged across collections (was hardcoded before)
      const [recentDonation, recentEvent, recentGallery, recentBlog, recentMessage] = await Promise.all([
        donations.findOne(completed, {
          sort: { createdAt: -1, _id: 1 },
          fields: ["amount", "sevaName", "type", "createdAt"],
        }),
        events.findOne({}, { sort: { createdAt: -1, _id: 1 }, fields: ["title", "createdAt"] }),
        galleries.findOne({}, { sort: { createdAt: -1, _id: 1 }, fields: ["title", "images", "createdAt"] }),
        blogs.findOne({ status: "published" }, { sort: { createdAt: -1, _id: 1 }, fields: ["title", "createdAt"] }),
        contactMessages.findOne({}, { sort: { createdAt: -1, _id: 1 }, fields: ["name", "subject", "createdAt"] }),
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
      ]
        .filter(Boolean)
        .sort((a, b) => new Date(b.at) - new Date(a.at));

      res.status(200).json({
        stats: {
          totalDonations,
          donationCount: donationAgg.count,
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

export { dashboardController };
