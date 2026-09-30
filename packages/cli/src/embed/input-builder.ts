/**
 * Input Builder
 *
 * Builds input text for embedding from functions and endpoints.
 * Supports different strategies: summary-based, source-based, or both.
 */

import * as fs from 'fs';
import {
  FunctionNode,
  Entrypoint,
  HttpEntrypointDetails,
  GraphQLEntrypointDetails,
  ParameterInfo,
} from '@coredoc/core/types';
import { FunctionSummary, SummaryOutput, SideEffect } from '../summarize/types.js';
import { EmbedItem, InputStrategy } from './types.js';
import { md5 } from './storage.js';

/**
 * Build input text for a function based on the input strategy
 */
export function buildFunctionInput(
  fn: FunctionNode,
  strategy: InputStrategy,
  summaryMap: Map<string, FunctionSummary>,
): string {
  const parts: string[] = [];

  // Always include basic info
  parts.push(`Function: ${fn.name}`);
  parts.push(`File: ${fn.location.filePath}`);

  if (fn.kind === 'method' && fn.classId) {
    // For methods, include class context
    parts.push(`Type: method`);
  } else {
    parts.push(`Type: function`);
  }

  // Include parameters
  if (fn.parameters.length > 0) {
    const params = fn.parameters.map((p: ParameterInfo) => {
      let param = p.name;
      if (p.type) {
        param += `: ${p.type.text}`;
      }
      return param;
    });
    parts.push(`Parameters: ${params.join(', ')}`);
  }

  // Include return type
  if (fn.returnType) {
    parts.push(`Returns: ${fn.returnType.text}`);
  }

  // Strategy-specific content
  if (strategy === 'summary' || strategy === 'both') {
    const summary = summaryMap.get(fn.id);
    if (summary) {
      parts.push('');
      parts.push(`Purpose: ${summary.purpose}`);
      parts.push(`Summary: ${summary.detailed_summary}`);

      if (summary.business_logic.length > 0) {
        parts.push(`Business Logic: ${summary.business_logic.join('; ')}`);
      }

      if (summary.data_handling) {
        parts.push(`Data Handling: ${summary.data_handling}`);
      }

      if (summary.side_effects.length > 0) {
        const effects = summary.side_effects.map((e: SideEffect) => `${e.type}: ${e.description}`);
        parts.push(`Side Effects: ${effects.join('; ')}`);
      }
    }
  }

  if (strategy === 'source' || strategy === 'both') {
    if (fn.sourceCode) {
      parts.push('');
      parts.push('Source Code:');
      // Truncate very long source code
      const maxSourceLength = 2000;
      const source =
        fn.sourceCode.length > maxSourceLength ? fn.sourceCode.substring(0, maxSourceLength) + '...' : fn.sourceCode;
      parts.push(source);
    }
  }

  // Include documentation if available
  if (fn.documentation) {
    parts.push('');
    parts.push(`Documentation: ${fn.documentation}`);
  }

  return parts.join('\n');
}

/**
 * Build input text for an endpoint based on the input strategy
 */
export function buildEndpointInput(
  endpoint: Entrypoint,
  fn: FunctionNode | undefined,
  strategy: InputStrategy,
  summaryMap: Map<string, FunctionSummary>,
): string {
  const parts: string[] = [];

  // Endpoint-specific info
  parts.push(`Endpoint Type: ${endpoint.type}`);

  // Type-specific details
  const details = endpoint.details;
  switch (details.type) {
    case 'http': {
      const http = details as HttpEntrypointDetails;
      parts.push(`HTTP Method: ${http.method}`);
      parts.push(`Path: ${http.fullPath}`);
      if (http.pathParams && http.pathParams.length > 0) {
        parts.push(`Path Parameters: ${http.pathParams.join(', ')}`);
      }
      if (http.middleware && http.middleware.length > 0) {
        parts.push(`Middleware: ${http.middleware.join(', ')}`);
      }
      if (http.auth?.required) {
        parts.push(`Authentication: required${http.auth.type ? ` (${http.auth.type})` : ''}`);
        if (http.auth.roles && http.auth.roles.length > 0) {
          parts.push(`Roles: ${http.auth.roles.join(', ')}`);
        }
      }
      break;
    }
    case 'graphql': {
      const gql = details as GraphQLEntrypointDetails;
      parts.push(`Operation: ${gql.operationType}`);
      parts.push(`Field: ${gql.fieldName}`);
      parts.push(`Parent Type: ${gql.parentType}`);
      break;
    }
    case 'grpc':
      parts.push(`Service: ${details.serviceName}`);
      parts.push(`Method: ${details.methodName}`);
      break;
    case 'websocket':
      parts.push(`Event: ${details.event}`);
      if (details.namespace) {
        parts.push(`Namespace: ${details.namespace}`);
      }
      break;
    case 'queue':
      parts.push(`System: ${details.system}`);
      parts.push(`Topic: ${details.topic}`);
      if (details.consumerGroup) {
        parts.push(`Consumer Group: ${details.consumerGroup}`);
      }
      break;
    case 'cron':
      parts.push(`Schedule: ${details.schedule}`);
      if (details.scheduleDescription) {
        parts.push(`Description: ${details.scheduleDescription}`);
      }
      break;
    case 'event':
      parts.push(`Event Name: ${details.eventName}`);
      break;
    case 'cli':
      parts.push(`Command: ${details.command}`);
      break;
    case 'mobile':
      parts.push(`Platform: ${details.platform}`);
      parts.push(`Trigger: ${details.trigger}`);
      parts.push(`Class: ${details.className}`);
      break;
  }

  // Include request/response schema info
  if (endpoint.requestSchema?.name) {
    parts.push(`Request Type: ${endpoint.requestSchema.name}`);
  }
  if (endpoint.responseSchema?.name) {
    parts.push(`Response Type: ${endpoint.responseSchema.name}`);
  }

  // Include handler function info
  if (fn) {
    parts.push('');
    parts.push(`Handler: ${fn.name}`);
    parts.push(`File: ${fn.location.filePath}`);

    // Include handler details based on strategy
    if (strategy === 'summary' || strategy === 'both') {
      const summary = summaryMap.get(fn.id);
      if (summary) {
        parts.push(`Purpose: ${summary.purpose}`);
        parts.push(`Summary: ${summary.detailed_summary}`);
      }
    }

    if (strategy === 'source' || strategy === 'both') {
      if (fn.sourceCode) {
        parts.push('');
        parts.push('Handler Source:');
        const maxSourceLength = 1500;
        const source =
          fn.sourceCode.length > maxSourceLength ? fn.sourceCode.substring(0, maxSourceLength) + '...' : fn.sourceCode;
        parts.push(source);
      }
    }
  }

  // Include endpoint documentation
  if (endpoint.documentation) {
    parts.push('');
    parts.push(`Documentation: ${endpoint.documentation}`);
  }

  return parts.join('\n');
}

