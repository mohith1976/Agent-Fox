/**
 * Error Message Component
 */

import './ErrorMessage.css';

interface ErrorMessageProps {
  message: string;
  onDismiss?: () => void;
}

export function ErrorMessage({ message, onDismiss }: ErrorMessageProps) {
  return (
    <div className="error-message" role="alert">
      <div className="error-message__content">
        <span className="error-message__icon">⚠️</span>
        <span className="error-message__text">{message}</span>
      </div>
      {onDismiss && (
        <button
          className="error-message__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss error"
        >
          ×
        </button>
      )}
    </div>
  );
}
