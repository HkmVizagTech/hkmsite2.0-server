// MongoDB evaluated `$regex` with PCRE. Postgres' regex dialect differs, so patterns are evaluated in
// JavaScript after translating the few PCRE constructs JavaScript reads differently.
const POSIX = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: "\\s",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  word: "\\w",
  xdigit: "0-9A-Fa-f",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
};
const KNOWN_ESCAPES = new Set("abBcdDeEfgGhHkKnNopPQrRsStvVwWxXzZAC".split(""));

export function compilePcre(source, flags = "i") {
  if (typeof source !== "string") throw new Error("$regex has to be a string");
  const src = source;
  let unicode = false;
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) throw new Error("Regular expression is invalid: \\ at end of pattern");
      if (/[A-Za-z]/.test(n) && !KNOWN_ESCAPES.has(n)) throw new Error("Regular expression is invalid: unrecognized character follows \\");
      if (n === "p" || n === "P") unicode = true;
      if (!inClass && n === "A") out += "^";
      else if (!inClass && n === "z") out += "$";
      else if (!inClass && n === "Z") out += "(?=\\n?$)";
      else out += c + n;
      i++;
      continue;
    }
    if (inClass) {
      if (c === "[" && src[i + 1] === ":") {
        const end = src.indexOf(":]", i + 2);
        const name = end > 0 ? src.slice(i + 2, end) : "";
        const neg = name.startsWith("^");
        const key = neg ? name.slice(1) : name;
        if (POSIX[key] !== undefined && !neg) {
          out += POSIX[key];
          i = end + 1;
          continue;
        }
      }
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      if (src[i + 1] === "^") {
        out += "^";
        i++;
      }
      if (src[i + 1] === "]") {
        out += "\\]";
        i++;
      }
      continue;
    }
    out += c;
  }
  try {
    return new RegExp(out, flags + (unicode ? "u" : ""));
  } catch (err) {
    throw new Error(`Regular expression is invalid: ${pcreMessage(String(err.message).replace(/^Invalid regular expression: .*?: /, ""))}`);
  }
}

// PCRE2's wording for the syntax errors V8 reports differently.
const pcreMessage = (m) => {
  if (/Unterminated group/.test(m)) return "missing closing parenthesis";
  if (/Unterminated character class/.test(m)) return "missing terminating ] for character class";
  if (/Unmatched '\)'/.test(m)) return "unmatched closing parenthesis";
  if (/Nothing to repeat/.test(m)) return "quantifier does not follow a repeatable item";
  if (/Range out of order/.test(m)) return "range out of order in character class";
  if (/Invalid group/.test(m)) return "unrecognized character after (? or (?-";
  if (/Invalid named reference|Invalid capture group name/.test(m)) return "syntax error in subpattern name (missing terminator?)";
  if (/Invalid property name/.test(m)) return "unknown property after \\P or \\p";
  if (/Invalid escape|Invalid regular expression/.test(m)) return "unrecognized character follows \\";
  return m;
};

// $regex on a field: strings match; arrays match when any string element does.
export const regexMatches = (value, re) => {
  if (typeof value === "string") return re.test(value);
  if (Array.isArray(value)) return value.some((v) => typeof v === "string" && re.test(v));
  return false;
};
