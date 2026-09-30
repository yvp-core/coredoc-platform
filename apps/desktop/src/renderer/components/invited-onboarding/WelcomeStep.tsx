interface WelcomeStepProps {
  workspaceName: string;
  role?: string;
}

function roleLabel(role?: string): string {
  if (role === 'admin') return 'Admin';
  return 'Member';
}

export function WelcomeStep({ workspaceName: _workspaceName, role }: WelcomeStepProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-content-tertiary">
        You've been added as a {roleLabel(role)}. Let's get you set up — connect your AI client to the project's MCP
        server, configure your keys, and link your local repos.
      </p>
    </div>
  );
}

export function welcomeTitle(workspaceName: string): string {
  return `You've been added to ${workspaceName}`;
}
