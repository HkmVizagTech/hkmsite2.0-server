// Iterative test to find what breaks the pending_seva_notice template.
// Tests each component in isolation and combination.

require("dotenv").config();

const WAPI_BASE = "https://wapi.flaxxa.com";

async function send(label, components) {
  const token = process.env.WAPI_TOKEN;
  const phone = "919234989686";
  const templateName = process.env.WAPI_PENDING_TEMPLATE_NAME || "pending_seva_notice";
  const templateLang = process.env.WAPI_TEMPLATE_LANG || "en";

  console.log(`\n--- TEST: ${label} ---`);
  console.log("Components:", JSON.stringify(components, null, 2));

  try {
    const res = await fetch(`${WAPI_BASE}/api/v1/sendtemplatemessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        phone,
        template_name: templateName,
        template_language: templateLang,
        components,
      }),
    });

    const raw = await res.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }

    console.log("Response:", JSON.stringify(parsed));
    return parsed;
  } catch (err) {
    console.error("Error:", err.message);
    return null;
  }
}

async function runTests() {
  const testImage = "https://pub-32ade8e1209149f980ffe2aa4ddc6c99.r2.dev/media-library/1786528614525-1786528613759-ChatGPTImageAug122026022735PM.webp";

  // Test 1: Body only (no header, no button)
  await send("BODY ONLY (no header, no button)", [
    {
      type: "body",
      parameters: [
        { type: "text", text: "Test Devotee" },
        { type: "text", text: "100" },
        { type: "text", text: "Sqft Seva" },
        { type: "text", text: "Once payment is completed, the amount will be allocated towards Sqft Seva" },
      ],
    },
  ]);

  // Test 2: Body + Button (no header)
  await send("BODY + BUTTON (no header)", [
    {
      type: "body",
      parameters: [
        { type: "text", text: "Test Devotee" },
        { type: "text", text: "100" },
        { type: "text", text: "Sqft Seva" },
        { type: "text", text: "Once payment is completed, the amount will be allocated towards Sqft Seva" },
      ],
    },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: "sqft-seva-campaign" }],
    },
  ]);

  // Test 3: Header + Body (no button)
  await send("HEADER + BODY (no button)", [
    {
      type: "header",
      parameters: [{ type: "image", image: { link: testImage } }],
    },
    {
      type: "body",
      parameters: [
        { type: "text", text: "Test Devotee" },
        { type: "text", text: "100" },
        { type: "text", text: "Sqft Seva" },
        { type: "text", text: "Once payment is completed, the amount will be allocated towards Sqft Seva" },
      ],
    },
  ]);

  // Test 4: Full (header + body + button) — the original
  await send("FULL (header + body + button)", [
    {
      type: "header",
      parameters: [{ type: "image", image: { link: testImage } }],
    },
    {
      type: "body",
      parameters: [
        { type: "text", text: "Test Devotee" },
        { type: "text", text: "100" },
        { type: "text", text: "Sqft Seva" },
        { type: "text", text: "Once payment is completed, the amount will be allocated towards Sqft Seva" },
      ],
    },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: "sqft-seva-campaign" }],
    },
  ]);

  // Test 5: Body only with 3 params (maybe the template only has 3 body vars?)
  await send("BODY ONLY with 3 params", [
    {
      type: "body",
      parameters: [
        { type: "text", text: "Test Devotee" },
        { type: "text", text: "100" },
        { type: "text", text: "Sqft Seva" },
      ],
    },
  ]);

  // Test 6: Body only with 2 params
  await send("BODY ONLY with 2 params", [
    {
      type: "body",
      parameters: [
        { type: "text", text: "Test Devotee" },
        { type: "text", text: "100" },
      ],
    },
  ]);

  // Test 7: Completely empty components
  await send("EMPTY components", []);
}

runTests();
