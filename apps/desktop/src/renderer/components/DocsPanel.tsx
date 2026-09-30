import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogFooter } from './ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { useDocsStore } from '../stores/docs-store';
import { DocsCatalog } from './DocsCatalog';
import { DocsListView } from './DocsListView';
import { DocViewer } from './DocViewer';
import type { DocFileInfo, GitRevision } from '../../shared/ipc-types';
import type { WorkflowAction } from '../stores/project-detail-store';
import { ScrollArea } from './ui/scroll-area';
import { Label } from './ui/label';

interface DocsPanelProps {
  projectId: string;
  repoNames: string[];
  runningDocsRepos: string[];
  onSwitchToChat: () => void;
  runCommand: (repoName: string, action: WorkflowAction, args?: Record<string, unknown>) => Promise<void>;
  /** When set, opens the generate dialog with this prompt pre-selected. Caller must reset to null after. */
  dialogRequest?: { promptName?: string } | null;
  onDialogRequestHandled?: () => void;
  /** Git revisions keyed by repo name, for displaying version info on doc cards */
  gitRevisions?: Map<string, GitRevision>;
  isFullScreen?: boolean;
  /** Cloud member mode */
  isCloudMember?: boolean;
  cloudWorkspaceId?: string;
}

interface DocsRunArgsInput {
  promptName?: string;
  includeDependencies?: boolean;
  dagPath?: string;
  templateFile?: string;
}

