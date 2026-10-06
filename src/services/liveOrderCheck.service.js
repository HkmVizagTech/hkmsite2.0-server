// Asks Razorpay directly whether a donation's order has been paid, for the
// moments when the donor's browser needs to know NOW rather than wait for the
// webhook (which can lag a few seconds): before offering the "Pay with
// PhonePe / UPI" fallback, and before recording an "I've paid" claim.
// A captured payment completes the donation through the normal pipeline.

const { donationModel } = require("../models/donation.model");
const { completeDonation } = require("./paymentCompletion.service");

const IN_PROGRESS = ["created", "authorized"];

/**
 * @returns {Promise<{ completed: boolean, inProgress: boolean, checked: boolean }>}
 */
async function liveCheckDonationOrder(donation) {
  if (!donation || !donation.razorpayOrderId) return { completed: false, inProgress: false, checked: false };
  if (donation.status === "completed") return { completed: true, inProgress: false, checked: false };
  // required lazily: payment.controller requires services that require this file
  const { createRazorpayInstance } = require("../controllers/payment.controller");
  const created = createRazorpayInstance(donation.paymentAccount);
  if (!created) return { completed: false, inProgress: false, checked: false };
  const res = await created.instance.orders.fetchPayments(donation.razorpayOrderId);
  const items = (res && res.items) || [];
  const captured = items.find((p) => p.status === "captured");
  if (captured) {
    await completeDonation({ orderId: donation.razorpayOrderId, paymentId: captured.id });
    return { completed: true, inProgress: false, checked: true };
  }
  return { completed: false, inProgress: items.some((p) => IN_PROGRESS.includes(p.status)), checked: true };
}

module.exports = { liveCheckDonationOrder };