/**
 * Build embed items from functions
 */
export function buildFunctionItems(
  functions: FunctionNode[],
  strategy: InputStrategy,
  summaryMap: Map<string, FunctionSummary>,
): EmbedItem[] {
  // A synthesized node (e.g. a Ruby association reader minted from `has_many`) carries no source
  // and no summary — its embedding input would be a bare signature, which bills an embedding call
  // to place a declaration convention in vector space as if it were a function body.
  return functions
    .filter((fn) => !fn.synthesized)
    .map((fn) => {
      const inputText = buildFunctionInput(fn, strategy, summaryMap);
      return {
        id: fn.id,
        versionedId: fn.versionedId,
        type: 'function' as const,
        name: fn.name,
        path: fn.location.filePath,
        inputText,
        inputChecksum: md5(inputText),
      };
    });
}

/**
 * Build embed items from endpoints
 */
export function buildEndpointItems(
  endpoints: Entrypoint[],
  functions: FunctionNode[],
  strategy: InputStrategy,
  summaryMap: Map<string, FunctionSummary>,
): EmbedItem[] {
  const functionMap = new Map(functions.map((fn) => [fn.id, fn]));

  return endpoints.map((endpoint) => {
    const handler = functionMap.get(endpoint.handlerId);
    const inputText = buildEndpointInput(endpoint, handler, strategy, summaryMap);

    // Build path for display
    let path: string;
    const details = endpoint.details;
    switch (details.type) {
      case 'http':
        path = `${details.method} ${details.fullPath}`;
        break;
      case 'graphql':
        path = `${details.operationType} ${details.fieldName}`;
        break;
      case 'grpc':
        path = `${details.serviceName}.${details.methodName}`;
        break;
      case 'websocket':
        path = `ws:${details.event}`;
        break;
      case 'queue':
        path = `${details.system}:${details.topic}`;
        break;
      case 'cron':
        path = `cron:${details.schedule}`;
        break;
      case 'event':
        path = `event:${details.eventName}`;
        break;
      case 'cli':
        path = `cli:${details.command}`;
        break;
      case 'mobile':
        path = `mobile:${details.trigger}:${details.className}`;
        break;
      default:
        path = endpoint.id;
    }

    return {
      id: endpoint.id,
      versionedId: endpoint.versionedId,
      type: 'endpoint' as const,
      name: path,
      path,
      handlerId: endpoint.handlerId,
      endpointType: endpoint.type,
      inputText,
      inputChecksum: md5(inputText),
    };
  });
}

/**
 * Load summaries from file and build a lookup map
 */
export function loadSummaries(summariesPath: string | undefined, defaultPath: string): Map<string, FunctionSummary> {
  const map = new Map<string, FunctionSummary>();
  const filePath = summariesPath || defaultPath;

  if (!fs.existsSync(filePath)) {
    return map;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const summaries: SummaryOutput = JSON.parse(content);

    for (const summary of summaries.summaries) {
      map.set(summary.functionId, summary);
    }
  } catch {
    // Summaries file not found or invalid - that's okay
  }

  return map;
}
