/**
 * Message Composer Component
 * Handles user input and message submission
 */

import { useState } from 'react';
import type { KeyboardEvent, FormEvent } from 'react';
import { Button } from '../common/Button';
import './MessageComposer.css';

interface MessageComposerProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageComposer({
  onSend,
  disabled = false,
  placeholder = 'Type your message...',
}: MessageComposerProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    
    if (input.trim() && !disabled) {
      onSend(input);
      setInput('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form className="message-composer" onSubmit={handleSubmit}>
      <textarea
        className="message-composer__input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        aria-label="Message input"
      />
      <Button
        type="submit"
        disabled={disabled || !input.trim()}
        variant="primary"
        aria-label="Send message"
      >
        Send
      </Button>
    </form>
  );
}
