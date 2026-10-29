// Donations are numbered in two separate running series, because the admin has two separate donation lists:
//   "donations" - everything made through the /donations page family (Admin > /donations/admin)
//   "seva"      - every other page: seva pages, festival pages, manual entries (Admin > /admin/donations)
// The rule here matches the filters those two lists use (DONATIONS_PAGE_FILTER in donationAdmin.controller.js
// and EXCLUDE_DONATIONS_PAGE in donation.controller.js), so each list shows an unbroken 1, 2, 3 ... count.
const DONATIONS_DOMAIN_PATTERN = /^donations(\/|$)/;

const seriesOf = (donation) => {
  const sourcePage = donation && donation.sourcePage;
  if (typeof sourcePage === "string" && (DONATIONS_DOMAIN_PATTERN.test(sourcePage) || sourcePage === "/donations")) return "donations";
  if (donation && donation.type === "Donation") return "donations";
  return "seva";
};

// Name of the counter (utils/counter.js) that holds the last number handed out in a series.
const counterName = (series) => `donation:${series}`;

module.exports = { seriesOf, counterName, DONATIONS_DOMAIN_PATTERN };
