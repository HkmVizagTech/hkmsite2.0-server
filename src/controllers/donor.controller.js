const { donorModel } = require("../models/donor.model");
const { donationModel } = require("../models/donation.model");
const { userModel } = require("../models/user.model");
const { donorIssueModel } = require("../models/donorIssue.model");

const donorController = {
  // GET /donor/me — profile: Donor ID, name, mobile, and assigned
  // preacher's name if they have one.
  me: async (req, res) => {
    try {
      const donor = await donorModel.findById(req.donor.donorId).lean();
      if (!donor) return res.status(404).json({ success: false, message: "Donor not found." });

      let preacherName = null;
      if (donor.assignedPreacherId) {
        const preacher = await userModel.findById(donor.assignedPreacherId).select("name").lean();
        preacherName = preacher ? preacher.name : null;
      }

      res.status(200).json({
        success: true,
        donor: {
          donorId: donor.donorId,
          name: donor.name,
          mobile: donor.mobile,
          email: donor.email,
          preacherName,
        },
      });
    } catch (err) {
      console.error("donor.me error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/my-donations — this donor's full donation history.
  myDonations: async (req, res) => {
    try {
      const donations = await donationModel
        .find({ donorRecordId: req.donor.donorId })
        .sort({ createdAt: -1 })
        .select("amount sevaName type status receiptNumber createdAt")
        .lean();
      res.status(200).json({ success: true, donations });
    } catch (err) {
      console.error("donor.myDonations error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/my-summary — aggregated stats for the dashboard's graphs:
  // a monthly giving trend and a breakdown by seva. Computed server-side
  // since it's cheap here and keeps the client from re-deriving the same
  // thing from the raw donation list.
  mySummary: async (req, res) => {
    try {
      const donorRecordId = new (require("mongoose").Types.ObjectId)(req.donor.donorId);
      const match = { donorRecordId, status: "completed" };

      const [monthly, bySeva, totals] = await Promise.all([
        donationModel.aggregate([
          { $match: match },
          { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]),
        donationModel.aggregate([
          { $match: match },
          { $group: { _id: { $ifNull: ["$sevaName", "General"] }, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { amount: -1 } },
        ]),
        donationModel.aggregate([
          { $match: match },
          { $group: { _id: null, totalAmount: { $sum: "$amount" }, totalCount: { $sum: 1 } } },
        ]),
      ]);

      res.status(200).json({
        success: true,
        monthly: monthly.map((m) => ({ month: m._id, amount: m.amount, count: m.count })),
        bySeva: bySeva.map((s) => ({ sevaName: s._id, amount: s.amount, count: s.count })),
        totals: { totalAmount: totals[0]?.totalAmount || 0, totalCount: totals[0]?.totalCount || 0 },
      });
    } catch (err) {
      console.error("donor.mySummary error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },

  // GET /donor/receipt/:donationId — download own receipt PDF. Ownership
  // is checked (donorRecordId must match the logged-in donor) before
  // generating anything, so a donor can never fetch someone else's
  // receipt just by guessing/incrementing an ID.
  downloadReceipt: async (req, res) => {
    try {
      const donation = await donationModel.findOne({ _id: req.params.donationId, donorRecordId: req.donor.donorId });
      if (!donation) return res.status(404).json({ success: false, message: "Receipt not found." });
      if (donation.status !== "completed" || !donation.receiptNumber) {
        return res.status(400).json({ success: false, message: "This donation doesn't have a receipt yet." });
      }

      const { generateReceiptBuffer } = require("../services/receipt.service");
      const pdfBytes = await generateReceiptBuffer(donation._id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="receipt-${donation.receiptNumber.replace(/\|/g, "-")}.pdf"`);
      res.send(Buffer.from(pdfBytes));
    } catch (err) {
      console.error("donor.downloadReceipt error:", err);
      res.status(500).json({ success: false, message: "Could not generate receipt." });
    }
  },

  // POST /donor/issues { subject, message } — raise a new issue/query.
  raiseIssue: async (req, res) => {
    try {
      const { subject, message } = req.body;
      if (!subject?.trim() || !message?.trim()) {
        return res.status(400).json({ success: false, message: "Please fill in both subject and message." });
      }
      const issue = await donorIssueModel.create({
        donorRecordId: req.donor.donorId,
        subject: subject.trim(),
        message: message.trim(),
      });
      res.status(201).json({ success: true, issue });
    } catch (err) {
      console.error("donor.raiseIssue error:", err);
      res.status(500).json({ success: false, message: "Could not submit your issue. Please try again." });
    }
  },

  // GET /donor/issues — this donor's own raised issues, with status.
  myIssues: async (req, res) => {
    try {
      const issues = await donorIssueModel
        .find({ donorRecordId: req.donor.donorId })
        .sort({ createdAt: -1 })
        .lean();
      res.status(200).json({ success: true, issues });
    } catch (err) {
      console.error("donor.myIssues error:", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
};

module.exports = { donorController };
