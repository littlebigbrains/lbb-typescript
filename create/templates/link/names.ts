// The normal forms of names, keys and codes (general linking 4.1), and the
// block keys of a mention (4.2). Pure functions: no I/O.
//
// A block key is `<kind>:<value>`, for example `name:mira ruiz tannenholt`,
// `name:initial:tannenholt m` or `email:mira.tannenholt@northbay.example`.
// Mentions that share a block key are compared. The kind gives the key a
// weight: a strong key (an email, a phone, a web address, a handle, a code)
// links at confidence 1 without a model; a medium or a weak key only finds a
// candidate.

/** The kinds of block keys. */
export type KeyKind =
  | "email"
  | "phone"
  | "web"
  | "handle"
  | "code"
  | "name"
  | "name:initial"
  | "alias"
  | "name:part"
  | "name:sound"
  | "domain";

export type KeyWeight = "strong" | "medium" | "weak";

/** The weight of each kind, and the value the candidate score adds for it. */
export const KEY_KINDS: Record<KeyKind, { weight: KeyWeight; value: number }> = {
  email: { weight: "strong", value: 1 },
  phone: { weight: "strong", value: 1 },
  web: { weight: "strong", value: 1 },
  handle: { weight: "strong", value: 1 },
  code: { weight: "strong", value: 1 },
  name: { weight: "medium", value: 0.8 },
  "name:initial": { weight: "medium", value: 0.6 },
  alias: { weight: "medium", value: 0.8 },
  "name:part": { weight: "weak", value: 0.3 },
  "name:sound": { weight: "weak", value: 0.25 },
  domain: { weight: "weak", value: 0.2 },
};

/** The kinds a key may start with, longest first, so `name:initial:x` is not read as `name`. */
const KIND_PREFIXES = (Object.keys(KEY_KINDS) as KeyKind[]).sort((a, b) => b.length - a.length);

/** The kind of a block key; `null` for a string that is no block key. */
export function keyKind(key: string): KeyKind | null {
  return KIND_PREFIXES.find((kind) => key.startsWith(`${kind}:`)) ?? null;
}

/** The weight of a block key; `null` for a string that is no block key. */
export function keyWeight(key: string): KeyWeight | null {
  const kind = keyKind(key);
  return kind ? KEY_KINDS[kind].weight : null;
}

export const isStrong = (key: string) => keyWeight(key) === "strong";

// ---- case, width and diacritics ------------------------------------------------

/** Letters that no Unicode decomposition maps to a base letter. */
const SPECIAL: Record<string, string> = {
  ß: "ss",
  ẞ: "ss",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
  ø: "o",
  Ø: "o",
  ł: "l",
  Ł: "l",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  þ: "th",
  Þ: "th",
  ı: "i",
  ħ: "h",
  Ħ: "h",
};

/**
 * Case, width and diacritics: Unicode NFKC, the marks removed, lower case.
 * `MIRA` is `mira`, `Müller` is `muller`, `Søren` is `soren`.
 */
export function fold(text: string): string {
  let out = "";
  for (const c of text.normalize("NFKC")) out += SPECIAL[c] ?? c;
  return out
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .normalize("NFC");
}

const UMLAUTS: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue" };

/**
 * The second form of a text with German umlauts: `Müller` is `mueller`.
 * `null` when the text has no umlaut.
 */
export function umlautFold(text: string): string | null {
  const nfc = text.normalize("NFC");
  if (!/[äöüÄÖÜ]/.test(nfc)) return null;
  return fold(nfc.replace(/[äöüÄÖÜ]/g, (c) => UMLAUTS[c]!));
}

// ---- names ---------------------------------------------------------------------

/** Titles, dropped from a name that keeps another word. */
export const TITLES = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "mx",
  "dr",
  "prof",
  "sir",
  "dame",
  "frau",
  "herr",
  "fr",
  "hr",
  "mme",
  "mlle",
  "sr",
  "sra",
  "srta",
]);

/** Legal forms, dropped from a name that keeps another word: the list of the name index. */
export const LEGAL_FORMS = new Set([
  "gmbh",
  "mbh",
  "ag",
  "kg",
  "kgaa",
  "ohg",
  "gbr",
  "ug",
  "ev",
  "se",
  "inc",
  "incorporated",
  "ltd",
  "limited",
  "llc",
  "llp",
  "lp",
  "plc",
  "corp",
  "corporation",
  "co",
  "sa",
  "sas",
  "sarl",
  "srl",
  "spa",
  "bv",
  "nv",
  "ab",
  "oy",
  "oyj",
  "pty",
  "pte",
]);

