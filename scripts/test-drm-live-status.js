// DRM's recurring snapshot carries what Razorpay itself says about each subscription, so DRM can count
// what this site's Monthly Seva screen counts. No database and no Razorpay: the live list is a stand-in.
//   node scripts/test-drm-live-status.js
const path = require("path");
const adminPath = require.resolve(path.join(__dirname, "../src/controllers/subscriptionsAdmin.controller.js"));
let live = {};
let boom = false;
// Stand in for the real module BEFORE the controller under test loads it.
require.cache[adminPath] = {
  id: adminPath, filename: adminPath, loaded: true,
  exports: { liveSubscriptions: async (account) => { if (boom) throw new Error("razorpay down"); return live[account] ?? null; } },
};
const { withLiveStatus, collapseSubscriptions } = require("../src/controllers/internal.controller");

let failures = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};
const donation = (sub, status, day, extra = {}) => ({ isRecurring: true, subscriptionId: sub, status, amount: 500, createdAt: new Date(`2026-10-${day}T10:00:00Z`), paymentAccount: "default", ...extra });

(async () => {
  console.log("\n--- the entry carries the account ---");
  const subs = () => collapseSubscriptions([donation("sub_a", "completed", 25), donation("sub_b", "completed", 24, { paymentAccount: "second" }), donation("sub_c", "completed", 23)]);
  check("each subscription says which Razorpay account it is in", subs().map((s) => [s.subscriptionId, s.paymentAccount]), [["sub_a", "default"], ["sub_b", "second"], ["sub_c", "default"]]);

  console.log("\n--- Razorpay's live state is added ---");
  live = {
    default: { sub_a: { status: "active", paidCount: 4, nextChargeAt: new Date("2026-11-25") }, sub_c: { status: "cancelled", paidCount: 3, nextChargeAt: null } },
    second: { sub_b: { status: "halted", paidCount: 2, nextChargeAt: null } },
  };
  const out = await withLiveStatus(subs());
  check("active stays active, with its next charge", [out[0].liveStatus, out[0].paidCount, out[0].nextChargeAt.toISOString().slice(0, 10)], ["active", 4, "2026-11-25"]);
  check("one in another account is found in that account", [out[1].subscriptionId, out[1].liveStatus], ["sub_b", "halted"]);
  check("a cancelled one says cancelled even though its latest charge was paid", [out[2].subscriptionId, out[2].status, out[2].liveStatus], ["sub_c", "completed", "cancelled"]);

  console.log("\n--- when Razorpay does not know it, or cannot be reached ---");
  live = { default: {} };
  let o = await withLiveStatus(subs());
  check("an unknown subscription simply has no live state", o.every((s) => s.liveStatus === undefined), true);
  boom = true;
  o = await withLiveStatus(subs());
  check("an unreachable Razorpay never breaks the snapshot - entries go out unchanged", o.length === 3 && o.every((s) => s.liveStatus === undefined), true);
  boom = false;
  check("no subscriptions: nothing to do", await withLiveStatus([]), []);

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log("\nall passed");
  process.exit(0);
})();
