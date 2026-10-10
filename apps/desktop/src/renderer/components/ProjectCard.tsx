import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { formatDate, formatRelativeTime } from '../lib/utils';
import type { Project, RepositoryStatus } from '../types/project';
import { isLoadingStatus } from '../types/project';
import { MenuDots, Pen, SlashCircle, TrashBinTrash } from '@solar-icons/react';
import { getBadge } from './RepoStateBadge';

interface ProjectCardProps {
  project: Project;
  onRename?: (project: Project) => void;
  onDelete?: (project: Project) => void;
}

/** Maximum number of repositories to display before showing overflow indicator */
const MAX_VISIBLE_REPOS = 3;

/**
 * Format the sync date for display.
 * Shows "Graph sync: DD.MM.YYYY" format.
 */
function formatSyncDate(timestamp: string | undefined): string {
  const date = timestamp ? new Date(timestamp) : undefined;
  if (!date || Number.isNaN(date.getTime())) {
    return 'Not synced yet';
  }

  return `Graph sync: ${formatDate(date)}`;
}

export function ProjectCard({ project, onRename, onDelete }: ProjectCardProps) {
  const navigate = useNavigate();
  const visibleRepos = project.repositories.slice(0, MAX_VISIBLE_REPOS);
  const overflowCount = project.repositories.length - MAX_VISIBLE_REPOS;

  const handleRename = () => {
    onRename?.(project);
  };

  const handleDelete = () => {
    onDelete?.(project);
  };

  const isAnyRepoBusy = project.repositories.some((repo) => isLoadingStatus(repo.status));

  const handleCardClick = (e: React.MouseEvent) => {
    // Prevent navigation when clicking dropdown menu
    const target = e.target as HTMLElement;
    if (target.closest('[data-radix-collection-item]') || target.closest('[role="menu"]')) {
      return;
    }
    navigate(`/project/${project.id}`);
  };

  const isCloudMember = !!project.cloudMember;
  const isCloudOwner = !!project.cloud?.enabled && !isCloudMember;
  const isLocal = !!project.wizardCompleted && !project.cloud?.enabled && !isCloudMember;
  const isDraft = !project.wizardCompleted && !isCloudMember;

  return (
    <Card
      className="relative cursor-pointer hover:border-primary/50 transition-colors min-h-[206px]"
      onClick={handleCardClick}
    >
      <CardHeader className="pb-1">
        <div className="flex items-center gap-1 min-w-0">
          <SlashCircle weight="Bold" className="size-4 text-primary" />
          <CardTitle className="text-base font-extrabold truncate min-w-0" title={project.name}>
            {project.name}
          </CardTitle>
          {isDraft && (
            <Badge variant="outlineInitial" className="text-[10px] py-0.5 ml-1 shrink-0">
              Draft
            </Badge>
          )}
          {isLocal && (
            <Badge variant="outlineSuccess" className="text-[10px] py-0.5 ml-1 shrink-0">
              Local
            </Badge>
          )}
          {isCloudMember && (
            <Badge variant="outlineInfo" className="text-[10px] py-0.5 ml-1 shrink-0">
              Invited
            </Badge>
          )}
          {isCloudOwner && (
            <>
              <Badge variant="outlineInfo" className="text-[10px] py-0.5 ml-1 shrink-0">
                Cloud
              </Badge>
              {/* <Badge variant="outlineInitial" className="text-[10px] py-0.5 ml-1 shrink-0">
                Owner
              </Badge> */}
            </>
          )}
          {!isCloudMember && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="wrapper"
                  size="icon"
                  className="w-6 h-6 shrink-0 ml-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MenuDots weight="Bold" className="h-2 w-2 rotate-90" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleRename}>
                  <Pen className="mr-2 size-4" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={handleDelete} disabled={isAnyRepoBusy}>
                  <TrashBinTrash className="mr-2 size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <CardDescription
          className="border-b pb-2"
          title={project.lastSyncAt ? formatRelativeTime(project.lastSyncAt) : undefined}
        >
          {formatSyncDate(project.lastSyncAt)}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Repositories ({project.repositories.length}):</p>

          {project.repositories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repositories added</p>
          ) : (
            <div className="space-y-1">
              {visibleRepos.map((repo) => (
                <RepositoryRow key={repo.id} name={repo.name} status={repo.status} />
              ))}

              {overflowCount > 0 && (
                <span className="text-xs bg-bg-supportive text-content-tertiary mt-1.5 rounded-md px-1 py-0.5">
                  +{overflowCount}
                </span>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface RepositoryRowProps {
  name: string;
  status: RepositoryStatus;
}

function RepositoryRow({ name, status }: RepositoryRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 min-w-0">
      <span className="text-sm truncate flex-1 min-w-0 text-content-tertiary" title={name}>
        {name}
      </span>
      {getBadge(status)}
    </div>
  );
}
