const BLOCKS = [
  { start: 0x0900, name: "devanagari", north: true },
  { start: 0x0980, name: "bengali", north: true },
  { start: 0x0a00, name: "gurmukhi", north: true },
  { start: 0x0a80, name: "gujarati", north: true },
  { start: 0x0b00, name: "odia", north: true },
  { start: 0x0b80, name: "tamil", north: false },
  { start: 0x0c00, name: "telugu", north: false },
  { start: 0x0c80, name: "kannada", north: false },
  { start: 0x0d00, name: "malayalam", north: false },
];

// Offsets within a 128-code-point Indic block.
const VOWELS = {
  0x05: "a",
  0x06: "a",
  0x07: "i",
  0x08: "i",
  0x09: "u",
  0x0a: "u",
  0x0b: "ri",
  0x0c: "lu",
  0x0d: "e",
  0x0e: "e",
  0x0f: "e",
  0x10: "ai",
  0x11: "o",
  0x12: "o",
  0x13: "o",
  0x14: "au",
  0x60: "ri",
  0x61: "lu",
};
const CONSONANTS = {
  0x15: "k",
  0x16: "kh",
  0x17: "g",
  0x18: "gh",
  0x19: "n",
  0x1a: "ch",
  0x1b: "chh",
  0x1c: "j",
  0x1d: "jh",
  0x1e: "n",
  0x1f: "t",
  0x20: "th",
  0x21: "d",
  0x22: "dh",
  0x23: "n",
  0x24: "t",
  0x25: "th",
  0x26: "d",
  0x27: "dh",
  0x28: "n",
  0x29: "n",
  0x2a: "p",
  0x2b: "ph",
  0x2c: "b",
  0x2d: "bh",
  0x2e: "m",
  0x2f: "y",
  0x30: "r",
  0x31: "r",
  0x32: "l",
  0x33: "l",
  0x34: "zh",
  0x35: "v",
  0x36: "sh",
  0x37: "sh",
  0x38: "s",
  0x39: "h",
  // Devanagari precomposed nukta letters
  0x58: "q",
  0x59: "kh",
  0x5a: "gh",
  0x5b: "z",
  0x5c: "r",
  0x5d: "rh",
  0x5e: "f",
  0x5f: "y",
};
const MATRAS = {
  0x3e: "a",
  0x3f: "i",
  0x40: "i",
  0x41: "u",
  0x42: "u",
  0x43: "ri",
  0x44: "ri",
  0x45: "e",
  0x46: "e",
  0x47: "e",
  0x48: "ai",
  0x49: "o",
  0x4a: "o",
  0x4b: "o",
  0x4c: "au",
  0x62: "lu",
  0x63: "lu",
  0x55: "",
  0x56: "ai",
  0x57: "au", // Telugu/Kannada/Malayalam length marks
};
const VIRAMA = 0x4d;
const NUKTA = 0x3c;
const CANDRABINDU = 0x01;
const ANUSVARA = 0x02;
const VISARGA = 0x03;
const AVAGRAHA = 0x3d;
const OM = 0x50;
const DANDA = 0x64;
const DOUBLE_DANDA = 0x65;
const DIGIT0 = 0x66;
// Nukta on a plain consonant (Devanagari style): ज़ → z, फ़ → f, ड़ → r …
const NUKTA_MAP = { 0x15: "q", 0x16: "kh", 0x17: "gh", 0x1c: "z", 0x21: "r", 0x22: "rh", 0x2b: "f", 0x2f: "y" };
// Tamil uses ச for both "s" and "ch"; names overwhelmingly read "s".
const TAMIL_OVERRIDES = { 0x1a: "s" };
const LABIALS = new Set(["p", "ph", "b", "bh", "m"]);
const TAMIL_VOICED = { 0x15: "g", 0x1f: "d", 0x24: "d", 0x2a: "b" };

