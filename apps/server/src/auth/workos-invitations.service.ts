import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig, configFromEnv } from '../config/app-config.js';

const WORKOS_API_BASE_URL = 'https://api.workos.com';
const REQUEST_TIMEOUT_MS = 10_000;

interface WorkOSResponse {
  id?: unknown;
  expires_at?: unknown;
  data?: unknown;
  message?: unknown;
  error?: unknown;
  email?: unknown;
  organization_id?: unknown;
  state?: unknown;
}

export interface DeliveredInvitation {
  id: string;
  expiresAt: Date;
}

export class WorkOSApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'WorkOSApiError';
  }
}

/**
 * WorkOS Connect authenticates users but does not create AuthKit invitation
 * emails. WorkOS-backed workspaces are mirrored to organizations lazily so
 * both new and existing users can receive a workspace-scoped invitation.
 * Non-WorkOS providers never call this client.
 */
@Injectable()
export class WorkOSInvitationsService {
  private readonly enabled: boolean;
  private readonly apiKey: string | null;

  constructor(@Optional() @Inject(AUTH_CONFIG) auth: AuthConfig = configFromEnv().auth) {
    this.enabled = auth.upstream === 'workos';
    const apiKey = auth.workos.apiKey?.trim();
    const authkitClientId = auth.workos.authkitClientId?.trim();
    if (this.enabled && (!apiKey || !authkitClientId)) {
      const missing = [!apiKey && 'WORKOS_API_KEY', !authkitClientId && 'WORKOS_AUTHKIT_CLIENT_ID'].filter(Boolean);
      throw new Error(
        `OAUTH_UPSTREAM=workos requires ${missing.join(', ')} for invitation delivery and acceptance (see .env.example).`,
      );
    }
    this.apiKey = apiKey || null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async ensureOrganization(externalId: string, name: string): Promise<string> {
    const lookupPath = `/organizations/external_id/${encodeURIComponent(externalId)}`;
    try {
      return this.requiredId(await this.request(lookupPath, { method: 'GET' }), 'organization');
    } catch (error) {
      if (!(error instanceof WorkOSApiError) || error.status !== 404) throw error;
    }

    try {
      const organization = await this.request('/organizations', {
        method: 'POST',
        body: { name, external_id: externalId },
        idempotencyKey: this.operationKey('organization', externalId),
      });
      return this.requiredId(organization, 'organization');
    } catch (createError) {
      // Concurrent first invitations can both observe the initial 404. The
      // unique external_id makes one create win; recover the winner by lookup.
      try {
        return this.requiredId(await this.request(lookupPath, { method: 'GET' }), 'organization');
      } catch {
        throw createError;
      }
    }
  }

  async ensureOrganizationMembership(organizationId: string, userId: string): Promise<void> {
    if (await this.findOrganizationMembership(organizationId, userId)) return;

    try {
      await this.request('/user_management/organization_memberships', {
        method: 'POST',
        body: { organization_id: organizationId, user_id: userId },
        idempotencyKey: this.operationKey('organization-membership', organizationId, userId),
      });
    } catch (createError) {
      // Treat a concurrent creator as success, but preserve the original API
      // error when no membership exists after the failed request.
      if (await this.findOrganizationMembership(organizationId, userId)) return;
      throw createError;
    }
  }

  async removeOrganizationMembership(organizationId: string, userId: string): Promise<boolean> {
    const membershipId = await this.findOrganizationMembership(organizationId, userId);
    if (!membershipId) return false;
    await this.request(`/user_management/organization_memberships/${encodeURIComponent(membershipId)}`, {
      method: 'DELETE',
    });
    return true;
  }

  async deleteOrganization(organizationId: string): Promise<void> {
    await this.requestIdempotentDelete(`/organizations/${encodeURIComponent(organizationId)}`, { method: 'DELETE' });
  }

  async send(email: string, organizationId: string, operationId: string): Promise<DeliveredInvitation> {
    // Recover a provider-side invitation left by a prior ambiguous timeout or
    // failed local cleanup. Reusing it makes local-first revocation safe and
    // prevents WorkOS's duplicate-invitation constraint from wedging re-invite.
    const existing = await this.findPendingInvitation(email, organizationId);
    if (existing) return this.resend(existing.id);

    try {
      const response = await this.request('/user_management/invitations', {
        method: 'POST',
        body: { email, organization_id: organizationId },
        idempotencyKey: this.operationKey('invitation', operationId),
      });
      return this.parseInvitation(response);
    } catch (createError) {
      // A request can reach WorkOS even when the response is lost. Query by the
      // provider's supported (organization_id, email) filters before reporting
      // failure so the local row can retain the returned remote handle.
      try {
        const recovered = await this.findPendingInvitation(email, organizationId);
        if (recovered) return recovered;
      } catch {
        // Preserve the create error; it is the operation the caller attempted.
      }
      throw createError;
    }
  }

  async resend(invitationId: string): Promise<DeliveredInvitation> {
    const response = await this.request(`/user_management/invitations/${encodeURIComponent(invitationId)}/resend`, {
      method: 'POST',
      body: {},
    });
    return this.parseInvitation(response);
  }

  async revoke(invitationId: string): Promise<void> {
    await this.requestIdempotentDelete(`/user_management/invitations/${encodeURIComponent(invitationId)}/revoke`, {
      method: 'POST',
      body: {},
    });
  }

  /**
   * Removal is idempotent: an object WorkOS no longer knows about is already in
   * the state the caller wants. Without this a 404 is unrecoverable — the local
   * workspace could never be deleted, and a pending invite could never be
   * revoked, because both keep the only handle on the remote object and the
   * placeholder member holds the (workspaceId, email) slot that blocks re-invite.
   */
  private async requestIdempotentDelete(
    path: string,
    options: { method: 'POST' | 'DELETE'; body?: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.request(path, options);
    } catch (error) {
      if (error instanceof WorkOSApiError && (error.status === 404 || error.status === 410)) return;
      throw error;
    }
  }

  private async findOrganizationMembership(organizationId: string, userId: string): Promise<string | null> {
    const query = new URLSearchParams({ organization_id: organizationId, user_id: userId });
    const response = await this.request(`/user_management/organization_memberships?${query.toString()}`, {
      method: 'GET',
    });
    if (!Array.isArray(response.data)) {
      throw new WorkOSApiError('WorkOS organization membership response is missing data');
    }
    const membership = response.data[0];
    if (!membership || typeof membership !== 'object') return null;
    return this.requiredId(membership as WorkOSResponse, 'organization membership');
  }

  private async findPendingInvitation(
    email: string,
    organizationId: string,
  ): Promise<(DeliveredInvitation & { id: string }) | null> {
    const query = new URLSearchParams({ organization_id: organizationId, email });
    const response = await this.request(`/user_management/invitations?${query.toString()}`, { method: 'GET' });
    if (!Array.isArray(response.data)) {
      throw new WorkOSApiError('WorkOS invitation list response is missing data');
    }
    const normalizedEmail = email.toLowerCase();
    for (const candidate of response.data) {
      if (!candidate || typeof candidate !== 'object') continue;
      const invitation = candidate as WorkOSResponse;
      if (
        invitation.state !== 'pending' ||
        invitation.organization_id !== organizationId ||
        typeof invitation.email !== 'string' ||
        invitation.email.toLowerCase() !== normalizedEmail
      ) {
        continue;
      }
      const parsed = this.parseInvitation(invitation);
      if (parsed.expiresAt.getTime() > Date.now()) return parsed;
    }
    return null;
  }

  private operationKey(kind: string, ...parts: string[]): string {
    return createHash('sha256')
      .update([kind, ...parts].join('\0'))
      .digest('hex');
  }

  private parseInvitation(response: WorkOSResponse): DeliveredInvitation {
    const id = this.requiredId(response, 'invitation');
    if (typeof response.expires_at !== 'string') {
      throw new WorkOSApiError('WorkOS invitation response is missing expires_at');
    }
    const expiresAt = new Date(response.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new WorkOSApiError('WorkOS invitation response contains an invalid expires_at');
    }
    return { id, expiresAt };
  }

  private requiredId(response: WorkOSResponse, objectName: string): string {
    if (typeof response.id !== 'string') {
      throw new WorkOSApiError(`WorkOS ${objectName} response is missing id`);
    }
    return response.id;
  }

  private async request(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'DELETE';
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    },
  ): Promise<WorkOSResponse> {
    if (!this.enabled || !this.apiKey) {
      throw new WorkOSApiError('WorkOS integration is not enabled');
    }

    let response: Response;
    try {
      response = await fetch(`${WORKOS_API_BASE_URL}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new WorkOSApiError(
        `WorkOS API request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        options.method !== 'GET',
      );
    }

    const body = (await response.json().catch(() => ({}))) as WorkOSResponse;
    if (!response.ok) {
      const detail =
        typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : null;
      throw new WorkOSApiError(
        detail ? `WorkOS API request failed: ${detail}` : `WorkOS API request failed (${response.status})`,
        response.status,
      );
    }
    return body;
  }
}
