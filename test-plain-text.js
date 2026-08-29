// Test: plain text message to verify token + phone work at all.

require("dotenv").config();

async function test() {
  const token = process.env.WAPI_TOKEN;
  const phone = "919234989686";

  console.log("Sending plain text message...");
  console.log("Token:", token ? token.substring(0, 8) + "..." : "NOT SET");
  console.log("Phone:", phone);

  try {
    const res = await fetch("https://wapi.flaxxa.com/api/v1/sendmessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        phone,
        message: "Hare Krishna! This is a test message from HkmVizag server to verify the WAPI connection is working.",
      }),
    });

    const raw = await res.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }

    console.log("HTTP Status:", res.status);
    console.log("Response:", JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();
