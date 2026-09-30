import type { StableIdGenerator } from '@coredoc/core';
import type { ScipCallFile } from '../../facts/scip/call-facts.js';
import { rustFunctionId, type RustFile, type TsNode } from './rust-cst.js';

/** Only actual invocation tokens enter the SCIP call join; values/references do not. */
export function rustScipCallFacts(files: RustFile[], idGen: StableIdGenerator): ScipCallFile[] {
  const defTypes = new Set(['function_item']);
  return files.map((file) => {
    const definitions: ScipCallFile['definitions'] = [];
    const calls: ScipCallFile['calls'] = [];
    for (const def of file.root.descendantsOfType([...defTypes]) as TsNode[]) {
      const name = def.childForFieldName('name');
      if (name)
        definitions.push({
          line: name.startPosition.row,
          start: name.startPosition.column,
          end: name.endPosition.column,
          id: rustFunctionId(idGen, file.relPath, def),
          name: name.text,
        });
    }
    for (const call of file.root.descendantsOfType('call_expression') as TsNode[]) {
      let owner = call.parent;
      while (owner && !defTypes.has(owner.type)) owner = owner.parent;
      if (!owner) continue;
      let token = call.childForFieldName('function');
      while (token?.type === 'generic_function') token = token.childForFieldName('function');
      const isMethodCall = token?.type === 'field_expression';
      if (token?.type === 'field_expression') token = token.childForFieldName('field');
      else if (token?.type === 'scoped_identifier') token = token.childForFieldName('name');
      if (!token || !['identifier', 'field_identifier'].includes(token.type)) continue;
      const callerId = rustFunctionId(idGen, file.relPath, owner);
      const line = call.startPosition.row + 1;
      const calleeExpression = call.text.split('\n')[0].slice(0, 120);
      calls.push({
        line: token.startPosition.row,
        start: token.startPosition.column,
        end: token.endPosition.column,
        name: token.text,
        edge: {
          id: idGen.callEdgeId(callerId, calleeExpression, `${file.relPath}:${line}`),
          callerId,
          calleeExpression,
          isMethodCall,
          location: { filePath: file.relPath, startLine: line, endLine: call.endPosition.row + 1 },
        },
      });
    }
    return { path: file.relPath, source: file.source, defaultPositionEncoding: 1, definitions, calls };
  });
}
