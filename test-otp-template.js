// Verifies the donor-login "otp" WhatsApp template (AUTHENTICATION category)
// end to end and prints the RAW Flaxxa response so we can see exactly why
// Meta rejects a send (message_wamid null).
//
//   node test-otp-template.js 919876543210
//
// Requires WAPI_TOKEN in .env, like the other test-*.js scripts here.

require("dotenv").config();

const WAPI_BASE = "https://wapi.flaxxa.com";

async function main() {
  const phone = process.argv[2];
  if (!phone) {
    console.error("Usage: node test-otp-template.js <phone>");
    process.exit(1);
  }
  if (!process.env.WAPI_TOKEN) {
    console.error("WAPI_TOKEN is not set in .env");
    process.exit(1);
  }

  const templateName = process.env.WAPI_OTP_TEMPLATE_NAME || "otp";
  const language = process.env.WAPI_OTP_TEMPLATE_LANG || "en";
  const otpCode = String(Math.floor(100000 + Math.random() * 900000));

  const components = [
    // Auth templates: Meta rewrites the copy-code button to a URL button at
    // approval time, so the send payload must be sub_type "url" with the
    // SAME code passed in BOTH the body and the button parameters.
    { type: "body", parameters: [{ type: "text", text: otpCode }] },
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: otpCode }],
    },
  ];

  console.log("template  :", templateName);
  console.log("language  :", language);
  console.log("otp code  :", otpCode);
  console.log("components:", JSON.stringify(components));
  console.log("");

  const res = await fetch(`${WAPI_BASE}/api/v1/sendtemplatemessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: process.env.WAPI_TOKEN,
      phone,
      template_name: templateName,
      template_language: language,
      components,
    }),
  });

  const raw = await res.text();
  console.log("HTTP status:", res.status);
  console.log("RAW RESPONSE:", raw);

  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    console.error("(response is not JSON)");
    process.exit(1);
  }

  if (parsed.message_wamid) {
    console.log("DELIVERED. wamid:", parsed.message_wamid);
  } else {
    console.error("Meta REJECTED the send (message_wamid is null). Full body above.");
    process.exit(1);
  }
}

main();