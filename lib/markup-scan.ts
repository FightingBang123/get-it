/**
 * A small, tolerant XML/XHTML tokenizer.
 *
 * EPUB's container.xml, OPF package document and chapter XHTML are all XML,
 * but pulling in a full parser for three well-understood file shapes is not
 * worth a new runtime dependency. This scanner produces a flat event stream
 * (`open` / `close` / `text`) and is deliberately forgiving:
 *
 *   • Namespace prefixes are stripped (`opf:item` → `item`).
 *   • Tags and attributes are matched case-insensitively.
 *   • Comments, CDATA, processing instructions and DOCTYPE are skipped.
 *   • Unquoted attribute values and single quotes are accepted.
 *   • A `>` inside a quoted attribute value does not end the tag.
 *
 * It is not a validating parser: unclosed tags are tolerated by the caller,
 * not repaired here.
 */

export type MarkupAttrs = Record<string, string>;

export type MarkupEvent =
  | { kind: "open"; name: string; attrs: MarkupAttrs; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** `"opf:item"` → `"item"`; also lowercases. */
export function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  const bare = colon === -1 ? qualified : qualified.slice(colon + 1);
  return bare.toLowerCase();
}

/** Walk a tag's `<name attr="v" …>` body and collect its attributes. */
export function parseAttributes(tagBody: string): MarkupAttrs {
  const attrs: MarkupAttrs = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(tagBody)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!(key in attrs)) attrs[key] = decodeEntities(value);
  }
  return attrs;
}

export function tokenizeMarkup(src: string): MarkupEvent[] {
  const events: MarkupEvent[] = [];
  const n = src.length;
  let textStart = 0;
  let i = 0;

  const flushText = (end: number) => {
    if (end > textStart) {
      const raw = src.slice(textStart, end);
      if (raw) events.push({ kind: "text", text: decodeEntities(raw) });
    }
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;

    // Comments.
    if (src.startsWith("<!--", lt)) {
      flushText(lt);
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      textStart = i;
      continue;
    }
    // CDATA is literal text.
    if (src.startsWith("<![CDATA[", lt)) {
      flushText(lt);
      const end = src.indexOf("]]>", lt + 9);
      const raw = src.slice(lt + 9, end === -1 ? n : end);
      if (raw) events.push({ kind: "text", text: raw });
      i = end === -1 ? n : end + 3;
      textStart = i;
      continue;
    }
    // Processing instruction.
    if (src.startsWith("<?", lt)) {
      flushText(lt);
      const end = src.indexOf("?>", lt + 2);
      i = end === -1 ? n : end + 2;
      textStart = i;
      continue;
    }
    // DOCTYPE and other declarations: skipped entirely (no entity expansion,
    // which also makes "billion laughs" impossible).
    if (src.startsWith("<!", lt)) {
      flushText(lt);
      const end = src.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      textStart = i;
      continue;
    }

    // Find the tag's closing `>`, respecting quoted attribute values.
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    if (j >= n) break; // unterminated tag — drop the tail

    flushText(lt);

    const inner = src.slice(lt + 1, j);
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      if (name) events.push({ kind: "close", name: localName(name) });
    } else {
      const selfClosing = inner.endsWith("/");
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameMatch = /^([^\s/>]+)/.exec(body);
      if (nameMatch) {
        events.push({
          kind: "open",
          name: localName(nameMatch[1]),
          attrs: parseAttributes(body),
          selfClosing,
        });
      }
    }

    i = j + 1;
    textStart = i;
  }

  flushText(n);
  return events;
}

// ── Entities ────────────────────────────────────────────────────────────
//
// Latin-1 plus the punctuation/math names that actually show up in books.
// Numeric character references cover everything else.

const LATIN1_NAMES = [
  "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect",
  "uml", "copy", "ordf", "laquo", "not", "shy", "reg", "macr",
  "deg", "plusmn", "sup2", "sup3", "acute", "micro", "para", "middot",
  "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
  "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil",
  "Egrave", "Eacute", "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml",
  "ETH", "Ntilde", "Ograve", "Oacute", "Ocirc", "Otilde", "Ouml", "times",
  "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute", "THORN", "szlig",
  "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil",
  "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml",
  "eth", "ntilde", "ograve", "oacute", "ocirc", "otilde", "ouml", "divide",
  "oslash", "ugrave", "uacute", "ucirc", "uuml", "yacute", "thorn", "yuml",
];

const NAMED_ENTITIES: Record<string, string> = (() => {
  const table: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    mdash: "—", ndash: "–", hellip: "…",
    lsquo: "‘", rsquo: "’", sbquo: "‚",
    ldquo: "“", rdquo: "”", bdquo: "„",
    bull: "•", dagger: "†", Dagger: "‡",
    permil: "‰", lsaquo: "‹", rsaquo: "›",
    euro: "€", trade: "™", minus: "−",
    prime: "′", Prime: "″", oline: "‾",
    frasl: "⁄", lowast: "∗", radic: "√",
    infin: "∞", ne: "≠", equiv: "≡",
    asymp: "≈", le: "≤", ge: "≥",
    larr: "←", uarr: "↑", rarr: "→", darr: "↓",
    harr: "↔", forall: "∀", part: "∂", exist: "∃",
    empty: "∅", nabla: "∇", isin: "∈", notin: "∉",
    sum: "∑", prod: "∏", int: "∫", and: "∧", or: "∨",
    cap: "∩", cup: "∪", sim: "∼", cong: "≅",
    sub: "⊂", sup: "⊃", sube: "⊆", supe: "⊇",
    oplus: "⊕", otimes: "⊗", perp: "⊥", sdot: "⋅",
    lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
    spades: "♠", clubs: "♣", hearts: "♥", diams: "♦",
  };
  LATIN1_NAMES.forEach((name, index) => {
    table[name] = String.fromCodePoint(0xa0 + index);
  });
  return table;
})();

const ENTITY_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

export function decodeEntities(input: string): string {
  if (input.indexOf("&") === -1) return input;
  return input.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}
