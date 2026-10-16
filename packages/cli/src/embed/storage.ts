/**
 * Embedding Storage
 *
 * Manages loading and saving embeddings with incremental update support.
 * Uses MD5 checksums to detect changes and skip unchanged items.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  EmbeddingsOutput,
  FunctionEmbedding,
  EndpointEmbedding,
  EmbedItem,
  EmbeddingProvider,
  InputStrategy,
  EmbedStats,
} from './types.js';

/**
 * Calculate MD5 checksum of a string
 */
export function md5(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * Embedding storage class for incremental updates
 */
export class EmbeddingStorage {
  private filePath: string;
  private existing: EmbeddingsOutput | null = null;
  private functionEmbeddings: Map<string, FunctionEmbedding> = new Map();
  private endpointEmbeddings: Map<string, EndpointEmbedding> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Load existing embeddings from disk
   */
  load(): EmbeddingsOutput | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      this.existing = JSON.parse(content) as EmbeddingsOutput;

      // Build lookup maps
      for (const fn of this.existing.functions) {
        this.functionEmbeddings.set(fn.functionId, fn);
      }

      for (const ep of this.existing.endpoints) {
        this.endpointEmbeddings.set(ep.endpointId, ep);
      }

      return this.existing;
    } catch {
      return null;
    }
  }

  /**
   * Check if an item needs re-embedding
   * Returns true if the item is new or its input checksum has changed
   */
  needsEmbedding(item: EmbedItem): boolean {
    const existing = (item.type === 'function' ? this.functionEmbeddings : this.endpointEmbeddings).get(item.id);
    return existing?.inputChecksum !== item.inputChecksum;
  }

  /**
   * Update with new embedding
   */
  updateFunction(embedding: FunctionEmbedding): void {
    this.functionEmbeddings.set(embedding.functionId, embedding);
  }

  /**
   * Update with new endpoint embedding
   */
  updateEndpoint(embedding: EndpointEmbedding): void {
    this.endpointEmbeddings.set(embedding.endpointId, embedding);
  }

  /**
   * Save embeddings to disk
   */
  save(
    repoId: string,
    repoName: string,
    provider: EmbeddingProvider,
    model: string,
    dimensions: number,
    inputStrategy: InputStrategy,
    stats: EmbedStats,
  ): void {
    const output: EmbeddingsOutput = {
      repoId,
      repoName,
      generatedAt: new Date().toISOString(),
      provider,
      model,
      dimensions,
      inputStrategy,
      functions: Array.from(this.functionEmbeddings.values()),
      endpoints: Array.from(this.endpointEmbeddings.values()),
      stats,
    };

    fs.writeFileSync(this.filePath, JSON.stringify(output, null, 2));
  }

  /**
   * Get counts of existing embeddings
   */
  getCounts(): { functions: number; endpoints: number } {
    return {
      functions: this.functionEmbeddings.size,
      endpoints: this.endpointEmbeddings.size,
    };
  }
}

/**
 * Create a function embedding result
 */
export function createFunctionEmbedding(item: EmbedItem, embedding: number[]): FunctionEmbedding {
  return {
    functionId: item.id,
    versionedId: item.versionedId,
    name: item.name,
    filePath: item.path,
    inputChecksum: item.inputChecksum,
    inputText: item.inputText,
    embedding,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Create an endpoint embedding result
 */
export function createEndpointEmbedding(item: EmbedItem, embedding: number[]): EndpointEmbedding {
  return {
    endpointId: item.id,
    versionedId: item.versionedId,
    type: item.endpointType || 'unknown',
    path: item.path,
    handlerId: item.handlerId || '',
    inputChecksum: item.inputChecksum,
    inputText: item.inputText,
    embedding,
    generatedAt: new Date().toISOString(),
  };
}
