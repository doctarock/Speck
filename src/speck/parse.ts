// The dependency parse sidecar (sidecars/parse/server.py, spaCy): the
// grammatical structure of a text, deterministic and local. It labels
// grammar and makes no judgment. Unavailable, it returns null and the caller
// does without.

export interface ParsedToken {
  i: number;
  text: string;
  idx: number;
  lemma: string;
  pos: string;
  // Fine part of speech (Penn tag, such as "VBD"), morphology, and the
  // whitespace after the token.
  tag: string;
  morph: string;
  ws: string;
  dep: string;
  head: number;
  sentStart: boolean;
  // Named-entity type ("DATE", "MONEY", ...), "" when none.
  ent: string;
}

export const PARSE_URL = (process.env.SPECK_PARSE_URL ?? "http://127.0.0.1:8766").replace(/\/+$/, "");
const TIMEOUT_MS = 5_000;

export async function parseText(text: string, fetchImpl: typeof fetch = fetch): Promise<ParsedToken[] | null> {
  try {
    const response = await fetchImpl(`${PARSE_URL}/parse`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const body = await response.json() as { ok?: boolean; tokens?: ParsedToken[] };
    return body.ok && Array.isArray(body.tokens) ? body.tokens : null;
  } catch {
    return null;
  }
}

// The sentences of a parse, each as its tokens.
export function sentences(tokens: readonly ParsedToken[]): ParsedToken[][] {
  const result: ParsedToken[][] = [];
  for (const token of tokens) {
    if (token.sentStart || !result.length) result.push([]);
    result.at(-1)!.push(token);
  }
  return result;
}

// The tokens of a token's subtree, in text order.
export function subtree(tokens: readonly ParsedToken[], root: ParsedToken): ParsedToken[] {
  const inside = new Set([root.i]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const token of tokens) if (!inside.has(token.i) && token.i !== token.head && inside.has(token.head)) { inside.add(token.i); grew = true; }
  }
  return tokens.filter((token) => inside.has(token.i));
}

export const spanText = (text: string, tokens: readonly ParsedToken[]): string =>
  tokens.length ? text.slice(tokens[0]!.idx, tokens.at(-1)!.idx + tokens.at(-1)!.text.length) : "";