/** One word of a name, folded: its hyphen parts, and whether it is an initial (`M.`). */
export interface NameWord {
  /** The parts of a hyphenated word (`tannenholt-ruiz` has `tannenholt` and `ruiz`); one part otherwise. */
  parts: string[];
  initial: boolean;
}

/**
 * The words of a name, folded. Punctuation between words separates them;
 * an apostrophe inside a word is removed (`O'Neil` is `oneil`); a hyphen
 * splits a word into parts. Titles and legal forms are dropped unless they
 * are all the name holds.
 */
export function nameWords(text: string, form: (text: string) => string = fold): NameWord[] {
  const words = form(text)
    .split(/[^\p{L}\p{N}'’\-‐‑]+/u)
    .map((token) => token.replace(/^['’\-‐‑]+|['’\-‐‑]+$/g, "").replace(/['’]/g, ""))
    .filter(Boolean)
    .map((token) => {
      const parts = token.split(/[-‐‑]+/).filter(Boolean);
      return { parts, initial: parts.length === 1 && [...parts[0]!].length === 1 };
    });
  const kept = words.filter(
    (w) => !(w.parts.length === 1 && (TITLES.has(w.parts[0]!) || LEGAL_FORMS.has(w.parts[0]!))),
  );
  return kept.length ? kept : words;
}

/**
 * Given-name variants (`Bob` for `Robert`): each variant to its common form.
 * The aliases people teach (5.5) add to it per thing.
 */
export const NICKNAMES: Record<string, string> = {
  bob: "robert",
  bobby: "robert",
  rob: "robert",
  robbie: "robert",
  bert: "robert",
  bill: "william",
  billy: "william",
  will: "william",
  willy: "william",
  liz: "elizabeth",
  lizzie: "elizabeth",
  beth: "elizabeth",
  betty: "elizabeth",
  eliza: "elizabeth",
  kate: "katherine",
  katie: "katherine",
  kathy: "katherine",
  cathy: "katherine",
  catherine: "katherine",
  mike: "michael",
  mick: "michael",
  jim: "james",
  jimmy: "james",
  jamie: "james",
  tom: "thomas",
  tommy: "thomas",
  dick: "richard",
  rick: "richard",
  rich: "richard",
  peggy: "margaret",
  maggie: "margaret",
  meg: "margaret",
  jen: "jennifer",
  jenny: "jennifer",
  dan: "daniel",
  danny: "daniel",
  dave: "david",
  joe: "joseph",
  sam: "samuel",
  ben: "benjamin",
  nick: "nicholas",
  chris: "christopher",
  matt: "matthew",
  andy: "andrew",
  tony: "anthony",
  steve: "steven",
  stephen: "steven",
  ed: "edward",
  eddie: "edward",
  ted: "edward",
  fred: "frederick",
  hans: "johannes",
  sepp: "josef",
  joseph: "josef",
  kathi: "katharina",
  uli: "ulrich",
  susi: "susanne",
  gabi: "gabriele",
  basti: "sebastian",
  flo: "florian",
};

/** The common form of a given name, or the word itself. */
export const commonName = (word: string): string => NICKNAMES[word] ?? word;

/** A name in its sorted form: every word part, sorted, joined by spaces. `Tannenholt-Ruiz, Mira` is `mira ruiz tannenholt`. */
export function sortedName(words: NameWord[]): string {
  return words
    .flatMap((w) => w.parts)
    .sort()
    .join(" ");
}

/** The form two names compare by: folded, sorted, each nickname as its common form. */
export function normalName(text: string): string {
  return sortedName(
    nameWords(text).map((w) => ({ ...w, parts: w.parts.map((p) => commonName(p)) })),
  );
}

/** The initials forms (4.1): a full word part with the first letter of each other word. */
export function initialForms(words: NameWord[]): string[] {
  if (words.length < 2) return [];
  const out: string[] = [];
  const firstLetter = (w: NameWord) => [...w.parts[0]!][0]!;
  const considered = words.slice(0, 4);
  considered.forEach((word, i) => {
    if (word.initial) return;
    for (const part of word.parts) {
      if ([...part].length < 2) continue;
      considered.forEach((other, j) => {
        if (i !== j) out.push(`${part} ${firstLetter(other)}`);
      });
    }
  });
  return [...new Set(out)];
}

/**
 * Cologne phonetics (Kölner Phonetik) of one word: a digit per sound, a
 * repeated digit once, and no vowel code after the first place.
 * `Müller` and `Mueller` are both `657`.
 */
export function cologne(word: string): string {
  const s = fold(word).replace(/[^a-z]/g, "");
  let codes = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const prev = s[i - 1] ?? "";
    const next = s[i + 1] ?? "";
    const before = (letters: string) => next !== "" && letters.includes(next);
    const after = (letters: string) => prev !== "" && letters.includes(prev);
    if ("aeijouy".includes(c)) codes += "0";
    else if (c === "b") codes += "1";
    else if (c === "p") codes += before("h") ? "3" : "1";
    else if (c === "d" || c === "t") codes += before("csz") ? "8" : "2";
    else if ("fvw".includes(c)) codes += "3";
    else if ("gkq".includes(c)) codes += "4";
    else if (c === "c") {
      if (i === 0) codes += before("ahkloqrux") ? "4" : "8";
      else codes += !after("sz") && before("ahkoqux") ? "4" : "8";
    } else if (c === "x") codes += after("ckq") ? "8" : "48";
    else if (c === "l") codes += "5";
    else if (c === "m" || c === "n") codes += "6";
    else if (c === "r") codes += "7";
    else if (c === "s" || c === "z") codes += "8";
  }
  let out = "";
  for (const code of codes) if (out.at(-1) !== code) out += code;
  return out ? out[0] + out.slice(1).replace(/0/g, "") : "";
}

// ---- keys, codes and addresses --------------------------------------------------

/** An email address: lower case, trimmed (the resolver's rule). `null` for a text that is no address. */
export function emailForm(text: string): string | null {
  const value = text.trim().toLowerCase();
  return /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z0-9-]{2,}$/.test(value) ? value : null;
}

/** A web address without the scheme, `www.`, the query and trailing slashes (the resolver's rule). */
export function webForm(text: string): string | null {
  const value = text
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(value) ? value : null;
}

/** A phone number: its digits, the last 9. `null` for fewer than 7 digits. */
export function phoneForm(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-9) : null;
}

/** A handle: lower case, without a leading `@`. */
export function handleForm(text: string): string | null {
  const value = text.trim().toLowerCase().replace(/^@/, "");
  return /^[a-z0-9_.-]{2,64}$/.test(value) ? value : null;
}

/**
 * The key a code matches by (`identifier_key` of link version 7): no
 * whitespace, lower case, no dot between leading letters and a digit.
 * `P 38`, `P.38` and `P38` are `p38`.
 */
export function codeForm(text: string): string | null {
  const squashed = fold(text).replace(/\s+/g, "");
  if (!squashed || !/\d/.test(squashed)) return null;
  return squashed.replace(/^(\p{L}+)\.(?=\d)/u, "$1");
}

/** Mail domains many people share: an address there says nothing about an organization. */
export const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "t-online.de",
  "mail.com",
]);

