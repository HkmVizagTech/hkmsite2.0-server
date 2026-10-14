const SITE_URL = (process.env.FRONTEND_URL || "https://www.harekrishnavizag.org").replace(/\/+$/, "");

const MAX_SEVA_FIELD_LENGTH = Number(process.env.PENDING_MAX_SEVA_FIELD_LENGTH || 120);

function normalizeForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const GENERIC_WORDS = new Set(["seva", "sevas", "campaign", "donation", "festival", "utsava"]);

function significantWords(value) {
  return normalizeForCompare(value)
    .split(" ")
    .filter((word) => word.length >= 5 && !GENERIC_WORDS.has(word));
}

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

const DEEP_LINK_ENABLED = String(process.env.PENDING_DEEP_LINK || "true") !== "false";

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

  const suffix = appendQuery(path, linkQuery);

  const sevaPlain = String(sevaName || "").trim() || "your seva";
  // {{3}} — carries the campaign context.
  const seva = withCampaignContext(sevaPlain, campaignLabel);
  const link = `${SITE_URL}/${suffix}`;

  const allocation = includeLinkInBody
    ? `Once payment is completed, the amount will be allocated towards ${sevaPlain}. You can complete it here: ${link}`
    : `Once payment is completed, the amount will be allocated towards ${sevaPlain}`;

  return {
    name: String(donorName || "Donor").trim() || "Donor",
    amount: String(amount),
    seva,
    sevaPlain,
    allocation,
    suffix,
    link,
  };
}

export { buildPendingFields, withCampaignContext, appendQuery, SITE_URL };
