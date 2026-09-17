/**
 * useThreadId Hook
 * 
 * Manages threadId persistence across browser sessions.
 * ThreadId is stored in localStorage for conversation continuity.
 * 
 * Usage:
 *   const { threadId, resetThread } = useThreadId();
 */

import { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';

const THREAD_ID_KEY = 'agent-fox-thread-id';

export function useThreadId() {
  const [threadId, setThreadId] = useState<string>(() => {
    // Initialize from localStorage or create new
    const stored = localStorage.getItem(THREAD_ID_KEY);
    if (stored) {
      return stored;
    }
    const newThreadId = uuidv4();
    localStorage.setItem(THREAD_ID_KEY, newThreadId);
    return newThreadId;
  });

  /**
   * Reset thread to start a new conversation
   * Generates a new UUID and persists to localStorage
   */
  const resetThread = () => {
    const newThreadId = uuidv4();
    localStorage.setItem(THREAD_ID_KEY, newThreadId);
    setThreadId(newThreadId);
  };

  /**
   * Persist threadId changes to localStorage
   */
  useEffect(() => {
    localStorage.setItem(THREAD_ID_KEY, threadId);
  }, [threadId]);

  return {
    threadId,
    resetThread,
  };
}
