import { create } from 'zustand';
import type {
  ChatMessage,
  ChatToolCall,
  ChatDocCard,
  ChatStreamDelta,
  ChatStreamToolUpdate,
  ChatStreamEnd,
  ChatSessionMeta,
  ChatSession,
  ChatContext,
} from '../../shared/ipc-types';

interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;

  // Session state
  sessionId: string | null;
  projectId: string | null;
  isDirty: boolean;
  sessions: ChatSessionMeta[];

  // Actions
  sendMessage: (content: string, context?: ChatContext) => Promise<void>;
  cancelMessage: () => void;
  clearMessages: () => void;

  // Session actions
  setProjectId: (projectId: string) => void;
  loadSessions: (projectId: string) => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  createSession: (projectId: string, name?: string) => Promise<string | null>;
  saveSession: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  renameSession: (sessionId: string, newName: string) => Promise<boolean>;

  // Docs generation in chat
  startDocsGeneration: (userContent: string, commandId: string) => void;
  completeDocsGeneration: (commandId: string, docCards: ChatDocCard[], error?: string) => Promise<void>;

  // Internal handlers
  handleDelta: (data: ChatStreamDelta) => void;
  handleTool: (data: ChatStreamToolUpdate) => void;
  handleEnd: (data: ChatStreamEnd) => void;
}

interface DocsCommandMeta {
  sessionId: string;
  projectId: string;
  assistantId: string;
}

// Maps commandId → chat session that owns the in-flight docs messages
const docsCommandMap = new Map<string, DocsCommandMeta>();

function applyDocsCompletionToMessage(
  message: ChatMessage,
  assistantId: string,
  docCards: ChatDocCard[],
  error?: string,
): ChatMessage {
  if (message.id !== assistantId) return message;
  return {
    ...message,
    isStreaming: false,
    content: error ? `Documentation generation failed: ${error}` : 'Here is the generated documentation:',
    docCards: error ? undefined : docCards,
  };
}

function completeChatMessage(message: ChatMessage, error?: string): ChatMessage {
  if (!error) return { ...message, isStreaming: false };
  const failure = `Chat failed: ${error}`;
  return {
    ...message,
    isStreaming: false,
    content: message.content ? `${message.content}\n\n${failure}` : failure,
  };
}

