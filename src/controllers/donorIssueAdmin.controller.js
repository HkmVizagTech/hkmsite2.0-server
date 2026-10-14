import { donorIssues, donors } from "../db/tables.js";
import { donorIssueSchema } from "../domain/schemas.js";
import { makeStore, castQueryId, queryEq } from "../domain/store.js";

const store = makeStore(donorIssues, donorIssueSchema);

const donorIssueAdminController = {
  list: async (req, res) => {
    try {
      const filter = {};
      if (req.query.status) filter.status = queryEq(req.query.status, "donorIssue", "status");
      const issues = await donorIssues.find(filter, { sort: { createdAt: -1, _id: -1 }, lean: true });

      const donorIds = [...new Set(issues.map((i) => String(i.donorRecordId)))];
      const found = donorIds.length
        ? await donors.find(
            { _id: { $in: donorIds.map((id) => castQueryId(id, "donor")) } },
            { fields: ["donorId", "name", "mobile"], lean: true }
          )
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

      const issue = await store.updateById(castQueryId(req.params.id, "donorIssue"), update);
      if (!issue) return res.status(404).json({ success: false, message: "Issue not found." });
      res.status(200).json({ success: true, issue });
    } catch (err) {
      console.error("donorIssueAdmin.respond error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

export { donorIssueAdminController };
