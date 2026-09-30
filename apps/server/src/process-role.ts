export type ProcessRole = 'api' | 'worker' | 'all';

export function parseProcessRole(raw: string | undefined): ProcessRole {
  if (raw === undefined || raw === '') return 'all';
  if (raw === 'api' || raw === 'worker' || raw === 'all') return raw;
  throw new Error(`Invalid PROCESS_ROLE="${raw}"; expected api, worker, or all`);
}
