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
//   {{3}} seva name, with the campaign it came from in brackets
//   {{4}} allocation sentence (plain seva name, no campaign — see below)
//   button URL suffix (Gupshup only) — appended to
//         https://www.harekrishnavizag.org/
//
// Campaign context lives in {{3}} only, deliberately. Seva names on festival
// pages are generic ("Abhisheka Seva", "Vastrabharana") and a donor who
// abandoned a checkout during Janmashtami will not recognise a bare seva name
// out of context — but the template already repeats the seva name in {{4}},
// so putting the campaign in both places would say "Sri Krishna Janmashtami"
// twice in a four-line message. {{3}} is the more prominent slot, so it wins.

const SITE_URL = (process.env.FRONTEND_URL || "https://www.harekrishnavizag.org").replace(/\/+$/, "");

// A parameter longer than this is more likely to look broken on a phone than
// to be helpful, so an over-long "seva (campaign)" falls back to the bare seva
// name. (Meta's own hard limit on a body parameter is far higher; this is a
// readability limit, not a protocol one.)
const MAX_SEVA_FIELD_LENGTH = Number(process.env.PENDING_MAX_SEVA_FIELD_LENGTH || 120);

// Letters and digits only, so that punctuation, casing and spacing differences
// ("Sri Krishna Janmashtami" vs "sri-krishna janmashtami") don't defeat the
// duplicate check below.
function normalizeForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Words that carry no identifying weight in a campaign name — every seva on
// the site could match on them, so they must not be what decides that a seva
// name "already mentions" its campaign.
const GENERIC_WORDS = new Set(["seva", "sevas", "campaign", "donation", "festival", "utsava"]);

// The words that actually identify a campaign: "Sri Krishna Janmashtami" ->
// ["krishna", "janmashtami"]. Short words ("sri", "of", "the") are dropped
// along with the generic ones.
function significantWords(value) {
  return normalizeForCompare(value)
    .split(" ")
    .filter((word) => word.length >= 5 && !GENERIC_WORDS.has(word));
}

/**
 * Appends the campaign a donation came from to its seva name:
 *   ("Abhisheka Seva", "Sri Krishna Janmashtami")
 *     -> "Abhisheka Seva (Sri Krishna Janmashtami)"
 *
 * Returns the seva name unchanged when there is no campaign, when the seva
 * name already names the campaign, or when the combined value would be too
 * long to read comfortably on a phone.
 *
 * "Already names it" is a word-level test, not a substring one: several
 * festival sevas are stored as "Janmashtami Abhisheka", which shares no full
 * substring with "Sri Krishna Janmashtami" but would still read as a stutter
 * if we appended the campaign. One shared identifying word is enough to skip.
 */
function withCampaignContext(sevaName, campaignLabel) {
  const seva = String(sevaName || "").trim();
  const label = String(campaignLabel || "").trim();
  if (!seva || !label) return seva;

  const sevaKey = normalizeForCompare(seva);
  const labelKey = normalizeForCompare(label);
  if (!sevaKey || !labelKey) return seva;
  if (sevaKey.includes(labelKey) || labelKey.includes(sevaKey)) return seva;

  const sevaWords = new Set(normalizeForCompare(seva).split(" "));
  if (significantWords(label).some((word) => sevaWords.has(word))) return seva;

  const combined = `${seva} (${label})`;
  return combined.length > MAX_SEVA_FIELD_LENGTH ? seva : combined;
}

// Master switch for the ?seva=…&amount=… deep link. Set PENDING_DEEP_LINK to
// "false" to fall back to bare page links everywhere — the escape hatch if a
// provider ever objects to a query string in a template URL button.
const DEEP_LINK_ENABLED = String(process.env.PENDING_DEEP_LINK || "true") !== "false";

/**
 * Appends deep-link params to a page path:
 *   ("janmashtami", { seva: "abhisheka", amount: "2100" })
 *     -> "janmashtami?seva=abhisheka&amount=2100"
 *
 * Empty and blank values are dropped, so a half-resolved query can never
 * produce a trailing "?seva=" that the page would then fail to match.
 */
function appendQuery(path, query) {
  if (!DEEP_LINK_ENABLED || !query || typeof query !== "object") return path;

  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    const value = String(rawValue == null ? "" : rawValue).trim();
    if (value) params.set(key, value);
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * @param {object} input
 * @param {string} input.donorName
 * @param {number|string} input.amount
 * @param {string} [input.sevaName]
 * @param {string} [input.campaignLabel] - festival/campaign the donation came
 *        from, e.g. "Sri Krishna Janmashtami". Shown in {{3}} only.
 * @param {string} [input.linkSuffix] - seva page path, e.g. "brick-seva-campaign"
 * @param {object} [input.linkQuery] - deep-link params for pages that support
 *        them, e.g. { seva: "abhisheka", amount: "2100" }. Empty values are
 *        dropped. Ignored when PENDING_DEEP_LINK is "false".
 * @param {boolean} [input.includeLinkInBody] - true for Flaxxa (no usable button)
 * @returns {{name: string, amount: string, seva: string, sevaPlain: string, allocation: string, suffix: string, link: string}}
 */
function buildPendingFields({
  donorName,
  amount,
  sevaName,
  campaignLabel,
  linkSuffix,
  linkQuery,
  includeLinkInBody = false,
}) {
  const path =
    String(linkSuffix || "donate")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "") || "donate";

  // suffix carries the query string too, because on Gupshup it is the value of
  // the template's dynamic URL button ("https://…/" + {{1}}) — keeping the
  // query here is what makes the button deep-link as well as the body text.
  const suffix = appendQuery(path, linkQuery);

  const sevaPlain = String(sevaName || "").trim() || "your seva";
  // {{3}} — carries the campaign context.
  const seva = withCampaignContext(sevaPlain, campaignLabel);
  const link = `${SITE_URL}/${suffix}`;

  // WhatsApp rejects template parameters containing newlines, tabs, or runs of
  // 4+ spaces — keep every value on one line.
  //
  // {{4}} uses the PLAIN seva name: the campaign is already stated in {{3}},
  // and repeating it here reads as a copy-paste error rather than emphasis.
  const allocation = includeLinkInBody
    ? `Once payment is completed, the amount will be allocated towards ${sevaPlain}. You can complete it here: ${link}`
    : `Once payment is completed, the amount will be allocated towards ${sevaPlain}`;

  return {
    name: String(donorName || "Devotee").trim() || "Devotee",
    amount: String(amount),
    seva,
    sevaPlain,
    allocation,
    suffix,
    link,
  };
}

module.exports = { buildPendingFields, withCampaignContext, appendQuery, SITE_URL };
