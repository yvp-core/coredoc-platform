import { useState, useCallback, useMemo } from 'react';
import { CheckCircle, Copy } from '@solar-icons/react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { CSSProperties, JSX } from 'react';
import type { McpInfoResult } from '../../shared/ipc-types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export type CopilotTab = 'claude-code' | 'cursor' | 'claude' | 'chatgpt';

export const coredocDark: Record<string, CSSProperties> = {
  'code[class*="language-"]': {
    color: 'var(--color-content-inverted)',
    fontFamily: 'var(--font-sans)',
    fontWeight: 300,
    fontSize: '12px',
    lineHeight: '16px',
    // Wrap rather than scroll. The values in here are absolute paths and workspace
    // URLs — the parts that matter sit at the END of the line, so a horizontal
    // scrollbar hides exactly what the reader came for. `anywhere` because these
    // tokens carry no spaces to break at.
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  'pre[class*="language-"]': {
    color: 'var(--color-content-inverted)',
    fontFamily: 'var(--font-sans)',
    fontWeight: 300,
    fontSize: '12px',
    lineHeight: '16px',
    // Wrap rather than scroll. The values in here are absolute paths and workspace
    // URLs — the parts that matter sit at the END of the line, so a horizontal
    // scrollbar hides exactly what the reader came for. `anywhere` because these
    // tokens carry no spaces to break at.
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    margin: 0,
    padding: '8px',
    overflow: 'auto',
  },
  property: { color: 'var(--color-content-code-magenta)' },
  string: { color: 'var(--color-content-code-green)' },
  punctuation: { color: 'var(--color-content-inverted)' },
  operator: { color: 'var(--color-content-inverted)' },
  boolean: { color: 'var(--color-content-code-green)' },
  number: { color: 'var(--color-content-code-green)' },
  keyword: { color: 'var(--color-content-code-magenta)' },
  'attr-name': { color: 'var(--color-content-code-magenta)' },
  'attr-value': { color: 'var(--color-content-code-green)' },
};

export function ClaudeLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
    >
      <g clipPath="url(#clip0_456_19579)">
        <path
          d="M3.13933 10.6367L6.286 8.872L6.33933 8.71867L6.286 8.63333H6.13333L5.60667 8.60133L3.808 8.55267L2.24867 8.488L0.738 8.40667L0.357333 8.326L0 7.856L0.0366667 7.62133L0.356667 7.40733L0.814 7.44733L1.82733 7.516L3.346 7.62133L4.44733 7.686L6.08 7.856H6.33933L6.376 7.75133L6.28667 7.686L6.218 7.62133L4.646 6.55733L2.94467 5.432L2.054 4.784L1.57133 4.45667L1.32867 4.14867L1.22333 3.47667L1.66067 2.99533L2.248 3.03533L2.398 3.076L2.99333 3.53333L4.26533 4.51733L5.926 5.73933L6.16933 5.942L6.266 5.87333L6.27867 5.82467L6.16933 5.642L5.266 4.01133L4.302 2.35133L3.87267 1.66333L3.75933 1.25067C3.71615 1.09217 3.69286 0.928916 3.69 0.764667L4.18867 0.0893333L4.464 0L5.128 0.0893333L5.408 0.332L5.82133 1.27467L6.48933 2.76067L7.526 4.78067L7.83 5.37933L7.992 5.934L8.05267 6.104H8.158V6.00667L8.24333 4.86933L8.40133 3.47267L8.55467 1.676L8.608 1.16933L8.85867 0.562667L9.35667 0.234667L9.746 0.421333L10.066 0.878L10.0213 1.174L9.83067 2.408L9.458 4.34333L9.21533 5.638H9.35667L9.51867 5.47667L10.1753 4.606L11.2767 3.23L11.7633 2.68333L12.33 2.08067L12.6947 1.79333H13.3833L13.89 2.546L13.6633 3.32333L12.954 4.22133L12.3667 4.98267L11.524 6.116L10.9973 7.02267L11.046 7.096L11.1713 7.08267L13.0753 6.67867L14.104 6.492L15.3313 6.282L15.8867 6.54067L15.9473 6.804L15.7287 7.342L14.416 7.666L12.8767 7.974L10.584 8.516L10.556 8.536L10.5887 8.57667L11.6213 8.674L12.0627 8.698H13.144L15.1573 8.848L15.684 9.196L16 9.62133L15.9473 9.94467L15.1373 10.358L14.044 10.0987L11.4913 9.492L10.6167 9.27267H10.4953V9.346L11.224 10.058L12.5613 11.2647L14.234 12.818L14.3187 13.2033L14.104 13.5067L13.8773 13.474L12.4073 12.3693L11.84 11.8713L10.556 10.7913H10.4707V10.9047L10.7667 11.3373L12.33 13.6847L12.4113 14.4047L12.298 14.64L11.8927 14.782L11.4473 14.7007L10.5313 13.4173L9.588 11.9727L8.826 10.6773L8.73267 10.7307L8.28333 15.5667L8.07267 15.8133L7.58667 16L7.182 15.6927L6.96733 15.1947L7.182 14.2107L7.44133 12.928L7.65133 11.908L7.842 10.6413L7.95533 10.22L7.94733 10.192L7.854 10.204L6.898 11.5153L5.44467 13.4787L4.294 14.7087L4.018 14.818L3.54 14.5713L3.58467 14.13L3.852 13.7373L5.444 11.7133L6.404 10.4587L7.024 9.73467L7.02 9.62933H6.98333L2.75467 12.3733L2.00133 12.4707L1.67667 12.1667L1.71733 11.6693L1.87133 11.5073L3.14333 10.6327L3.13933 10.6367Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id="clip0_456_19579">
          <rect width="16" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function CursorLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
    >
      <g clipPath="url(#clip0_456_19583)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M14.7373 3.78666L8.33333 0.0899923C8.23219 0.0315971 8.11746 0.000854492 8.00067 0.000854492C7.88388 0.000854492 7.76914 0.0315971 7.668 0.0899923L1.262 3.78666C1.17714 3.83581 1.10667 3.90639 1.05765 3.99133C1.00862 4.07627 0.982769 4.17259 0.982666 4.27066V11.728C0.982666 11.928 1.08933 12.1127 1.26267 12.2127L7.66733 15.9107C7.7685 15.969 7.88322 15.9997 8 15.9997C8.11678 15.9997 8.2315 15.969 8.33267 15.9107L14.738 12.2127C14.8231 12.1635 14.8937 12.0929 14.9429 12.0078C14.992 11.9227 15.0179 11.8262 15.018 11.728V4.27133C15.0178 4.17319 14.9919 4.07682 14.9427 3.99188C14.8936 3.90693 14.823 3.83639 14.738 3.78733L14.7373 3.78666ZM14.3353 4.57066L8.152 15.28C8.11 15.352 8 15.3227 8 15.2393V8.22666C7.99989 8.15772 7.98166 8.09003 7.94714 8.03035C7.91263 7.97068 7.86303 7.92113 7.80333 7.88666L1.73 4.37999C1.65867 4.33866 1.688 4.22799 1.77133 4.22799H14.138C14.314 4.22799 14.4233 4.41866 14.3353 4.57066Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id="clip0_456_19583">
          <rect width="16" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function ChatGPTLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={className}
    >
      <g clipPath="url(#clip0_3430_8122)">
        <path
          d="M5.62532 5.33864V3.9453C5.62532 3.82795 5.66898 3.73992 5.77068 3.68132L8.54709 2.06799C8.92501 1.848 9.37564 1.74538 9.84072 1.74538C11.585 1.74538 12.6898 3.10941 12.6898 4.56135C12.6898 4.664 12.6898 4.78134 12.6752 4.89869L9.7971 3.19732C9.62269 3.09471 9.44819 3.09471 9.27379 3.19732L5.62532 5.33864ZM12.1083 10.7654V7.43595C12.1083 7.23057 12.021 7.08391 11.8466 6.98126L8.19816 4.83994L9.39009 4.15056C9.49182 4.09196 9.57907 4.09196 9.68079 4.15056L12.4572 5.76389C13.2567 6.23328 13.7945 7.23057 13.7945 8.19851C13.7945 9.31314 13.1404 10.3399 12.1083 10.7652V10.7654ZM4.76772 7.83204L3.57579 7.12808C3.47409 7.06948 3.43044 6.98141 3.43044 6.86407V3.63743C3.43044 2.06814 4.62237 0.880059 6.23588 0.880059C6.84646 0.880059 7.41323 1.08544 7.89304 1.45209L5.02949 3.12415C4.85512 3.22676 4.76787 3.37342 4.76787 3.57883V7.83216L4.76772 7.83204ZM7.33332 9.32799L5.62532 8.36002V6.30677L7.33332 5.3388L9.04119 6.30677V8.36002L7.33332 9.32799ZM8.43076 13.7867C7.82021 13.7867 7.25343 13.5813 6.77363 13.2147L9.63714 11.5426C9.81155 11.44 9.89879 11.2934 9.89879 11.088V6.83463L11.1053 7.53859C11.207 7.59719 11.2507 7.68522 11.2507 7.8026V11.0292C11.2507 12.5985 10.0441 13.7866 8.43076 13.7866V13.7867ZM4.98575 10.5161L2.20933 8.90277C1.40981 8.43335 0.872053 7.4361 0.872053 6.46813C0.872053 5.3388 1.54071 4.32681 2.57269 3.90144V7.24542C2.57269 7.4508 2.65996 7.59746 2.83434 7.70011L6.46835 9.8267L5.27642 10.5161C5.17473 10.5747 5.08745 10.5747 4.98575 10.5161ZM4.82595 12.9214C3.18339 12.9214 1.97689 11.6747 1.97689 10.1347C1.97689 10.0174 1.99146 9.90003 2.00591 9.78268L4.86945 11.4547C5.04382 11.5574 5.21835 11.5574 5.39272 11.4547L9.04119 9.32815V10.7215C9.04119 10.8388 8.99757 10.9269 8.89584 10.9855L6.11945 12.5988C5.7415 12.8188 5.29087 12.9214 4.8258 12.9214H4.82595ZM8.43076 14.6667C10.1896 14.6667 11.6577 13.4054 11.9921 11.7333C13.6201 11.3079 14.6667 9.76795 14.6667 8.19866C14.6667 7.17194 14.2306 6.17469 13.4457 5.45599C13.5184 5.14797 13.562 4.83994 13.562 4.53207C13.562 2.43476 11.8758 0.865325 9.92797 0.865325C9.53559 0.865325 9.15764 0.923923 8.77969 1.056C8.12548 0.410639 7.22426 0 6.23588 0C4.47705 0 3.00901 1.26126 2.67457 2.93332C1.04658 3.35869 0 4.89869 0 6.46798C0 7.4947 0.436026 8.49195 1.22098 9.21064C1.14831 9.51867 1.10468 9.8267 1.10468 10.1346C1.10468 12.2319 2.79086 13.8013 4.73867 13.8013C5.13107 13.8013 5.50902 13.7427 5.88698 13.6106C6.54103 14.256 7.44226 14.6667 8.43076 14.6667Z"
          fill="currentColor"
        />
      </g>
      <defs>
        <clipPath id="clip0_456_19583">
          <rect width="16" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

export function CopyableCodeBlock({ code, language = 'json' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const isMultiLine = code.trim().includes('\n');

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  if (!isMultiLine) {
    return (
      <div className="relative group rounded-lg bg-bg-tertiary overflow-hidden flex items-center">
        <div className="flex-1 px-3 py-2.5 text-sm text-content-tertiary [overflow-wrap:anywhere] whitespace-pre-wrap">
          {code}
        </div>
        <button
          onClick={handleCopy}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-md bg-bg-tertiary hover:bg-primary-hover text-content-secondary hover:text-content-primary opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          {copied ? <CheckCircle weight="Bold" className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    );
  }

  return (
    <div className="relative group rounded-lg bg-bg-inverted border border-border-inverted shadow-foundation backdrop-blur-[1.5px] overflow-clip">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-bg-inverted-secondary/50 hover:bg-bg-inverted-secondary text-content-quaternary hover:text-content-inverted opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
      >
        {copied ? <CheckCircle weight="Bold" className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {/* Wrapping is done in CSS, NOT with the library's `wrapLongLines`. That prop
          turns each line into a flex row, and with `showLineNumbers` on it collapses
          every token to its own narrow column — a long `"url"` came out shredded one
          letter per line. `pre-wrap` on the pre and the code (restated here because
          `customStyle` and `codeTagProps` merge OVER the theme) wraps the line while
          leaving the token spans inline; the gutter number is an inline-block of fixed
          width, so a wrapped continuation starts under it instead of pushing it. */}
      <SyntaxHighlighter
        language={language}
        style={coredocDark}
        showLineNumbers
        customStyle={{
          margin: 0,
          padding: '8px',
          background: 'transparent',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
        lineNumberStyle={{
          color: 'var(--color-content-tertiary)',
          opacity: 0.5,
          fontSize: '12px',
          lineHeight: '16px',
          display: 'inline-block',
          width: '2em',
          minWidth: '2em',
          paddingRight: '8px',
          textAlign: 'right' as const,
        }}
        codeTagProps={{
          style: {
            fontFamily: 'var(--font-sans)',
            fontWeight: 300,
            fontSize: '12px',
            lineHeight: '16px',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

const COPILOT_LABEL: Record<CopilotTab, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
};

const COPILOT_LOGO: Record<CopilotTab, (props: { className?: string }) => JSX.Element> = {
  'claude-code': ClaudeLogo,
  cursor: CursorLogo,
  claude: ClaudeLogo,
  chatgpt: ChatGPTLogo,
};

export function CopilotSelect({ value, onChange }: { value: CopilotTab; onChange: (tab: CopilotTab) => void }) {
  const Logo = COPILOT_LOGO[value];
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CopilotTab)}>
      <SelectTrigger className="h-auto w-full justify-between rounded-lg border-alto-300 bg-white px-3 py-1.5 text-sm font-semibold text-content-secondary shadow-field">
        <SelectValue asChild>
          <span className="flex items-center gap-1.5">
            <Logo className="size-4" />
            {COPILOT_LABEL[value]}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(COPILOT_LABEL) as CopilotTab[]).map((tab) => {
          const TabLogo = COPILOT_LOGO[tab];
          return (
            <SelectItem key={tab} value={tab}>
              <TabLogo className="size-4" />
              {COPILOT_LABEL[tab]}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export function buildConfigJson(mcpInfo: McpInfoResult): string | null {
  if (!mcpInfo.success || !mcpInfo.command || !mcpInfo.args || !mcpInfo.env) {
    return null;
  }

  return JSON.stringify(
    {
      mcpServers: {
        coredoc: {
          command: mcpInfo.command,
          args: mcpInfo.args,
          env: mcpInfo.env,
        },
      },
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// McpConfigView — shared MCP configuration UI
// ---------------------------------------------------------------------------

interface McpConfigViewProps {
  mcpInfo: McpInfoResult | null;
}

export function McpConfigView({ mcpInfo }: McpConfigViewProps) {
  const [copilot, setCopilot] = useState<CopilotTab>('claude-code');

  const configJson = useMemo(() => (mcpInfo ? buildConfigJson(mcpInfo) : null), [mcpInfo]);
  const configError = mcpInfo && !mcpInfo.success ? mcpInfo.error || 'Failed to resolve local MCP configuration.' : '';

  const sectionTitle =
    copilot === 'claude-code'
      ? 'Add to your Claude Code MCP settings'
      : copilot === 'cursor'
        ? 'Add to your Cursor MCP settings'
        : copilot === 'claude'
          ? 'Add to your Claude MCP settings'
          : 'Add to your ChatGPT MCP settings';

  return (
    <div className="flex flex-col gap-3">
      <CopilotSelect value={copilot} onChange={setCopilot} />

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold leading-4 text-content-quaternary">{sectionTitle}</p>

        <div className="flex flex-col gap-2 text-sm leading-5 text-content-secondary">
          {copilot === 'claude-code' ? (
            <>
              <p>1. In your project root, create .mcp.json</p>
              <p>2. Paste this project-bound JSON and save:</p>
            </>
          ) : copilot === 'cursor' ? (
            <>
              <p>1. In Cursor, open Settings &rarr; MCP and open your MCP configuration file.</p>
              <p>2. Paste this project-bound JSON and save:</p>
            </>
          ) : copilot === 'claude' ? (
            <>
              <p>1. Open Claude settings and navigate to the MCP configuration.</p>
              <p>2. Paste this project-bound JSON and save:</p>
            </>
          ) : (
            <>
              <p>1. Open ChatGPT settings and navigate to the MCP configuration.</p>
              <p>2. Paste this project-bound JSON and save:</p>
            </>
          )}

          {configError ? (
            <div className="rounded-lg border border-border-warning bg-bg-warning/40 px-3 py-2 text-sm text-content-warning">
              {configError}
            </div>
          ) : configJson ? (
            <CopyableCodeBlock code={configJson} />
          ) : (
            <div className="rounded-lg border border-border-tertiary bg-bg-overlay px-3 py-2 text-sm text-content-tertiary">
              Resolving local MCP configuration...
            </div>
          )}

          {copilot === 'claude-code' ? (
            <>
              <p>3. Restart Claude Code (or reload the project).</p>
              <p>
                4. In Claude Code, open the MCP list (Claude Code exposes MCP servers and their scopes; you can verify
                it&apos;s picked up)
              </p>
            </>
          ) : copilot === 'cursor' ? (
            <>
              <p>3. Restart Cursor.</p>
              <p>4. In Cursor, open the MCP list to verify it&apos;s picked up.</p>
            </>
          ) : copilot === 'claude' ? (
            <>
              <p>3. Restart Claude.</p>
              <p>4. Verify coredoc appears in the MCP server list.</p>
            </>
          ) : (
            <>
              <p>3. Restart ChatGPT.</p>
              <p>4. Verify coredoc appears in the MCP server list.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
