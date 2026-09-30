import { csharpFileScope, parseCSharp } from '../substrate/csharp/substrate.js';
import type { CSharpProfile } from '../types/csharp-profile.js';
import type { LanguageProvider } from './types.js';
import { csharpSourceSignals } from '../substrate/csharp/signals.js';

export const csharpProvider = {
  language: 'csharp',
  discovery: { extensions: ['.cs'] },
  isProfile(value): value is CSharpProfile {
    if (!value || typeof value !== 'object' || !('parserId' in value) || !('substrate' in value)) return false;
    const substrate = value.substrate;
    return (
      !!substrate &&
      typeof substrate === 'object' &&
      'language' in substrate &&
      substrate.language === 'csharp' &&
      'include' in substrate &&
      Array.isArray(substrate.include)
    );
  },
  sourceFiles: (profile, root) => csharpFileScope(root, profile),
  parse: parseCSharp,
  sourceSignals: csharpSourceSignals,
} satisfies LanguageProvider<CSharpProfile>;
