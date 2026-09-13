const { donorModel } = require("../models/donor.model");
const { donationModel } = require("../models/donation.model");
const { userModel } = require("../models/user.model");

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
};

module.exports = { donorController };
