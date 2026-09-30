// =============================================================================
// The ONE wiring point: every built-in LanguageProvider is registered here.
// Adding a language = add its provider module + one registerLanguage() line below.
// Importing @coredoc/profile-parser populates the registry as a side effect.
// =============================================================================
import { goProvider } from './go.js';
import { csharpProvider } from './csharp.js';
import { kotlinProvider } from './kotlin.js';
import { pythonProvider } from './python.js';
import { registerLanguage } from './registry.js';
import { rubyProvider } from './ruby.js';
import { rustProvider } from './rust.js';
import { swiftProvider } from './swift.js';
import { typescriptProvider } from './typescript.js';
import { zigProvider } from './zig.js';

registerLanguage(typescriptProvider);
registerLanguage(rubyProvider);
registerLanguage(swiftProvider);
registerLanguage(pythonProvider);
registerLanguage(rustProvider);
registerLanguage(goProvider);
registerLanguage(zigProvider);
registerLanguage(kotlinProvider);
registerLanguage(csharpProvider);

export { registerLanguage, getLanguage, allLanguages, providerForExport } from './registry.js';
export {
  isMultiTargetProfile,
  resolveProfileExport,
  resolveProfileModule,
  resolveTargets,
  type ResolvedProfileExport,
  type ResolvedTarget,
} from './resolve.js';
export { typescriptProvider } from './typescript.js';
export { rubyProvider } from './ruby.js';
export { swiftProvider } from './swift.js';
export { pythonProvider } from './python.js';
export { rustProvider } from './rust.js';
export { goProvider } from './go.js';
export { zigProvider } from './zig.js';
export { kotlinProvider } from './kotlin.js';
export { csharpProvider } from './csharp.js';
export type { LanguageProvider, LanguageDiscovery, ParseOptions } from './types.js';
export type { SourceFileScope } from '../substrate/source-file-scope.js';
