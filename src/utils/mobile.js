// Cleans a donor's mobile number down to 10 digits. Mirrors cleanMobile() in the client (lib/phone.ts).
// A full international form (+91 / 91 / 0 / 091 / 0091 followed by 10 digits) has its prefix removed first; a
// number that really starts with 91 is left alone, because the country code only counts at exactly 12 digits.
const cleanMobile = (raw) => {
  let d = String(raw == null ? "" : raw).replace(/\D/g, "");
  if (d.length === 14 && d.startsWith("0091")) d = d.slice(4);
  else if (d.length === 13 && d.startsWith("091")) d = d.slice(3);
  else if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d.slice(0, 10);
};

// A valid Indian mobile: 10 digits starting 6-9.
const isValidMobile = (mobile) => /^[6-9]\d{9}$/.test(mobile);

const MOBILE_MESSAGE = "Please enter a valid 10-digit mobile number.";

module.exports = { cleanMobile, isValidMobile, MOBILE_MESSAGE };
