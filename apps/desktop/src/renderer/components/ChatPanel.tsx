import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Plain,
  Routing3,
  Compass,
  Documents,
  Map as MapIcon,
  DocumentText,
  Stars,
  Stop,
  Refresh,
  CodeFile,
} from '@solar-icons/react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { useChatStore } from '../stores/chat-store';
import { cn, formatDateTime } from '../lib/utils';
import { MarkdownRenderer } from './markdown/MarkdownRenderer';
import type { ChatMessage, ChatDocCard } from '../../shared/ipc-types';

/** Rough token estimate: ~4 chars per token for English text */
const CHARS_PER_TOKEN = 4;
/** Max context window in tokens (Claude) */
const MAX_CONTEXT_TOKENS = 200_000;
/** Warn when context exceeds this percentage */
const WARN_THRESHOLD = 0.8;
/** Context is full at this percentage */
const FULL_THRESHOLD = 0.95;

interface ChatPanelProps {
  projectId: string;
  /** Repo name to scope context to. null = project scope (show "All" badge). undefined = no badge. */
  contextRepo?: string | null;
  /** Whether the chat panel is in full-screen mode (left panel collapsed) */
  isFullScreen?: boolean;
  /** Slot for context source dropdown (rendered in the chat input footer) */
  contextSourceSlot?: ReactNode;
  /** Cloud member mode */
  isCloudMember?: boolean;
  cloudWorkspaceId?: string;
  cloudRepoNames?: string[];
  /** Called when a doc card in a chat message is clicked. */
  onDocCardClick?: (card: ChatDocCard) => void;
  /** Called to create a new chat session */
  onNewSession?: () => void;
}

export function ChatPanel({
  projectId,
  contextRepo,
  isFullScreen,
  contextSourceSlot,
  isCloudMember,
  cloudWorkspaceId,
  cloudRepoNames,
  onDocCardClick,
  onNewSession,
}: ChatPanelProps) {
  const messages = useChatStore((s) => s.messages);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollHostRef = useRef<HTMLDivElement>(null);
  // Bottom-most visible item index — used to anchor the viewport to this
  // message when the container resizes so the bottom stays locked in place.
  const lastVisibleIndex = useRef(0);

  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      virtuosoRef.current?.scrollToIndex({
        index: lastVisibleIndex.current,
        align: 'end',
        behavior: 'auto',
      });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden"
      data-fullscreen={isFullScreen ? '' : undefined}
    >
      {/* Chat content */}
      <div ref={scrollHostRef} className="flex-1 min-h-0">
        {messages.length === 0 ? (
          <div className="h-full overflow-auto">
            <div className="px-4 pt-3 pb-2 min-h-full flex flex-col">
              <ChatEmptyState
                projectId={projectId}
                contextRepo={contextRepo}
                isCloudMember={isCloudMember}
                cloudWorkspaceId={cloudWorkspaceId}
                cloudRepoNames={cloudRepoNames}
              />
            </div>
          </div>
        ) : (
          <Virtuoso
            key={messages[0]?.id ?? 'empty'}
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={messages}
            initialTopMostItemIndex={Math.max(0, messages.length - 1)}
            followOutput="smooth"
            alignToBottom
            increaseViewportBy={{ top: 200, bottom: 200 }}
            rangeChanged={({ endIndex }: { endIndex: number }) => {
              if (endIndex >= 0) lastVisibleIndex.current = endIndex;
            }}
            itemContent={(_index: number, message: ChatMessage) => (
              <div className="px-4 pt-1 pb-1 first:pt-3 last:pb-2 overflow-x-hidden">
                <ChatMessageBubble message={message} onDocCardClick={onDocCardClick} />
              </div>
            )}
          />
        )}
      </div>

      {/* Chat input — isolated component, typing does not re-render messages */}
      <ChatInput
        projectId={projectId}
        contextRepo={contextRepo}
        contextSourceSlot={contextSourceSlot}
        isCloudMember={isCloudMember}
        cloudWorkspaceId={cloudWorkspaceId}
        cloudRepoNames={cloudRepoNames}
        onNewSession={onNewSession}
      />
    </div>
  );
}

