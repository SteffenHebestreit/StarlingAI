export const DEFAULT_TTS_CHUNK_MAX_CHARS = 400;

function normalizeParagraph(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitLongWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let offset = 0; offset < word.length; offset += maxChars) {
        chunks.push(word.slice(offset, offset + maxChars));
      }
      continue;
    }

    if (!current) {
      current = word;
      continue;
    }

    if ((current.length + 1 + word.length) <= maxChars) {
      current = `${current} ${word}`;
      continue;
    }

    chunks.push(current);
    current = word;
  }

  if (current) chunks.push(current);
  return chunks;
}

function packSegments(segments: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const segment of segments) {
    const cleaned = normalizeParagraph(segment);
    if (!cleaned) continue;

    if (cleaned.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongWords(cleaned, maxChars));
      continue;
    }

    if (!current) {
      current = cleaned;
      continue;
    }

    if ((current.length + 1 + cleaned.length) <= maxChars) {
      current = `${current} ${cleaned}`;
      continue;
    }

    chunks.push(current);
    current = cleaned;
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitParagraphIntoSentences(paragraph: string): string[] {
  const sentences = paragraph.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(normalizeParagraph).filter(Boolean);
  if (sentences && sentences.length > 0) return sentences;
  return [paragraph];
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  const clauses = sentence.match(/[^,;:]+(?:[,;:]+(?=\s|$)|$)/g)?.map(normalizeParagraph).filter(Boolean);
  if (clauses && clauses.length > 1 && clauses.every((clause) => clause.length <= maxChars)) {
    return packSegments(clauses, maxChars);
  }
  return splitLongWords(sentence, maxChars);
}

export function splitTextForTts(text: string, maxChars = DEFAULT_TTS_CHUNK_MAX_CHARS): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n\s*\n+/).map(normalizeParagraph).filter(Boolean);
  const chunks: string[] = [];

  for (const paragraph of paragraphs) {
    const sentences = splitParagraphIntoSentences(paragraph);
    const nextChunks: string[] = [];
    let current = "";

    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        if (current) {
          nextChunks.push(current);
          current = "";
        }
        nextChunks.push(...splitLongSentence(sentence, maxChars));
        continue;
      }

      if (!current) {
        current = sentence;
        continue;
      }

      if ((current.length + 1 + sentence.length) <= maxChars) {
        current = `${current} ${sentence}`;
        continue;
      }

      nextChunks.push(current);
      current = sentence;
    }

    if (current) nextChunks.push(current);
    chunks.push(...nextChunks);
  }

  return chunks.length > 0 ? chunks : splitLongWords(normalized, maxChars);
}

function concatByteArrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString("ascii");
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  bytes.set(Buffer.from(value, "ascii"), offset);
}

type ParsedWavChunk = {
  formatChunk: Uint8Array;
  formatKey: string;
  audioData: Uint8Array;
};

function parseWavChunk(bytes: Uint8Array): ParsedWavChunk {
  if (bytes.byteLength < 12) {
    throw new Error("Chunked TTS merge requires WAV responses, but one response was too small to be a WAV file.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("Chunked TTS merge requires WAV responses, but one response was not a RIFF/WAVE file.");
  }

  let offset = 12;
  let formatChunk: Uint8Array | null = null;
  const dataChunks: Uint8Array[] = [];

  while ((offset + 8) <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > bytes.byteLength) {
      throw new Error("Chunked TTS merge received a truncated WAV response.");
    }

    const chunkBody = bytes.slice(chunkStart, chunkEnd);
    if (chunkId === "fmt ") {
      formatChunk = chunkBody;
    } else if (chunkId === "data") {
      dataChunks.push(chunkBody);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!formatChunk || dataChunks.length === 0) {
    throw new Error("Chunked TTS merge requires WAV responses with both fmt and data chunks.");
  }

  return {
    formatChunk,
    formatKey: Buffer.from(formatChunk).toString("base64"),
    audioData: concatByteArrays(dataChunks),
  };
}

export function mergeWavAudioChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    throw new Error("Chunked TTS merge requires at least one audio response.");
  }
  if (chunks.length === 1) return chunks[0]!;

  const parsedChunks = chunks.map(parseWavChunk);
  const baseFormat = parsedChunks[0]?.formatKey;
  if (!baseFormat) {
    throw new Error("Chunked TTS merge could not read the WAV format chunk.");
  }

  for (const parsed of parsedChunks.slice(1)) {
    if (parsed.formatKey !== baseFormat) {
      throw new Error("Chunked TTS merge requires all WAV responses to share the same audio format.");
    }
  }

  const formatChunk = parsedChunks[0]!.formatChunk;
  const audioData = concatByteArrays(parsedChunks.map((parsed) => parsed.audioData));
  const formatPadding = formatChunk.byteLength % 2;
  const dataPadding = audioData.byteLength % 2;
  const totalLength = 12 + 8 + formatChunk.byteLength + formatPadding + 8 + audioData.byteLength + dataPadding;
  const merged = new Uint8Array(totalLength);
  const view = new DataView(merged.buffer);

  writeAscii(merged, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeAscii(merged, 8, "WAVE");

  let offset = 12;
  writeAscii(merged, offset, "fmt ");
  view.setUint32(offset + 4, formatChunk.byteLength, true);
  merged.set(formatChunk, offset + 8);
  offset += 8 + formatChunk.byteLength + formatPadding;

  writeAscii(merged, offset, "data");
  view.setUint32(offset + 4, audioData.byteLength, true);
  merged.set(audioData, offset + 8);

  return merged;
}

export async function sendChunkedTtsRequests<TInput extends { text: string }>(
  input: TInput,
  options: {
    maxChunkChars?: number;
    requestChunk: (nextInput: TInput) => Promise<Response>;
  },
): Promise<Response> {
  const chunks = splitTextForTts(input.text, options.maxChunkChars);
  if (chunks.length <= 1) {
    return options.requestChunk(input);
  }

  const audioResponses: Uint8Array[] = [];
  let contentType = "audio/wav";

  for (const chunk of chunks) {
    const response = await options.requestChunk({ ...input, text: chunk } as TInput);
    if (!response.ok) return response;

    contentType = response.headers.get("content-type") ?? contentType;
    if (!contentType.toLowerCase().includes("audio/wav")) {
      return new Response(JSON.stringify({
        error: `Chunked TTS merge requires WAV audio, but the backend returned '${contentType}'.`,
      }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    audioResponses.push(new Uint8Array(await response.arrayBuffer()));
  }

  return new Response(mergeWavAudioChunks(audioResponses).buffer.slice(0) as ArrayBuffer, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}