export const useChatStore = create<ChatState>((set, get) => {
  // Set up IPC listeners on store creation
  if (typeof window !== 'undefined' && window.electronAPI) {
    window.electronAPI.onChatStreamDelta((data) => get().handleDelta(data));
    window.electronAPI.onChatStreamTool((data) => get().handleTool(data));
    window.electronAPI.onChatStreamEnd((data) => get().handleEnd(data));
  }

  return {
    messages: [],
    isLoading: false,
    error: null,
    sessionId: null,
    projectId: null,
    isDirty: false,
    sessions: [],

    sendMessage: async (content, context) => {
      const { messages } = get();

      // Add user message
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };

      // Add placeholder assistant message
      const assistantMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolCalls: [],
        timestamp: new Date().toISOString(),
      };

      set({
        messages: [...messages, userMsg, assistantMsg],
        isLoading: true,
        error: null,
        isDirty: true,
      });

      try {
        await window.electronAPI.sendChatMessage(content, context);
      } catch (error) {
        const failure = error instanceof Error ? error.message : 'Failed to send message';
        set((state) => ({
          isLoading: false,
          error: failure,
          messages: state.messages.map((message) =>
            message.id === assistantMsg.id ? completeChatMessage(message, failure) : message,
          ),
        }));
      }
    },

    startDocsGeneration: (userContent, commandId) => {
      const { messages, sessionId, projectId } = get();
      if (!sessionId || !projectId) return;

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: userContent,
        timestamp: new Date().toISOString(),
      };

      const assistantId = `docs-${Date.now()}`;
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: 'Thinking... Just a sec...',
        isStreaming: true,
        timestamp: new Date().toISOString(),
      };

      docsCommandMap.set(commandId, { sessionId, projectId, assistantId });

      // Note: we intentionally do NOT set isLoading here.
      // Docs generation uses per-message isStreaming instead of the global isLoading flag
      // to avoid race conditions when multiple docs commands run concurrently
      // (the first completion would flip chat to idle while others are still pending).
      set({
        messages: [...messages, userMsg, assistantMsg],
        isDirty: true,
      });
    },

    completeDocsGeneration: async (commandId, docCards, error) => {
      const meta = docsCommandMap.get(commandId);
      docsCommandMap.delete(commandId);
      if (!meta) return;

      const { sessionId: targetSessionId, projectId, assistantId } = meta;
      const { sessionId: activeSessionId } = get();

      if (activeSessionId === targetSessionId) {
        set((state) => ({
          messages: state.messages.map((m) => applyDocsCompletionToMessage(m, assistantId, docCards, error)),
          isDirty: true,
        }));
        await get().saveSession();
        return;
      }

      // User switched chats while docs were generating — patch the originating session on disk.
      const loaded = await window.electronAPI.loadSession(targetSessionId);
      if (!loaded.success || !loaded.session) return;

      const updatedMessages = (loaded.session.messages ?? []).map((m) =>
        applyDocsCompletionToMessage(m, assistantId, docCards, error),
      );
      if (!updatedMessages.some((m) => m.id === assistantId)) return;

      const listMeta = get().sessions.find((s) => s.id === targetSessionId);
      const session: ChatSession = {
        ...loaded.session,
        messages: updatedMessages,
        name: listMeta?.name ?? loaded.session.name,
        createdAt: listMeta?.createdAt ?? loaded.session.createdAt,
        updatedAt: new Date().toISOString(),
      };

      const saveResult = await window.electronAPI.saveSession(session);
      if (saveResult.success) {
        await get().loadSessions(projectId);
      }
    },

    handleDelta: ({ messageId, delta }) => {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId || (m.isStreaming && m.role === 'assistant') ? { ...m, content: m.content + delta } : m,
        ),
      }));
    },

    handleTool: ({ messageId, toolCall }) => {
      set((state) => ({
        messages: state.messages.map((m) => {
          if (m.id === messageId || (m.isStreaming && m.role === 'assistant')) {
            const existingTools = m.toolCalls || [];
            const existingIndex = existingTools.findIndex((t) => t.id === toolCall.id);

            let updatedTools: ChatToolCall[];
            if (existingIndex >= 0) {
              // Update existing tool call
              updatedTools = [...existingTools];
              updatedTools[existingIndex] = toolCall;
            } else {
              // Add new tool call
              updatedTools = [...existingTools, toolCall];
            }

            return { ...m, toolCalls: updatedTools };
          }
          return m;
        }),
      }));
    },

    handleEnd: ({ messageId, success, error }) => {
      const failure = success ? undefined : (error ?? 'Unknown error');
      set((state) => ({
        isLoading: false,
        error: failure ?? null,
        messages: state.messages.map((m) =>
          m.id === messageId || (m.isStreaming && m.role === 'assistant') ? completeChatMessage(m, failure) : m,
        ),
      }));

      // Auto-save session after message completes
      const { sessionId, saveSession } = get();
      if (sessionId) {
        saveSession();
      }
    },

    cancelMessage: () => {
      window.electronAPI.cancelChat();
      set((state) => ({
        isLoading: false,
        messages: state.messages.map((m) =>
          m.isStreaming ? { ...m, isStreaming: false, content: m.content + ' [cancelled]' } : m,
        ),
      }));

      // Save partial response to session file
      const { sessionId, saveSession } = get();
      if (sessionId) {
        saveSession();
      }
    },

    clearMessages: () => {
      window.electronAPI.clearChat();
      set({ messages: [], error: null, isDirty: false });
    },

    setProjectId: (projectId) => {
      const current = get().projectId;
      if (current === projectId) return;
      window.electronAPI.clearChat();
      set({ projectId, sessionId: null, messages: [], isDirty: false, error: null });
    },

    loadSessions: async (projectId) => {
      const result = await window.electronAPI.listSessions(projectId);
      if (result.success && result.sessions) {
        set({ sessions: result.sessions, projectId });
      }
    },

    loadSession: async (sessionId) => {
      const { sessionId: currentId, isDirty, saveSession } = get();
      if (currentId && currentId !== sessionId && isDirty) {
        await saveSession();
      }

      const result = await window.electronAPI.loadSession(sessionId);
      if (result.success && result.session) {
        window.electronAPI.clearChat();
        set({
          sessionId: result.session.id,
          projectId: result.session.projectId,
          messages: result.session.messages || [],
          isDirty: false,
          error: null,
        });
      }
    },

    createSession: async (projectId, name) => {
      const { sessionId: currentId, isDirty, saveSession } = get();
      if (currentId && isDirty) {
        await saveSession();
      }

      const result = await window.electronAPI.createSession(projectId, name);
      if (result.success && result.session) {
        window.electronAPI.clearChat();
        set({
          sessionId: result.session.id,
          projectId,
          messages: [],
          isDirty: false,
          error: null,
        });
        // Refresh session list
        get().loadSessions(projectId);
        return result.session.id;
      }
      return null;
    },

    saveSession: async () => {
      const { sessionId, projectId, messages, isDirty, sessions } = get();
      if (!sessionId || !projectId || !isDirty) return;

      // Find current session to get its name
      const currentSession = sessions.find((s) => s.id === sessionId);
      const session: ChatSession = {
        id: sessionId,
        projectId,
        name: currentSession?.name || `Chat ${new Date().toLocaleDateString()}`,
        createdAt: currentSession?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages,
      };

      const result = await window.electronAPI.saveSession(session);
      if (result.success) {
        set({ isDirty: false });
        // Update session in local list
        if (result.session) {
          set((state) => ({
            sessions: state.sessions.map((s) => (s.id === sessionId ? result.session! : s)),
          }));
        }
      }
    },

    deleteSession: async (sessionId) => {
      const result = await window.electronAPI.deleteSession(sessionId);
      if (result.success) {
        const { projectId, sessionId: currentSessionId } = get();
        // Remove from local list
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== sessionId),
        }));
        // If deleted current session, clear state
        if (sessionId === currentSessionId) {
          window.electronAPI.clearChat();
          set({ sessionId: null, messages: [], isDirty: false });
        }
        // Refresh session list
        if (projectId) {
          get().loadSessions(projectId);
        }
        return true;
      }
      return false;
    },

    renameSession: async (sessionId, newName) => {
      const result = await window.electronAPI.renameSession(sessionId, newName);
      if (result.success && result.session) {
        // Update in local list
        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === sessionId ? result.session! : s)),
        }));
        return true;
      }
      return false;
    },
  };
});
