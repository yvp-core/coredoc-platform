import { useQuery } from '@tanstack/react-query';
import { intentReleaseTriggerOptions } from '../../features/intent/intent-release-api';
import { intentCiWorkflow, type CiPlatform } from '../../../shared/intent-ci-workflow';
import { IntentReleaseTrigger } from '../../../shared/intent-release-types';
import { useState, useEffect, useCallback } from 'react';
import { CopyableCodeBlock } from '../McpConfigView';
import { CheckCircle, Copy, DangerTriangle, Eye, EyeClosed } from '@solar-icons/react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface TokenInfo {
  id: string;
  name: string;
  tokenPrefix: string | null;
  permissions: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

interface TeamMcpCiCdStepProps {
  workspaceId: string;
}

const CI_TOKEN_PERMISSIONS = new Set([
  'parser:read',
  'parser:write',
  'result:read',
  'result:write',
  'repo:push',
  'intent:release',
  'intent:bindings',
]);

export function selectCiToken(tokens: readonly TokenInfo[]): TokenInfo | undefined {
  return tokens.find(({ permissions }) => {
    const actual = new Set(permissions);
    return (
      actual.size === CI_TOKEN_PERMISSIONS.size &&
      [...CI_TOKEN_PERMISSIONS].every((permission) => actual.has(permission))
    );
  });
}

