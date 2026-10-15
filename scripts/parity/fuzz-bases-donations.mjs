// Valid base bodies for the donations slice (scripts/parity/fuzz.mjs --bases=...). Getters give every request a fresh UTR.
let n = 0;
const utr = () => `FZUTR${Date.now().toString(36)}${n++}`;
const withUtr = (extra) => ({
  get utrNumber() {
    return utr();
  },
  ...extra,
});

export default {
  "POST /donations/": { donorName: "FZ Donor", amount: 100, donorMobile: "9000000001" },
  "POST /donations/manual": withUtr({
    donorName: "FZ Manual",
    amount: 50,
    donorMobile: "9000000002",
    manualPaymentMode: "cash",
  }),
  "PUT /donations/:id": { message: "fuzz" },
  "PUT /donations/:id/prasadam-status": { prasadamStatus: "pending" },
  "PUT /donations/:id/receipt-number": { receiptNumber: "HKMI|FZ|1" },
  "PUT /donations/:id/manual-complete": withUtr({ manualPaymentMode: "upi" }),
  "POST /donations/upi-dismiss": { donationId: "000000000000000000000000" },
  "PUT /donations-admin/transactions/:id/prasadam-status": { prasadamStatus: "pending" },
  "PUT /donations-admin/transactions/:id/receipt-number": { receiptNumber: "HKMI|FZ|2" },
  "POST /donations-admin/manual-complete": { donationId: "000000000000000000000000", razorpayPaymentId: "pay_fz" },
  "PATCH /donor/me": { name: "Fuzz Donor" },
  "POST /donor/issues": { subject: "fuzz subject", message: "fuzz message" },
  "PUT /api/internal/drm/donors/by-mobile/:mobile/profile": { name: "Fuzz Donor" },
  "POST /api/internal/drm/donations/offline": withUtr({
    donorName: "FZ Offline",
    amount: 75,
    donorMobile: "9000000003",
    manualPaymentMode: "cash",
  }),
  "PUT /api/internal/drm/donations/:id/prasadam-status": { status: "pending" },
};
