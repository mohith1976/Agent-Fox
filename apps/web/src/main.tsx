import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App, { ChatErrorBoundary } from './App.tsx';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <ChatErrorBoundary>
      <App />
    </ChatErrorBoundary>
  </StrictMode>,
);
