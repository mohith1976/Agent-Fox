import { END } from '@langchain/langgraph';
import { ExpenseWorkflowState, type ExpenseWorkflowStateType, WorkflowMode } from './expense.state';
import { EXPENSE_CONFIG } from './expense.config';

/**
 * Expense Workflow Edges
 * 
 * Conditional routing logic for the expense workflow graph
 * Handles:
 * - Resume from checkpointed waiting states
 * - Intent-based routing
 * - Transaction validation routing
 * - Query transformation routing
 * - Bounded loop protection
 */

export const ExpenseEdges = {
  // ========================================
  // START ROUTING - Handles checkpointed waiting state resume
  // ========================================

  /**
   * Route from START node
   * 
   * RESUME LOGIC: Check if this is resuming from a waiting state
   * - AWAITING_CLARIFICATION → parse_clarification
   * - PENDING_CONFIRMATION → parse_edit_or_confirm
   * - AWAITING_USER_CLARIFICATION → classify_intent
   * - Otherwise → classify_intent (new request)
   */
  routeFromStart: (state: ExpenseWorkflowStateType): string => {
    // RESUME: Check if this is resuming from a waiting state

    if (state.workflowMode === WorkflowMode.AWAITING_CLARIFICATION) {
      // "cancel" (and equivalents) during clarification means abort the
      // whole flow — route straight to clear_batch so the user gets
      // "Transaction cancelled." instead of another clarification round.
      if (isCancelMessage(state.message)) {
        return 'clear_batch';
      }
      // Topic switch: a brand-new QUESTION is not a clarification answer —
      // send it for fresh interpretation instead of swallowing it into the
      // old flow. (Bare values like "100"/"phonepay" still resume.)
      if (looksLikeNewQuery(state.message)) {
        return 'classify_intent';
      }
      // User provided clarification response - resume from parse_clarification
      return 'parse_clarification';
    }

    if (state.workflowMode === WorkflowMode.PENDING_CONFIRMATION) {
      // Exact cancel words cancel outright WITHOUT consulting the LLM: a
      // single-word "cancel" misread as confirmation would WRITE the batch —
      // the one error direction that must be structurally impossible. Anchored
      // match only, so "cancel item 2"-style edits still reach the parser.
      if (isCancelMessage(state.message)) {
        return 'clear_batch';
      }
      // Same topic-switch rule: questions divert to fresh interpretation
      // (the pending batch is preserved for later confirm/cancel).
      if (looksLikeNewQuery(state.message)) {
        return 'classify_intent';
      }
      // User responding to confirmation prompt - resume from parse_edit_or_confirm
      return 'parse_edit_or_confirm';
    }

    if (state.workflowMode === WorkflowMode.AWAITING_USER_CLARIFICATION) {
      // User responding after confusion - resume from classify_intent
      return 'classify_intent';
    }

    // Broaden consent: a bare affirmation ("yes") right after a zero-hit
    // query re-runs the previous scope dateless. Requires an outstanding
    // offer AND widenable dates — otherwise it terminates here (a later
    // "yes" finds no dates to drop and falls through to classification).
    // Waiting states above take precedence, so "yes" mid-confirm still
    // confirms and "yes" mid-clarification still answers.
    if (
      isAffirmation(state.message) &&
      state.broadenOffered === true &&
      (state.filters?.dateFrom || state.filters?.dateTo)
    ) {
      return 'broaden_previous';
    }

    // NEW REQUEST: Normal classification
    return 'classify_intent';
  },

  // ========================================
  // INTENT ROUTING
  // ========================================

  /**
   * Route based on classified intent
   *
   * - COMBINATIONAL (2+ sub-requests) → start_combination (mixed, transaction
   *   first) or answer_subqueries (all analytical). Only when the primary
   *   intent passed the confidence gate — a forced UNKNOWN stays single.
   * - NEW_TRANSACTION → parse_transactions
   * - ANALYTICAL_QUERY → interpret_query
   * - EDIT_OR_CONFIRM → parse_edit_or_confirm
   * - UNKNOWN → request_user_clarification
   */
  routeByIntent: (state: ExpenseWorkflowStateType): string => {
    const subs = state.subRequests;
    if (
      state.intent !== 'UNKNOWN' &&
      subs &&
      subs.length > 1
    ) {
      const hasTxn = subs.some(
        (s) =>
          s.intent === 'NEW_TRANSACTION_BATCH' ||
          s.intent === 'EDIT_OR_CONFIRM',
      );
      return hasTxn ? 'start_combination' : 'answer_subqueries';
    }

    if (state.intent === 'NEW_TRANSACTION_BATCH') {
      // Never silently overwrite an unconfirmed batch: if the user starts a
      // new transaction while one awaits confirmation, re-present the pending
      // batch first (they confirm/cancel it, then re-send).
      if (
        state.workflowMode === WorkflowMode.PENDING_CONFIRMATION &&
        state.pendingBatch &&
        state.pendingBatch.length > 0
      ) {
        return 'present_batch';
      }
      return 'parse_transactions';
    }

    if (state.intent === 'ANALYTICAL_QUERY') {
      return 'interpret_query';
    }

    if (state.intent === 'EDIT_OR_CONFIRM') {
      // Confirm/edit with NO pending batch (e.g. bare "i paid" misclassified
      // as confirmation) must never reach the write path — treat it as a fresh
      // transaction attempt so the user gets a clarification question instead
      // of a financial-write failure.
      if (!state.pendingBatch || state.pendingBatch.length === 0) {
        return 'parse_transactions';
      }
      return 'parse_edit_or_confirm';
    }

    if (state.intent === 'UNKNOWN') {
      return 'request_user_clarification';
    }

    return 'handle_error';
  },

  // ========================================
  // TRANSACTION PATH ROUTING
  // ========================================

  /**
   * Route after transaction validation
   * 
   * - COMPLETE → present_batch
   * - MISSING_INFO → request_clarification (with bounded retry)
   * - Max attempts reached → reject_incomplete_transaction
   */
  routeAfterValidation: (state: ExpenseWorkflowStateType): string => {
    if (state.validationStatus === 'COMPLETE') {
      return 'present_batch';
    }

    if (state.validationStatus === 'MISSING_INFO') {
      if (
        state.clarificationAttempts >=
          EXPENSE_CONFIG.MAX_CLARIFICATION_ATTEMPTS ||
        state.clarificationRounds >= EXPENSE_CONFIG.MAX_CLARIFICATION_ROUNDS
      ) {
        // Bounded retry - stop asking
        return 'reject_incomplete_transaction';
      }
      return 'request_clarification'; // WAITING-STATE NODE
    }

    return 'handle_error';
  },

  /**
   * Route after edit/confirm parsing
   * 
   * - CONFIRM → write_batch (execute financial write)
   * - EDIT → merge_edits (loop back to present_batch)
   * - CANCEL → clear_batch
   */
  routeAfterEditConfirm: (state: ExpenseWorkflowStateType): string => {
    if (state.confirmAction === 'CONFIRM') {
      return 'write_batch'; // Execute financial write
    }

    if (state.confirmAction === 'EDIT') {
      return 'merge_edits'; // Apply edits, loop back to present_batch
    }

    if (state.confirmAction === 'CANCEL') {
      return 'clear_batch';
    }

    return 'handle_error';
  },

  /**
   * Route after the financial write.
   *
   * - success + deferred analytical subs → answer_deferred_subs (fresh
   *   post-write reads — a balance answered before the write would be stale)
   * - anything else → END (failures keep batch + subs for later resume)
   */
  routeAfterWrite: (state: ExpenseWorkflowStateType): string | typeof END => {
    if (
      state.status === 'success' &&
      state.pendingSubs &&
      state.pendingSubs.length > 0
    ) {
      return 'answer_deferred_subs';
    }
    return END;
  },

  // ========================================
  // QUERY PATH ROUTING
  // ========================================

  /**
   * Route after query interpretation.
   *
   * - terminologyList set → read_terminology_lists (the WORDS themselves;
   *   retrieval would answer a different question with colored rows)
   * - otherwise → retrieve_transactions (normal analytical path)
   */
  routeAfterInterpret: (state: ExpenseWorkflowStateType): string => {
    if (state.terminologyListRequested) {
      return 'read_terminology_lists';
    }
    return 'retrieve_transactions';
  },

  /**
   * Route after query result validation
   *
   * - SUFFICIENT → generate_answer
   * - INSUFFICIENT → transform_query (with bounded retry)
   * - Max attempts reached → inform_user_insufficient
   */
  routeAfterQueryValidation: (state: ExpenseWorkflowStateType): string => {
    if (state.queryResultStatus === 'SUFFICIENT') {
      // Chart requests render via the generate_chart tool instead of text.
      if (state.chartRequested) {
        return 'build_chart';
      }
      return 'generate_answer';
    }

    if (state.queryResultStatus === 'INSUFFICIENT') {
      if (
        state.transformationAttempt >= EXPENSE_CONFIG.MAX_QUERY_TRANSFORMATIONS
      ) {
        // Bounded retry - stop transforming
        return 'inform_user_insufficient';
      }
      return 'transform_query'; // Loop back to retrieve_transactions
    }

    return 'handle_error';
  },

  /**
   * Route after answer validation
   * 
   * - SATISFACTORY → END (success)
   * - UNSATISFACTORY → regenerate_answer (with bounded retry)
   * - Max attempts reached → END (return what we have)
   */
  routeAfterAnswerValidation: (state: ExpenseWorkflowStateType): string | typeof END => {
    if (state.answerStatus === 'SATISFACTORY') {
      return END; // Success - return answer to user
    }

    if (state.answerStatus === 'UNSATISFACTORY') {
      if (
        state.regenerationAttempt >= EXPENSE_CONFIG.MAX_ANSWER_REGENERATIONS
      ) {
        // Bounded retry - return what we have
        return END;
      }
      return 'regenerate_answer'; // Loop back to validate_answer
    }

    return 'handle_error';
  },
};

