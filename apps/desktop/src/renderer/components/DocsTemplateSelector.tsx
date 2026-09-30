import { useState, type ReactNode } from 'react';
import { DocumentText, Documents } from '@solar-icons/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu';
import { useDocsStore } from '../stores/docs-store';
import type { DocsPromptOption } from '../../shared/ipc-types';

interface DocsTemplateSelectorProps {
  onSelect: (promptName?: string) => void;
  trigger: ReactNode;
}

interface CatalogGroup {
  category: string;
  items: DocsPromptOption[];
}

function groupPromptOptions(promptOptions: DocsPromptOption[]): CatalogGroup[] {
  const groups = new Map<string, DocsPromptOption[]>();
  for (const prompt of promptOptions) {
    const current = groups.get(prompt.category) || [];
    current.push(prompt);
    groups.set(prompt.category, current);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      items: [...items].sort((left, right) => left.label.localeCompare(right.label)),
    }));
}

export function DocsTemplateSelector({ onSelect, trigger }: DocsTemplateSelectorProps) {
  const promptOptions = useDocsStore((s) => s.promptOptions);
  const groups = groupPromptOptions(promptOptions);
  const [open, setOpen] = useState(false);

  const handleSelect = (promptName: string) => {
    onSelect(promptName);
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        alignOffset={-12}
        className="w-[267px] p-1 bg-bg-primary-hover shadow-surface rounded-md ring-0 border-none"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="max-h-[480px] overflow-y-auto">
          {/* All documentation */}
          <div
            className="flex items-center gap-1 w-full px-2 py-1.5 rounded-sm text-sm leading-5 cursor-default select-none text-content-action-secondary hover:bg-bg-overlay-hover"
            onClick={() => {
              onSelect(undefined);
              setOpen(false);
            }}
          >
            <Documents className="size-4 shrink-0" />
            <span className="truncate">All documentation</span>
          </div>

          {groups.map((group) => (
            <div key={group.category}>
              {/* Category label */}
              <div className="pt-1 pb-px text-xs leading-4 text-content-quaternary text-center select-none">
                {group.category}
              </div>

              {/* Items */}
              {group.items.map((item) => (
                <div
                  key={item.prompt}
                  className="flex items-center gap-1 w-full px-2 py-1.5 rounded-sm text-sm leading-5 cursor-default select-none text-content-action-secondary hover:bg-bg-overlay-hover"
                  onClick={() => handleSelect(item.prompt)}
                >
                  <DocumentText className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </div>
              ))}
            </div>
          ))}

          {groups.length === 0 && (
            <div className="px-2 py-3 text-sm text-content-quaternary text-center select-none">
              No templates available
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
