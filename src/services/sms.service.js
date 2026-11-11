// OTP text messages through the Instaalerts (Karix) JSON API.
// The message must match the DLT-registered template word for word; only the OTP changes.
// Needs SMS_API_KEY (never commit it). SMS_SENDER defaults to the registered sender ID HKVCC.
const axios = require("axios");

const URL = process.env.SMS_API_URL || "https://japi.instaalerts.zone/httpapi/JsonReceiver";
const otpText = (otp) =>
  `${otp} is your OTP (One Time Password) for logging into the vaikuntham app. For security reasons, do not share the OTP. -Hare Krishna Movement`;

const isSmsConfigured = () => !!process.env.SMS_API_KEY;

/** Sends a login OTP by SMS to a 10-digit Indian mobile. Throws if the provider does not accept it. */
async function sendOtpSms(mobile10, otp) {
  const key = process.env.SMS_API_KEY;
  if (!key) throw new Error("SMS is not configured (SMS_API_KEY missing)");
  const dest = `91${String(mobile10).replace(/\D/g, "").slice(-10)}`;
  const res = await axios.post(
    URL,
    {
      ver: "1.0",
      key,
      encrpt: "0",
      messages: [{ dest: [dest], text: otpText(otp), send: process.env.SMS_SENDER || "HKVCC", type: "PM" }],
    },
    { timeout: 15000, headers: { "Content-Type": "application/json" }, validateStatus: () => true }
  );
  const body = res.data || {};
  // A successful submit returns HTTP 200 with status.code "200" (and an ackid). Anything else is a failure.
  const code = String((body.status && body.status.code) || "");
  if (res.status !== 200 || (code && code !== "200")) {
    const desc = (body.status && body.status.desc) || JSON.stringify(body).slice(0, 200);
    throw new Error(`SMS provider rejected the message (${res.status} ${code}): ${desc}`);
  }
  return { ackid: body.ackid || (body.status && body.status.ackid) || null, raw: body };
}

module.exports = { sendOtpSms, isSmsConfigured, otpText };
