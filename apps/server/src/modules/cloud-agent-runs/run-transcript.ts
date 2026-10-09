/**
 * Finds a Claude Code session transcript inside a state archive (the
 * runner's gzip tar of its state directory) without buffering either: the
 * archive is read as a stream until the transcript's entry, whose body is then
 * handed out as a stream; the rest of the archive is never read.
 */
import { StringDecoder } from 'node:string_decoder';
import { PassThrough, type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { redactTranscriptLine } from './redact-secrets.js';

/**
 * Above this a transcript is refused rather than downloaded. Archives are
 * capped compressed (MAX_STATE_ARCHIVE_BYTES); JSONL compresses well, so a
 * transcript can be several times larger than its archive.
 */
export const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

export type TranscriptLookup =
  | { kind: 'found'; size: number; stream: Readable }
  | { kind: 'missing' }
  | { kind: 'too_large'; size: number };

const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

/** Claude Code keeps a session at `<config dir>/projects/<project>/<session id>.jsonl`; the config dir is `claude/`. */
function transcriptPath(sessionId: string): RegExp {
  const id = sessionId.replace(/[^0-9a-f-]/gi, '');
  return new RegExp(`^(?:\\./)?claude/projects/[^/]+/${id}\\.jsonl$`);
}

/**
 * Looks for the session's transcript in the archive stream. On `found` the
 * caller must consume or destroy the stream; the archive is released when
 * the stream ends or closes. Otherwise the archive is already released.
 */
export function findTranscript(
  archive: Readable,
  sessionId: string,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): Promise<TranscriptLookup> {
  const wanted = transcriptPath(sessionId);
  return new Promise((resolve, reject) => {
    let settled = false;
    let delivered = false;
    let out: PassThrough | null = null;
    const release = () => {
      if (!archive.destroyed) archive.destroy();
    };
    const parser = new tar.Parser({
      strict: true,
      onReadEntry: (entry) => {
        if (settled || !FILE_TYPES.has(entry.type) || !wanted.test(entry.path)) {
          entry.resume();
          return;
        }
        settled = true;
        if (entry.size > maxBytes) {
          release();
          resolve({ kind: 'too_large', size: entry.size });
          return;
        }
        const stream = new PassThrough();
        out = stream;
        entry.on('end', () => {
          delivered = true;
          release();
        });
        stream.on('close', release);
        entry.pipe(stream);
        resolve({ kind: 'found', size: entry.size, stream });
      },
    });
    pipeline(archive, parser).then(
      () => {
        if (!settled) resolve({ kind: 'missing' });
      },
      (error: unknown) => {
        // Releasing the archive early ends the pipeline with an error: expected once settled.
        if (!settled) reject(error);
        else if (out && !delivered) out.destroy(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Masks a transcript line by line with the server's secret patterns, the
 * same ones events get. Archives are stored unredacted; downloads are not.
 */
export function redactTranscript(): Transform {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      // Only the new text is searched, so a long line is not rescanned chunk after chunk.
      const text = decoder.write(chunk);
      const last = text.lastIndexOf('\n');
      if (last === -1) {
        partial += text;
        return done();
      }
      const complete = partial + text.slice(0, last);
      partial = text.slice(last + 1);
      done(null, `${complete.split('\n').map(redactTranscriptLine).join('\n')}\n`);
    },
    flush(done) {
      partial += decoder.end();
      done(null, partial ? redactTranscriptLine(partial) : '');
    },
  });
}