/** The domain of an email address or a web address; `null` for a free mail domain. */
export function domainOf(value: string): string | null {
  const host = value.includes("@") ? value.split("@")[1]! : value.split("/")[0]!;
  const domain = host.replace(/^www\./, "");
  return FREE_MAIL.has(domain) ? null : domain;
}

// ---- block keys ----------------------------------------------------------------

/** What a span is, for its keys: a name, a key of one kind, or a span of free text read as either. */
export type SpanKind = "name" | "email" | "phone" | "web" | "handle" | "code" | "text";

/** The keys of a name: the sorted name, the initials forms, each part and its sound, in each form of the text. */
function nameKeys(text: string): string[] {
  const forms = [fold(text), umlautFold(text)].filter((f): f is string => f !== null);
  const keys: string[] = [];
  for (const form of forms) {
    const words = nameWords(form, (t) => t);
    if (!words.length) continue;
    const variants = [words];
    const common = words.map((w) => ({ ...w, parts: w.parts.map((p) => commonName(p)) }));
    if (sortedName(common) !== sortedName(words)) variants.push(common);
    for (const variant of variants) {
      if (!variant.some((w) => w.initial)) keys.push(`name:${sortedName(variant)}`);
      for (const initials of initialForms(variant)) keys.push(`name:initial:${initials}`);
    }
    for (const word of words)
      for (const part of word.parts) {
        if ([...part].length < 3 || !/\p{L}/u.test(part)) continue;
        keys.push(`name:part:${part}`);
        const sound = cologne(part);
        if (sound.length >= 2) keys.push(`name:sound:${sound}`);
      }
  }
  return [...new Set(keys)];
}

/** Whether a span of free text is written as a key of this kind. */
export function looksLike(span: string, kind: "email" | "web" | "phone" | "code"): boolean {
  const text = span.trim();
  if (kind === "email") return emailForm(text) !== null;
  if (kind === "web")
    return /^(https?:\/\/|www\.)/i.test(text) && !text.includes("@") && webForm(text) !== null;
  // A phone number in text starts with `+`: a date or an amount is no phone number.
  if (kind === "phone") return /^\+[\d ()./-]{7,}$/.test(text) && phoneForm(text) !== null;
  // A code: letters and digits in one token (`P38`, `PX-200`), or letters and a number (`P 38`).
  return (
    text.length <= 24 && /^(?=.*\d)(?=.*\p{L})[\p{L}\d][\p{L}\d.\-/]*( \d[\d.]*)?$/u.test(text)
  );
}

