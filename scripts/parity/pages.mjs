import { discover } from "./lib.mjs";

const [A, B] = process.argv.slice(2);
const ctx = await discover(process.env.SRC_MONGO_URI || "mongodb://127.0.0.1:27018/test");
const paths = [
  "/",
  "/about",
  "/contact",
  "/events",
  "/gallery",
  "/festival",
  "/donations",
  "/shop",
  "/volunteer",
  "/vaikuntham",
  "/blogs",
  "/blogs?category=Krishna%20Katha",
  "/vaishnav-calendar",
  "/csr",
  "/subhojanam",
  "/chaturmas",
  "/janmashtami",
  "/radhashtami",
  "/govardhan-puja",
  "/pitru-paksha",
  "/vijayadashami",
  "/ekadashi",
  "/shayani-ekadashi",
  "/special-occasion",
  "/sqft-seva-campaign",
  "/brick-seva-campaign",
  "/gau-seva",
  "/anna-daan-seva",
  "/gita-daan-seva",
  "/alankara-vastra-seva",
  "/donate/general",
  "/daily-schedule",
  "/founder",
  "/iskcon-vizag-temple",
  "/privacy-policy",
  "/terms-and-conditions",
  "/refund-policy",
  ctx.blog && `/blogs/${ctx.blog.slug}`,
  ctx.event && `/events/${ctx.event._id}`,
  ctx.festival && `/festivals/${ctx.festival.slug}`,
  ctx.showcase && `/festivals/${ctx.showcase.slug}`,
  ctx.product && `/shop/${ctx.product.slug}`,
  ctx.campaigner && `/sqft-seva-campaign/${ctx.campaigner.slug}`,
].filter(Boolean);

const mask = (t) => t.replace(/localhost:310[01]/g, "SITE").replace(/localhost:960[01]/g, "API");
const textOf = (raw) => {
  const html = mask(raw);
  const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .join("|");
  const meta = [...html.matchAll(/<(title|meta [^>]*(?:name|property)="[^"]+"[^>]*)>?([^<]*)/g)]
    .map((m) => m[0].replace(/\s+/g, " "))
    .join("|");
  const body = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return { ld, meta, body };
};
const get = async (base, p) => {
  try {
    const r = await fetch(base + p, { redirect: "manual" });
    return { status: r.status, ...textOf(await r.text()) };
  } catch (e) {
    return { status: 0, ld: "", meta: "", body: e.message };
  }
};

let ok = 0;
const bad = [];
for (const p of paths) {
  const [a, b] = [await get(A, p), await get(B, p)];
  const same = a.status === b.status && a.body === b.body && a.ld === b.ld && a.meta === b.meta;
  if (same) ok++;
  else bad.push({ p, a, b });
  console.log(same ? "ok  " : "DIFF", a.status, b.status, p);
}
console.log(`\npages identical: ${ok}/${paths.length}`);
for (const { p, a, b } of bad) {
  const i = [...a.body].findIndex((c, k) => c !== b.body[k]);
  console.log(
    `\n${p}: status ${a.status}/${b.status}  firstDiff@${i}\n  A: ...${a.body.slice(Math.max(0, i - 40), i + 80)}\n  B: ...${b.body.slice(Math.max(0, i - 40), i + 80)}`
  );
}
process.exit(bad.length ? 1 : 0);