const LETTER_NAMES = {
  ఎ: "A",
  ఏ: "A",
  బి: "B",
  బీ: "B",
  సి: "C",
  సీ: "C",
  డి: "D",
  డీ: "D",
  ఇ: "E",
  ఈ: "E",
  ఎఫ్: "F",
  జి: "G",
  జీ: "G",
  హెచ్: "H",
  ఐ: "I",
  జె: "J",
  కె: "K",
  ఎల్: "L",
  ఎం: "M",
  ఎమ్: "M",
  ఎన్: "N",
  ఒ: "O",
  ఓ: "O",
  పి: "P",
  పీ: "P",
  క్యూ: "Q",
  ఆర్: "R",
  ఎస్: "S",
  టి: "T",
  టీ: "T",
  యు: "U",
  యూ: "U",
  వి: "V",
  వీ: "V",
  డబ్ల్యు: "W",
  ఎక్స్: "X",
  వై: "Y",
  జెడ్: "Z",
};

const COMMON_WORDS = {
  రావు: "Rao",
  राव: "Rao",
  ರಾವ್: "Rao",
  రెడ్డి: "Reddy",
  ರೆಡ್ಡಿ: "Reddy",
  నాయుడు: "Naidu",
  చౌదరి: "Chowdary",
  శ్రీ: "Sri",
  श्री: "Shri",
  ஸ்ரீ: "Sri",
  ಶ್ರೀ: "Sri",
  విశాఖపట్నం: "Visakhapatnam",
  విశాఖపట్టణం: "Visakhapatnam",
  విశాఖ: "Visakha",
  వైజాగ్: "Vizag",
  गाजुवाका: "Gajuwaka",
  గాజువాక: "Gajuwaka",
  విజయవాడ: "Vijayawada",
  హైదరాబాద్: "Hyderabad",
  తెలంగాణ: "Telangana",
  दिल्ली: "Delhi",
  सिंह: "Singh",
  ਸਿੰਘ: "Singh",
  सिंग: "Singh",
  नई: "New",
  मुंबई: "Mumbai",
  हैदराबाद: "Hyderabad",
  சென்னை: "Chennai",
  ಬೆಂಗಳೂರು: "Bengaluru",
  నగర్: "Nagar",
  కాలనీ: "Colony",
  కాలని: "Colony",
  "కాలనీ,": "Colony,",
};

const ZWJ = 0x200d;
const ZWNJ = 0x200c;

function blockOf(code) {
  for (const b of BLOCKS) if (code >= b.start && code < b.start + 0x80) return b;
  return null;
}

/** True if the text contains any character from the Indic blocks. */
function hasIndic(text) {
  return /[ऀ-ൿ]/.test(String(text || ""));
}

