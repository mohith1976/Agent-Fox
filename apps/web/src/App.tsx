import { useState, useEffect, Component } from 'react';
import type { ReactNode } from 'react';
import { useChat } from './hooks/useChat';
import { useThreadId } from './hooks/useThreadId';
import { MessageComposer } from './components/chat/MessageComposer';
import { LoadingState } from './components/common/LoadingState';
import { ErrorMessage } from './components/common/ErrorMessage';
import { Button } from './components/common/Button';
import type { Message, PendingTransaction } from './types/chat.types';
import { downloadWorkbook, uploadWorkbook, getState } from './api/chat.api';
import './App.css';

/**
 * Safety net: without this, ANY render throw (unexpected message shape,
 * oversized payload, browser quirk) unmounts the whole React tree — the
 * "entire page goes blank" symptom with zero diagnostics. The boundary
 * catches it and shows the error ON the page (screenshot-able) with a
 * reload action, instead of a white screen.
 */
export class ChatErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('Chat render crashed:', error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app">
          <main className="app__main">
            <div className="chat-container">
              <div className="messages">
                <div className="message message--assistant">
                  <div className="message__bubble">
                    <h3>Something went wrong displaying the chat.</h3>
                    <p>
                      Your data is safe — this is a display error. Please
                      screenshot the detail below and share it:
                    </p>
                    <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>
                      {String(
                        this.state.error?.stack ||
                          this.state.error?.message ||
                          this.state.error,
                      )}
                    </pre>
                    <Button
                      variant="primary"
                      onClick={() => window.location.reload()}
                    >
                      Reload chat
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </main>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const { threadId, resetThread } = useThreadId();
  const { messages, isLoading, error, pendingBatch, sendMessage, clearError, setRecoveredState } = useChat(threadId);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [isRecovering, setIsRecovering] = useState(true);

  // State recovery on mount
  useEffect(() => {
    const recoverConversationState = async () => {
      try {
        const state = await getState(threadId);
        
        // Apply recovered state if it exists
        if (state.pendingBatch || state.messages.length > 0) {
          console.log('Recovered conversation state:', {
            messageCount: state.messages.length,
            hasPendingBatch: !!state.pendingBatch,
            status: state.status,
          });
          
          // Convert recovered messages to proper Message type
          const recoveredMessages: Message[] = state.messages.map((msg: any) => ({
            id: msg.id || `recovered-${Date.now()}-${Math.random()}`,
            role: msg.role,
            content: msg.content,
            timestamp: new Date(msg.timestamp),
            pendingBatch: msg.pendingBatch || null,
            chartImage: msg.chartImage || null,
            error: msg.error || null,
            workflowMode: msg.workflowMode,
          }));
          
          // Apply recovered state to chat hook
          setRecoveredState({
            messages: recoveredMessages,
            pendingBatch: state.pendingBatch,
          });
        }
      } catch (err) {
        console.error('Failed to recover conversation state:', err);
        // Gracefully continue without recovered state
      } finally {
        setIsRecovering(false);
      }
    };

    recoverConversationState();
  }, [threadId, setRecoveredState]);

  // Defensive: a malformed batch item must degrade to ₹0/blank — never
  // throw inside render (undefined.toLocaleString() = white screen).
  const formatAmount = (amount: unknown) =>
    `₹${Number(amount ?? 0).toLocaleString('en-IN')}`;

  const handleDownloadWorkbook = async () => {
    try {
      setIsDownloading(true);
      setDownloadError(null);
      
      const blob = await downloadWorkbook();
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Budget_2026_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download workbook');
    } finally {
      setIsDownloading(false);
    }
  };

  const handleUploadWorkbook = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.name.endsWith('.xlsx')) {
      setUploadError('Please select an Excel file (.xlsx)');
      return;
    }

    try {
      setIsUploading(true);
      setUploadError(null);
      setUploadSuccess(null);
      
      const result = await uploadWorkbook(file);
      setUploadSuccess(result.message);
      
      // Clear success message after 3 seconds
      setTimeout(() => setUploadSuccess(null), 3000);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to upload workbook');
    } finally {
      setIsUploading(false);
      // Reset file input
      event.target.value = '';
    }
  };

  const handleResetConversation = () => {
    resetThread();
    window.location.reload(); // Simple reload to clear all state
  };

  const renderPendingBatch = (batch: PendingTransaction[], disabled: boolean) => (
    <div className="pending-batch">
      <h3 className="pending-batch__title">📋 Transaction Review</h3>
      <p className="pending-batch__subtitle">Please review before saving:</p>
      <div className="pending-batch__list">
        {batch.map((tx) => (
          <div key={tx.itemNumber} className="pending-transaction">
            <div className="pending-transaction__header">
              <span className="pending-transaction__number">{tx.itemNumber}</span>
              <span className="pending-transaction__description">{tx.description}</span>
            </div>
            <div className="pending-transaction__details">
              <span className="pending-transaction__amount">{formatAmount(tx.amount)}</span>
              <span className="pending-transaction__mode">{tx.mode || '?'}</span>
              <span className={`pending-transaction__direction pending-transaction__direction--${(tx.direction || '').toLowerCase()}`}>
                {tx.direction || '?'}
              </span>
              <span className="pending-transaction__category" title="Expense type (decides the row color) — edit with 'change item N category to …'">
                🏷️ {tx.colourCategory || tx.suggestedCategory || (tx as unknown as { category?: string }).category || 'UNCATEGORIZED'}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="pending-batch__actions">
        {/* Disabled while a request is in flight: double-clicking Confirm
            would otherwise send two requestIds → two workbook rows. */}
        <Button variant="primary" onClick={() => sendMessage('confirm')} disabled={disabled}>
          ✓ Confirm & Save
        </Button>
        <Button variant="secondary" onClick={() => sendMessage('cancel')} disabled={disabled}>
          × Cancel
        </Button>
      </div>
      <p className="pending-batch__hint">
        💡 You can edit: "change item 2 to 600", "change item 1 category to personal", or "change item 1 description to coffee"
      </p>
    </div>
  );

  const renderMessage = (msg: Message) => {
    return (
      <div key={msg.id} className={`message message--${msg.role}`}>
        <div className="message__bubble">
          {/* String() guard: if a response ever arrives as a non-string
              (object/array), render it as text instead of React throwing
              "Objects are not valid as a React child" (white screen). */}
          <div className="message__content">
            {typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content ?? '')}
          </div>
          
          {msg.error && (
            <div className="message__error">
              <ErrorMessage message={msg.error} />
            </div>
          )}
          
          {msg.pendingBatch && msg.pendingBatch.length > 0 && renderPendingBatch(msg.pendingBatch, isLoading)}
          
          {msg.chartImage && (
            <div className="message__chart">
              <img 
                src={`data:image/png;base64,${msg.chartImage}`} 
                alt="Spending chart"
                className="chart-image"
              />
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-content">
          <div className="app__header-left">
            <h1 className="app__title">🦊 Agent Fox</h1>
            <p className="app__subtitle">Personal Finance Assistant</p>
          </div>
          <div className="app__header-right">
            <Button 
              variant="secondary" 
              onClick={handleResetConversation}
              title="Start a new conversation"
            >
              🔄 New Chat
            </Button>
            <Button 
              variant="secondary" 
              onClick={handleDownloadWorkbook}
              disabled={isDownloading}
            >
              {isDownloading ? '⏳ Downloading...' : '📥 Download Workbook'}
            </Button>
            <Button 
              variant="secondary" 
              onClick={() => document.getElementById('upload-workbook')?.click()}
              disabled={isUploading}
            >
              {isUploading ? '⏳ Uploading...' : '📤 Upload Workbook'}
            </Button>
            <input
              id="upload-workbook"
              type="file"
              accept=".xlsx"
              onChange={handleUploadWorkbook}
              style={{ display: 'none' }}
            />
          </div>
        </div>
        {downloadError && (
          <div className="app__header-error">
            <ErrorMessage message={downloadError} onDismiss={() => setDownloadError(null)} />
          </div>
        )}
        {uploadError && (
          <div className="app__header-error">
            <ErrorMessage message={uploadError} onDismiss={() => setUploadError(null)} />
          </div>
        )}
        {uploadSuccess && (
          <div className="app__header-success">
            ✅ {uploadSuccess}
          </div>
        )}
      </header>

      <main className="app__main">
        {isRecovering ? (
          <div className="chat-container">
            <div className="messages">
              <div className="message message--assistant">
                <div className="message__bubble">
                  <LoadingState />
                  <p style={{ marginTop: '1rem', textAlign: 'center', color: '#666' }}>
                    Recovering conversation state...
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="chat-container">
          <div className="messages">
            {messages.length === 0 ? (
              <div className="empty-state">
                <h2 className="empty-state__title">How can I help with your finances?</h2>
                <div className="empty-state__suggestions">
                  <p className="empty-state__suggestion-label">Try asking:</p>
                  <button className="suggestion-chip" onClick={() => sendMessage('spent 500 on groceries via phonepay')}>
                    💳 "spent 500 on groceries via phonepay"
                  </button>
                  <button className="suggestion-chip" onClick={() => sendMessage('how much did I spend this month?')}>
                    📊 "how much did I spend this month?"
                  </button>
                  <button className="suggestion-chip" onClick={() => sendMessage('show me a chart of my spending')}>
                    📈 "show me a chart of my spending"
                  </button>
                </div>
              </div>
            ) : (
              messages.map(renderMessage)
            )}
            
            {isLoading && (
              <div className="message message--assistant">
                <div className="message__bubble">
                  <LoadingState />
                </div>
              </div>
            )}
          </div>

          {error && !isLoading && (
            <div className="chat-error">
              <ErrorMessage message={error} onDismiss={clearError} />
            </div>
          )}

          <MessageComposer 
            onSend={sendMessage} 
            disabled={isLoading}
            placeholder={pendingBatch ? 'Type "confirm" to save or "edit item X"...' : 'Type your message...'}
          />
        </div>
        )}
      </main>
    </div>
  );
}

export default App;
