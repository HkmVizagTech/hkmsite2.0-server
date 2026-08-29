// src/services/pendingMessage.util.js
//
// Single source of truth for the pending-transaction message's variable
// values, shared by both providers so the two paths can never drift apart:
//
//   Flaxxa  (whatsapp.service.js) — cannot fill a {{1}} in a button URL, so
//           the seva link is appended to the {{4}} sentence in the body.
//   Gupshup (gupshup.service.js)  — fills the button URL properly, so {{4}}
//           stays a clean sentence and the link goes to the button instead.
//
// Template variable map (both providers, same approved wording):
//   {{1}} donor name
//   {{2}} amount
//   {{3}} seva name
//   {{4}} allocation sentence
//   button URL suffix (Gupshup only) — appended to
//         https://www.harekrishnavizag.org/

const SITE_URL = (process.env.FRONTEND_URL || "https://www.harekrishnavizag.org").replace(/\/+$/, "");

/**
 * @param {object} input
 * @param {string} input.donorName
 * @param {number|string} input.amount
 * @param {string} [input.sevaName]
 * @param {string} [input.linkSuffix] - seva page path, e.g. "brick-seva-campaign"
 * @param {boolean} [input.includeLinkInBody] - true for Flaxxa (no usable button)
 * @returns {{name: string, amount: string, seva: string, allocation: string, suffix: string, link: string}}
 */
function buildPendingFields({ donorName, amount, sevaName, linkSuffix, includeLinkInBody = false }) {
  const suffix =
    String(linkSuffix || "donate")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "") || "donate";

  const seva = sevaName || "your seva";
  const link = `${SITE_URL}/${suffix}`;

  // WhatsApp rejects template parameters containing newlines, tabs, or runs of
  // 4+ spaces — keep every value on one line.
  const allocation = includeLinkInBody
    ? `Once payment is completed, the amount will be allocated towards ${seva}. You can complete it here: ${link}`
    : `Once payment is completed, the amount will be allocated towards ${seva}`;

  return {
    name: String(donorName || "Devotee").trim() || "Devotee",
    amount: String(amount),
    seva,
    allocation,
    suffix,
    link,
  };
}

module.exports = { buildPendingFields, SITE_URL };
