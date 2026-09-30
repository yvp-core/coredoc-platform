import { describe, expect, it } from 'vitest';
import { isLanguageBuiltinCall } from './builtin-calls.js';

describe('isLanguageBuiltinCall', () => {
  it('flags language / runtime / framework built-ins by call tail', () => {
    for (const expr of [
      'items.map',
      'arr.filter',
      'list.push',
      'str.replace',
      'set.has',
      'map.get',
      'JSON.stringify',
      'Math.max',
      'promise.then',
      'console.log',
      'fs.existsSync',
      'path.join',
      'useState',
      'useEffect',
    ]) {
      expect(isLanguageBuiltinCall(expr), expr).toBe(true);
    }
  });

  it('does not flag repo-internal helpers / domain calls', () => {
    for (const expr of [
      'cn',
      'getOutputDir',
      'apiRequest',
      'WorkspaceRole',
      'this.controlPlane.listRepos',
      'repository.findByUuid',
      'svc.summarizeRepository',
    ]) {
      expect(isLanguageBuiltinCall(expr), expr).toBe(false);
    }
  });

  it('returns false for empty / undefined expressions', () => {
    expect(isLanguageBuiltinCall(undefined)).toBe(false);
    expect(isLanguageBuiltinCall('')).toBe(false);
  });
});
