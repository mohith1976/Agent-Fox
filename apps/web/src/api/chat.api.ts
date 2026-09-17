/**
 * Chat API Client
 * 
 * Typed API client for communication with the NestJS backend
 */

import type { ChatRequest, ChatResponse } from '../types/chat.types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3009';

export class ChatApiError extends Error {
  statusCode?: number;
  response?: unknown;
  
  constructor(
    message: string,
    statusCode?: number,
    response?: unknown,
  ) {
    super(message);
    this.name = 'ChatApiError';
    this.statusCode = statusCode;
    this.response = response;
  }
}

export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ChatApiError(
        `API returned ${response.status}: ${errorText}`,
        response.status,
      );
    }

    const data: unknown = await response.json();

    // Basic validation of response structure
    if (
      typeof data !== 'object' ||
      data === null ||
      !('success' in data) ||
      !('response' in data) ||
      !('workflowMode' in data)
    ) {
      throw new ChatApiError('Invalid response structure from API');
    }

    return data as ChatResponse;
  } catch (error) {
    if (error instanceof ChatApiError) {
      throw error;
    }

    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new ChatApiError('Unable to connect to backend. Please ensure the API is running.');
    }

    throw new ChatApiError(
      error instanceof Error ? error.message : 'Unknown error occurred',
    );
  }
}

export async function checkHealth(): Promise<{ status: string; workflow: string }> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/chat/health`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new ChatApiError(`Health check failed: ${response.status}`, response.status);
    }

    const data: unknown = await response.json();

    if (
      typeof data !== 'object' ||
      data === null ||
      !('status' in data) ||
      (!('workflow' in data) && !('service' in data))
    ) {
      throw new ChatApiError('Invalid health response');
    }

    const record = data as { status: string; workflow?: string; service?: string };
    return { status: record.status, workflow: record.workflow ?? record.service ?? 'unknown' };
  } catch (error) {
    throw new ChatApiError(
      error instanceof Error ? error.message : 'Health check failed',
    );
  }
}

export async function downloadWorkbook(): Promise<Blob> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/chat/download-workbook`, {
      method: 'GET',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ChatApiError(
        `Failed to download workbook: ${response.status} - ${errorText}`,
        response.status,
      );
    }

    const blob = await response.blob();
    return blob;
  } catch (error) {
    if (error instanceof ChatApiError) {
      throw error;
    }

    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new ChatApiError('Unable to connect to backend. Please ensure the API is running.');
    }

    throw new ChatApiError(
      error instanceof Error ? error.message : 'Unknown error occurred',
    );
  }
}

/**
 * Upload Excel workbook to S3 (replaces existing)
 */
export async function uploadWorkbook(file: File): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/chat/upload-workbook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      body: file,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new ChatApiError(
        errorData.error || `Upload failed: ${response.status}`,
        response.status,
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ChatApiError) {
      throw error;
    }

    throw new ChatApiError(
      error instanceof Error ? error.message : 'Upload failed',
    );
  }
}

/**
 * Conversation State Interface
 * Represents the recovered state from a thread
 */
export interface ConversationState {
  messages: any[];
  pendingBatch: any | null;
  lastResponse: string;
  status: string;
}

/**
 * Get conversation state for a thread
 * Used for state recovery on page refresh/mount
 * 
 * @param threadId - The thread ID to recover state for
 * @returns Conversation state or empty state if not found
 */
export async function getState(threadId: string): Promise<ConversationState> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/chat/state/${threadId}`, {
      method: 'GET',
    });

    if (!response.ok) {
      // Return empty state on error (graceful degradation)
      console.warn(`Failed to recover state for thread ${threadId}: ${response.status}`);
      return {
        messages: [],
        pendingBatch: null,
        lastResponse: '',
        status: 'idle',
      };
    }

    const data: unknown = await response.json();

    if (
      typeof data !== 'object' ||
      data === null ||
      !('messages' in data) ||
      !('status' in data)
    ) {
      throw new ChatApiError('Invalid state response structure');
    }

    return data as ConversationState;
  } catch (error) {
    // Return empty state on error (graceful degradation)
    console.error('Error recovering conversation state:', error);
    return {
      messages: [],
      pendingBatch: null,
      lastResponse: '',
      status: 'idle',
    };
  }
}