function SecretRow({
  label,
  value,
  placeholder,
  onToggleReveal,
  onCopyValue,
  isRevealed,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onToggleReveal?: () => void | Promise<void>;
  onCopyValue?: () => string | Promise<string>;
  isRevealed?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const revealable = !!onToggleReveal;

  const handleCopy = useCallback(async () => {
    try {
      const copyValue = onCopyValue ? await onCopyValue() : value;
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      return;
    }
  }, [onCopyValue, value]);

  const display = revealable && !isRevealed ? (placeholder ?? '••••••••••••••••') : value;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm leading-5 text-content-tertiary px-0.5">{label}</span>
      <div className="flex items-center gap-4 bg-selago-100 rounded-lg shadow-field px-3 py-2 w-full max-w-[800px] overflow-hidden">
        <p className="flex-1 min-w-0 text-sm font-medium leading-5 text-content-tertiary whitespace-nowrap overflow-hidden text-ellipsis">
          {display}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {revealable && (
            <button
              type="button"
              onClick={() => onToggleReveal?.()}
              className="size-4 cursor-pointer text-content-quaternary hover:text-content-secondary transition-colors"
              aria-label={isRevealed ? 'Hide' : 'Reveal'}
            >
              {isRevealed ? <EyeClosed size={16} /> : <Eye size={16} />}
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="size-4 cursor-pointer text-content-quaternary hover:text-content-secondary transition-colors"
            aria-label={copied ? 'Copied' : 'Copy'}
          >
            {copied ? <CheckCircle weight="Bold" size={16} /> : <Copy size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export function TeamMcpCiCdStep({ workspaceId }: TeamMcpCiCdStepProps) {
  const triggerQuery = useQuery(intentReleaseTriggerOptions(workspaceId));
  const reposQuery = useQuery({
    queryKey: ['intent', 'release-repos', workspaceId],
    queryFn: () => window.electronAPI.workspaceListRepos(workspaceId),
  });
  const serverQuery = useQuery({
    queryKey: ['workspace', 'server-config'],
    queryFn: () => window.electronAPI.workspaceGetServerConfig(),
  });
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [platform, setPlatform] = useState<CiPlatform>('github');

  const loadTokens = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await window.electronAPI.workspaceListTokens(workspaceId);
      setTokens(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const resolveTokenValue = useCallback(async (): Promise<string> => {
    if (revealedToken) return revealedToken;

    setError(null);
    const existing = selectCiToken(tokens);
    if (!existing) {
      try {
        const result = await window.electronAPI.workspaceCreateToken(workspaceId, 'ci');
        await loadTokens();
        return result.token;
      } catch (err) {
        setError((err as Error).message);
        throw err;
      }
    }

    try {
      const result = await window.electronAPI.workspaceGetTokenValue(workspaceId, existing.id);
      return result.token;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('404')) {
        try {
          await window.electronAPI.workspaceRevokeToken(workspaceId, existing.id);
          const created = await window.electronAPI.workspaceCreateToken(workspaceId, 'ci');
          await loadTokens();
          return created.token;
        } catch (e) {
          setError((e as Error).message);
          throw e;
        }
      }

      setError(msg);
      throw err;
    }
  }, [tokens, workspaceId, revealedToken, loadTokens]);

  const toggleTokenReveal = useCallback(async () => {
    if (revealedToken) {
      setRevealedToken(null);
      return;
    }

    try {
      const token = await resolveTokenValue();
      setRevealedToken(token);
    } catch {
      return;
    }
  }, [revealedToken, resolveTokenValue]);

  const setupUnavailable = triggerQuery.isError || reposQuery.isError || serverQuery.isError;
  const setupLoading = triggerQuery.isPending || reposQuery.isPending || serverQuery.isPending;
  const snippets =
    !setupLoading && !setupUnavailable
      ? (reposQuery.data.length
          ? reposQuery.data
          : [
              {
                id: 'bootstrap',
                intentRepoKey: null,
                repoName: platform === 'github' ? `\${{ github.event.repository.name }}` : '$CI_PROJECT_NAME',
                productionBranch: null,
                intentReleaseTrigger: null,
              },
            ]
        ).map((repo) => ({
          ...repo,
          ...intentCiWorkflow({
            repoName: repo.repoName,
            intentRepoKey: repo.intentRepoKey ?? null,
            productionBranch: repo.productionBranch ?? null,
            trigger: repo.intentReleaseTrigger ?? triggerQuery.data ?? IntentReleaseTrigger.Manual,
            serverUrl: serverQuery.data.url,
            platform,
          }),
        }))
      : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-content-tertiary">
        Loading CI/CD configuration...
      </div>
    );
  }

  const existingToken = selectCiToken(tokens);
  const tokenPlaceholder = existingToken?.tokenPrefix
    ? `${existingToken.tokenPrefix}••••••••••••••••••••••••`
    : 'cdt_••••••••••••••••••••••••';
  const tokenValue = revealedToken ?? tokenPlaceholder;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="ci-platform" className="text-sm font-medium text-content-secondary">
          CI provider
        </label>
        <Select
          value={platform}
          onValueChange={(value) => {
            if (value === 'github' || value === 'gitlab') setPlatform(value);
          }}
        >
          <SelectTrigger id="ci-platform" aria-label="CI provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="github">GitHub Actions</SelectItem>
            <SelectItem value="gitlab">GitLab CI</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error && <div className="px-3 py-2 rounded-md bg-red-500/10 text-sm text-red-400">{error}</div>}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium leading-5 text-content-secondary">Add secrets to your repository</h3>
        <p className="text-sm font-normal text-content-quaternary px-0.5">
          {platform === 'github'
            ? 'Go to your repository → Settings → Secrets and variables → Actions.'
            : 'Go to your project → Settings → CI/CD → Variables. Mask and protect COREDOC_TOKEN and set its environment scope to coredoc-publish (not *). Protect the production branch.'}
        </p>
        <SecretRow
          label="COREDOC_TOKEN:"
          value={tokenValue}
          placeholder={tokenPlaceholder}
          onToggleReveal={toggleTokenReveal}
          onCopyValue={resolveTokenValue}
          isRevealed={!!revealedToken}
        />
        <p className="text-sm leading-5 text-content-secondary">Required Environment Variables:</p>
        <SecretRow label="COREDOC_WORKSPACE_ID:" value={workspaceId} />
        {serverQuery.data && !serverQuery.isError && (
          <SecretRow label="Coredoc Server url:" value={serverQuery.data.url} />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium leading-5 text-content-secondary px-0.5">Workflow</h3>
        <div
          className="relative overflow-hidden rounded-2xl py-3 flex flex-col gap-0.5"
          style={{
            background: 'linear-gradient(76.4deg, #fde68a 0%, #fcd34d 100%)',
          }}
        >
          <div className="flex items-center gap-1 h-5 px-3">
            <DangerTriangle weight="Bold" className="size-4 text-content-primary shrink-0" />
            <span className="text-sm font-semibold leading-5 text-content-primary">Before you copy the workflow</span>
          </div>
          <div className="pl-8 pr-3">
            <p className="text-xs leading-4 text-content-secondary">
              The workflow uses each repository’s saved name and production branch. Check those settings before adding
              it to your pipeline. Uncomment setup blocks only for the languages you use.
            </p>
          </div>
        </div>

        <p className="text-sm leading-5 text-content-quaternary px-0.5">
          {platform === 'github'
            ? 'Add this workflow to .github/workflows/coredoc.yml in each repository:'
            : 'Merge these jobs into .gitlab-ci.yml in each repository:'}
        </p>
        <p className="text-sm leading-5 text-content-quaternary px-0.5">
          Check in .coredoc/profile.ts from the Intent Loop Setup guide. The CI token also syncs intent bindings. Match
          dependency commands to your package manager and workspace paths. One job parses all targets in a monorepo;
          setup downloads finish before parsing starts. These templates do not detect languages automatically.
        </p>
        {setupLoading && <p className="text-sm text-content-tertiary">Loading repository settings...</p>}
        {setupUnavailable && (
          <p role="alert" className="text-sm text-content-warning">
            Repository setup unavailable
          </p>
        )}
        {snippets.map((snippet) => (
          <div key={snippet.id} className="flex flex-col gap-2">
            <h4 className="text-sm font-medium text-content-secondary">{snippet.repoName}</h4>
            {!snippet.productionBranch && (
              <p className="text-sm text-content-tertiary">
                Run once manually to connect the repository, then set its production branch above to enable automatic
                graph sync.
              </p>
            )}
            <CopyableCodeBlock code={snippet.graph} language="yaml" />
            {snippet.deploymentNote && <p className="text-sm text-content-tertiary">{snippet.deploymentNote}</p>}
            {snippet.deploymentStep && (
              <>
                <p className="text-sm text-content-secondary">
                  Deploy mode: add this step to your production deployment job and connect its deployed SHA output. A
                  branch push alone does not confirm delivery.
                </p>
                <CopyableCodeBlock code={snippet.deploymentStep} language="yaml" />
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
