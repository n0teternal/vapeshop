export type SupportedCsvEncoding = "utf-8" | "windows-1251" | "ibm866" | "koi8-r";

type DecodedCandidate = {
  encoding: SupportedCsvEncoding;
  text: string;
  score: number;
};

const ENCODINGS: SupportedCsvEncoding[] = ["utf-8", "windows-1251", "ibm866", "koi8-r"];

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function scoreDecodedText(text: string): number {
  // Higher score means "more likely this decode is correct".
  let score = 0;

  const replacementCount = countMatches(text, /\uFFFD/g);
  const controlCount = countMatches(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g);
  const cyrillicCount = countMatches(text, /[\u0400-\u04FF]/g);
  const questionCount = countMatches(text, /\?/g);

  // Typical UTF-8 mojibake if decoded as CP1251/CP866: "Р..." / "С..."
  const mojibakeRuPairs = countMatches(text, /(?:\u0420[\u0400-\u04FF]|\u0421[\u0400-\u04FF])/g);
  // Typical UTF-8 mojibake with Latin fallback: "Ð..." / "Ñ..."
  const mojibakeLatinPairs = countMatches(text, /(?:\u00D0.|\u00D1.)/g);

  if (/(^|[\r\n])[ \t]*id[;, \t]+title[;, \t]+description/i.test(text)) {
    score += 500;
  }

  score -= replacementCount * 1000;
  score -= controlCount * 200;
  score -= mojibakeRuPairs * 4;
  score -= mojibakeLatinPairs * 4;

  // If text has many "?" and almost no readable Cyrillic, it is likely broken.
  if (questionCount > 5 && cyrillicCount < Math.min(questionCount, 25)) {
    score -= questionCount * 3;
  }

  // Mild positive signal for readable Cyrillic.
  score += Math.min(cyrillicCount, 300);

  return score;
}

function decodeWithEncoding(buffer: Buffer, encoding: SupportedCsvEncoding): string {
  const decoder = new TextDecoder(encoding, { fatal: false });
  return decoder.decode(buffer);
}

export function decodeCsvBuffer(params: {
  buffer: Buffer;
  forcedEncoding?: SupportedCsvEncoding | null;
}): { text: string; encoding: SupportedCsvEncoding } {
  if (params.forcedEncoding) {
    return {
      text: decodeWithEncoding(params.buffer, params.forcedEncoding),
      encoding: params.forcedEncoding,
    };
  }

  let best: DecodedCandidate | null = null;

  for (const encoding of ENCODINGS) {
    let text: string;
    try {
      text = decodeWithEncoding(params.buffer, encoding);
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
    return { text: params.buffer.toString("utf8"), encoding: "utf-8" };
  }

  return { text: best.text, encoding: best.encoding };
}

