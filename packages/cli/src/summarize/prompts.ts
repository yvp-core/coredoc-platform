/**
 * Shared prompts for summarizers
 *
 * Prompt strings and builders shared by the local summarizers (Claude Agent SDK)
 * and the CI summarizer (Vercel AI SDK).
 */

import { FunctionNode, ParsedRepo, HttpEntrypointDetails } from '@coredoc/core/types';
import { generateERDiagram } from '@coredoc/core/utils';
import { CalleeSummaryContext, FunctionSummary, SideEffect } from './types.js';

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

export const FUNCTION_SUMMARIZER_SYSTEM_PROMPT = `You are a code analysis expert. Your task is to analyze source code and generate structured summaries.

CRITICAL RULES:
1. Report ONLY DIRECT side effects - effects that happen IN THIS CODE, not in called functions
2. Do not propagate or duplicate side effects from called functions
3. Be precise and concise - avoid speculation
4. If uncertain about something, add it to "unknowns" rather than guessing
5. Base all analysis on the actual code, not assumptions
6. Describe what the code does and why — do NOT transcribe the source or restate the signature verbatim; the reader already has the code

WHAT IS NOT A SIDE EFFECT (DO NOT REPORT THESE):
- Calling other functions/methods is NOT a side effect - even if those functions have side effects
- Delegating work to another function is NOT a side effect
- Passing arguments to functions is NOT a side effect
- Returning values is NOT a side effect
- Pure computation, data transformation, or mapping is NOT a side effect
- Creating arrays, objects, or data structures is NOT a side effect

IMPORTANT: If a function just calls another function and returns, it likely has NO SIDE EFFECTS.
Example: "return startApplication(module, [...customizations])" has ZERO side effects.
The side effects belong to startApplication, not to the calling function.

WHAT IS A SIDE EFFECT (only these, and ONLY if directly in the code):
- logging: console.log, logger.info/warn/error, debug output in THIS function body
- database: Direct ORM/query calls in THIS function (repository.find, em.persist, prisma.user.create)
- event: Direct event emissions in THIS function (kafkaProducer.send, eventEmitter.emit)
- external_call: Direct HTTP calls in THIS function (fetch, axios.get, httpService.post)
- job: Direct job scheduling in THIS function (queue.add, scheduler.schedule)
- other: File I/O, global state mutation directly in THIS function

If the code only calls other functions without directly performing I/O, the side_effects array should be EMPTY [].

OUTPUT FORMAT:
You MUST respond with valid JSON matching this exact schema:
{
  "detailed_summary": "string - comprehensive description of what it does",
  "purpose": "string - one sentence describing the purpose",
  "business_logic": ["array of strings - business rules, filters, conditions, if/else logic"],
  "side_effects": [
    {
      "type": "logging|database|event|external_call|job|other",
      "description": "what the side effect does",
      "isDirect": true
    }
  ],
  "data_handling": "string - how data is transformed, validated, or processed",
  "confidence_level": "high|medium|low",
  "unknowns": ["array of strings - things that couldn't be determined"]
}

SIDE EFFECT TYPES (only report if code DIRECTLY contains these):
- logging: console.log, logger calls, debug output
- database: DB queries, ORM operations (find, save, update, delete)
- event: Event emissions (Kafka produce, EventEmitter.emit, pub/sub)
- external_call: HTTP/gRPC to external services (NOT internal function calls!)
- job: Job scheduling, queue operations (enqueue, schedule)
- other: Any other side effect not in above categories

CONFIDENCE LEVELS:
- high: Code is straightforward, all aspects clearly understood
- medium: Some ambiguity but core functionality is clear
- low: Significant unknowns or complex/obfuscated logic

Respond with ONLY the JSON object, no markdown code blocks.`;

export const REPO_SUMMARIZER_SYSTEM_PROMPT = `You are a code analysis expert. Your task is to generate a high-level summary of a codebase repository.

RULES:
1. Be concise and factual
2. Focus on what the repository does, not implementation details
3. Base all analysis on the provided information, not assumptions
4. For data model, describe the main entities and their key relationships
5. For external integrations, list only the service names (not implementation details)
6. Reference where things live; do not reproduce directory trees, full file lists, or enum/constant values verbatim — those go stale the moment the code changes

OUTPUT FORMAT:
You MUST respond with valid JSON matching this exact schema:
{
  "overview": "2-3 sentence description of what this repository/service does",
  "dataModel": "Brief description of main data entities and their relationships",
  "externalIntegrations": ["ServiceName1", "ServiceName2", ...]
}

EXAMPLES:

{
  "overview": "An authentication and user management service that handles user registration, login, password reset, and session management. It supports OAuth2 providers and issues JWT tokens for API access.",
  "dataModel": "User is the central entity with Profile and Credentials. Users have Sessions for active logins and RefreshTokens for token renewal. OAuthConnection links users to external providers. Role and Permission control access.",
  "externalIntegrations": ["Google OAuth", "GitHub OAuth", "SendGrid", "Redis"]
}

{
  "overview": "A monorepo containing shared libraries and API clients used across multiple frontend and backend services. It provides TypeScript SDK for internal APIs, common UI components, and shared utility functions.",
  "dataModel": "No database entities. This is a library package that exports typed API clients, React components, and utility modules consumed by other services.",
  "externalIntegrations": ["Core API", "Billing API", "Analytics API"]
}

Respond with ONLY the JSON object, no markdown code blocks.`;

