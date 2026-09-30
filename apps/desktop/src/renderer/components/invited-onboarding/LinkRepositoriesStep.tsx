import type { LinkedRepo } from '../../../shared/ipc-types';
import type { WorkspaceRepo } from '../../stores/workspace-store';
import { Button } from '../ui/button';
import { CodeFile, LinkMinimalistic } from '@solar-icons/react';

interface LinkRepositoriesStepProps {
  repos: WorkspaceRepo[];
  linked: LinkedRepo[];
  onLink: (repoName: string) => void | Promise<void>;
  onUnlink: (repoName: string) => void | Promise<void>;
}

export function LinkRepositoriesStep({ repos, linked, onLink, onUnlink }: LinkRepositoriesStepProps) {
  const pathFor = (repoName: string) => linked.find((r) => r.repoName === repoName)?.localPath;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-content-tertiary">
        Match the project's repositories to your local folders. This gives your AI client access to both your code and
        the semantic graph for more complete answers.
      </p>

      <div className="flex flex-col gap-1">
        <p className="text-sm text-content-secondary">Workspace repositories:</p>
        <ul className="flex flex-col">
          {repos.map((repo) => {
            const localPath = pathFor(repo.repoName);
            return (
              <li
                key={repo.repoName}
                className="flex items-center justify-between gap-3 px-4 py-3 shadow-surface rounded-lg border border-border-tertiary"
              >
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <CodeFile weight="Bold" className="size-4" />
                  <p className="text-sm font-semibold text-content-primary truncate">{repo.repoName}</p>
                </div>
                {localPath ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => onUnlink(repo.repoName)}>
                    <LinkMinimalistic weight="Outline" className="size-4" />
                    Unlink
                  </Button>
                ) : (
                  <Button type="button" variant="secondary" size="sm" onClick={() => onLink(repo.repoName)}>
                    <LinkMinimalistic weight="Outline" className="size-4" />
                    Link to local repo
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <p className="text-xs text-content-quaternary text-normal">
        You can always relink repositories later from the project menu (⋮).
      </p>
    </div>
  );
}
