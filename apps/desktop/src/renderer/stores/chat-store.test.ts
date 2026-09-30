import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const electronAPI = {
  onChatStreamDelta: vi.fn(),
  onChatStreamTool: vi.fn(),
  onChatStreamEnd: vi.fn(),
  sendChatMessage: vi.fn(),
};

let useChatStore: typeof import('./chat-store').useChatStore;

beforeAll(async () => {
  vi.stubGlobal('window', { electronAPI });
  ({ useChatStore } = await import('./chat-store'));
});

afterEach(() => {
  electronAPI.sendChatMessage.mockReset();
  useChatStore.setState({
    messages: [],
    isLoading: false,
    error: null,
    sessionId: null,
    projectId: null,
    isDirty: false,
    sessions: [],
  });
});

describe('chat error lifecycle', () => {
  it('renders a failed stream as a terminal assistant response', () => {
    useChatStore.setState({
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: new Date().toISOString(),
        },
      ],
      isLoading: true,
    });

    useChatStore
      .getState()
      .handleEnd({ sessionId: 'default', messageId: 'msg-1', success: false, error: 'Codex startup failed.' });

    expect(useChatStore.getState()).toMatchObject({
      isLoading: false,
      error: 'Codex startup failed.',
      messages: [{ id: 'msg-1', isStreaming: false, content: 'Chat failed: Codex startup failed.' }],
    });
  });

  it('terminates the placeholder when the chat IPC rejects before streaming starts', async () => {
    electronAPI.sendChatMessage.mockRejectedValueOnce(new Error('Codex runtime not found.'));

    await useChatStore.getState().sendMessage('Hello', { project: 'project-1' });

    expect(useChatStore.getState()).toMatchObject({
      isLoading: false,
      error: 'Codex runtime not found.',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', isStreaming: false, content: 'Chat failed: Codex runtime not found.' },
      ],
    });
  });
});
