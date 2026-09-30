import { useMemo, Fragment } from 'react';
import { Programming } from '@solar-icons/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { XTerminal } from './XTerminal';
import type { RunningCommand } from '../stores/project-detail-store';

interface RepoTerminalTabsProps {
  repoNames: string[];
  activeTerminalRepo: string | null;
  runningCommands: Map<string, RunningCommand>;
  terminalClearCounter: Map<string, number>;
  onSetActiveRepo: (repoName: string) => void;
  hideTabs?: boolean;
  hideHeader?: boolean;
}

export function RepoTerminalTabs({
  repoNames,
  activeTerminalRepo,
  runningCommands,
  terminalClearCounter,
  onSetActiveRepo,
  hideTabs,
  hideHeader,
}: RepoTerminalTabsProps) {
  const hasAnyRepos = repoNames.length > 0;

  // If active tab doesn't exist in repos, default to first (unless hideTabs — single-repo mode)
  const activeTab =
    activeTerminalRepo && repoNames.includes(activeTerminalRepo)
      ? activeTerminalRepo
      : hideTabs
        ? null
        : (repoNames[0] ?? null);

  // Build a map of repo -> active command IDs
  const commandIdsByRepo = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [id, cmd] of runningCommands) {
      let set = map.get(cmd.repoName);
      if (!set) {
        set = new Set();
        map.set(cmd.repoName, set);
      }
      set.add(id);
    }
    return map;
  }, [runningCommands]);

  const isIdle = runningCommands.size === 0;

  if (!hasAnyRepos || (hideTabs && !activeTab)) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        {!hideHeader && (
          <div className="flex h-[30px] items-end rounded-t-lg border border-b-0 border-border-inverted bg-bg-inverted-secondary px-1 text-content-quaternary">
            <span className="inline-flex items-center gap-1.5 rounded-t-[4px] px-3 pt-0.5 pb-1.5 font-sans text-xs font-light leading-4 tracking-normal">
              <Programming weight="Outline" className="size-3.5" />
              Terminal
            </span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center rounded-b-xl border border-t-0 border-border-inverted bg-bg-inverted text-xs font-light text-content-inverted">
          Run an action to see output here...
        </div>
      </div>
    );
  }

  return (
    <Tabs
      value={activeTab ?? undefined}
      onValueChange={onSetActiveRepo}
      className="flex-1 flex flex-col min-h-0 gap-0 border-none"
    >
      {hideTabs && !hideHeader ? (
        <div className="flex h-[30px] items-end rounded-t-lg border border-b-0 border-border-inverted bg-bg-inverted-secondary px-1 text-content-quaternary">
          {isIdle ? (
            <span className="inline-flex items-center gap-1.5 rounded-t-[4px] px-3 pt-0.5 pb-1.5 font-sans text-xs font-light leading-4 tracking-normal">
              <Programming weight="Outline" className="size-3.5" />
              Terminal
            </span>
          ) : (
            <span className="inline-flex items-center gap-2.5 rounded-t-[4px] bg-bg-inverted px-3 pt-0.5 pb-1.5 font-sans text-xs font-light leading-4 tracking-normal">
              {repoNames.length === 1 ? repoNames[0] : 'Terminal'}
            </span>
          )}
        </div>
      ) : !hideTabs ? (
        <TabsList className="h-[30px] w-full items-end justify-start gap-1 rounded-t-lg rounded-b-none border border-b-0 border-border-inverted bg-bg-inverted-secondary px-1 pb-0 text-content-quaternary">
          {repoNames.map((name, index) => {
            const isPrevActive = index > 0 && repoNames[index - 1] === activeTab;
            const isCurrentActive = name === activeTab;
            const showDivider = repoNames.length >= 3 && index > 0 && !isPrevActive && !isCurrentActive;
            return (
              <Fragment key={name}>
                <TabsTrigger
                  value={name}
                  className="relative inline-flex h-auto flex-none cursor-pointer items-center gap-2.5 rounded-t-[4px] rounded-b-none border-none px-3 pt-0.5 pb-1.5 font-sans text-xs font-light leading-4 tracking-normal text-content-quaternary hover:text-content-inverted data-[state=active]:bg-bg-inverted data-[state=active]:text-content-quaternary"
                >
                  {showDivider && (
                    <div
                      className="absolute left-[-0.5px] top-1/2 -translate-y-1/2 rounded-full bg-border-inverted"
                      style={{ width: '1px', height: '12px' }}
                    />
                  )}
                  {name}
                </TabsTrigger>
              </Fragment>
            );
          })}
        </TabsList>
      ) : null}

      {repoNames.map((name) => (
        <TabsContent
          key={name}
          value={name}
          forceMount
          className="m-0 flex min-h-0 flex-1 flex-col rounded-b-xl border border-t-0 border-border-inverted bg-bg-inverted px-3 py-2"
          style={{ display: activeTab === name ? 'flex' : 'none' }}
        >
          <XTerminal
            repoName={name}
            activeCommandIds={commandIdsByRepo.get(name) || new Set()}
            clearCounter={terminalClearCounter.get(name) || 0}
            isVisible={activeTab === name}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
