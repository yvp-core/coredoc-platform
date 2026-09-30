/**
 * Turso Provisioning Service
 *
 * Provisions per-workspace Turso databases via the Turso Platform API.
 * When a workspace is created, this service creates a new database and auth token,
 * then stores the URL and encrypted token in the control plane.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ControlPlaneService } from './control-plane.service.js';
import { encrypt, decrypt, isEncryptionAvailable } from './encryption.js';
import { miscConfigFromEnv, TURSO_CONFIG, type TursoLegacyConfig, tursoConfigFromEnv } from '../config/app-config.js';

// =============================================================================
// Types
// =============================================================================

interface TursoCreateDbResponse {
  database: {
    Name: string;
    Hostname: string;
    DbId: string;
  };
}

interface TursoCreateTokenResponse {
  jwt: string;
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class TursoProvisioningService {
  private readonly logger = new Logger(TursoProvisioningService.name);
  private readonly apiBase = 'https://api.turso.tech/v1';

  constructor(
    private readonly controlPlane: ControlPlaneService,
    @Optional() @Inject(TURSO_CONFIG) private readonly turso: TursoLegacyConfig = tursoConfigFromEnv(),
  ) {}

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Provision a new Turso database for a workspace.
   * Creates the database, generates an auth token, and updates the control plane.
   *
   * @returns The database URL, or null if provisioning is not configured
   */
  async provisionDatabase(workspaceId: string, workspaceSlug: string): Promise<string | null> {
    const { org, orgToken } = this.turso;

    if (!org || !orgToken) {
      this.logger.warn('TURSO_ORG or TURSO_ORG_TOKEN not set — skipping DB provisioning');
      return null;
    }

    const dbName = `${workspaceId}-${workspaceSlug}`;

    try {
      // Create the database
      const dbResponse = await this.createDatabase(org, orgToken, dbName);
      const dbUrl = `libsql://${dbResponse.database.Hostname}`;

      // Create an auth token for the database
      const tokenResponse = await this.createToken(org, orgToken, dbName);

      // Encrypt token at rest using AES-256-GCM
      if (!isEncryptionAvailable() && miscConfigFromEnv().nodeEnv === 'production') {
        throw new Error('SERVER_ENCRYPTION_KEY is required in production for token encryption');
      }
      const encryptedToken = isEncryptionAvailable() ? encrypt(tokenResponse.jwt) : tokenResponse.jwt; // Fallback for dev without encryption key

      await this.controlPlane.updateWorkspace(workspaceId, {
        dbUrl,
        dbTokenEncrypted: encryptedToken,
      });

      this.logger.log(`Provisioned Turso database for workspace ${workspaceSlug}: ${dbUrl}`);
      return dbUrl;
    } catch (error) {
      this.logger.error(`Failed to provision Turso database for workspace ${workspaceSlug}`, error);
      // Workspace is created in control plane but dbUrl remains NULL
      // Retry provisioning on next access
      return null;
    }
  }

  /**
   * Check if a workspace has a provisioned database, and retry provisioning if not.
   */
  async ensureDatabase(workspaceId: string, workspaceSlug: string): Promise<{ url: string; token: string } | null> {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) return null;

    if (workspace.dbUrl && workspace.dbTokenEncrypted) {
      const token = isEncryptionAvailable() ? decrypt(workspace.dbTokenEncrypted) : workspace.dbTokenEncrypted;
      return { url: workspace.dbUrl, token };
    }

    // Retry provisioning
    const url = await this.provisionDatabase(workspaceId, workspaceSlug);
    if (!url) return null;

    const updated = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!updated?.dbUrl || !updated.dbTokenEncrypted) return null;

    const token = isEncryptionAvailable() ? decrypt(updated.dbTokenEncrypted) : updated.dbTokenEncrypted;
    return { url: updated.dbUrl, token };
  }

  /**
   * Delete a workspace's Turso database.
   */
  async deprovisionDatabase(workspaceId: string, workspaceSlug: string): Promise<void> {
    const { org, orgToken } = this.turso;

    if (!org || !orgToken) return;

    const dbName = `${workspaceId}-${workspaceSlug}`;

    try {
      await this.deleteDatabase(org, orgToken, dbName);
      this.logger.log(`Deprovisioned Turso database for workspace ${workspaceSlug}`);
    } catch (error) {
      this.logger.error(`Failed to deprovision Turso database for workspace ${workspaceSlug}`, error);
    }
  }

  // ===========================================================================
  // Turso Platform API
  // ===========================================================================

  private async createDatabase(org: string, token: string, dbName: string): Promise<TursoCreateDbResponse> {
    const response = await fetch(`${this.apiBase}/organizations/${org}/databases`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: dbName,
        group: miscConfigFromEnv().environment === 'production' ? 'prod' : 'default',
      }),
    });

    if (!response.ok) {
      throw new Error(`Turso API error: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<TursoCreateDbResponse>;
  }

  private async createToken(org: string, token: string, dbName: string): Promise<TursoCreateTokenResponse> {
    const response = await fetch(`${this.apiBase}/organizations/${org}/databases/${dbName}/auth/tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Turso API error: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<TursoCreateTokenResponse>;
  }

  private async deleteDatabase(org: string, token: string, dbName: string): Promise<void> {
    const response = await fetch(`${this.apiBase}/organizations/${org}/databases/${dbName}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Turso API error: ${response.status} ${await response.text()}`);
    }
  }
}