export function DocsPanel({
  projectId,
  repoNames,
  runningDocsRepos,
  isFullScreen,
  onSwitchToChat,
  runCommand,
  dialogRequest,
  onDialogRequestHandled,
  gitRevisions,
  isCloudMember,
  cloudWorkspaceId,
}: DocsPanelProps) {
  const view = useDocsStore((s) => s.view);
  const isLoading = useDocsStore((s) => s.isLoading);
  const initForRepos = useDocsStore((s) => s.initForRepos);
  const loadDocs = useDocsStore((s) => s.loadDocs);
  const promptOptions = useDocsStore((s) => s.promptOptions);
  const activeDagPath = useDocsStore((s) => s.activeDagPath);
  const setActiveDagPath = useDocsStore((s) => s.setActiveDagPath);
  const defaultRepo = repoNames[0] ?? '';
  const docsRunning = runningDocsRepos.length > 0;

  const previousRunningCountRef = useRef(runningDocsRepos.length);

  // Dialog state for generation options
  const [showDialog, setShowDialog] = useState(false);
  const [dialogRepo, setDialogRepo] = useState(defaultRepo);
  const [dialogPrompt, setDialogPrompt] = useState<string | undefined>();
  const [dialogIncludeDeps, setDialogIncludeDeps] = useState(true);
  const [dialogDagPath, setDialogDagPath] = useState<string | undefined>(activeDagPath);
  const [dialogTemplateFile, setDialogTemplateFile] = useState<string | undefined>();

  useEffect(() => {
    initForRepos(projectId, repoNames, cloudWorkspaceId);
  }, [initForRepos, projectId, repoNames, cloudWorkspaceId]);

  useEffect(() => {
    if (dialogRepo && repoNames.includes(dialogRepo)) {
      return;
    }
    setDialogRepo(defaultRepo);
  }, [defaultRepo, dialogRepo, repoNames.includes]);

  useEffect(() => {
    setDialogDagPath(activeDagPath);
  }, [activeDagPath]);

  useEffect(() => {
    const previousCount = previousRunningCountRef.current;
    const currentCount = runningDocsRepos.length;
    if (previousCount > 0 && currentCount === 0 && repoNames.length > 0) {
      loadDocs(projectId, repoNames);
    }
    previousRunningCountRef.current = currentCount;
  }, [loadDocs, repoNames, runningDocsRepos.length]);

  // Open dialog when requested externally (e.g. from toolbar template selector)
  useEffect(() => {
    if (dialogRequest) {
      openGenerateDialog(dialogRequest.promptName, defaultRepo);
      onDialogRequestHandled?.();
    }
  }, [dialogRequest]);

  const openGenerateDialog = (promptName?: string, repoName?: string) => {
    setDialogRepo(repoName ?? defaultRepo);
    setDialogPrompt(promptName);
    setDialogIncludeDeps(true);
    setDialogTemplateFile(undefined);
    setShowDialog(true);
  };

  const handleCatalogGenerate = (promptName?: string) => {
    openGenerateDialog(promptName, defaultRepo);
  };

  const handleSelectTemplateDag = async () => {
    const result = await window.electronAPI.selectTemplateDag();
    if (!result.success) {
      console.error('Failed to select template DAG:', result.error);
      return;
    }
    if (result.canceled || !result.path) {
      return;
    }

    setDialogDagPath(result.path);
    await setActiveDagPath(result.path);
  };

  const handleClearTemplateDag = async () => {
    setDialogDagPath(undefined);
    await setActiveDagPath(undefined);
  };

  const handleSelectTemplateFile = async () => {
    const result = await window.electronAPI.selectTemplateFile();
    if (!result.success) {
      console.error('Failed to select template file:', result.error);
      return;
    }
    if (result.canceled || !result.path) {
      return;
    }
    setDialogTemplateFile(result.path);
    setDialogPrompt(undefined);
  };

  const handleDialogGenerate = async () => {
    if (!dialogPrompt && !dialogTemplateFile) {
      return;
    }
    setShowDialog(false);
    if (isCloudMember && cloudWorkspaceId) {
      // Cloud member — use cloud doc generation, routed through runCommand for
      // consistent UI (chat message, progress bar, terminal output)
      await runCommand(dialogRepo, 'cloud-docs', {
        workspaceId: cloudWorkspaceId,
        promptName: dialogPrompt,
      });
      onSwitchToChat();
    } else {
      const args = buildDocsArgs({
        promptName: dialogPrompt,
        includeDependencies: dialogIncludeDeps,
        dagPath: dialogDagPath,
        templateFile: dialogTemplateFile,
      });
      await runCommand(dialogRepo, 'docs', args);
      onSwitchToChat();
    }
  };

  const handleRegenerateDoc = async (doc: DocFileInfo) => {
    if (!doc.promptName) {
      return;
    }

    if (isCloudMember && cloudWorkspaceId) {
      await runCommand(doc.repoName, 'cloud-docs', {
        workspaceId: cloudWorkspaceId,
        promptName: doc.promptName,
      });
    } else {
      const args = buildDocsArgs({
        promptName: doc.promptName,
        includeDependencies: true,
        dagPath: activeDagPath,
      });
      await runCommand(doc.repoName, 'docs', args);
    }
  };

  const promptOptionsSorted = [...promptOptions].sort((left, right) => left.label.localeCompare(right.label));
  const templateFileSelected = !!dialogTemplateFile;

  if (isLoading && view === 'catalog') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-content-secondary">Loading documents...</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 flex flex-col min-h-0">
        <ScrollArea className="h-[calc(100vh-120px)]">
          <div className="flex-1 min-h-0">
            {view === 'catalog' && (
              <DocsCatalog promptOptions={promptOptionsSorted} onGenerate={handleCatalogGenerate} />
            )}
            {view === 'list' && <DocsListView gitRevisions={gitRevisions} isFullScreen={isFullScreen} />}
            {view === 'viewer' && <DocViewer onRegenerate={handleRegenerateDoc} isRegenerating={docsRunning} />}
          </div>
        </ScrollArea>
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate Documentation</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-2">
              <Label>Repository</Label>
              <Select value={dialogRepo} onValueChange={setDialogRepo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repoNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Document type</Label>
              <Select
                value={dialogPrompt ?? ''}
                onValueChange={(v) => setDialogPrompt(v || undefined)}
                disabled={templateFileSelected}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select document type" />
                </SelectTrigger>
                <SelectContent>
                  {/* <SelectItem value="__all__">All documentation</SelectItem> */}
                  {promptOptionsSorted.map((opt) => (
                    <SelectItem key={opt.prompt} value={opt.prompt}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {templateFileSelected && (
                <p className="text-xs text-content-tertiary">Disabled while a custom template file is selected.</p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Include dependencies</Label>
                <Switch
                  checked={dialogIncludeDeps}
                  disabled={!dialogPrompt || templateFileSelected}
                  onCheckedChange={setDialogIncludeDeps}
                />
              </div>
              {!dialogPrompt && !templateFileSelected && (
                <p className="text-xs text-content-tertiary">Applies only when generating a single document type.</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Template DAG (optional)</Label>
              <div className="flex items-center gap-2">
                <Input value={dialogDagPath ?? ''} placeholder="Use built-in prompts DAG" readOnly />
                <Button variant="outline" onClick={handleSelectTemplateDag}>
                  Select
                </Button>
                {dialogDagPath && (
                  <Button variant="ghost" onClick={handleClearTemplateDag}>
                    Clear
                  </Button>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Template file (optional)</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={dialogTemplateFile ?? ''}
                  placeholder="Generate from a standalone markdown template"
                  readOnly
                />
                <Button variant="outline" onClick={handleSelectTemplateFile}>
                  Select
                </Button>
                {dialogTemplateFile && (
                  <Button variant="ghost" onClick={() => setDialogTemplateFile(undefined)}>
                    Clear
                  </Button>
                )}
              </div>
              {dialogTemplateFile && (
                <p className="text-xs text-content-tertiary">
                  Runs only the selected template file for this repository.
                </p>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleDialogGenerate} disabled={docsRunning || (!dialogPrompt && !dialogTemplateFile)}>
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function buildDocsArgs(input: DocsRunArgsInput): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};

  if (input.templateFile) {
    args['template-file'] = input.templateFile;
    return args;
  }

  if (input.promptName) {
    if (input.includeDependencies) {
      args.prompt = input.promptName;
    } else {
      args.prompts = input.promptName;
    }
  }

  if (input.dagPath) {
    args['dag-path'] = input.dagPath;
  }

  return Object.keys(args).length > 0 ? args : undefined;
}
