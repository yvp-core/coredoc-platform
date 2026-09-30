/**
 * Parser Output Validation
 *
 * Validates ParsedRepo output for common mistakes.
 * Run this after parsing to catch issues before they cause problems downstream.
 *
 * @module @coredoc/cli/validate
 */

import type { ParsedRepo, HttpEntrypointDetails } from '@coredoc/core/types';

/**
 * Represents a validation error or warning found during ParsedRepo validation.
 */
export interface ValidationError {
  /** Severity level: 'error' for blocking issues, 'warning' for potential problems */
  severity: 'error' | 'warning';
  /** Category of the validation check (e.g., 'ClassNode.methods', 'FunctionNode.versionedId') */
  category: string;
  /** Human-readable description of the issue */
  message: string;
  /** ID of the node with the issue (if applicable) */
  nodeId?: string;
  /** Name of the node with the issue (if applicable) */
  nodeName?: string;
}

/**
 * Validates ParsedRepo output for common mistakes.
 * Run this after parsing to catch issues before they cause problems downstream.
 *
 * @param result - The ParsedRepo output to validate
 * @returns Array of validation errors and warnings
 *
 * @example
 * ```typescript
 * const result = await parser.parse();
 * const errors = validateParsedRepo(result);
 *
 * if (errors.some(e => e.severity === 'error')) {
 *   printValidationErrors(errors);
 *   throw new Error('Parser output validation failed');
 * }
 * ```
 */
