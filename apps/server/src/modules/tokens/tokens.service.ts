/**
 * Tokens Service
 *
 * Service token CRUD with cdt_ prefix and SHA-256 hash storage.
 * Plaintext token is returned only once on creation.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { isUuid, isUuidV4 } from '../../common/validators/uuid.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { encrypt, decrypt, isEncryptionAvailable } from '../../database/encryption.js';
import {
  CI_TOKEN_PERMISSIONS,
  isExactTelemetryPurpose,
  TELEMETRY_TOKEN_PERMISSIONS,
  type TokenPermission,
} from '../../auth/token-permissions.js';

// =============================================================================
// Types
// =============================================================================

export interface CreateTokenResult {
  id: string;
  name: string;
  /** Plaintext token — shown only once */
  token: string;
  permissions: string[];
  expiresAt: Date | null;
  createdAt: Date;
}

export interface TokenInfo {
  id: string;
  name: string;
  /** First 12 chars of token for identification (e.g. "cdt_a1b2c3d4"), null for legacy tokens */
  tokenPrefix: string | null;
  permissions: string[];
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface InstallationTokenInfo {
  id: string;
  name: string;
  tokenPrefix: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  private static readonly TOKEN_PREFIX = 'cdt_';
  private static readonly TOKEN_BYTES = 32;

  constructor(private readonly controlPlane: ControlPlaneService) {}

  private installationTokenName(installationId: string): string {
    if (!isUuidV4(installationId)) throw new BadRequestException('installationId must be a UUID v4');
    return `capture-agent:${installationId.toLowerCase()}`;
  }

  async rotateInstallationToken(
    workspaceId: string,
    installationId: string,
    createdBy: string,
  ): Promise<CreateTokenResult> {
    const name = this.installationTokenName(installationId);
    const plaintext = `${TokensService.TOKEN_PREFIX}${randomBytes(TokensService.TOKEN_BYTES).toString('hex')}`;
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');
    const tokenPrefix = plaintext.slice(0, 12);

    const result = await this.controlPlane.replaceInstallationTelemetryToken({
      workspaceId,
      name,
      tokenHash,
      tokenPrefix,
      tokenEncrypted: null,
      createdBy,
      permissions: [...TELEMETRY_TOKEN_PERMISSIONS],
      expiresAt: null,
      lastUsedAt: null,
    });
    if (result.kind === 'conflict') {
      throw new ConflictException('Installation token identity conflicts with an existing token');
    }

    this.logger.log(`Created or rotated installation telemetry token for workspace ${workspaceId}`);
    return {
      id: result.token.id,
      name: result.token.name,
      token: plaintext,
      permissions: result.token.permissions,
      expiresAt: result.token.expiresAt,
      createdAt: result.token.createdAt,
    };
  }

  async listInstallationTokens(workspaceId: string, createdBy: string): Promise<InstallationTokenInfo[]> {
    const tokens = await this.listTokens(workspaceId);
    return tokens
      .filter(
        (token) =>
          token.createdBy === createdBy &&
          token.name.startsWith('capture-agent:') &&
          isExactTelemetryPurpose(token.permissions),
      )
      .map(({ id, name, tokenPrefix, expiresAt, createdAt, lastUsedAt }) => ({
        id,
        name,
        tokenPrefix,
        expiresAt,
        createdAt,
        lastUsedAt,
      }));
  }

  async revokeInstallationToken(workspaceId: string, installationId: string, createdBy: string): Promise<void> {
    const name = this.installationTokenName(installationId);
    const deleted = await this.controlPlane.deleteInstallationTelemetryToken({
      workspaceId,
      name,
      createdBy,
      permissions: [...TELEMETRY_TOKEN_PERMISSIONS],
    });
    if (!deleted) throw new NotFoundException('Installation token not found');
    this.logger.log(`Revoked installation telemetry token for workspace ${workspaceId}`);
  }

  async listOwnedTelemetryTokens(workspaceId: string, createdBy: string): Promise<InstallationTokenInfo[]> {
    const tokens = await this.listTokens(workspaceId);
    return tokens
      .filter((token) => token.createdBy === createdBy && isExactTelemetryPurpose(token.permissions))
      .map(({ id, name, tokenPrefix, expiresAt, createdAt, lastUsedAt }) => ({
        id,
        name,
        tokenPrefix,
        expiresAt,
        createdAt,
        lastUsedAt,
      }));
  }

  async revokeOwnedTelemetryToken(workspaceId: string, tokenId: string, createdBy: string): Promise<void> {
    if (!isUuid(tokenId)) throw new BadRequestException('tokenId must be a UUID');
    const deleted = await this.controlPlane.deleteOwnedTelemetryToken({
      workspaceId,
      tokenId: tokenId.toLowerCase(),
      createdBy,
      permissions: [...TELEMETRY_TOKEN_PERMISSIONS],
    });
    if (!deleted) throw new NotFoundException('Telemetry token not found');
    this.logger.log(`Revoked caller-owned telemetry token for workspace ${workspaceId}`);
  }

  async createToken(
    workspaceId: string,
    name: string,
    createdBy: string,
    expiresAt?: Date,
    permissions: readonly TokenPermission[] = CI_TOKEN_PERMISSIONS,
  ): Promise<CreateTokenResult> {
    // Generate plaintext token with cdt_ prefix
    const rawBytes = randomBytes(TokensService.TOKEN_BYTES);
    const plaintext = `${TokensService.TOKEN_PREFIX}${rawBytes.toString('hex')}`;

    // Store SHA-256 hash for O(1) auth lookups
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');

    // Telemetry credentials are consumed once by Desktop main and then live only
    // in the mode-0600 relay config. CI/MCP tokens retain the existing reveal path.
    const tokenEncrypted = !isExactTelemetryPurpose(permissions) && isEncryptionAvailable() ? encrypt(plaintext) : null;

    // Store prefix for identification in list views (e.g. "cdt_a1b2c3d4")
    const tokenPrefix = plaintext.slice(0, 12);

    try {
      const token = await this.controlPlane.createServiceToken({
        workspaceId,
        name,
        tokenHash,
        createdBy,
        permissions: [...permissions],
        expiresAt,
        tokenEncrypted,
        tokenPrefix,
      });

      this.logger.log(`Created service token "${name}" for workspace ${workspaceId}`);

      return {
        id: token.id,
        name: token.name,
        token: plaintext,
        permissions: token.permissions,
        expiresAt: token.expiresAt,
        createdAt: token.createdAt,
      };
    } catch (error: unknown) {
      // Handle unique constraint violation (workspace_id, name)
      if (error instanceof Error && error.message.includes('unique')) {
        throw new ConflictException(`Token with name "${name}" already exists in this workspace`);
      }
      throw error;
    }
  }

  async listTokens(workspaceId: string): Promise<TokenInfo[]> {
    const tokens = await this.controlPlane.listServiceTokens(workspaceId);
    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      tokenPrefix: t.tokenPrefix ?? null,
      permissions: t.permissions,
      expiresAt: t.expiresAt,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
    }));
  }

  /**
   * Retrieve the full plaintext token value (admin only).
   * Returns null for legacy tokens created before encrypted storage.
   */
  async getTokenValue(workspaceId: string, tokenId: string): Promise<string | null> {
    const token = await this.controlPlane.getServiceToken(workspaceId, tokenId);
    if (!token) throw new NotFoundException('Token not found');
    if (isExactTelemetryPurpose(token.permissions)) {
      throw new ForbiddenException('Telemetry token values cannot be retrieved');
    }
    if (!token.tokenEncrypted) return null;
    this.logger.warn(`Token value retrieved: tokenId=${tokenId}, workspace=${workspaceId}`);
    return decrypt(token.tokenEncrypted);
  }

  async revokeToken(workspaceId: string, tokenId: string): Promise<void> {
    try {
      await this.controlPlane.deleteServiceToken(workspaceId, tokenId);
      this.logger.log(`Revoked service token ${tokenId} for workspace ${workspaceId}`);
    } catch {
      throw new NotFoundException('Token not found');
    }
  }
}
