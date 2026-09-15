import { useState } from 'react';
import { useChat } from './hooks/useChat';
import { MessageComposer } from './components/chat/MessageComposer';
import { LoadingState } from './components/common/LoadingState';
import { ErrorMessage } from './components/common/ErrorMessage';
import { Button } from './components/common/Button';
import type { Message, PendingTransaction } from './types/chat.types';
import { downloadWorkbook } from './api/chat.api';
import './App.css';

function App() {
  const { messages, isLoading, error, pendingBatch, sendMessage, clearError } = useChat();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  const formatAmount = (amount: number) => `₹${amount.toLocaleString()}`;

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

  const renderPendingBatch = (batch: PendingTransaction[]) => (
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
              <span className="pending-transaction__mode">{tx.mode}</span>
              <span className={`pending-transaction__direction pending-transaction__direction--${tx.direction.toLowerCase()}`}>
                {tx.direction}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="pending-batch__actions">
        <Button variant="primary" onClick={() => sendMessage('confirm')}>
          ✓ Confirm & Save
        </Button>
        <Button variant="secondary" onClick={() => sendMessage('cancel')}>
          × Cancel
        </Button>
      </div>
      <p className="pending-batch__hint">
        💡 You can edit: "change item 2 to 600" or "change item 1 description to coffee"
      </p>
    </div>
  );

  const renderMessage = (msg: Message) => {
    return (
      <div key={msg.id} className={`message message--${msg.role}`}>
        <div className="message__bubble">
          <div className="message__content">{msg.content}</div>
          
          {msg.error && (
            <div className="message__error">
              <ErrorMessage message={msg.error} />
            </div>
          )}
          
          {msg.pendingBatch && msg.pendingBatch.length > 0 && renderPendingBatch(msg.pendingBatch)}
          
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
              onClick={handleDownloadWorkbook}
              disabled={isDownloading}
            >
              {isDownloading ? '⏳ Downloading...' : '📥 Download Workbook'}
            </Button>
          </div>
        </div>
        {downloadError && (
          <div className="app__header-error">
            <ErrorMessage message={downloadError} onDismiss={() => setDownloadError(null)} />
          </div>
        )}
      </header>

      <main className="app__main">
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
      </main>
    </div>
  );
}

export default App;