export function validateParsedRepo(result: ParsedRepo): ValidationError[] {
  const errors: ValidationError[] = [];
  const fileIds = new Set(result.files.map((f) => f.id));

  // =========================================================================
  // 1. ClassNode.methods Validation
  // =========================================================================
  for (const cls of result.classes) {
    for (let i = 0; i < cls.methods.length; i++) {
      const methodRef = cls.methods[i];
      if (typeof methodRef !== 'string') {
        errors.push({
          severity: 'error',
          category: 'ClassNode.methods',
          message: `ClassNode.methods[${i}] should be a string ID, found ${typeof methodRef}`,
          nodeId: cls.id,
          nodeName: cls.name,
        });
      }
    }
  }

  // =========================================================================
  // 2. FunctionNode Validation
  // =========================================================================
  for (const func of result.functions) {
    // Check versionedId
    if (!func.versionedId) {
      errors.push({
        severity: 'error',
        category: 'FunctionNode.versionedId',
        message: `Missing versionedId`,
        nodeId: func.id,
        nodeName: func.name,
      });
    }

    // Method-specific checks
    if (func.kind === 'method') {
      if (!func.classId) {
        errors.push({
          severity: 'error',
          category: 'FunctionNode.classId',
          message: `Method missing classId`,
          nodeId: func.id,
          nodeName: func.name,
        });
      }
      if (func.visibility === undefined) {
        errors.push({
          severity: 'error',
          category: 'FunctionNode.visibility',
          message: `Method missing visibility`,
          nodeId: func.id,
          nodeName: func.name,
        });
      }
      if (func.isStatic === undefined) {
        errors.push({
          severity: 'error',
          category: 'FunctionNode.isStatic',
          message: `Method missing isStatic`,
          nodeId: func.id,
          nodeName: func.name,
        });
      }
      if (func.isAbstract === undefined) {
        errors.push({
          severity: 'error',
          category: 'FunctionNode.isAbstract',
          message: `Method missing isAbstract`,
          nodeId: func.id,
          nodeName: func.name,
        });
      }
    }

    // Function-specific checks
    if (func.kind === 'function') {
      if (func.isExported === undefined) {
        errors.push({
          severity: 'warning',
          category: 'FunctionNode.isExported',
          message: `Function missing isExported`,
          nodeId: func.id,
          nodeName: func.name,
        });
      }
    }
  }

  // =========================================================================
  // 3. EntityNode Validation
  // =========================================================================
  for (const entity of result.entities) {
    if (!entity.versionedId) {
      errors.push({
        severity: 'error',
        category: 'EntityNode.versionedId',
        message: `Missing versionedId`,
        nodeId: entity.id,
        nodeName: entity.name,
      });
    }

    for (const field of entity.fields) {
      if (field.isPrimaryKey === undefined) {
        errors.push({
          severity: 'error',
          category: 'EntityField.isPrimaryKey',
          message: `Field ${field.name} has undefined isPrimaryKey (should be boolean)`,
          nodeId: entity.id,
          nodeName: `${entity.name}.${field.name}`,
        });
      }
      if (field.isNullable === undefined) {
        errors.push({
          severity: 'error',
          category: 'EntityField.isNullable',
          message: `Field ${field.name} has undefined isNullable (should be boolean)`,
          nodeId: entity.id,
          nodeName: `${entity.name}.${field.name}`,
        });
      }
      if (field.isUnique === undefined) {
        errors.push({
          severity: 'error',
          category: 'EntityField.isUnique',
          message: `Field ${field.name} has undefined isUnique (should be boolean)`,
          nodeId: entity.id,
          nodeName: `${entity.name}.${field.name}`,
        });
      }
      if (field.isGenerated === undefined) {
        errors.push({
          severity: 'error',
          category: 'EntityField.isGenerated',
          message: `Field ${field.name} has undefined isGenerated (should be boolean)`,
          nodeId: entity.id,
          nodeName: `${entity.name}.${field.name}`,
        });
      }
    }
  }

  // =========================================================================
  // 4. Entrypoint Validation
  // =========================================================================
  for (const ep of result.entrypoints) {
    if (!ep.versionedId) {
      errors.push({
        severity: 'error',
        category: 'Entrypoint.versionedId',
        message: `Missing versionedId`,
        nodeId: ep.id,
      });
    }

    if (ep.details.type === 'http') {
      const httpDetails = ep.details as HttpEntrypointDetails;

      if (!httpDetails.fullPath) {
        errors.push({
          severity: 'error',
          category: 'HttpEntrypoint.fullPath',
          message: `HTTP entrypoint missing fullPath`,
          nodeId: ep.id,
        });
      }

      // Check if path has params but pathParams is empty
      if (httpDetails.fullPath) {
        const hasPathParams = httpDetails.fullPath.includes(':') || httpDetails.fullPath.includes('{');
        if (hasPathParams && (!httpDetails.pathParams || httpDetails.pathParams.length === 0)) {
          errors.push({
            severity: 'warning',
            category: 'HttpEntrypoint.pathParams',
            message: `Path "${httpDetails.fullPath}" has parameters but pathParams is empty`,
            nodeId: ep.id,
          });
        }
      }
    }
  }

  // =========================================================================
  // 5. ImportEdge Validation
  // =========================================================================
  for (const imp of result.imports) {
    const isPackageLikeImport = !imp.moduleSpecifier.startsWith('.') && !imp.moduleSpecifier.startsWith('/');
    const resolvesToKnownInternalFile = imp.targetFileId !== undefined && fileIds.has(imp.targetFileId);

    // Package-like specifiers are considered external unless they resolve
    // to a known file in this ParsedRepo (e.g., monorepo workspace alias).
    if (isPackageLikeImport && imp.targetFileId !== undefined && !resolvesToKnownInternalFile) {
      errors.push({
        severity: 'error',
        category: 'ImportEdge.targetFileId',
        message: `Package import "${imp.moduleSpecifier}" has targetFileId that does not resolve to a known internal file`,
        nodeId: imp.id,
      });
    }
  }

  // =========================================================================
  // 6. ExternalCallEdge Validation
  // =========================================================================
  for (const call of result.externalCalls) {
    if (!call.versionedId) {
      errors.push({
        severity: 'error',
        category: 'ExternalCallEdge.versionedId',
        message: `Missing versionedId`,
        nodeId: call.id,
      });
    }

    if (!call.targetDescriptor) {
      errors.push({
        severity: 'warning',
        category: 'ExternalCallEdge.targetDescriptor',
        message: `Missing targetDescriptor (needed for cross-service resolution)`,
        nodeId: call.id,
      });
    }
  }

  // =========================================================================
  // 7. SDK Definition Validation
  // =========================================================================
  if (result.sdkDefinitions) {
    for (const sdk of result.sdkDefinitions) {
      if (!sdk.versionedId) {
        errors.push({
          severity: 'error',
          category: 'SdkMethodDefinition.versionedId',
          message: `Missing versionedId`,
          nodeId: sdk.id,
          nodeName: `${sdk.className}.${sdk.methodName}`,
        });
      }

      // Light validation for HTTP paths - warnings only, agent uses judgment
      // Many valid patterns exist: '/users', 'users', full URLs, env-based URLs, etc.
      if (sdk.protocol === 'http' && sdk.httpDetails?.pathTemplate) {
        const path = sdk.httpDetails.pathTemplate;

        // Warning: Check for obviously wrong values (variable references captured as paths)
        if (path.match(/^(this\.|self\.|config\.|process\.)/)) {
          errors.push({
            severity: 'warning',
            category: 'SdkMethodDefinition.pathTemplate',
            message: `pathTemplate looks like a variable reference: "${path}" - should be the actual path`,
            nodeId: sdk.id,
            nodeName: `${sdk.className}.${sdk.methodName}`,
          });
        }

        // Info: Path params in template should generally match pathParams array
        // But this can vary by codebase, so just a soft warning
        const templateParams = (path.match(/\{(\w+)\}/g) || []).map((p) => p.slice(1, -1));
        const declaredParams = sdk.httpDetails.pathParams || [];
        if (templateParams.length !== declaredParams.length && templateParams.length > 0) {
          errors.push({
            severity: 'warning',
            category: 'SdkMethodDefinition.pathParams',
            message: `pathParams count mismatch: ${templateParams.length} in template, ${declaredParams.length} declared`,
            nodeId: sdk.id,
            nodeName: `${sdk.className}.${sdk.methodName}`,
          });
        }
      }
    }
  }

  // =========================================================================
  // 8. Cross-Reference Validation
  // =========================================================================

  // Build ID sets for reference checking
  const functionIds = new Set(result.functions.map((f) => f.id));
  const classIds = new Set(result.classes.map((c) => c.id));
  const componentIds = new Set((result.components || []).map((c) => c.id));
  const routeIds = new Set((result.routes || []).map((r) => r.id));

  // Check method classId references exist
  for (const func of result.functions) {
    if (func.kind === 'method' && func.classId) {
      if (!classIds.has(func.classId)) {
        errors.push({
          severity: 'warning',
          category: 'Reference.classId',
          message: `Method references non-existent class`,
          nodeId: func.id,
          nodeName: func.name,
        });
      }
    }
  }

  // Check ClassNode.methods references exist
  for (const cls of result.classes) {
    for (const methodId of cls.methods) {
      if (typeof methodId === 'string' && !functionIds.has(methodId)) {
        errors.push({
          severity: 'warning',
          category: 'Reference.methodId',
          message: `Class references non-existent method: ${methodId}`,
          nodeId: cls.id,
          nodeName: cls.name,
        });
      }
    }
  }

  // Check entrypoint handlerId references exist
  for (const ep of result.entrypoints) {
    if (ep.handlerId && !functionIds.has(ep.handlerId)) {
      errors.push({
        severity: 'warning',
        category: 'Reference.handlerId',
        message: `Entrypoint references non-existent handler: ${ep.handlerId}`,
        nodeId: ep.id,
      });
    }
  }

  // =========================================================================
  // 9. ComponentNode Validation
  // =========================================================================
  if (result.components) {
    for (const component of result.components) {
      if (!component.versionedId) {
        errors.push({
          severity: 'error',
          category: 'ComponentNode.versionedId',
          message: `Missing versionedId`,
          nodeId: component.id,
          nodeName: component.name,
        });
      }

      if (!component.framework) {
        errors.push({
          severity: 'error',
          category: 'ComponentNode.framework',
          message: `Missing or empty framework`,
          nodeId: component.id,
          nodeName: component.name,
        });
      }

      if (component.fileId && !fileIds.has(component.fileId)) {
        errors.push({
          severity: 'warning',
          category: 'ComponentNode.fileId',
          message: `fileId references non-existent file`,
          nodeId: component.id,
          nodeName: component.name,
        });
      }

      if (component.childComponents) {
        for (const usage of component.childComponents) {
          if (usage.componentId && !componentIds.has(usage.componentId)) {
            errors.push({
              severity: 'warning',
              category: 'ComponentNode.childComponents',
              message: `childComponent "${usage.componentName}" references non-existent component: ${usage.componentId}`,
              nodeId: component.id,
              nodeName: component.name,
            });
          }
        }
      }
    }
  }

  // =========================================================================
  // 10. RouteNode Validation
  // =========================================================================
  if (result.routes) {
    for (const route of result.routes) {
      if (!route.path) {
        errors.push({
          severity: 'error',
          category: 'RouteNode.path',
          message: `Missing or empty path`,
          nodeId: route.id,
        });
      }

      if (route.componentId && !componentIds.has(route.componentId)) {
        errors.push({
          severity: 'warning',
          category: 'RouteNode.componentId',
          message: `componentId references non-existent component: ${route.componentId}`,
          nodeId: route.id,
        });
      }

      if (route.parentRouteId && !routeIds.has(route.parentRouteId)) {
        errors.push({
          severity: 'warning',
          category: 'RouteNode.parentRouteId',
          message: `parentRouteId references non-existent route: ${route.parentRouteId}`,
          nodeId: route.id,
        });
      }

      if (!route.componentName) {
        errors.push({
          severity: 'warning',
          category: 'RouteNode.componentName',
          message: `Missing componentName`,
          nodeId: route.id,
        });
      }
    }
  }

  // =========================================================================
  // 11. StateStoreNode Validation
  // =========================================================================
  const validLibraries = new Set(['redux', 'zustand', 'mobx', 'pinia', 'vuex', 'recoil', 'jotai', 'other']);
  if (result.stateStores) {
    for (const store of result.stateStores) {
      if (!store.versionedId) {
        errors.push({
          severity: 'error',
          category: 'StateStoreNode.versionedId',
          message: `Missing versionedId`,
          nodeId: store.id,
          nodeName: store.storeName,
        });
      }

      if (!store.storeName) {
        errors.push({
          severity: 'error',
          category: 'StateStoreNode.storeName',
          message: `Missing or empty storeName`,
          nodeId: store.id,
        });
      }

      if (!validLibraries.has(store.library)) {
        errors.push({
          severity: 'error',
          category: 'StateStoreNode.library',
          message: `Invalid library "${store.library}" (valid: ${[...validLibraries].join(', ')})`,
          nodeId: store.id,
          nodeName: store.storeName,
        });
      }

      if (!Array.isArray(store.actions)) {
        errors.push({
          severity: 'error',
          category: 'StateStoreNode.actions',
          message: `actions must be an array`,
          nodeId: store.id,
          nodeName: store.storeName,
        });
      }

      if (!Array.isArray(store.selectors)) {
        errors.push({
          severity: 'error',
          category: 'StateStoreNode.selectors',
          message: `selectors must be an array`,
          nodeId: store.id,
          nodeName: store.storeName,
        });
      }

      if (store.fileId && !fileIds.has(store.fileId)) {
        errors.push({
          severity: 'warning',
          category: 'StateStoreNode.fileId',
          message: `fileId references non-existent file`,
          nodeId: store.id,
          nodeName: store.storeName,
        });
      }
    }
  }

  return errors;
}

