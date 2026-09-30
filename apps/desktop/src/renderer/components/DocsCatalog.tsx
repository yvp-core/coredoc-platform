import { DocumentText } from '@solar-icons/react';
import type { DocsPromptOption } from '../../shared/ipc-types';

interface DocsCatalogProps {
  promptOptions: DocsPromptOption[];
  onGenerate: (promptName?: string) => void;
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

export function DocsCatalog({ promptOptions, onGenerate }: DocsCatalogProps) {
  const groups = groupPromptOptions(promptOptions);

  return (
    <div className="flex-1">
      <div className="flex flex-col items-center p-6 pb-10">
        <div className="flex items-center gap-3 mb-8">
          <img src="./logo.svg" alt="Coredoc" className="w-10 h-10" />
          <span className="text-2xl font-semibold">Coredoc.ai</span>
        </div>

        <div className="w-full max-w-[800px] space-y-6">
          <div>
            <h3 className="text-xs font-medium text-content-tertiary mb-3">Generate All</h3>
            <div className="flex gap-2">
              <button
                className="flex w-[188px] flex-col items-start gap-1.5 p-4 rounded-md border border-border-tertiary hover:bg-bg-overlay transition-colors text-left"
                onClick={() => onGenerate(undefined)}
              >
                <DocumentText className="size-4 text-content-tertiary" />
                <span className="text-xs leading-4 text-content-tertiary">Full documentation</span>
              </button>
            </div>
          </div>

          {groups.map((group) => (
            <div key={group.category}>
              <h3 className="text-xs font-medium text-content-tertiary mb-3">{group.category}</h3>
              <div className="flex gap-2 flex-wrap">
                {group.items.map((item) => (
                  <button
                    key={item.prompt}
                    className="flex w-[188px] flex-col items-start gap-1.5 p-4 rounded-md border border-border-tertiary hover:bg-bg-overlay transition-colors text-left"
                    onClick={() => onGenerate(item.prompt)}
                  >
                    <DocumentText className="size-4 text-content-tertiary" />
                    <span className="text-xs leading-4 text-content-tertiary">{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {groups.length === 0 && (
            <div className="border border-border-tertiary rounded-md p-4 text-xs text-content-tertiary">
              No prompts available for the selected template DAG.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
