import { isolationPrerequisite } from '../../facts/scip/system-tools.js';
import { existsSync } from 'node:fs';
import { installedTool, installTool, type PinnedTool, type ToolInstallOptions } from '../../facts/scip/tool-install.js';

export function rubyToolRelease(platform = process.platform, arch = process.arch): PinnedTool {
  const release =
    platform === 'darwin' && arch === 'arm64'
      ? { asset: 'arm64-darwin', sha256: '21eae26b54402b04214ba5e6f6014c9f6b0fa394352825f33eb6314666dabd79' }
      : platform === 'linux' && arch === 'x64' && !existsSync('/etc/alpine-release')
        ? { asset: 'x86_64-linux', sha256: '125982c27b59f8f35e6eb2904718789a4bdf28b0637baad9532977769b6058a7' }
        : undefined;
  if (!release)
    throw new Error(
      'The Ruby indexer supports macOS ARM64 and Linux x64 (glibc). Use basic analysis on this platform.',
    );
  return {
    name: 'scip-ruby',
    version: '0.4.8',
    entry: 'scip-ruby',
    url: `https://github.com/sourcegraph/scip-ruby/releases/download/scip-ruby-v0.4.8/scip-ruby-${release.asset}`,
    sha256: release.sha256,
  };
}

export function installedRubyTool(repoRoot?: string): string | undefined {
  try {
    return installedTool(rubyToolRelease(), repoRoot);
  } catch {
    return undefined;
  }
}

export function installRubyTool(repoRoot?: string, options?: ToolInstallOptions): Promise<string> {
  return installTool(rubyToolRelease(), repoRoot, options);
}

export function rubyScipPrereqs(repoRoot: string): string | null {
  const issue = isolationPrerequisite();
  if (issue) return issue;
  try {
    rubyToolRelease();
  } catch (error) {
    return (error as Error).message;
  }
  return installedRubyTool(repoRoot)
    ? null
    : 'The optional Ruby indexer is missing. Run coredoc tools install ruby or choose basic analysis. No Gemfile changes are required.';
}