/**
 * Prints validation errors in a readable format.
 *
 * @param errors - Array of validation errors to print
 *
 * @example
 * ```typescript
 * const errors = validateParsedRepo(result);
 * printValidationErrors(errors);
 * ```
 */
export function printValidationErrors(errors: ValidationError[]): void {
  if (errors.length === 0) {
    console.log('✅ Validation passed - no errors found');
    return;
  }

  const errorCount = errors.filter((e) => e.severity === 'error').length;
  const warningCount = errors.filter((e) => e.severity === 'warning').length;

  console.log(`\n❌ Validation found ${errorCount} errors and ${warningCount} warnings:\n`);

  // Group by category
  const byCategory = new Map<string, ValidationError[]>();
  for (const error of errors) {
    const list = byCategory.get(error.category) || [];
    list.push(error);
    byCategory.set(error.category, list);
  }

  for (const [category, categoryErrors] of byCategory) {
    console.log(`\n${category}:`);
    for (const error of categoryErrors.slice(0, 5)) {
      // Show max 5 per category
      const prefix = error.severity === 'error' ? '  ❌' : '  ⚠️';
      const nodeInfo = error.nodeName || error.nodeId || '';
      console.log(`${prefix} ${error.message}${nodeInfo ? ` [${nodeInfo}]` : ''}`);
    }
    if (categoryErrors.length > 5) {
      console.log(`  ... and ${categoryErrors.length - 5} more`);
    }
  }
}

/**
 * Validates ParsedRepo and throws if there are any errors.
 *
 * @param result - The ParsedRepo output to validate
 * @throws Error if validation finds any errors (not warnings)
 *
 * @example
 * ```typescript
 * const result = await parser.parse();
 * assertValidParsedRepo(result); // Throws if invalid
 * ```
 */
export function assertValidParsedRepo(result: ParsedRepo): void {
  const errors = validateParsedRepo(result);
  const errorCount = errors.filter((e) => e.severity === 'error').length;

  if (errorCount > 0) {
    printValidationErrors(errors);
    throw new Error(`Parser output validation failed with ${errorCount} error(s)`);
  }

  // Print warnings even if no errors
  const warnings = errors.filter((e) => e.severity === 'warning');
  if (warnings.length > 0) {
    printValidationErrors(warnings);
  }
}
