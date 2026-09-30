import { useEffect, useState } from 'react';
import type { AnalysisChoice, AnalysisPrompt } from '../../shared/ipc-types';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from './ui/dialog';

/** Global so a pending parse remains answerable after navigation or renderer reload. */
export function AnalysisPrerequisitesDialog() {
  const [prompts, setPrompts] = useState<AnalysisPrompt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void window.electronAPI
        .getAnalysisPrompts()
        .then((next) => {
          if (!disposed && request === revision) setPrompts(next);
        })
        .catch(() => {
          if (!disposed) setError('Could not load analysis status.');
        });
    };
    const unsubscribe = window.electronAPI.onAnalysisPromptsChanged(refresh);
    refresh();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  const prompt = prompts[0];
  if (!prompt) return null;
  const installing = prompt.phase === 'installing';
  const execution = prompt.phase === 'execution';
  const language =
    prompt.language === 'ruby'
      ? 'Ruby'
      : prompt.language === 'python'
        ? 'Python'
        : prompt.language === 'rust'
          ? 'Rust'
          : prompt.language === 'go'
            ? 'Go'
            : (prompt.language ?? 'C#');
  const answer = async (choice: AnalysisChoice) => {
    setBusy(true);
    setError(undefined);
    try {
      const accepted = await window.electronAPI.answerAnalysisPrompt(prompt.id, choice);
      if (!accepted) setError('This choice is no longer available. Please check the current analysis status.');
    } catch {
      setError('Could not send your choice. Please try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="grid-cols-1"
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {installing
              ? `Installing ${language} indexer`
              : execution
                ? `Run enhanced ${language} analysis?`
                : `Improve ${language} analysis`}
          </DialogTitle>
          <DialogDescription>
            {prompt.repoName} ·{' '}
            {installing ? 'Installing optional analysis tools' : 'Choose how to analyze this repository'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <output aria-live="polite" className="text-sm text-content-primary">
            {prompt.message}
          </output>
          {!installing && (
            <>
              {!execution && (
                <>
                  <p className="text-sm text-content-secondary">
                    {language === 'C#'
                      ? 'Enhanced analysis uses .NET SDK 10 and a C# indexer. Coredoc can download the indexer (about 18 MB) when you choose Install. The SDK is installed separately. Your source repository stays unchanged.'
                      : language === 'Ruby'
                        ? 'Coredoc can install the standalone Ruby indexer (about 19 MB on macOS, 42 MB on Linux). It needs no Gemfile changes or Ruby SDK. Your source repository stays unchanged.'
                        : language === 'Python'
                          ? 'Coredoc can install the Python indexer (about 4.4 MB). It analyzes project sources and bundled type stubs without executing Python or changing your environment.'
                          : 'Install the tools listed above, then choose Check again. Your source repository stays unchanged.'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {prompt.canInstall && (
                      <Button size="sm" disabled={busy} onClick={() => void answer('install')}>
                        Install {language} indexer
                      </Button>
                    )}
                    {language === 'C#' && (
                      <>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() =>
                            void window.electronAPI.openDeliveryExternal({
                              externalUrl: 'https://dotnet.microsoft.com/en-us/download',
                            })
                          }
                        >
                          Get .NET SDK
                        </Button>
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() =>
                            void window.electronAPI.openDeliveryExternal({
                              externalUrl: 'https://github.com/yvp-core/scip-dotnet',
                            })
                          }
                        >
                          scip-dotnet setup
                        </Button>
                      </>
                    )}
                  </div>
                </>
              )}
              <p className="text-sm text-content-secondary">
                Basic analysis uses the built-in parser. It extracts code structure and routes, with fewer resolved
                {language === 'C#' ? ' calls and data operations.' : ' internal calls.'}
              </p>
              {!prompt.canUseBasic && (
                <p className="text-sm text-content-tag-warning">
                  This profile requires enhanced analysis. Basic fallback is disabled.
                </p>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-content-warning">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button variant="secondary" disabled={busy} onClick={() => void answer('cancel')}>
            Cancel analysis
          </Button>
          {!installing && (
            <Button
              variant={prompt.canUseBasic ? 'secondary' : 'default'}
              disabled={busy}
              onClick={() => void answer(execution ? 'run' : 'retry')}
            >
              {execution ? 'Run enhanced' : 'Check again'}
            </Button>
          )}
          {!installing && prompt.canUseBasic && (
            <Button disabled={busy} onClick={() => void answer('basic')}>
              Use basic
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
