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
      !('workflow' in data)
    ) {
      throw new ChatApiError('Invalid health response');
    }

    return data as { status: string; workflow: string };
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
