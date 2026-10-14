import { completeDonation } from "./paymentCompletion.service.js";
import { createRazorpayInstance } from "../controllers/payment.controller.js";

const IN_PROGRESS = ["created", "authorized"];
const NOT_CHECKED = { completed: false, inProgress: false, checked: false };

export const liveCheckDonationOrder = async (donation) => {
  if (!donation?.razorpayOrderId) return NOT_CHECKED;
  if (donation.status === "completed") return { completed: true, inProgress: false, checked: false };

  const created = createRazorpayInstance(donation.paymentAccount);
  if (!created) return NOT_CHECKED;

  const { items = [] } = (await created.instance.orders.fetchPayments(donation.razorpayOrderId)) ?? {};
  const captured = items.find((p) => p.status === "captured");
  if (captured) {
    await completeDonation({ orderId: donation.razorpayOrderId, paymentId: captured.id });
    return { completed: true, inProgress: false, checked: true };
  }
  return { completed: false, inProgress: items.some((p) => IN_PROGRESS.includes(p.status)), checked: true };
};