/**
 * The block keys of a span. A key field gives its strong key (and an email
 * or a web address its domain); a name gives its name keys; a span of free
 * text is read as an email, a web address, a phone number or a code when it
 * is written as one, else as a name. `aliases` are the names people taught
 * the mention's thing (`alias:<normal name>`).
 */
export function blockKeys(span: string, kind: SpanKind, aliases: string[] = []): string[] {
  const keys: string[] = [];
  const add = (key: string | null) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  const strong = (k: Exclude<SpanKind, "name" | "text">) => {
    const value =
      k === "email"
        ? emailForm(span)
        : k === "web"
          ? webForm(span)
          : k === "phone"
            ? phoneForm(span)
            : k === "handle"
              ? handleForm(span)
              : codeForm(span);
    if (!value) return;
    add(`${k}:${value}`);
    if (k === "email" || k === "web") {
      const domain = domainOf(value);
      if (domain) add(`domain:${domain}`);
    }
  };
  if (kind === "name") nameKeys(span).forEach(add);
  else if (kind === "text") {
    const parsed = (["email", "web", "phone", "code"] as const).find((k) => looksLike(span, k));
    if (parsed) strong(parsed);
    else nameKeys(span).forEach(add);
  } else strong(kind);
  for (const alias of aliases) {
    const name = normalName(alias);
    if (name) add(`alias:${name}`);
  }
  return keys;
}

/** The block keys a mention keeps as graph facts, at most. */
export const MAX_KEYS = 16;

/** The keys of a span to keep: strong first, then medium, then weak, at most {@link MAX_KEYS}. */
export function keptKeys(keys: string[]): string[] {
  const rank = (key: string) => ({ strong: 0, medium: 1, weak: 2 })[keyWeight(key) ?? "weak"];
  return [...keys].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_KEYS);
}

// ---- similarity ----------------------------------------------------------------

/** Jaro-Winkler similarity of two strings, 0 to 1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const x = [...a];
  const y = [...b];
  if (!x.length || !y.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(x.length, y.length) / 2) - 1);
  const xMatched = new Array<boolean>(x.length).fill(false);
  const yMatched = new Array<boolean>(y.length).fill(false);
  let matches = 0;
  for (let i = 0; i < x.length; i++)
    for (let j = Math.max(0, i - window); j < Math.min(y.length, i + window + 1); j++)
      if (!yMatched[j] && x[i] === y[j]) {
        xMatched[i] = yMatched[j] = true;
        matches++;
        break;
      }
  if (!matches) return 0;
  let transpositions = 0;
  for (let i = 0, j = 0; i < x.length; i++) {
    if (!xMatched[i]) continue;
    while (!yMatched[j]) j++;
    if (x[i] !== y[j]) transpositions++;
    j++;
  }
  const jaro =
    (matches / x.length + matches / y.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && x[prefix] !== undefined && x[prefix] === y[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** 1 for equal strings, 0 for strings with nothing in common: normalized Levenshtein. */
export function levenshteinRatio(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const longest = Math.max(x.length, y.length);
  if (!longest) return 1;
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return 1 - previous[y.length]! / longest;
}

/**
 * How alike two names are, 0 to 1. Each word part of the shorter name is
 * matched to its best part of the other: an initial agrees with a part of
 * that first letter (0.8), a nickname with its common form (0.95), other
 * parts by Jaro-Winkler. The score is the mean of the matches.
 */
export function nameSimilarity(a: string, b: string): number {
  const parts = (text: string) =>
    nameWords(text).flatMap((w) => w.parts.map((part) => ({ part, initial: w.initial })));
  let [x, y] = [parts(a), parts(b)];
  if (!x.length || !y.length) return 0;
  if (x.length > y.length) [x, y] = [y, x];
  const used = new Set<number>();
  let total = 0;
  for (const word of x) {
    let best = 0;
    let at = -1;
    y.forEach((other, j) => {
      if (used.has(j)) return;
      const score =
        word.initial || other.initial
          ? word.part[0] === other.part[0]
            ? 0.8
            : 0
          : word.part === other.part
            ? 1
            : commonName(word.part) === commonName(other.part)
              ? 0.95
              : jaroWinkler(word.part, other.part);
      if (score > best) [best, at] = [score, j];
    });
    if (at >= 0) used.add(at);
    total += best;
  }
  return total / x.length;
}
