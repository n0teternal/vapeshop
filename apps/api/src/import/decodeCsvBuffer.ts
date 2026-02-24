type SupportedEncoding = "utf-8" | "windows-1251" | "ibm866" | "koi8-r";

type DecodedCandidate = {
  encoding: SupportedEncoding;
  text: string;
  score: number;
};

const ENCODINGS: SupportedEncoding[] = ["utf-8", "windows-1251", "ibm866", "koi8-r"];

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function scoreDecodedText(text: string): number {
  // Higher score means "more likely this decode is correct".
  let score = 0;

  const replacementCount = countMatches(text, /\uFFFD/g);
  const controlCount = countMatches(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);

  const cyrillicChars = text.match(/[А-Яа-яЁё]/g) ?? [];
  const cyrillicCount = cyrillicChars.length;
  const suspiciousRsCount = cyrillicChars.filter((ch) => ch === "Р" || ch === "С").length;
  const suspiciousRsRatio = cyrillicCount > 0 ? suspiciousRsCount / cyrillicCount : 0;

  // Typical UTF-8 mojibake markers when decoded with CP1251/CP866.
  const mojibakeRuPairs = countMatches(text, /(?:Р[А-яЁё]|С[А-яЁё])/g);
  const mojibakeLatinPairs = countMatches(text, /(?:Ð.|Ñ.)/g);

  if (/(^|[\r\n])[ \t]*id[;, \t]+title[;, \t]+description/i.test(text)) {
    score += 500;
  }

  score -= replacementCount * 1000;
  score -= controlCount * 200;
  score -= mojibakeRuPairs * 3;
  score -= mojibakeLatinPairs * 3;

  if (suspiciousRsRatio > 0.45) {
    score -= Math.round((suspiciousRsRatio - 0.45) * 2500);
  }

  // Mild positive signal: decoded text contains readable Cyrillic.
  score += Math.min(cyrillicCount, 300);

  return score;
}

function decodeWithEncoding(buffer: Buffer, encoding: SupportedEncoding): string {
  const decoder = new TextDecoder(encoding, { fatal: false });
  return decoder.decode(buffer);
}

export function decodeCsvBuffer(buffer: Buffer): { text: string; encoding: SupportedEncoding } {
  let best: DecodedCandidate | null = null;

  for (const encoding of ENCODINGS) {
    let text: string;
    try {
      text = decodeWithEncoding(buffer, encoding);
    } catch {
      continue;
    }

    const candidate: DecodedCandidate = {
      encoding,
      text,
      score: scoreDecodedText(text),
    };

    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  if (!best) {
    return { text: buffer.toString("utf8"), encoding: "utf-8" };
  }

  return { text: best.text, encoding: best.encoding };
}

