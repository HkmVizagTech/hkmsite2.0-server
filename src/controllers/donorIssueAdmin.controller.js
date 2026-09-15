const { donorIssueModel } = require("../models/donorIssue.model");
const { donorModel } = require("../models/donor.model");

const donorIssueAdminController = {
  // GET /admin/donor-issues?status=open|in-progress|resolved
  list: async (req, res) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      const issues = await donorIssueModel.find(filter).sort({ createdAt: -1 }).lean();

      const donorIds = [...new Set(issues.map((i) => String(i.donorRecordId)))];
      const donors = await donorModel.find({ _id: { $in: donorIds } }).select("donorId name mobile").lean();
      const donorMap = new Map(donors.map((d) => [String(d._id), d]));

      res.status(200).json({
        success: true,
        issues: issues.map((i) => ({ ...i, donor: donorMap.get(String(i.donorRecordId)) || null })),
      });
    } catch (err) {
      console.error("donorIssueAdmin.list error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // PUT /admin/donor-issues/:id { adminResponse, status }
  respond: async (req, res) => {
    try {
      const { adminResponse, status } = req.body;
      const update = {};
      if (adminResponse !== undefined) {
        update.adminResponse = adminResponse;
        update.respondedAt = new Date();
        update.respondedBy = req.user.userId;
      }
      if (status) update.status = status;

      const issue = await donorIssueModel.findByIdAndUpdate(req.params.id, update, { new: true });
      if (!issue) return res.status(404).json({ success: false, message: "Issue not found." });
      res.status(200).json({ success: true, issue });
    } catch (err) {
      console.error("donorIssueAdmin.respond error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

module.exports = { donorIssueAdminController };
