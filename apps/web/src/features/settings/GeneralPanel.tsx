import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '@/api/client';
import { renameWorkspace, workspaceConfigQueryOptions } from '@/api/queries/workspace-config';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function GeneralPanel({ wsId, canManage }: { wsId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { data: config } = useSuspenseQuery(workspaceConfigQueryOptions(wsId));
  const [name, setName] = useState(config.workspace.name);
  const [validation, setValidation] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const mutation = useMutation({
    mutationFn: renameWorkspace,
    onSuccess: () => {
      setSaved(true);
      // 'config' feeds this card and Overview; 'me' feeds the workspace
      // switcher label in the shell.
      queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'config'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (name.trim() === '') {
      setValidation('Name is required');
      return;
    }
    setValidation(null);
    mutation.mutate({ wsId, name: name.trim() });
  }

  const error =
    validation ??
    (mutation.error ? (mutation.error instanceof ApiError ? mutation.error.message : 'Failed to rename') : null);

  return (
    <Card>
      {/* The slug is immutable — UpdateWorkspaceDto has no `slug` field, so no rename is offered for it. */}
      <CardHead title="General" sub={config.workspace.slug} />
      <CardBody>
        {canManage ? (
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="workspace-name">Workspace name</Label>
              <Input
                id="workspace-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setSaved(false);
                }}
                className="w-72"
              />
            </div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
            {saved && !error && <span className="pb-1.5 text-[12px] text-brand-text">Saved</span>}
          </form>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-[11.5px] text-ink-4">Workspace name</span>
            <span className="text-[12.5px] text-ink-1">{config.workspace.name}</span>
          </div>
        )}
        {error && <p className="mt-2 text-[12px] text-danger-text">{error}</p>}
      </CardBody>
    </Card>
  );
}
