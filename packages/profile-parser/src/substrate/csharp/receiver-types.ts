import type { Expression } from './model.js';

/** Roslyn receiver facts from the same isolated compilation as the SCIP index. */
export interface CSharpReceiverType {
  file: string;
  start: number;
  end: number;
  type?: string | null;
  typeArguments: string[];
}

export class CSharpReceiverTypes {
  private facts = new Map<string, CSharpReceiverType | null>();
  constructor(facts: CSharpReceiverType[]) {
    for (const fact of facts) {
      if (fact.file.startsWith('/') || fact.file.split('/').includes('..'))
        throw new Error('C# receiver type contains a path outside its source scope.');
      const key = `${fact.file}:${fact.start}:${fact.end}`;
      const previous = this.facts.get(key);
      this.facts.set(key, previous !== undefined && JSON.stringify(previous) !== JSON.stringify(fact) ? null : fact);
    }
  }
  get(file: string, expression: Expression): CSharpReceiverType | null | undefined {
    return this.facts.get(`${file}:${expression.start}:${expression.end}`);
  }
}
