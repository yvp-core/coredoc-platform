/** Evaluate the C# conditional-directive boolean grammar without executing source. */
function condition(source: string, symbols: Set<string>): boolean {
  const tokens = source.match(/\w+|&&|\|\||==|!=|[!()]/g) ?? [];
  if (tokens.join('') !== source.replace(/\s/g, '')) throw new Error(`Unsupported conditional directive: ${source}`);
  let i = 0;
  function atom(): boolean {
    const token = tokens[i++];
    if (token === '!') return !atom();
    if (token === '(') {
      const value = or();
      if (tokens[i++] !== ')') throw new Error('Unbalanced conditional directive');
      return value;
    }
    if (!token || !/^\w+$/.test(token)) throw new Error('Invalid conditional directive');
    return token === 'true' || (token !== 'false' && symbols.has(token));
  }
  function eq(): boolean {
    let value = atom();
    while (tokens[i] === '==' || tokens[i] === '!=') {
      const operator = tokens[i++];
      const right = atom();
      value = operator === '==' ? value === right : value !== right;
    }
    return value;
  }
  function and(): boolean {
    let value = eq();
    while (tokens[i] === '&&') {
      i++;
      const right = eq();
      value = value && right;
    }
    return value;
  }
  function or(): boolean {
    let value = and();
    while (tokens[i] === '||') {
      i++;
      const right = and();
      value = value || right;
    }
    return value;
  }
  const result = or();
  if (i !== tokens.length) throw new Error('Invalid conditional directive');
  return result;
}

/** Select an explicitly configured build's branches, preserving every source offset. */
export function preprocess(source: string, defines: string[]): string {
  const symbols = new Set(defines);
  const stack: { parent: boolean; selected: boolean; active: boolean; sawElse: boolean }[] = [];
  const lines = source.split(/(?<=\n)/);
  let blockComment = false;
  let multilineQuote = '';
  const blank = (line: string) => line.replace(/[^\r\n]/g, ' ');
  const result = lines.map((input) => {
    let line = input;
    const directive =
      !blockComment && !multilineQuote ? /^\s*#(if|elif|else|endif|define|undef)\b(.*)/.exec(line) : null;
    const active = stack.at(-1)?.active ?? true;
    if (directive) {
      const kind = directive[1];
      const text = directive[2]!.replace(/\/\/.*$/, '').trim();
      if (kind === 'if') {
        const selected = condition(text, symbols);
        stack.push({ parent: active, selected, active: active && selected, sawElse: false });
      } else if (kind === 'elif' || kind === 'else') {
        const frame = stack.at(-1);
        if (!frame || frame.sawElse) throw new Error('Unmatched conditional branch');
        const selected = kind === 'else' || condition(text, symbols);
        frame.active = frame.parent && !frame.selected && selected;
        frame.selected ||= selected;
        frame.sawElse = kind === 'else';
      } else if (kind === 'endif') {
        if (!stack.pop()) throw new Error('Unmatched #endif');
      } else if (active) {
        if (!/^\w+$/.test(text)) throw new Error('Invalid preprocessor symbol');
        if (kind === 'define') symbols.add(text);
        else symbols.delete(text);
      }
      return blank(line);
    }
    if (!active) return blank(line);
    // Track multiline comments/strings so text resembling a directive inside a
    // literal remains source. Ordinary strings and char literals end on this line.
    for (let i = 0; i < line.length; i++) {
      if (blockComment) {
        if (line.startsWith('*/', i)) {
          blockComment = false;
          i++;
        }
        continue;
      }
      if (multilineQuote) {
        if (multilineQuote === '@"' && line.startsWith('""', i)) {
          i++;
          continue;
        }
        const end = multilineQuote === '@"' ? '"' : multilineQuote;
        if (line.startsWith(end, i)) {
          i += end.length - 1;
          multilineQuote = '';
        }
        continue;
      }
      if (line.startsWith('//', i)) break;
      if (line.startsWith('/*', i)) {
        blockComment = true;
        i++;
        continue;
      }
      if (line.startsWith('@"', i)) {
        multilineQuote = '@"';
        i++;
        continue;
      }
      // The bundled grammar rejects the empty interpolated string `$""`; the same-length
      // plain literal keeps every later offset aligned with the compiler index.
      if (line.startsWith('$""', i) && line[i + 3] !== '"') {
        line = `${line.slice(0, i)} ""${line.slice(i + 3)}`;
        i += 2;
        continue;
      }
      const raw = /^"{3,}/.exec(line.slice(i));
      if (raw) {
        multilineQuote = raw[0];
        i += raw[0].length - 1;
        continue;
      }
      if (line[i] === '"' || line[i] === "'") {
        const quote = line[i++];
        while (i < line.length && line[i] !== quote) {
          if (line[i] === '\\') i++;
          i++;
        }
      }
    }
    return line;
  });
  if (stack.length) throw new Error('Unterminated #if');
  return result.join('');
}