export const PACKAGE_SUMMARIZER_SYSTEM_PROMPT = `You are a code analysis expert. Your task is to generate a one-sentence purpose description for each package in a monorepo.

RULES:
1. Be concise and factual - exactly ONE sentence per package
2. Focus on what the package does, not implementation details
3. Base all analysis on the provided information, not assumptions
4. Each purpose should clearly differentiate the package from others
5. State the package's role, not its contents — do not restate the file list or directory layout already provided above

OUTPUT FORMAT:
You MUST respond with a valid JSON array matching this exact schema:
[
  { "packageId": "package-stable-id", "purpose": "One sentence describing what this package does" },
  ...
]

EXAMPLES:

[
  { "packageId": "abc123:pkg:packages/api", "purpose": "REST API server that handles user authentication, project management, and billing operations." },
  { "packageId": "abc123:pkg:packages/shared", "purpose": "Shared TypeScript types, utility functions, and validation schemas used across all other packages." },
  { "packageId": "abc123:pkg:packages/worker", "purpose": "Background job processor that handles email delivery, report generation, and data synchronization tasks." }
]

Respond with ONLY the JSON array, no markdown code blocks.`;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the prompt for summarizing a single function/method.
 */
export function buildFunctionPrompt(fn: FunctionNode, calleeSummaries: CalleeSummaryContext[]): string {
  // Both summarize paths (summarize/index.ts and ci-summarize-orchestrator.ts) drop source-less
  // functions before they reach a prompt. A signature-only prompt produces a confident fabrication
  // at full LLM cost, so a caller that gets here has a filter bug — fail fast rather than pay for it.
  if (!fn.sourceCode?.trim()) {
    throw new Error(
      `Cannot summarize ${fn.name} (${fn.location.filePath}:${fn.location.startLine}): no source code ` +
        `captured by the parser build that produced this output — re-parse with the current build.`,
    );
  }
  const itemType = fn.kind === 'method' ? 'method' : 'function';
  const className = fn.classId ? fn.classId.split(':').pop()?.split('.')[0] : null;

  let prompt = `Analyze this ${itemType}:

NAME: ${fn.name}${className ? ` (in class ${className})` : ''}
FILE: ${fn.location.filePath}:${fn.location.startLine}
${fn.documentation ? `DOCUMENTATION: ${fn.documentation}\n` : ''}
SOURCE CODE:
\`\`\`
${fn.sourceCode}
\`\`\`
`;

  if (calleeSummaries.length > 0) {
    prompt += `
CALLED ITEMS (for context only - DO NOT report their side effects as your direct effects):
${calleeSummaries
  .map((cs) => {
    const sideEffectsList =
      cs.side_effects.length > 0
        ? cs.side_effects.map((se: SideEffect) => se.description).join(', ')
        : 'none identified';
    return `- ${cs.functionName}: ${cs.purpose}
  Their side effects (INDIRECT - do not duplicate): ${sideEffectsList}`;
  })
  .join('\n')}
`;
  }

  prompt += `
Generate the summary JSON:`;

  return prompt;
}

/**
 * Build the prompt for summarizing a repository.
 */
