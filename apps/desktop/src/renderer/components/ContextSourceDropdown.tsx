import { ShareCircle, CodeFile } from '@solar-icons/react';
import { Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from './ui/dropdown-menu';
import type { ContextSelection } from '../stores/project-detail-store';
import { cn } from '../lib/utils';

interface ContextSourceDropdownProps {
  repoNames: string[];
  contextSelection: ContextSelection;
  onSelect: (ctx: ContextSelection) => void;
}

export function ContextSourceDropdown({ repoNames, contextSelection, onSelect }: ContextSourceDropdownProps) {
  const label = contextSelection.kind === 'project' ? 'Project Graph' : contextSelection.repoName;
  const Icon = contextSelection.kind === 'project' ? ShareCircle : CodeFile;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 p-0.5 text-xs font-semibold leading-4 text-content-secondary cursor-pointer hover:text-content-primary transition-colors"
        >
          <Icon weight="Bold" className="size-4" />
          <span>Context Source: {label}</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-[200px] p-1 bg-bg-overlay rounded-md shadow-surface">
        <DropdownMenuLabel className="text-xs leading-4 text-content-quaternary px-2 pt-1 pb-px">
          Send question to…
        </DropdownMenuLabel>

        {/* Project Graph option */}
        <DropdownMenuItem
          onClick={() => onSelect({ kind: 'project' })}
          className={cn(
            'flex items-center justify-between px-2 py-1.5 rounded-sm text-sm leading-5 font-normal text-content-action-secondary cursor-pointer',
            contextSelection.kind === 'project' && 'bg-bg-overlay-hover',
          )}
        >
          <div className="flex items-center gap-1">
            <ShareCircle weight="Bold" className="size-4" />
            <span>Project Graph</span>
          </div>
          {contextSelection.kind === 'project' && <Check className="size-4 text-content-secondary" />}
        </DropdownMenuItem>

        {/* Repo options */}
        {repoNames.map((name) => {
          const isSelected = contextSelection.kind === 'repo' && contextSelection.repoName === name;
          return (
            <DropdownMenuItem
              key={name}
              onClick={() => onSelect({ kind: 'repo', repoName: name })}
              className={cn(
                'flex items-center justify-between px-2 py-1.5 rounded-sm text-sm leading-5 font-normal text-content-action-secondary cursor-pointer',
                isSelected && 'bg-bg-overlay-hover',
              )}
            >
              <div className="flex items-center gap-1">
                <CodeFile className="size-4" />
                <span>{name}</span>
              </div>
              {isSelected && <Check className="size-4 text-content-secondary" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
