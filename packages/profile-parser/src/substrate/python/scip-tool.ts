import { isolatedPlatformPrerequisite } from '../../facts/scip/system-tools.js';
import { installedTool, installTool, type PinnedTool, type ToolInstallOptions } from '../../facts/scip/tool-install.js';

export const PYTHON_SCIP_RELEASE: PinnedTool = {
  name: 'scip-python',
  version: '0.6.6',
  entry: 'index.js',
  url: 'https://registry.npmjs.org/@sourcegraph/scip-python/-/scip-python-0.6.6.tgz',
  sha256: 'be8e0a1ec180423c60e9f2c2672c208f49a35ab690ac0f8f1259e4223dbd6e42',
  archive: { prefix: 'package', contentsSha256: '37a3775d5ef1872bdf19f7ff429b3d51b8f234099872d4fa91bf35386d685fa4' },
};

export function installedPythonTool(repoRoot?: string): string | undefined {
  return installedTool(PYTHON_SCIP_RELEASE, repoRoot);
}

export function installPythonTool(repoRoot?: string, options?: ToolInstallOptions): Promise<string> {
  return installTool(PYTHON_SCIP_RELEASE, repoRoot, options);
}

export function pythonScipPrereqs(repoRoot: string): string | null {
  const gate = isolatedPlatformPrerequisite(
    'Enhanced Python analysis requires macOS or Linux with bubblewrap. Use basic analysis on this platform.',
  );
  if (gate) return gate;
  return installedPythonTool(repoRoot)
    ? null
    : 'The optional Python indexer is missing. Run coredoc tools install python or choose basic analysis. No Python environment changes are required.';
}
