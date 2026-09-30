interface MatcherState {
  readonly transitions: Map<number, number>;
  failure: number;
  terminal: boolean;
}

/**
 * Streaming Aho-Corasick matcher for exact byte patterns.
 *
 * Construction is linear in the total pattern bytes; each scanned byte follows
 * at most one trie transition plus failure links, including across input chunks.
 */
export class ByteMultiPatternMatcher {
  private readonly states: MatcherState[] = [{ transitions: new Map(), failure: 0, terminal: false }];
  private state = 0;

  constructor(patterns: readonly Uint8Array[]) {
    const unique = new Set<string>();
    for (const pattern of patterns) {
      if (pattern.byteLength === 0) throw new Error('Byte matcher patterns must be non-empty');
      const bytes = Buffer.from(pattern);
      const identity = bytes.toString('base64');
      if (unique.has(identity)) continue;
      unique.add(identity);
      let state = 0;
      for (const byte of bytes) {
        const existing = this.states[state]!.transitions.get(byte);
        if (existing !== undefined) {
          state = existing;
          continue;
        }
        const next = this.states.length;
        this.states.push({ transitions: new Map(), failure: 0, terminal: false });
        this.states[state]!.transitions.set(byte, next);
        state = next;
      }
      this.states[state]!.terminal = true;
    }

    const queue: number[] = [];
    for (const child of this.states[0]!.transitions.values()) queue.push(child);
    for (let index = 0; index < queue.length; index += 1) {
      const state = queue[index]!;
      for (const [byte, child] of this.states[state]!.transitions) {
        queue.push(child);
        let fallback = this.states[state]!.failure;
        while (fallback !== 0 && !this.states[fallback]!.transitions.has(byte)) {
          fallback = this.states[fallback]!.failure;
        }
        const transition = this.states[fallback]!.transitions.get(byte);
        this.states[child]!.failure = transition ?? 0;
        this.states[child]!.terminal ||= this.states[this.states[child]!.failure]!.terminal;
      }
    }
  }

  reset(): void {
    this.state = 0;
  }

  push(chunk: Uint8Array): boolean {
    for (const byte of chunk) {
      while (this.state !== 0 && !this.states[this.state]!.transitions.has(byte)) {
        this.state = this.states[this.state]!.failure;
      }
      this.state = this.states[this.state]!.transitions.get(byte) ?? 0;
      if (this.states[this.state]!.terminal) return true;
    }
    return false;
  }

  matches(value: string | Uint8Array): boolean {
    this.reset();
    return this.push(typeof value === 'string' ? Buffer.from(value, 'utf8') : value);
  }
}
