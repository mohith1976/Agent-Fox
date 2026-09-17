/**
 * useChat Hook
 * 
 * Manages chat state, messages, and API communication
 */

import { useState, useCallback } from 'react';
import { sendChatMessage, ChatApiError } from '../api/chat.api';
import type { Message, PendingTransaction } from '../types/chat.types';
import { generateRequestId } from '../utils/ids';

export interface UseChatReturn {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  pendingBatch: PendingTransaction[] | null;
  sendMessage: (content: string) => Promise<void>;
  clearError: () => void;
  setRecoveredState: (state: {
    messages: Message[];
    pendingBatch: PendingTransaction[] | null;
  }) => void;
}

export function useChat(threadId: string): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBatch, setPendingBatch] = useState<PendingTransaction[] | null>(null);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim()) {
      return;
    }

    // Clear previous error
    setError(null);
    setIsLoading(true);

    // Generate unique requestId for this message
    const requestId = generateRequestId();

    // Add user message immediately
    const userMessage: Message = {
      id: requestId,
      role: 'user',
      content: content.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);

    try {
      // Send to backend
      const response = await sendChatMessage({
        requestId,
        threadId,
        message: content.trim(),
        triggerCode: 'manual', // ✅ FIXED: Match DB trigger_code
      });

      // Update pending batch state
      setPendingBatch(response.pendingBatch ?? null);

      // Add assistant message
      const assistantMessage: Message = {
        id: `${requestId}-response`,
        role: 'assistant',
        content: response.response,
        timestamp: new Date(),
        pendingBatch: response.pendingBatch ?? null,
        chartImage: response.chartImage ?? null,
        error: response.error ?? null,
        workflowMode: response.workflowMode,
      };

      setMessages((prev) => [...prev, assistantMessage]);

      // If there was an error in the response, show it
      if (response.error) {
        setError(response.error);
      }
    } catch (err) {
      // Handle API/network errors
      const errorMessage = err instanceof ChatApiError 
        ? err.message 
        : 'An unexpected error occurred';

      setError(errorMessage);

      // Add error message to chat
      const errorAssistantMessage: Message = {
        id: `${requestId}-error`,
        role: 'assistant',
        content: 'Sorry, I encountered an error processing your request.',
        timestamp: new Date(),
        error: errorMessage,
      };

      setMessages((prev) => [...prev, errorAssistantMessage]);
    } finally {
      setIsLoading(false);
    }
  }, [threadId]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const setRecoveredState = useCallback(
    (state: {
      messages: Message[];
      pendingBatch: PendingTransaction[] | null;
    }) => {
      setMessages(state.messages);
      setPendingBatch(state.pendingBatch);
    },
    [],
  );

  return {
    messages,
    isLoading,
    error,
    pendingBatch,
    sendMessage,
    clearError,
    setRecoveredState,
  };
}
