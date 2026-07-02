const { donationModel } = require("../models/donation.model");

const DCC_API_URL = process.env.DCC_API_URL || "https://vhkmsurabhi.com/api/socialmedia/addDonation";

const DCC_PAYMENT_MODES = {
  online: Number(process.env.DCC_MODE_ONLINE || 3),
  cash: Number(process.env.DCC_MODE_CASH || 1),
  cheque: Number(process.env.DCC_MODE_CHEQUE || 2),
  upi: Number(process.env.DCC_MODE_UPI || 3),
  bank: Number(process.env.DCC_MODE_BANK || 4),
};

const formatDateForDcc = (value) => {
  const date = value ? new Date(value) : new Date();
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
};

const compact = (parts) => parts.map((part) => String(part || "").trim()).filter(Boolean);

const buildFullAddress = (prasadamAddress) => {
  if (!prasadamAddress) return null;
  const value = compact([
    prasadamAddress.doorNo,
    prasadamAddress.house,
    prasadamAddress.street,
    prasadamAddress.area,
    prasadamAddress.city,
    prasadamAddress.state,
    prasadamAddress.pincode,
    prasadamAddress.country,
  ]).join(", ");
  return value || null;
};

const buildDccPayload = (donation, gatewayPaymentId) => ({
  donorName: donation.donorName,
  donorPhone: donation.donorMobile || "",
  donorEmail: donation.donorEmail || null,
  gender: null,
  address: {
    fullAddress: buildFullAddress(donation.prasadamAddress),
    state: donation.prasadamAddress?.state || null,
    city: donation.prasadamAddress?.city || null,
    pinCode: donation.prasadamAddress?.pincode || null,
  },
  PAN: donation.panNumber || null,
  amount: String(Number(donation.amount)),
  accountType: Number(process.env.DCC_ACCOUNT_TYPE || 4),
  sevaCategory: Number(process.env.DCC_SEVA_CATEGORY || 1),
  sevaSubCategory: Number(process.env.DCC_SEVA_SUBCATEGORY || 1),
  sevaSubCategoryCode: process.env.DCC_SEVA_SUBCATEGORY_CODE || null,
  modeOfPayment: DCC_PAYMENT_MODES.online,
  gatewayPaymentId: gatewayPaymentId || donation.razorpayPaymentId || donation.transactionId || null,
  transactionDate: formatDateForDcc(donation.date || donation.createdAt || new Date()),
  enrolledBy: Number(process.env.DCC_ENROLLED_BY || 36),
});

const isDccConfigured = () => Boolean(process.env.DCC_API_KEY);

async function postToDcc(payload) {
  const response = await fetch(DCC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "DCC-Api-Key": process.env.DCC_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (error) {
    parsed = { raw };
  }

  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && parsed.Message
      ? parsed.Message
      : raw || `DCC request failed with status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.response = parsed;
    throw err;
  }

  return parsed;
}

async function syncDonationToDcc(donationOrId, gatewayPaymentId) {
  const donation = typeof donationOrId === "object" && donationOrId !== null
    ? donationOrId
    : await donationModel.findById(donationOrId);

  if (!donation) return { ok: false, skipped: true, reason: "donation_not_found" };
  if (!isDccConfigured()) return { ok: false, skipped: true, reason: "dcc_not_configured" };
  if (donation.receiptNumber || donation.dccSyncStatus === "synced") {
    return { ok: true, skipped: true, reason: "already_synced" };
  }

  const lock = await donationModel.findOneAndUpdate(
    {
      _id: donation._id,
      receiptNumber: { $in: [null, ""] },
      dccSyncStatus: { $ne: "syncing" },
    },
    {
      dccSyncStatus: "syncing",
      dccLastAttemptAt: new Date(),
    },
    { new: true }
  );

  if (!lock) {
    const latest = await donationModel.findById(donation._id);
    if (latest?.receiptNumber || latest?.dccSyncStatus === "synced") {
      return { ok: true, skipped: true, reason: "already_synced" };
    }
    return { ok: false, skipped: true, reason: "sync_in_progress" };
  }

  const payload = buildDccPayload(lock, gatewayPaymentId);

  try {
    const dccResponse = await postToDcc(payload);
    const receiptNumber = dccResponse?.ReceiptNumber || null;

    await donationModel.findByIdAndUpdate(lock._id, {
      dccSyncStatus: "synced",
      dccSyncedAt: new Date(),
      dccSyncError: null,
      dccPayload: payload,
      dccResponse,
      ...(receiptNumber
        ? {
            receiptNumber,
            receiptGeneratedAt: new Date(),
          }
        : {}),
    });

    return { ok: true, dccResponse, receiptNumber };
  } catch (error) {
    await donationModel.findByIdAndUpdate(lock._id, {
      dccSyncStatus: "failed",
      dccSyncError: error && error.message ? error.message : String(error),
      dccPayload: payload,
      dccResponse: error && error.response ? error.response : null,
    });

    console.error("DCC sync failed", lock._id.toString(), error && error.stack ? error.stack : error);
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  DCC_PAYMENT_MODES,
  buildDccPayload,
  isDccConfigured,
  syncDonationToDcc,
};
