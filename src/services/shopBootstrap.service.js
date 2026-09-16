/**
 * Shared source of truth for the temple shop's default devotional
 * categories. Consumed at server boot (ensureDefaultShopCategories) so a
 * fresh/empty database ships with a usable catalog, and by the standalone
 * seed script (scripts/seed-shop-categories.js) for on-demand runs. Always
 * idempotent — missing slugs are inserted, existing ones are left untouched.
 */

const { shopCategoryModel } = require("../models/shopCategory.model");

// Matches the slugifier used by the product controller so seeded and
// admin-created categories behave identically.
const slugify = (name) =>
  String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const DEFAULT_SHOP_CATEGORIES = [
  {
    name: "Books & Bhagavad Gita",
    description:
      "Srila Prabhupada's books, Bhagavad Gita As It Is, and sacred spiritual literature for devotees and seekers alike.",
    sortOrder: 10,
  },
  {
    name: "Japa Mala & Tulasi",
    description:
      "Tulasi japa malas, bead counters, japa bags and aids for your daily chanting and meditation.",
    sortOrder: 20,
  },
  {
    name: "Incense & Dhoop",
    description:
      "Agarbatti, dhoop, camphor and altar incense that perfume your home and altar with devotion.",
    sortOrder: 30,
  },
  {
    name: "Deities & Murtis",
    description:
      "Beautiful murtis of Lord Krishna and the Lordships for a blissful home altar or temple setting.",
    sortOrder: 40,
  },
  {
    name: "Pooja Essentials",
    description:
      "Puja thali, brass lamps, bells, arati sets and everything needed for your daily worship.",
    sortOrder: 50,
  },
  {
    name: "Clothing (Dhoti & Kurta)",
    description:
      "Traditional dhoti-kurta sets, devotional kurtas and modest temple clothing.",
    sortOrder: 60,
  },
  {
    name: "Home Decor & Posters",
    description:
      "Framed paintings of the Lordships, wall posters, tapestries and spiritual home decor.",
    sortOrder: 70,
  },
  {
    name: "Prasadam & Sweets",
    description:
      "Sanctified sweets and prasadam lovingly prepared and blessed at the temple.",
    sortOrder: 80,
  },
  {
    name: "T-Shirts & Apparel",
    description:
      "Krishna-themed t-shirts, hoodies and casual devotional wear for all ages.",
    sortOrder: 90,
  },
  {
    name: "Music & Bhajans",
    description:
      "Kirtan albums, bhajan music, mantra CDs and devotional audio to elevate the heart.",
    sortOrder: 100,
  },
  {
    name: "Gifts & Gift Sets",
    description:
      "Hand-picked spiritual gift sets and offering kits for every auspicious occasion.",
    sortOrder: 110,
  },
  {
    name: "Sankirtan & Outreach",
    description:
      "Prasadam packets, leaflets and essentials supporting the temple's sankirtan and outreach seva.",
    sortOrder: 120,
  },
];

// Inserts any default category whose slug doesn't already exist. Safe to
// call every boot: a covered shop is a no-op (fast single query per slug),
// an empty shop gets its defaults. Returns { created, skipped }.
async function ensureDefaultShopCategories() {
  const createdNames = [];
  let skipped = 0;

  for (const c of DEFAULT_SHOP_CATEGORIES) {
    const slug = slugify(c.name);
    const existing = await shopCategoryModel.findOne({ slug }).lean();
    if (existing) {
      skipped += 1;
      continue;
    }
    await shopCategoryModel.create({ ...c, slug });
    createdNames.push(c.name);
  }

  if (createdNames.length > 0) {
    console.log(`Shop bootstrap: created ${createdNames.length} default category(ies), skipped ${skipped} existing.`);
  }
  return { created: createdNames.length, createdNames, skipped };
}

module.exports = { DEFAULT_SHOP_CATEGORIES, slugify, ensureDefaultShopCategories };