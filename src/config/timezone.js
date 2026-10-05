// src/config/timezone.js
//
// MUST be the first require in every entry point (index.js, app.js, and both
// files under worker/). First *require*, not first statement — anything
// required above this line is fully evaluated before this runs, and a module
// that captures a date at load time would capture it in the wrong zone.
//
// The temple is in Visakhapatnam and every date a human reads out of this
// system — an 80G receipt, a DCC transaction date, an admin report row — is
// an IST date. Railway runs containers in UTC and nothing here used to set
// TZ, so a UTC "day" ran 05:30 IST to 05:30 IST and every donation taken
// between midnight and 05:30 IST was computed as the previous day.
//
// This is set in code rather than as a Railway variable because a variable
// can be missed on a new service, on a redeploy, or on a second worker, and
// the symptom is silently wrong dates on legal documents rather than an
// error anybody would notice. An externally supplied TZ still wins, so a
// test or a one-off run can still override it.
//
// Setting TZ fixes everything that goes through a JavaScript Date. It does
// NOT reach inside MongoDB: $dateToString, $year, $month, $dayOfMonth,
// $week and $dateTrunc all execute on the database server, which never sees
// this process's zone and defaults to UTC. Those each take an explicit
// `timezone` option and are passed IST individually at every call site.

const IST = "Asia/Kolkata";
const IST_OFFSET = "+05:30";

if (!process.env.TZ) {
  process.env.TZ = IST;
}

// A bare calendar date with no time and no zone, as every from/to/date
// query param on the admin screens arrives.
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// `new Date("2026-10-01")` is specified by ECMA-262 to parse a date-only
// string as UTC midnight, and process.env.TZ does not change that — it is
// in the language standard, not a platform default. In IST that instant is
// 05:30 on the 1st, so a `from=2026-10-01` filter silently excluded every
// donation taken in the first five and a half hours of that day. Anchoring
// the string to +05:30 makes it mean IST midnight, which is what the admin
// picking that date in the calendar means.
//
// Anything that is not a bare date (a full ISO instant, a Date) is already
// an unambiguous instant and is passed through untouched.
function istDayStart(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : new Date(value.getTime());
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  const d = BARE_DATE.test(s) ? new Date(`${s}T00:00:00.000${IST_OFFSET}`) : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Inclusive end of the same IST calendar day. For a bare date this is
// anchored explicitly for the same reason as istDayStart; for a full
// instant it falls back to setHours, which follows process.env.TZ and is
// therefore IST too, but the explicit branch means the common case does not
// depend on that at all.
function istDayEnd(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const d = new Date(value.getTime());
    d.setHours(23, 59, 59, 999);
    return d;
  }
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  if (BARE_DATE.test(s)) return new Date(`${s}T23:59:59.999${IST_OFFSET}`);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

module.exports = { IST, IST_OFFSET, istDayStart, istDayEnd };
