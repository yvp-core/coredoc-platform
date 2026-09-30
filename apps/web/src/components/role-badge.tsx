const LABELS: Record<string, string> = {
  owner: 'Owner · can review',
  admin: 'Admin · can review',
  member: 'Member',
};

export function RoleBadge({ role }: { role: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-[9px] py-0.5 text-[11px] text-ink-2">
      <span
        aria-hidden="true"
        className="size-[7px] rounded-full"
        style={{ background: 'linear-gradient(273deg, var(--accent-a), var(--accent-b))' }}
      />
      {LABELS[role.toLowerCase()] ?? role}
    </span>
  );
}
