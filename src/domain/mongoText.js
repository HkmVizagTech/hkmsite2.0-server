import { DELIMITERS, STRIPPED, FOLD_NFD } from "./mongoTextTables.js";

// Emulation of MongoDB's `$text` (text index v3, language english): the same tokenizer, stop words and
// Snowball English stemmer, so a search matches the same documents the old text index did.

const STOP_WORDS = new Set(
  (
    "a about above after again against all am an and any are aren't as at be because been before being below between both " +
    "but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had " +
    "hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd " +
    "i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once " +
    "only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such " +
    "than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this " +
    "those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's " +
    "where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your " +
    "yours yourself yourselves"
  ).split(" ")
);

const inRanges = (ranges, cp) => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
};

const lowerChar = (ch, cp) => {
  const out = ch.toLowerCase();
  if (out.length > 1 || out.codePointAt(0) !== cp)
    return [...out].filter((c) => !inRanges(STRIPPED, c.codePointAt(0))).join("");
  return out;
};
const baseChar = (ch, cp) => (inRanges(FOLD_NFD, cp) ? ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase() : ch);
const foldChar = (ch, cp) => baseChar(lowerChar(ch, cp), lowerChar(ch, cp).codePointAt(0));
// Diacritics are removed from the stem, after stemming.
const stripDiacritics = (s) => {
  let out = "";
  for (const ch of s) out += baseChar(ch, ch.codePointAt(0));
  return out;
};

// Splits text into lower-cased tokens (before stop words and stemming).
export function rawTokens(text) {
  const tokens = [];
  let cur = "";
  const flush = () => {
    if (cur) tokens.push(cur);
    cur = "";
  };
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (inRanges(DELIMITERS, cp)) flush();
    else if (inRanges(STRIPPED, cp)) continue;
    else cur += lowerChar(ch, cp);
  }
  flush();
  return tokens;
}

// ---- Snowball English (Porter2) ----
const VOWELS = new Set("aeiouy");
const isVowel = (w, i) => VOWELS.has(w[i]);

const regions = (w) => {
  let r1 = w.length;
  let r2 = w.length;
  const m = /^(gener|commun|arsen)/.exec(w);
  if (m) r1 = m[1].length;
  else {
    for (let i = 1; i < w.length; i++) {
      if (!isVowel(w, i) && isVowel(w, i - 1)) {
        r1 = i + 1;
        break;
      }
    }
  }
  for (let i = r1 + 1; i < w.length; i++) {
    if (!isVowel(w, i) && isVowel(w, i - 1)) {
      r2 = i + 1;
      break;
    }
  }
  return [r1, r2];
};

const endsShortSyllable = (w, end = w.length) => {
  if (end === 2) return isVowel(w, 0) && !isVowel(w, 1);
  if (end < 3) return false;
  const c = w[end - 1];
  return !isVowel(w, end - 3) && isVowel(w, end - 2) && !isVowel(w, end - 1) && !"wxY".includes(c);
};
const isShort = (w, r1) => r1 >= w.length && endsShortSyllable(w);

const EXCEPTIONS = {
  skis: "ski",
  skies: "sky",
  dying: "die",
  lying: "lie",
  tying: "tie",
  idly: "idl",
  gently: "gentl",
  ugly: "ugli",
  early: "earli",
  only: "onli",
  singly: "singl",
  sky: "sky",
  news: "news",
  howe: "howe",
  atlas: "atlas",
  cosmos: "cosmos",
  bias: "bias",
  andes: "andes",
};
const EXCEPTIONS_1A = new Set(["inning", "outing", "canning", "herring", "earring", "proceed", "exceed", "succeed"]);

