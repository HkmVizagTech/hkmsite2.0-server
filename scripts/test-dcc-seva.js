// Checks the DCC seva mapping. Run: node scripts/test-dcc-seva.js
// Nothing here touches a database or DCC.
const { buildDccPayload, resolveSevaMapping, cleanDccSeva } = require("../src/services/dcc.service");

let failures = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return console.log(`  ok   ${label}`);
  failures++;
  console.error(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`);
};
const pick = (p) => ({ cat: p.sevaCategory, sub: p.sevaSubCategory, code: p.sevaSubCategoryCode });
const base = { donorName: "T", donorMobile: "9000000000", amount: 100, manualPaymentMode: "cash", utrNumber: "u1" };

console.log("\n--- cleanDccSeva ---");
check("numbers and a sub code id", cleanDccSeva({ category: 3, subCategory: 5, code: 1 }), { sevaCategory: 3, sevaSubCategory: 5, sevaSubCategoryCode: 1 });
check("strings of digits are accepted", cleanDccSeva({ category: "3", subCategory: "5", code: "1" }), { sevaCategory: 3, sevaSubCategory: 5, sevaSubCategoryCode: 1 });
check("a Seva Code text", cleanDccSeva({ category: 2, subCategory: 103, code: "BSC" }), { sevaCategory: 2, sevaSubCategory: 103, sevaSubCategoryCode: "BSC" });
check("a code with brackets and spaces, as in the list", cleanDccSeva({ category: 10, subCategory: 40, code: "MNS-VDA (BFP)" })?.sevaSubCategoryCode, "MNS-VDA (BFP)");
check("missing -> null", cleanDccSeva({ category: 3, subCategory: 5 }), null);
check("zero / negative / fractions / text ids -> null", [cleanDccSeva({ category: 0, subCategory: 5, code: 1 }), cleanDccSeva({ category: 3, subCategory: -1, code: 1 }), cleanDccSeva({ category: 3.5, subCategory: 5, code: 1 }), cleanDccSeva({ category: "x", subCategory: 5, code: 1 })], [null, null, null, null]);
check("a code that is not plain text -> null", [cleanDccSeva({ category: 3, subCategory: 5, code: "<script>" }), cleanDccSeva({ category: 3, subCategory: 5, code: {} }), cleanDccSeva({ category: 3, subCategory: 5, code: "x".repeat(41) })], [null, null, null]);

console.log("\n--- what DCC is sent ---");
const website = { ...base, type: "BRICK", sourcePage: "/brick-seva-campaign", sevaName: "Brick Seva" };
const beforeGuess = pick(buildDccPayload(website, "pay_1"));
check("a website brick donation: the old guess, unchanged (24 / 118 / MNSO-B)", beforeGuess, { cat: 24, sub: 118, code: "MNSO-B" });
check("it is exactly what resolveSevaMapping gives", beforeGuess, { cat: resolveSevaMapping(website).sevaCategory, sub: resolveSevaMapping(website).sevaSubCategory, code: resolveSevaMapping(website).sevaSubCategoryCode });
const drmOld = { ...base, type: "Deepotsava - Annadana Seva", sourcePage: "admin-manual", sevaName: "Deepotsava - Annadana Seva" };
check("a DRM receipt with no seva values: the old guess (annadana -> ANGE)", pick(buildDccPayload(drmOld, "u1")), { cat: 1, sub: 1, code: "ANGE" });
const chosen = cleanDccSeva({ category: 3, subCategory: 5, code: 1 });
check("the same receipt with the picked seva passed in: exactly that seva", pick(buildDccPayload(drmOld, "u1", chosen)), { cat: 3, sub: 5, code: 1 });
const stored = { ...drmOld, dccSevaCategory: 3, dccSevaSubCategory: 5, dccSevaSubCategoryCode: "1" };
check("on a retry, the seva kept on the donation is used (code stored as text)", pick(buildDccPayload(stored, "u1")), { cat: 3, sub: 5, code: 1 });
const brickStored = { ...base, sourcePage: "admin-manual", sevaName: "Brick Seva", dccSevaCategory: 2, dccSevaSubCategory: 103, dccSevaSubCategoryCode: "BSC" };
check("Brick Seva from the list: 2 / 103 / BSC", pick(buildDccPayload(brickStored, "u1")), { cat: 2, sub: 103, code: "BSC" });
check("junk stored values are ignored, the old guess is used", pick(buildDccPayload({ ...drmOld, dccSevaCategory: "abc", dccSevaSubCategory: 5, dccSevaSubCategoryCode: "1" }, "u1")), { cat: 1, sub: 1, code: "ANGE" });
check("everything else in the DCC request is untouched", (({ donorName, donorPhone, amount, accountType, modeOfPayment, gatewayPaymentId }) => ({ donorName, donorPhone, amount, accountType, modeOfPayment, gatewayPaymentId }))(buildDccPayload(drmOld, "u1", chosen)), { donorName: "T", donorPhone: "9000000000", amount: "100", accountType: 4, modeOfPayment: 1, gatewayPaymentId: "u1" });

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log("\nall passed");
process.exit(0);
