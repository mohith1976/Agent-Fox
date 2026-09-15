/**
 * ID Generation Utilities
 * 
 * Generates UUIDs for requestId and threadId
 */

export function generateUUID(): string {
  return crypto.randomUUID();
}

export function generateRequestId(): string {
  return generateUUID();
}

export function generateThreadId(): string {
  return generateUUID();
}
