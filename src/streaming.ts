export function splitTextForStreaming(text: string, chunkSize: number): string[] {
  if (!text) return [];
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) return [text];

  const size = Math.max(1, Math.floor(chunkSize));
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}

export function streamChunkExtraPause(chunk: string, punctPauseMs: number): number {
  if (punctPauseMs <= 0) return 0;
  if (!chunk) return 0;

  if (chunk.endsWith("\n")) return punctPauseMs;

  const trimmed = chunk.trimEnd();
  if (!trimmed) return 0;

  if (/[，、,]$/.test(trimmed)) return Math.floor(punctPauseMs * 0.5);
  if (/[。！？.!?；;：:]$/.test(trimmed)) return punctPauseMs;
  return 0;
}