export function buildRepoPrompt(parsedRepo: ParsedRepo, functionSummaries: FunctionSummary[]): string {
  // Build summary map for quick lookup
  const summaryMap = new Map(functionSummaries.map((s) => [s.functionId, s]));

  // Derive languages from files
  const languages = [...new Set(parsedRepo.files.map((f) => f.language).filter(Boolean))];

  // Get HTTP endpoints (up to 50) with their purposes
  const httpEndpoints = parsedRepo.entrypoints
    .filter((ep) => ep.details.type === 'http')
    .slice(0, 50)
    .map((ep) => {
      const details = ep.details as HttpEntrypointDetails;
      const summary = summaryMap.get(ep.handlerId);
      const purpose = summary?.purpose || 'Purpose not available';
      return `- ${details.method} ${details.fullPath}: ${purpose}`;
    });

  // Generate compact ERD (relations only, no fields) for LLM context
  const erd = generateERDiagram(parsedRepo.entities, { includeFields: false });

  // Get unique external service/SDK names
  const externalServices = [
    ...new Set(parsedRepo.externalCalls.map((ec) => ec.sdkName || ec.serviceName).filter(Boolean)),
  ];

  let prompt = `Analyze this repository and generate a high-level summary:

REPOSITORY: ${parsedRepo.name}
TYPE: ${parsedRepo.type}
LANGUAGES: ${languages.join(', ') || 'Unknown'}

STATISTICS:
- Files: ${parsedRepo.files.length}
- Functions/Methods: ${parsedRepo.functions.length}
- Classes: ${parsedRepo.classes.length}
- HTTP Endpoints: ${parsedRepo.entrypoints.filter((ep) => ep.details.type === 'http').length}
- Database Entities: ${parsedRepo.entities.length}
- External Calls: ${parsedRepo.externalCalls.length}
`;

  if (httpEndpoints.length > 0) {
    prompt += `
HTTP ENDPOINTS (${httpEndpoints.length} shown):
${httpEndpoints.join('\n')}
`;
  }

  if (erd) {
    prompt += `
DATA MODEL (ERD):
\`\`\`mermaid
${erd}
\`\`\`
`;
  }

  if (externalServices.length > 0) {
    prompt += `
EXTERNAL SERVICES/SDKS USED:
${externalServices.map((s) => `- ${s}`).join('\n')}
`;
  }

  prompt += `
Generate the repository summary JSON:`;

  return prompt;
}

/**
 * Build the prompt for summarizing packages in a monorepo.
 */
export function buildPackagePrompt(parsedRepo: ParsedRepo, _functionSummaries: FunctionSummary[]): string {
  // Build file-to-package map for matching functions to packages
  const fileToPackageId = new Map(parsedRepo.files.map((f) => [f.id, f.packageId]));

  // Build function-to-file map
  const functionFileMap = new Map(parsedRepo.functions.map((f) => [f.id, f.fileId]));

  // Count functions per package
  const functionCountByPackage = new Map<string, number>();
  for (const fn of parsedRepo.functions) {
    const pkgId = fileToPackageId.get(fn.fileId);
    if (pkgId) {
      functionCountByPackage.set(pkgId, (functionCountByPackage.get(pkgId) || 0) + 1);
    }
  }

  // Entrypoints per package (count and types)
  const entrypointsByPackage = new Map<string, Map<string, number>>();
  for (const ep of parsedRepo.entrypoints) {
    const fnFileId = functionFileMap.get(ep.handlerId);
    const pkgId = fnFileId ? fileToPackageId.get(fnFileId) : undefined;
    if (pkgId) {
      if (!entrypointsByPackage.has(pkgId)) {
        entrypointsByPackage.set(pkgId, new Map());
      }
      const typeMap = entrypointsByPackage.get(pkgId)!;
      const epType = ep.details.type;
      typeMap.set(epType, (typeMap.get(epType) || 0) + 1);
    }
  }

  // Entities per package
  const entitiesByPackage = new Map<string, string[]>();
  for (const entity of parsedRepo.entities) {
    const pkgId = fileToPackageId.get(entity.fileId);
    if (pkgId) {
      if (!entitiesByPackage.has(pkgId)) {
        entitiesByPackage.set(pkgId, []);
      }
      entitiesByPackage.get(pkgId)!.push(entity.name);
    }
  }

  // Files per package (top 5 paths)
  const filesByPackage = new Map<string, string[]>();
  for (const file of parsedRepo.files) {
    if (!filesByPackage.has(file.packageId)) {
      filesByPackage.set(file.packageId, []);
    }
    filesByPackage.get(file.packageId)!.push(file.path);
  }

  let prompt = `Analyze each package in this monorepo and generate a one-sentence purpose description for each:

REPOSITORY: ${parsedRepo.name}
TYPE: ${parsedRepo.type || 'Unknown'}
TOTAL PACKAGES: ${parsedRepo.packages.length}

`;

  for (const pkg of parsedRepo.packages) {
    const fnCount = functionCountByPackage.get(pkg.id) || 0;
    const epTypes = entrypointsByPackage.get(pkg.id);
    const entities = entitiesByPackage.get(pkg.id) || [];
    const files = filesByPackage.get(pkg.id) || [];

    prompt += `--- PACKAGE: ${pkg.name} ---
ID: ${pkg.id}
Path: ${pkg.path}
Type: ${pkg.type || 'Unknown'}
Language: ${pkg.language || 'Unknown'}
Functions: ${fnCount}
`;

    if (epTypes && epTypes.size > 0) {
      const epSummary = [...epTypes.entries()].map(([type, count]) => `${type}(${count})`).join(', ');
      prompt += `Entrypoints: ${epSummary}
`;
    }

    if (entities.length > 0) {
      prompt += `Entities: ${entities.join(', ')}
`;
    }

    if (files.length > 0) {
      const topFiles = files.slice(0, 5);
      prompt += `Top files: ${topFiles.join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}
`;
    }

    prompt += '\n';
  }

  prompt += `Generate the package summaries JSON array:`;

  return prompt;
}
