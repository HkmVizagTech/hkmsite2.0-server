import { donorIssues, donors } from "../db/tables.js";

const donorIssueAdminController = {
  list: async (req, res) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = req.query.status;
      const issues = await donorIssues.find(filter, { sort: { createdAt: -1, _id: -1 } });

      const donorIds = [...new Set(issues.map((i) => String(i.donorRecordId)))];
      const found = donorIds.length
        ? await donors.find({ _id: { $in: donorIds } }, { fields: ["donorId", "name", "mobile"] })
        : [];
      const donorMap = new Map(found.map((d) => [String(d._id), d]));

      res.status(200).json({
        success: true,
        issues: issues.map((i) => ({ ...i, donor: donorMap.get(String(i.donorRecordId)) || null })),
      });
    } catch (err) {
      console.error("donorIssueAdmin.list error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

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

      const issue = await donorIssues.updateById(req.params.id, update);
      if (!issue) return res.status(404).json({ success: false, message: "Issue not found." });
      res.status(200).json({ success: true, issue });
    } catch (err) {
      console.error("donorIssueAdmin.respond error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

export { donorIssueAdminController };
