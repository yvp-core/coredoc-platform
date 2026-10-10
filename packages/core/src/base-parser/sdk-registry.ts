/**
 * SDK Registry — package-anchored mapping for third-party SDK detection.
 *
 * The profile-parser substrate consults this registry when resolving a
 * constructor or function call (via static import analysis) to a known
 * third-party SDK package, emitting an `ExternalCallEdge`.
 *
 * Why package-anchored and not name-anchored:
 *   Earlier the registry mapped constructor/function NAMES to services:
 *   any `new OpenAI(...)` in any file produced an OpenAI external_call,
 *   even if `OpenAI` was a local class never imported from the `openai`
 *   package. That false-positived against unrelated repos. Anchoring on
 *   the import's module specifier requires real provenance: the call site
 *   must use an identifier imported from a recognized SDK package.
 *
 * Maintenance philosophy: we can't enumerate every SDK ever shipped. The
 * registry is an opinionated default covering the SDKs that ship as
 * `external_call` edges out of the box. Per-repo extraction profiles can
 * extend coverage to recognize repo-specific or org-internal packages.
 *
 * ONE SERVICE, ONE IDENTITY, ACROSS ECOSYSTEMS
 *   Keys are module specifiers in whatever form the language writes them: an
 *   npm package name (`@slack/web-api`) or a Go module path
 *   (`github.com/slack-go/slack`). Every key for the same service MUST carry
 *   the identical `{ service, protocol }` value — that string is what the
 *   cross-repo linker joins on, so a TypeScript repo calling `@slack/web-api`
 *   and a Go repo calling `slack-go/slack` have to collapse onto one "Slack"
 *   node or the dependency graph shows two unrelated services. The Go entries
 *   below therefore sit next to their npm sibling rather than in a language
 *   section, so drift is visible in review. `sdk-registry.test.ts` pins the
 *   invariant.
 *
 *   Go keys are written WITHOUT a major-version suffix: `lookupSdkByPackage`'s
 *   prefix walk resolves `…/openai-go/v3` and `…/slack/slackevents` down to
 *   the versionless module path, so one key covers every version and
 *   subpackage of a module.
 *
 *   Not every Go SDK needs a key. The Go substrate derives registry keys from
 *   an import path first (strip Go's `-go` / `go-` language marker, map the
 *   AWS and Google per-service module layouts onto their npm key shape), so
 *   `github.com/stripe/stripe-go` already reaches `stripe` and
 *   `…/aws-sdk-go-v2/service/s3` already reaches `@aws-sdk/client-s3`. A Go
 *   key is added only where that derivation cannot land on the npm name —
 *   a vendor prefix the marker rule does not strip (`slack-go/slack`,
 *   `algoliasearch-client-go`), an npm name that is scoped or suffixed
 *   (`@sentry/node`, `posthog-node`), or an AWS service whose npm key is
 *   hyphenated while Go's module segment is not (`secretsmanager` vs
 *   `client-secrets-manager`).
 */

export type SdkProtocol = 'http' | 'grpc' | 'sdk';

export interface SdkPackage {
  /** Canonical service name shown on the edge (e.g. "OpenAI", "AWS S3"). */
  service: string;
  /** Transport — `'sdk'` means the SDK proxies the wire protocol internally. */
  protocol: SdkProtocol;
}

/**
 * `<packageName, SdkPackage>`. Match a call site against this by inspecting
 * the import declaration that brought the callee identifier into scope.
 */
