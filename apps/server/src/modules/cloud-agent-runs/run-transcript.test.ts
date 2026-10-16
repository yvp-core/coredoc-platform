import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { redactTranscript } from './run-transcript.js';

describe('redactTranscript', () => {
  it('masks lines split across chunks, multi-byte characters included, and a last line without a newline', async () => {
    const token = 'ghp_0123456789abcdefghijABCDEFGHIJ012345';
    const source = Buffer.from(
      `${JSON.stringify({ text: `café ${token}` })}\n${JSON.stringify({ text: 'ok' })}\n{"text":"tail ${token}"}`,
    );
    // Seven-byte chunks cut the token, the lines and the two-byte "é".
    const chunks = Array.from({ length: Math.ceil(source.length / 7) }, (_, index) =>
      source.subarray(index * 7, index * 7 + 7),
    );

    let out = '';
    for await (const chunk of Readable.from(chunks).pipe(redactTranscript())) out += chunk.toString();
    expect(out).toBe('{"text":"café [REDACTED]"}\n{"text":"ok"}\n{"text":"tail [REDACTED]"}');
  });
});
