const IST = "Asia/Kolkata";
const IST_OFFSET = "+05:30";

if (!process.env.TZ) {
  process.env.TZ = IST;
}

// A bare calendar date with no time and no zone, as every from/to/date
// query param on the admin screens arrives.
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function istDayStart(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : new Date(value.getTime());
  const s = String(value == null ? "" : value).trim();
  if (!s) return null;
  const d = BARE_DATE.test(s) ? new Date(`${s}T00:00:00.000${IST_OFFSET}`) : new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

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

export { IST, IST_OFFSET, istDayStart, istDayEnd };
