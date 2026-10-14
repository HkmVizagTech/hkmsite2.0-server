// MongoDB evaluated `$regex` with PCRE. Postgres' regex dialect differs, so patterns are evaluated in
// JavaScript after translating the PCRE constructs JavaScript reads differently or not at all.
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
  ascii: "\\x00-\\x7f",
};
const KNOWN_ESCAPES = new Set("abBcdDeEfgGhHkKnNopPQrRsStvVwWxXzZAC".split(""));
const GENERAL_CATEGORIES =
  /^(L|Lu|Ll|Lt|Lm|Lo|M|Mn|Mc|Me|N|Nd|Nl|No|P|Pc|Pd|Ps|Pe|Pi|Pf|Po|S|Sm|Sc|Sk|So|Z|Zs|Zl|Zp|C|Cc|Cf|Cs|Co|Cn|L&)$/;
const HSPACE = " \\t\\xa0\\u1680\\u180e\\u2000-\\u200a\\u202f\\u205f\\u3000";
const invalid = (why) => new Error(`Regular expression is invalid: ${why}`);

const unicodeProperty = (name) => {
  const neg = name.startsWith("^");
  const bare = neg ? name.slice(1) : name;
  if (bare === "Any") return { neg, text: "[\\s\\S]" };
  const prop = GENERAL_CATEGORIES.test(bare) ? (bare === "L&" ? "LC" : bare) : `Script=${bare}`;
  try {
    new RegExp(`\\p{${prop}}`, "u");
  } catch {
    throw invalid("unknown property after \\P or \\p");
  }
  return { neg, text: `${prop}` };
};

export function compilePcre(source, flags = "i") {
  if (typeof source !== "string") throw new Error("$regex has to be a string");
  let src = source;
  let f = new Set(flags.split(""));
  // leading option settings: (?i) (?-i) (?m) (?s) (?im-s)
  for (let m = /^\(\?([imsx]*)(?:-([imsx]*))?\)/.exec(src); m; m = /^\(\?([imsx]*)(?:-([imsx]*))?\)/.exec(src)) {
    if (m[1].includes("x") || (m[2] || "").includes("x")) throw invalid("unrecognized character after (? or (?-");
    for (const c of m[1]) f.add(c);
    for (const c of m[2] || "") f.delete(c);
    src = src.slice(m[0].length);
  }

  let unicode = false;
  let out = "";
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) throw invalid("\\ at end of pattern");
      if (/[uULlF]/.test(n))
        throw new Error("Regular expression is invalid: PCRE2 does not support \\F, \\L, \\l, \\N{name}, \\U, or \\u");
      if (/[A-Za-z]/.test(n) && !KNOWN_ESCAPES.has(n)) throw invalid("unrecognized character follows \\");
      i++;
      if (n === "Q") {
        const end = src.indexOf("\\E", i + 1);
        const lit = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
        out += lit.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
        i = end === -1 ? src.length : end + 1;
        continue;
      }
      if (n === "E") continue;
      if (n === "p" || n === "P") {
        let name;
        if (src[i + 1] === "{") {
          const end = src.indexOf("}", i + 2);
          if (end === -1) throw invalid("malformed \\P or \\p sequence");
          name = src.slice(i + 2, end);
          i = end;
        } else {
          name = src[i + 1] ?? "";
          i += 1;
        }
        const prop = unicodeProperty(name);
        unicode = true;
        const negate = (n === "P") !== prop.neg;
        out += prop.text.startsWith("[") ? prop.text : `\\${negate ? "P" : "p"}{${prop.text}}`;
        continue;
      }
      if (n === "x" && src[i + 1] === "{") {
        const end = src.indexOf("}", i + 2);
        if (end === -1) throw invalid("missing terminating } for \\x{");
        const hex = src.slice(i + 2, end);
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw invalid("non-hex character in \\x{} (closing brace missing?)");
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) throw invalid("character code point value in \\x{} or \\o{} is too large");
        unicode = true;
        out += `\\u{${hex}}`;
        i = end;
        continue;
      }
      if (inClass) {
        if (n === "h") out += HSPACE;
        else if (n === "a") out += "\\x07";
        else if (n === "e") out += "\\x1b";
        else out += c + n;
        continue;
      }
      if (n === "A") out += "^";
      else if (n === "z") out += "$";
      else if (n === "Z") out += "(?=\\n?$)";
      else if (n === "h") out += `[${HSPACE}]`;
      else if (n === "H") out += `[^${HSPACE}]`;
      else if (n === "R") out += "(?:\\r\\n|[\\n\\x0b\\f\\r\\x85\\u2028\\u2029])";
      else if (n === "N") out += "[^\\n]";
      else if (n === "a") out += "\\x07";
      else if (n === "e") out += "\\x1b";
      else out += c + n;
      continue;
    }
    if (inClass) {
      if (c === "[" && src[i + 1] === ":") {
        const end = src.indexOf(":]", i + 2);
        const name = end > 0 ? src.slice(i + 2, end) : "";
        const key = name.startsWith("^") ? name.slice(1) : name;
        if (POSIX[key] === undefined) {
          if (end > 0 && /^\^?[a-z]+$/.test(name)) throw invalid("unknown POSIX class name");
        } else if (!name.startsWith("^")) {
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
    if (c === "(" && src[i + 1] === "?") {
      if (src[i + 2] === "#") {
        const end = src.indexOf(")", i + 3);
        if (end === -1) throw invalid("missing ) after (?# comment");
        i = end;
        continue;
      }
      if (src[i + 2] === "P" && src[i + 3] === "<") {
        out += "(?<";
        i += 3;
        continue;
      }
      if (src[i + 2] === "P" && src[i + 3] === "=") {
        const end = src.indexOf(")", i + 4);
        if (end === -1) throw invalid("missing closing parenthesis");
        out += `\\k<${src.slice(i + 4, end)}>`;
        i = end;
        continue;
      }
    }
    // possessive quantifiers read as greedy ones
    if (c === "+" && /[*+?}]/.test(src[i - 1] ?? "") && src[i - 2] !== "\\") continue;
    out += c;
  }
  try {
    return new RegExp(out, [...f].join("") + (unicode ? "u" : ""));
  } catch (err) {
    throw invalid(pcreMessage(String(err.message).replace(/^Invalid regular expression: .*?: /, "")));
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
  if (/Invalid named reference|Invalid capture group name/.test(m))
    return "syntax error in subpattern name (missing terminator?)";
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