const STEP2 = [
  ["ization", "ize"],
  ["ational", "ate"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["iveness", "ive"],
  ["tional", "tion"],
  ["biliti", "ble"],
  ["lessli", "less"],
  ["entli", "ent"],
  ["ation", "ate"],
  ["alism", "al"],
  ["aliti", "al"],
  ["ousli", "ous"],
  ["iviti", "ive"],
  ["fulli", "ful"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["abli", "able"],
  ["izer", "ize"],
  ["ator", "ate"],
  ["alli", "al"],
  ["bli", "ble"],
  ["ogi", "og"],
  ["li", ""],
];
const STEP3 = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["alize", "al"],
  ["icate", "ic"],
  ["iciti", "ic"],
  ["ative", ""],
  ["ical", "ic"],
  ["ness", ""],
  ["ful", ""],
];
const STEP4 = [
  "ement",
  "ance",
  "ence",
  "able",
  "ible",
  "ment",
  "ant",
  "ent",
  "ism",
  "ate",
  "iti",
  "ous",
  "ive",
  "ize",
  "ion",
  "al",
  "er",
  "ic",
];

export function stem(input) {
  let w = input;
  if (Object.prototype.hasOwnProperty.call(EXCEPTIONS, w)) return EXCEPTIONS[w];
  if (w.length <= 2) return w;
  if (w[0] === "'") w = w.slice(1);
  // mark consonant y
  let chars = [...w];
  if (chars[0] === "y") chars[0] = "Y";
  for (let i = 1; i < chars.length; i++)
    if (chars[i] === "y" && VOWELS.has(chars[i - 1]) && chars[i - 1] !== "y") chars[i] = "Y";
  w = chars.join("");
  let [r1, r2] = regions(w);
  const inR1 = (suffixLen) => w.length - suffixLen >= r1;
  const inR2 = (suffixLen) => w.length - suffixLen >= r2;

  // step 0
  for (const s of ["'s'", "'s", "'"]) {
    if (w.endsWith(s)) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  // step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ied") || w.endsWith("ies")) w = w.length > 4 ? w.slice(0, -2) : w.slice(0, -1);
  else if (w.endsWith("us") || w.endsWith("ss")) {
    /* unchanged */
  } else if (w.endsWith("s")) {
    if (/[aeiouy]/.test(w.slice(0, -2))) w = w.slice(0, -1);
  }
  if (EXCEPTIONS_1A.has(w)) return w.replace(/Y/g, "y");

  // step 1b
  const vowelIn = (s) => /[aeiouy]/.test(s);
  const eed = /(eedly|eed)$/.exec(w);
  if (eed) {
    if (inR1(eed[1].length)) w = w.slice(0, -eed[1].length) + "ee";
  } else {
    const m = /(ingly|edly|ing|ed)$/.exec(w);
    if (m && vowelIn(w.slice(0, -m[1].length))) {
      w = w.slice(0, -m[1].length);
      if (/(at|bl|iz)$/.test(w)) w += "e";
      else if (/(bb|dd|ff|gg|mm|nn|pp|rr|tt)$/.test(w)) w = w.slice(0, -1);
      else if (isShort(w, r1)) w += "e";
    }
  }
  // step 1c
  if (w.length > 2 && (w.endsWith("y") || w.endsWith("Y")) && !isVowel(w, w.length - 2)) w = w.slice(0, -1) + "i";

  // step 2
  for (const [suf, rep] of STEP2) {
    if (w.endsWith(suf)) {
      if (inR1(suf.length)) {
        if (suf === "ogi") {
          if (w[w.length - 4] === "l") w = w.slice(0, -3) + rep;
        } else if (suf === "li") {
          if (/[cdeghkmnrt]/.test(w[w.length - 3] ?? "")) w = w.slice(0, -2);
        } else w = w.slice(0, -suf.length) + rep;
      }
      break;
    }
  }
  // step 3
  for (const [suf, rep] of STEP3) {
    if (w.endsWith(suf)) {
      if (inR1(suf.length)) {
        if (suf === "ative") {
          if (inR2(suf.length)) w = w.slice(0, -suf.length);
        } else w = w.slice(0, -suf.length) + rep;
      }
      break;
    }
  }
  // step 4
  for (const suf of STEP4) {
    if (w.endsWith(suf)) {
      if (inR2(suf.length)) {
        if (suf === "ion") {
          if (/[st]$/.test(w.slice(0, -3))) w = w.slice(0, -3);
        } else w = w.slice(0, -suf.length);
      }
      break;
    }
  }
  // step 5
  if (w.endsWith("e")) {
    if (inR2(1) || (inR1(1) && !endsShortSyllable(w, w.length - 1))) w = w.slice(0, -1);
  } else if (w.endsWith("ll") && inR2(1)) w = w.slice(0, -1);

  return w.replace(/Y/g, "y");
}

// Stems of the non-stop tokens in `text`.
export function stems(text, { keepStopWords = false } = {}) {
  const out = new Set();
  for (const t of rawTokens(text)) if (keepStopWords || !STOP_WORDS.has(t)) out.add(stripDiacritics(stem(t)));
  return out;
}

// ---- query ----
// `-term` excludes, "quoted phrases" must all appear, remaining words match if any of them is present.
// Mirrors MongoDB's FTS query parser: tokens are runs of text, a single `-` or `"`, or whitespace
// (\n \v \f \r and space only; a tab is ordinary text).
const isQuerySpace = (ch) => ch === " " || (ch >= "\n" && ch <= "\r");

export function parseQuery(query) {
  const terms = new Set();
  const negTerms = new Set();
  const phrases = [];
  const negPhrases = [];
  const s = String(query);
  let inNegation = false;
  let inPhrase = false;
  let phraseNegated = false;
  let quoteOffset = 0;
  let i = 0;
  const skipSpace = () => {
    const start = i;
    while (i < s.length && isQuerySpace(s[i])) i++;
    return i > start;
  };
  let prevSpace = true;
  skipSpace();
  while (i < s.length) {
    const start = i;
    const ch = s[i++];
    const wasSpace = prevSpace;
    if (wasSpace && !inPhrase) inNegation = false;
    if (ch === "-" || ch === '"') {
      prevSpace = skipSpace();
      if (ch === "-") {
        if (!inPhrase && wasSpace) inNegation = true;
      } else if (inPhrase) {
        const phrase = s.slice(quoteOffset + 1, start).toLowerCase();
        (phraseNegated ? negPhrases : phrases).push(phrase);
        inPhrase = false;
      } else {
        inPhrase = true;
        phraseNegated = inNegation;
        quoteOffset = start;
      }
      continue;
    }
    while (i < s.length && !isQuerySpace(s[i]) && s[i] !== "-" && s[i] !== '"') i++;
    const text = s.slice(start, i);
    prevSpace = skipSpace();
    const negated = inPhrase ? phraseNegated : inNegation;
    if (!(inPhrase && phraseNegated)) for (const st of stems(text)) (negated ? negTerms : terms).add(st);
  }
  return { terms, negTerms, phrases, negPhrases };
}

const foldText = (text) => {
  let out = "";
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (inRanges(STRIPPED, cp)) continue;
    out += foldChar(ch, cp);
  }
  return out;
};

// `doc` is { stems: Set, text: string } from indexDocument.
export function indexDocument(fields) {
  const text = fields.filter((f) => typeof f === "string");
  const joined = text.join(" ");
  // Negated terms were matched against every token, stop words included.
  return { stems: stems(joined), allStems: stems(joined, { keepStopWords: true }), folded: text.map(foldText) };
}

export function matches(parsed, doc) {
  const { terms, negTerms, phrases, negPhrases } = parsed;
  const phraseTerms = phrases.flatMap((p) => [...stems(p)]);
  const positive = new Set([...terms, ...phraseTerms]);
  if (!positive.size) return false;
  if (![...positive].some((t) => doc.stems.has(t))) return false;
  for (const t of negTerms) if (doc.allStems.has(t)) return false;
  const has = (p) => doc.folded.some((f) => f.includes(foldText(p)));
  if (!phrases.every(has)) return false;
  if (negPhrases.some(has)) return false;
  return true;
}