/**
 * Conservative cancel-phrase matcher for the clarification waiting state.
 * "stop" never reaches here (intercepted at the request boundary).
 */
function isCancelMessage(message: string): boolean {
  return /^(cancel|cancelled|never\s?mind|forget\s(it|this)|leave\sit|no\s?(thanks|thank\syou)?)$/i.test(
    (message || '').trim(),
  );
}

/**
 * Bare-affirmation matcher for broaden consent. Anchored full match only —
 * "yes, broaden it for 2 weeks" carries its own scope via the keyword path;
 * this is for the lone "yes" answering a zero-hit broaden offer.
 */
function isAffirmation(message: string): boolean {
  return /^(yes|yeah|yup|yep|ok|okay|sure|do it|please do|go ahead|sounds good)$/i.test(
    (message || '').trim().replace(/[!.?]+$/, ''),
  );
}

/**
 * Fresh-query detector for waiting states. Clarification answers and
 * confirmations ("100", "phonepay", "bank", "out", "yes", "cancel", edits)
 * are bare values — a brand-new user query must NOT be swallowed as an
 * answer to the old flow. Matches question shapes, imperative query verbs
 * ("generate a chart...", "show my spending...") and query nouns anywhere
 * ("my current bank balance").
 *
 * Two hard lessons encoded here:
 * - `expense`/`expenses` are NOT divert nouns: "expense" is a legitimate
 *   answer to the direction question ("going out (expense) or coming
 *   in?"), and diverting it both misfires AND wipes the waiting context.
 * - A single answer-vocabulary word (mode/direction/confirm words) NEVER
 *   diverts, no matter what lists grow later — it is by construction an
 *   answer, not a topic switch.
 * Mode/direction words are deliberately absent from the noun list so real
 * answers ("bank", "out", "yes") still resume. When in doubt it returns
 * false (resume wins).
 */
