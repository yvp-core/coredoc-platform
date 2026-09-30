import * as React from 'react';
import { AddCircle } from '@solar-icons/react';
import { Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { useProjectsStore } from '../stores/projects-store';
import { ProjectCard } from '../components/ProjectCard';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { EditProjectDialog } from '../components/EditProjectDialog';
import { DeleteProjectDialog } from '../components/DeleteProjectDialog';
import { PageHeader } from '../components/AppLayout';
import type { Project } from '../types/project';

function ProjectCardSkeleton() {
  return (
    <Card className="animate-pulse">
      <CardHeader className="pb-1">
        <div className="flex items-center gap-1">
          <div className="size-4 bg-muted rounded" />
          <div className="h-4 w-28 bg-muted rounded" />
        </div>
        <div className="h-3 w-36 bg-muted rounded border-b pb-2 mt-1" />
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          <div className="h-3 w-24 bg-muted rounded" />
          <div className="h-4 w-full bg-muted rounded" />
          <div className="h-4 w-3/4 bg-muted rounded" />
        </div>
      </CardContent>
    </Card>
  );
}

export function ProjectsPage() {
  const { projects, isLoadingLocal, isLoadingCloud, initialized } = useProjectsStore();

  // Dialog states
  const [addDialogOpen, setAddDialogOpen] = React.useState(false);
  const [editDialogOpen, setEditDialogOpen] = React.useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(null);

  const handleRename = (project: Project) => {
    setSelectedProject(project);
    setEditDialogOpen(true);
  };

  const handleDelete = (project: Project) => {
    setSelectedProject(project);
    setDeleteDialogOpen(true);
  };

  // Show skeleton cards during initial load
  if (!initialized && isLoadingLocal) {
    return (
      <>
        <PageHeader>
          <div>
            <h1 className="text-xl font-bold">Workspaces</h1>
          </div>
          <div className="flex gap-2 no-drag" />
        </PageHeader>
        <div className="flex-1 overflow-auto px-6 pt-1 pb-4">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">
            {[1, 2, 3].map((i) => (
              <ProjectCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">Workspaces</h1>
          {isLoadingCloud && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>

        <div className="flex gap-2 no-drag">
          {projects.length > 0 && (
            <Button onClick={() => setAddDialogOpen(true)}>
              <AddCircle weight="Bold" className="size-4" />
              Add new Workspace
            </Button>
          )}
        </div>
      </PageHeader>

      <div className="flex-1 overflow-auto px-6 pt-1 pb-4">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              <AddCircle className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold mb-2">No Workspace yet</h2>
            <p className="text-muted-foreground mb-6">Create your first one to get started.</p>
            <Button onClick={() => setAddDialogOpen(true)}>
              <AddCircle className="size-4 mr-2" />
              Create your first one
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-4">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} onRename={handleRename} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <AddProjectDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
      <EditProjectDialog open={editDialogOpen} onOpenChange={setEditDialogOpen} project={selectedProject} />
      <DeleteProjectDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} project={selectedProject} />
    </>
  );
}