export const SDK_PACKAGES: Record<string, SdkPackage> = {
  // AI / LLM
  openai: { service: 'OpenAI', protocol: 'http' },
  '@anthropic-ai/sdk': { service: 'Anthropic', protocol: 'http' },
  // Go: the official SDK's module is `anthropic-sdk-go`, whose marker-stripped
  // name is `anthropic-sdk` — never the scoped npm name.
  'github.com/anthropics/anthropic-sdk-go': { service: 'Anthropic', protocol: 'http' },
  '@ai-sdk/openai': { service: 'OpenAI', protocol: 'http' },
  '@ai-sdk/anthropic': { service: 'Anthropic', protocol: 'http' },
  '@ai-sdk/google': { service: 'Google AI', protocol: 'http' },
  // Go: the current unified SDK, and the Gemini-era one it replaced.
  'google.golang.org/genai': { service: 'Google AI', protocol: 'http' },
  'github.com/google/generative-ai-go': { service: 'Google AI', protocol: 'http' },
  '@ai-sdk/amazon-bedrock': { service: 'AWS Bedrock', protocol: 'http' },
  cohere: { service: 'Cohere', protocol: 'http' },

  // Payments
  stripe: { service: 'Stripe', protocol: 'http' },
  '@stripe/stripe-js': { service: 'Stripe', protocol: 'http' },

  // Comms
  twilio: { service: 'Twilio', protocol: 'http' },
  '@slack/web-api': { service: 'Slack', protocol: 'http' },
  '@slack/bolt': { service: 'Slack', protocol: 'http' },
  // Go: `slack-go/slack` — the marker rule strips the module's own name, not
  // the vendor segment that carries the `-go` here.
  'github.com/slack-go/slack': { service: 'Slack', protocol: 'http' },
  resend: { service: 'Resend', protocol: 'http' },
  '@sendgrid/mail': { service: 'SendGrid', protocol: 'http' },
  'github.com/sendgrid/sendgrid-go': { service: 'SendGrid', protocol: 'http' },

  // Captcha
  hcaptcha: { service: 'hCaptcha', protocol: 'http' },
  '@hcaptcha/react-hcaptcha': { service: 'hCaptcha', protocol: 'http' },
  'react-google-recaptcha': { service: 'reCAPTCHA', protocol: 'http' },

  // Observability
  '@sentry/node': { service: 'Sentry', protocol: 'sdk' },
  '@sentry/browser': { service: 'Sentry', protocol: 'sdk' },
  '@sentry/nextjs': { service: 'Sentry', protocol: 'sdk' },
  '@sentry/react': { service: 'Sentry', protocol: 'sdk' },
  'github.com/getsentry/sentry-go': { service: 'Sentry', protocol: 'sdk' },
  'posthog-node': { service: 'PostHog', protocol: 'http' },
  'posthog-js': { service: 'PostHog', protocol: 'http' },
  'github.com/posthog/posthog-go': { service: 'PostHog', protocol: 'http' },
  'mixpanel-browser': { service: 'Mixpanel', protocol: 'http' },
  '@amplitude/analytics-browser': { service: 'Amplitude', protocol: 'http' },
  'github.com/amplitude/analytics-go': { service: 'Amplitude', protocol: 'http' },
  '@datadog/browser-rum': { service: 'Datadog', protocol: 'http' },
  '@datadog/browser-logs': { service: 'Datadog', protocol: 'http' },
  'github.com/DataDog/datadog-api-client-go': { service: 'Datadog', protocol: 'http' },

  // AI logging
  braintrust: { service: 'Braintrust', protocol: 'http' },

  // Cloud / Storage — AWS SDK v3 packages
  //
  // The Go substrate rewrites `…/aws-sdk-go{,-v2}/service/<svc>` to
  // `@aws-sdk/client-<svc>`, which lands on the npm key whenever the AWS
  // service id is a single word. The two entries below are the exceptions:
  // npm hyphenates the id, Go does not, so they need the module path itself.
  '@aws-sdk/client-s3': { service: 'AWS S3', protocol: 'http' },
  '@aws-sdk/client-ses': { service: 'AWS SES', protocol: 'http' },
  '@aws-sdk/client-sqs': { service: 'AWS SQS', protocol: 'http' },
  '@aws-sdk/client-dynamodb': { service: 'AWS DynamoDB', protocol: 'http' },
  '@aws-sdk/client-secrets-manager': { service: 'AWS Secrets Manager', protocol: 'http' },
  'github.com/aws/aws-sdk-go-v2/service/secretsmanager': { service: 'AWS Secrets Manager', protocol: 'http' },
  '@aws-sdk/client-bedrock-runtime': { service: 'AWS Bedrock', protocol: 'http' },
  'github.com/aws/aws-sdk-go-v2/service/bedrockruntime': { service: 'AWS Bedrock', protocol: 'http' },
  '@google-cloud/storage': { service: 'Google Cloud Storage', protocol: 'http' },
  '@google-cloud/bigquery': { service: 'Google BigQuery', protocol: 'http' },

  // Search / Data
  meilisearch: { service: 'Meilisearch', protocol: 'http' },
  algoliasearch: { service: 'Algolia', protocol: 'http' },
  'github.com/algolia/algoliasearch-client-go': { service: 'Algolia', protocol: 'http' },
  '@elastic/elasticsearch': { service: 'Elasticsearch', protocol: 'http' },
  'github.com/elastic/go-elasticsearch': { service: 'Elasticsearch', protocol: 'http' },

  // Vector DBs / RAG
  '@pinecone-database/pinecone': { service: 'Pinecone', protocol: 'http' },
  'github.com/pinecone-io/go-pinecone': { service: 'Pinecone', protocol: 'http' },
  '@qdrant/js-client-rest': { service: 'Qdrant', protocol: 'http' },
  weaviate: { service: 'Weaviate', protocol: 'http' },
  'github.com/weaviate/weaviate-go-client': { service: 'Weaviate', protocol: 'http' },

  // Other common third-party APIs
  '@octokit/rest': { service: 'GitHub', protocol: 'http' },
  // The core package is what plugin-composed clients import (`Octokit.plugin(retry)`);
  // NOTE the composed-ctor call shape itself needs indirection-hop resolution the
  // substrate doesn't do yet — this row alone captures only direct `new Octokit()` use.
  '@octokit/core': { service: 'GitHub', protocol: 'http' },
  octokit: { service: 'GitHub', protocol: 'http' },
  'github.com/google/go-github': { service: 'GitHub', protocol: 'http' },
};

/**
 * Look up SDK metadata for an import's module specifier. Returns undefined
 * for unknown packages — per-repo extraction profiles may extend coverage.
 *
 * Sub-path imports like `@sentry/nextjs/server` resolve to the longest
 * known package prefix.
 */
export function lookupSdkByPackage(modulePath: string): SdkPackage | undefined {
  if (!modulePath) return undefined;

  const direct = SDK_PACKAGES[modulePath];
  if (direct) return direct;

  // Sub-path import handling. Walk prefixes longest-first so
  // `@sentry/nextjs/server` matches `@sentry/nextjs` before any shorter
  // ancestor.
  const segments = modulePath.split('/');
  for (let i = segments.length - 1; i >= 1; i--) {
    const prefix = segments.slice(0, i).join('/');
    const hit = SDK_PACKAGES[prefix];
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Match-shape returned by the in-parser SDK detector when a call site
 * resolves to a known SDK package.
 */
export interface SdkPackageMatch extends SdkPackage {
  /** The imported package specifier (`'openai'`, `'@sentry/node'`, etc.). */
  sdkName: string;
  /** The callee text as written (`OpenAI`, `Sentry.init`, `loadStripe`). */
  callee: string;
  /** What kind of call site matched. */
  kind: 'constructor' | 'factory' | 'namespace';
}
