import { csharpFileScope, parseCSharp } from '../substrate/csharp/substrate.js';
import type { CSharpProfile } from '../types/csharp-profile.js';
import { hasLanguage } from './registry.js';
import type { LanguageProvider } from './types.js';
import { csharpSourceSignals } from '../substrate/csharp/signals.js';

export const csharpProvider = {
  language: 'csharp',
  discovery: { extensions: ['.cs'] },
  isProfile: (v): v is CSharpProfile =>
    hasLanguage(v, 'csharp') && Array.isArray((v as CSharpProfile).substrate.include),
  sourceFiles: (profile, root) => csharpFileScope(root, profile),
  parse: parseCSharp,
  sourceSignals: csharpSourceSignals,
} satisfies LanguageProvider<CSharpProfile>;