/**
 * The four chat entry points. Each carries its own icon tint (Figma `4832:6496`
 * and siblings): the tile is the hue's 100, the glyph a readable tone of the same
 * hue. The tint is per-card identity, not decoration — it is what makes the four
 * scannable at a glance when the labels wrap differently.
 */
const quickActions = [
  { icon: Routing3, title: 'Explore end-to-end flows', tile: 'bg-dodger-blue-100', glyph: 'text-dodger-blue-500' },
  {
    icon: Compass,
    title: 'Explore system dependencies',
    tile: 'bg-lavender-magenta-100',
    glyph: 'text-lavender-magenta-400',
  },
  { icon: Documents, title: 'Create docs from graph', tile: 'bg-red-100', glyph: 'text-red-500' },
  { icon: MapIcon, title: 'View high-level system map', tile: 'bg-orange-100', glyph: 'text-orange-500' },
];

function ChatEmptyState({
  projectId,
  contextRepo,
  isCloudMember,
  cloudWorkspaceId,
  cloudRepoNames,
}: Pick<ChatInputProps, 'projectId' | 'contextRepo' | 'isCloudMember' | 'cloudWorkspaceId' | 'cloudRepoNames'>) {
  const sendMessage = useChatStore((s) => s.sendMessage);

  const handleQuickAction = useCallback(
    async (title: string) => {
      if (isCloudMember && cloudWorkspaceId) {
        await sendMessage(title, {
          cloudMember: true,
          workspaceId: cloudWorkspaceId,
          cloudRepoNames,
          ...(contextRepo ? { repo: contextRepo } : {}),
        });
        return;
      }
      await sendMessage(title, contextRepo ? { project: projectId, repo: contextRepo } : { project: projectId });
    },
    [sendMessage, isCloudMember, cloudWorkspaceId, cloudRepoNames, contextRepo, projectId],
  );

  return (
    <div className="flex flex-1 flex-col items-center justify-center w-full pb-8">
      {/* Logo */}
      <div className="flex items-center gap-3 mb-8">
        <img src="./logo.svg" alt="Coredoc" className="w-10 h-10" />
        <span className="text-2xl font-semibold">Coredoc.ai</span>
      </div>

      {/* Quick action cards — Figma `4832:6495` wrapper, `4832:6496` and siblings.
          `flex-1 min-w-0 max-w-[200px]`, NOT a fixed width: 200px is the design's
          ceiling at full width, and pinning it there is what made the row overflow
          and clip its first and last card once the left panel or a drawer narrowed
          the pane. `self-stretch` keeps all four the same height however the
          labels wrap. */}
      <div className="flex w-full flex-wrap items-stretch justify-center gap-4">
        {quickActions.map((action) => (
          <button
            key={action.title}
            type="button"
            // `basis-[160px]` is the wrap threshold, not a width. Four across needs
            // 4×160+3×16 = 688px, which the design's full-width pane clears — so it
            // stays 4×1 there and the cards grow toward the 200px ceiling. Once a left
            // panel AND a drawer are both open the pane drops under 688 and the row
            // wraps to 2×2 rather than squeezing four columns into ~165px each, which
            // stacked every label into a four-line sliver.
            className="flex min-w-0 max-w-[200px] flex-1 basis-[160px] flex-col items-start gap-1.5 self-stretch rounded-md border border-selago-100 bg-selago-50 p-4 text-left transition-colors hover:border-selago-200"
            onClick={() => handleQuickAction(action.title)}
          >
            <span className={cn('flex shrink-0 items-center justify-center rounded-sm p-1', action.tile)}>
              <action.icon className={cn('size-4', action.glyph)} />
            </span>
            <span className="text-xs leading-4 text-content-tertiary">{action.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface ChatInputProps {
  projectId: string;
  contextRepo?: string | null;
  contextSourceSlot?: ReactNode;
  isCloudMember?: boolean;
  cloudWorkspaceId?: string;
  cloudRepoNames?: string[];
  onNewSession?: () => void;
}

function ChatInput({
  projectId,
  contextRepo,
  contextSourceSlot,
  isCloudMember,
  cloudWorkspaceId,
  cloudRepoNames,
  onNewSession,
}: ChatInputProps) {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isLoading = useChatStore((s) => s.isLoading);
  const cancelMessage = useChatStore((s) => s.cancelMessage);
  const messages = useChatStore((s) => s.messages);
  const clearMessages = useChatStore((s) => s.clearMessages);
  const [input, setInput] = useState('');

  // Estimate context usage from message history
  const contextUsage = useMemo(() => {
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
    const ratio = estimatedTokens / MAX_CONTEXT_TOKENS;
    return { estimatedTokens, ratio };
  }, [messages]);

  const isContextFull = contextUsage.ratio >= FULL_THRESHOLD;
  const isContextWarning = contextUsage.ratio >= WARN_THRESHOLD;

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading || isContextFull) return;
    const message = input;
    setInput('');

    if (isCloudMember && cloudWorkspaceId) {
      const linkedPaths = await window.electronAPI.getLinkedRepos(cloudWorkspaceId);
      const linkedRepoPaths: Record<string, string> = {};
      for (const lr of linkedPaths) {
        linkedRepoPaths[lr.repoName] = lr.localPath;
      }
      const context = {
        cloudMember: true,
        workspaceId: cloudWorkspaceId,
        cloudRepoNames,
        linkedRepoPaths,
        ...(contextRepo ? { repo: contextRepo } : {}),
      };
      await sendMessage(message, context);
    } else {
      // Local mode — existing behavior
      const context = contextRepo ? { project: projectId, repo: contextRepo } : { project: projectId };
      await sendMessage(message, context);
    }
  }, [
    input,
    isLoading,
    isContextFull,
    isCloudMember,
    cloudWorkspaceId,
    cloudRepoNames,
    contextRepo,
    projectId,
    sendMessage,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return String(tokens);
  };

  return (
    <div className="shrink-0">
      <div
        className={cn(
          'flex flex-col gap-2 rounded-xl border shadow-field px-3 pt-2.5 pb-2',
          isContextFull ? 'border-red-500/30 bg-red-500/5' : 'border-border-input bg-bg-input',
        )}
      >
        {/* Context overflow banner — inside the input container to avoid layout shift */}
        {isContextFull && (
          <div className="flex items-center justify-between gap-2 px-1 py-1">
            <span className="text-xs text-red-400">Context is full. Start a new chat to continue.</span>
            <Button size="xs" variant="outline" onClick={onNewSession || clearMessages} className="text-xs shrink-0">
              New chat
            </Button>
          </div>
        )}
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isContextFull ? 'Context full — start a new chat' : 'Ask anything about the project, use / for command'
          }
          disabled={isLoading || isContextFull}
          className="border-0 bg-transparent shadow-none p-0 h-auto text-xs focus-visible:ring-0"
        />
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
            {contextSourceSlot ?? <div />}
            {/* Context usage indicator */}
            {messages.length > 0 && (
              <span
                className={cn(
                  'text-[10px] tabular-nums whitespace-nowrap',
                  isContextFull
                    ? 'text-content-warning'
                    : isContextWarning
                      ? 'text-content-tag-info'
                      : 'text-content-quaternary',
                )}
              >
                {formatTokens(contextUsage.estimatedTokens)} / {formatTokens(MAX_CONTEXT_TOKENS)} tokens
              </span>
            )}
          </div>
          {isLoading ? (
            <Button
              size="icon-xs"
              variant="default"
              aria-label="Cancel response"
              onClick={cancelMessage}
              className="size-7 shrink-0 ml-auto rounded-full border border-border-action shadow-action backdrop-blur-[10px]"
            >
              <Stop weight="Bold" className="size-3" />
            </Button>
          ) : (
            <Button
              size="icon-xs"
              variant="default"
              aria-label="Send message"
              onClick={handleSend}
              disabled={!input.trim() || isContextFull}
              className="size-7 shrink-0 ml-auto rounded-full border border-border-action shadow-action backdrop-blur-[10px]"
            >
              <Plain weight="Bold" className="size-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  onDocCardClick,
}: {
  message: ChatMessage;
  onDocCardClick?: (card: ChatDocCard) => void;
}) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : ''}`}>
      <div className={`min-w-0 ${isUser ? 'max-w-[80%]' : 'w-full'}`}>
        {isUser ? (
          <div className="rounded-tl-lg rounded-tr-lg rounded-bl-lg px-3 py-2 text-sm text-content-primary transition-colors duration-500 bg-bg-primary-hover [div[data-fullscreen]_&]:bg-bg-overlay-hover">
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        ) : (
          <div className="text-sm min-w-0">
            {message.isStreaming && !message.content && (
              <div className="flex items-center gap-2 px-1 py-2">
                <GradientIcon>
                  <Stars weight="Bold" className="size-5" />
                </GradientIcon>
                <div className="flex items-center gap-1">
                  <span className="text-sm font-medium text-content-primary">Thinking</span>
                  <span className="text-xs text-content-quaternary pt-0.5">Just a sec...</span>
                </div>
              </div>
            )}
            {message.content && (
              <div className="overflow-hidden">
                <MarkdownRenderer
                  content={message.content}
                  className="text-sm"
                  enableMermaid={true}
                  enableSyntaxHighlight={true}
                  diagramZoomable={true}
                  maxDiagramHeight={400}
                />
              </div>
            )}
            {message.docCards && message.docCards.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-2 pb-1">
                {message.docCards.map((card) => (
                  <ChatDocCardItem key={card.id} card={card} onDocCardClick={onDocCardClick} />
                ))}
              </div>
            )}
            {message.isStreaming && message.content && (
              <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5" />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function GradientIcon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 gradient-icon', className)}>
      <svg width="0" height="0" className="absolute">
        <defs>
          <linearGradient id="gradient-icon-fill" x1="100%" y1="50%" x2="0%" y2="50%" gradientUnits="objectBoundingBox">
            <stop offset="0%" stopColor="#439CFB" />
            <stop offset="100%" stopColor="#F187FB" />
          </linearGradient>
        </defs>
      </svg>
      {children}
    </span>
  );
}

function ChatDocCardItem({
  card,
  onDocCardClick,
}: {
  card: ChatDocCard;
  onDocCardClick?: (card: ChatDocCard) => void;
}) {
  const formattedDate = card.generatedAt ? formatDateTime(new Date(card.generatedAt)) : null;

  return (
    <button
      type="button"
      className="font-sans font-normal flex gap-1.5 items-start px-4 py-3 rounded-lg bg-bg-primary border border-white/50 shadow-surface text-left transition-colors hover:border-primary/50 cursor-pointer w-full max-w-[400px]"
      onClick={() => onDocCardClick?.(card)}
    >
      <div className="bg-bg-supportive flex items-center justify-center p-1.5 rounded-sm shrink-0">
        <DocumentText weight="Bold" className="size-4 text-white" />
      </div>
      <div className="flex-1 flex flex-col gap-1.5 min-w-0 pl-2">
        <span className="text-sm font-medium leading-5 tracking-normal text-content-primary truncate">
          {card.title}
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <CodeFile className="size-4 text-content-secondary shrink-0" />
            <span className="text-xs leading-4 tracking-normal text-content-secondary whitespace-nowrap">
              {card.repoName}
            </span>
          </div>
          {formattedDate && (
            <div className="flex items-center gap-1">
              <Refresh weight="Bold" className="size-4 text-content-secondary shrink-0" />
              <span className="text-xs leading-4 tracking-normal text-content-secondary whitespace-nowrap">
                {formattedDate}
              </span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