function transliterate(text) {
  const chars = Array.from(String(text || ""));
  let out = "";
  // Pending inherent "a" after a consonant, and facts about the current word
  // for the north-Indian final-schwa rule.
  let pendingA = false;
  let lastConsonant = null; // latin of the last consonant written
  let lastWasConjunct = false; // last consonant followed a virama
  let afterVirama = false;
  let block = null;
  let wordAksharas = 0;

  const flushA = (atWordEnd) => {
    if (!pendingA) return;
    pendingA = false;
    // North-Indian scripts: drop the silent final "a" of a word of 2+ syllables,
    // unless the word ends in a conjunct (कृष्ण → Krishna).
    if (atWordEnd && block && block.north && wordAksharas > 1 && !lastWasConjunct) return;
    out += "a";
  };

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.codePointAt(0);
    if (code === ZWJ || code === ZWNJ) continue;
    const b = blockOf(code);

    if (!b) {
      // Leaving an Indic word.
      const boundary = !/[\p{L}\p{M}]/u.test(ch);
      flushA(boundary);
      if (boundary) {
        wordAksharas = 0;
        lastWasConjunct = false;
        afterVirama = false;
      }
      out += ch;
      continue;
    }

    block = b;
    const off = code - b.start;

    if (CONSONANTS[off] !== undefined) {
      flushA(false);
      let latin = CONSONANTS[off];
      if (b.name === "tamil" && TAMIL_OVERRIDES[off] !== undefined) latin = TAMIL_OVERRIDES[off];
      // va as the second letter of a cluster reads "w": ద్వారక → Dwaraka
      if (off === 0x35 && afterVirama) latin = "w";
      // శ before ర/వ in a cluster reads "s": శ్రీనివాస్ → Srinivas, ఈశ్వర → Eswara
      if (off === 0x36 && !b.north) {
        const n1 = chars[i + 1] ? chars[i + 1].codePointAt(0) - b.start : -1;
        const n2 = chars[i + 2] ? chars[i + 2].codePointAt(0) - b.start : -1;
        if (n1 === VIRAMA && (n2 === 0x30 || n2 === 0x35)) latin = "s";
      }
      // South-Indian names write a final త్ as "th": సంపత్ → Sampath
      if (off === 0x24 && !b.north) {
        const n1 = chars[i + 1] ? chars[i + 1].codePointAt(0) - b.start : -1;
        const after = chars[i + 2] || "";
        if (n1 === VIRAMA && !blockOf((after || " ").codePointAt(0))) latin = "th";
      }
      // Tamil: k/t/th/p sound voiced between vowels and after a nasal
      // (முருகன் → Murugan, பாண்டியன் → Pandiyan)
      if (b.name === "tamil" && TAMIL_VOICED[off] && /[aeiou]$|(?:n|m|ng)$/.test(out) && wordAksharas > 0) {
        latin = TAMIL_VOICED[off];
      }
      // nukta right after this consonant changes it (ज़ → z)
      const next = chars[i + 1] ? chars[i + 1].codePointAt(0) - b.start : -1;
      if (next === NUKTA) {
        latin = NUKTA_MAP[off] !== undefined ? NUKTA_MAP[off] : latin;
        i++;
      }
      out += latin;
      lastWasConjunct = afterVirama;
      afterVirama = false;
      lastConsonant = latin;
      pendingA = true;
      wordAksharas++;
      continue;
    }
    if (MATRAS[off] !== undefined) {
      pendingA = false;
      out += MATRAS[off];
      continue;
    }
    if (off === VIRAMA) {
      pendingA = false;
      afterVirama = true;
      continue;
    }
    if (VOWELS[off] !== undefined) {
      flushA(false);
      out += VOWELS[off];
      lastWasConjunct = false;
      wordAksharas++;
      continue;
    }
    if (off === ANUSVARA || off === CANDRABINDU) {
      flushA(false);
      // "m" before p/b/m and at the end of a word, "n" before anything else
      const nxt = chars[i + 1];
      const nb = nxt ? blockOf(nxt.codePointAt(0)) : null;
      const nOff = nb ? nxt.codePointAt(0) - nb.start : -1;
      const nLatin = nb && CONSONANTS[nOff] !== undefined ? CONSONANTS[nOff] : null;
      // South-Indian names write it "m" before sh/s/h/y/r/l/v too (వంశీ → Vamshi)
      const southM = !b.north && nLatin && /^(sh|s|h|y|r|l|v)$/.test(nLatin);
      out += !nLatin ? (off === ANUSVARA ? "m" : "n") : LABIALS.has(nLatin) || southM ? "m" : "n";
      continue;
    }
    if (off === VISARGA) {
      flushA(false);
      out += "h";
      continue;
    }
    if (off === NUKTA || off === AVAGRAHA) continue;
    if (off === OM) {
      flushA(false);
      out += "om";
      continue;
    }
    if (off === DANDA || off === DOUBLE_DANDA) {
      flushA(true);
      out += ".";
      continue;
    }
    if (off >= DIGIT0 && off <= DIGIT0 + 9) {
      flushA(false);
      out += String(off - DIGIT0);
      continue;
    }
    // anything else in the block (rare signs): drop it
  }
  flushA(true);
  return out;
}

const titleCase = (s) =>
  s.replace(/[A-Za-z][A-Za-z']*/g, (w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w));

function toEnglish(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (!hasIndic(text)) return text.trim();
  const replaced = text.replace(/[ऀ-ൿ‌‍]+/g, (w, at, whole) => {
    const nextToDot = whole[at - 1] === "." || whole[at + w.length] === ".";
    if (nextToDot && LETTER_NAMES[w] !== undefined) return LETTER_NAMES[w];
    return COMMON_WORDS[w] !== undefined ? COMMON_WORDS[w] : w;
  });
  return titleCase(transliterate(replaced).replace(/ayi\b/g, "ai")) // సాయి → Sai
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

export { toEnglish, transliterate, hasIndic };
