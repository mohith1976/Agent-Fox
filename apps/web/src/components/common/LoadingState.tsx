/**
 * Loading State Component
 */

import './LoadingState.css';

export function LoadingState() {
  return (
    <div className="loading-state">
      <div className="loading-state__spinner" />
      <span className="loading-state__text">Thinking...</span>
    </div>
  );
}
