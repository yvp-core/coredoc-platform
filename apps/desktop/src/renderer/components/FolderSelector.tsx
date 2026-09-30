import { Folder, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import type { NewFolderInput } from '../types/project';
import { Label } from './ui/label';
import { getBaseName } from '../utils/platform';

interface FolderSelectorProps {
  selectedFolders: NewFolderInput[];
  onFoldersChange: (folders: NewFolderInput[]) => void;
  disabled?: boolean;
}

export function FolderSelector({ selectedFolders, onFoldersChange, disabled }: FolderSelectorProps) {
  const handleSelectFolders = async () => {
    const result = await window.electronAPI.selectFolders();
    if (result.success && result.paths && result.paths.length > 0) {
      const newFolders: NewFolderInput[] = result.paths
        .filter((folderPath) => {
          return !selectedFolders.some((f) => f.path === folderPath);
        })
        .map((folderPath) => ({
          path: folderPath,
          name: getBaseName(folderPath),
        }));
      onFoldersChange([...selectedFolders, ...newFolders]);
    }
  };

  const removeFolder = (path: string) => {
    onFoldersChange(selectedFolders.filter((f) => f.path !== path));
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Repository source:</Label>
        <Button type="button" variant="outline" size="sm" onClick={handleSelectFolders} disabled={disabled}>
          <Folder className="size-4 mr-1" />
          Add local repository
        </Button>
      </div>

      <div className="rounded-lg border border-alto-200 bg-alto-300 overflow-clip">
        {selectedFolders.length === 0 ? (
          <div className="flex min-h-20 flex-col items-center justify-center gap-0 text-center">
            <p className="text-xs font-bold leading-4 text-content-secondary">No local repositories selected</p>
            <p className="text-xs font-medium leading-4 text-content-quaternary">At least one repository is required</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[150px_1fr_40px]">
              <span className="py-1.5 pt-1.5 pr-2 pb-1 pl-3 text-xs font-semibold leading-4 text-content-quaternary">
                Repo-name
              </span>
              <span className="py-1.5 pt-1.5 pr-2 pb-1 text-xs font-semibold leading-4 text-content-quaternary">
                Location
              </span>
              <span />
            </div>
            <div className="max-h-[240px] overflow-y-auto scrollbar-thin">
              {selectedFolders.map((folder) => (
                <div
                  key={folder.path}
                  className="grid grid-cols-[150px_1fr_40px] items-center border-t border-alto-200 pr-1.5"
                >
                  <span className="truncate py-1.5 pr-2 pl-3 text-xs font-bold leading-4 text-content-secondary">
                    {folder.name}
                  </span>
                  <span className="truncate py-1.5 px-2 text-xs font-semibold leading-4 text-content-quaternary">
                    {folder.path}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 rounded-sm text-content-warning hover:text-content-warning"
                    onClick={() => removeFolder(folder.path)}
                    disabled={disabled}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
