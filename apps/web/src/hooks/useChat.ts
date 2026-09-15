/**
 * useChat Hook
 * 
 * Manages chat state, messages, and API communication
 */

import { useState, useRef, useCallback } from 'react';
import { sendChatMessage, ChatApiError } from '../api/chat.api';
import type { Message, PendingTransaction } from '../types/chat.types';
import { generateRequestId, generateThreadId } from '../utils/ids';

export interface UseChatReturn {
  messages: Message[];
  isLoading: boolean;
  error: string | null;
  threadId: string;
  pendingBatch: PendingTransaction[] | null;
  sendMessage: (content: string) => Promise<void>;
  clearError: () => void;
}

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBatch, setPendingBatch] = useState<PendingTransaction[] | null>(null);
  
  // threadId persists for the session
  const threadIdRef = useRef<string>(generateThreadId());

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim()) {
      return;
    }

    // Clear previous error
    setError(null);
    setIsLoading(true);

    // Generate unique requestId for this message
    const requestId = generateRequestId();
    const threadId = threadIdRef.current;

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
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    messages,
    isLoading,
    error,
    threadId: threadIdRef.current,
    pendingBatch,
    sendMessage,
    clearError,
  };
}