function looksLikeNewQuery(message: string): boolean {
  const text = (message || '').trim();
  if (!text) {
    return false;
  }
  // Single-word answer vocabulary can never be a topic switch.
  if (
    /^(phonepay|phonepe|phnpe|gpay|upi|wallet|paytm|money|cash|bank|card|account|credit|credited|debit|debited|in|out|income|expense|yes|yeah|yup|no|confirm|confirmed|cancel|cancelled|ok|okay)$/i.test(
      text,
    )
  ) {
    return false;
  }
  if (text.endsWith('?')) {
    return true;
  }
  if (
    /^(how|what|when|where|which|who|whom|whose|show|tell|give|list|count|make|plot|chart|graph|generate|create|display|draw|download|get|fetch|find|check|summarise|summarize|break)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return /\b(balance|balances|chart|graph|total|spent|spend|spending|summary|report|transactions?)\b/i.test(
    text,
  );
}

/**
 * Policy Notes:
 * 
 * **Confirmation/Edit:** Resume pending workflow
 * **Analytical Query:** Answer query, KEEP pendingBatch (don't overwrite)
 * **New Transaction:** IntentClassifier recognizes as NEW_TRANSACTION_BATCH:
 *   - Replaces pending (if user explicitly starts new flow)
 *   - OR asks user to confirm/cancel current pending first
 * 
 * **Bounded Loop Protection:**
 * All retry mechanisms have max attempt limits to prevent infinite loops:
 * - Clarification attempts: MAX_CLARIFICATION_ATTEMPTS
 * - Query transformations: MAX_QUERY_TRANSFORMATIONS
 * - Answer regenerations: MAX_ANSWER_REGENERATIONS
 */
