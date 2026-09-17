import { Logger } from '@nestjs/common';
import { ExpenseWorkflowState, type ExpenseWorkflowStateType, WorkflowMode } from './expense.state';
import { EXPENSE_CONFIG } from './expense.config';
import { EMPTY_USAGE, type LlmUsage } from '../../llm/azure-ai.service';
import { normalizeModeLabel } from '../excel/excel.service';

/**
 * Expense Workflow Nodes
 * 
 * All node implementations for the expense workflow including:
 * - Classification
 * - Transaction parsing, validation, and writing
 * - Query interpretation and answer generation
 * - Recovery and error handling
 * 
 * IMPORTANT: Node implementations receive services via dependency injection
 * This file exports factory functions that create nodes with injected dependencies
 */

const logger = new Logger('ExpenseNodes');

/**
 * Create expense workflow nodes with injected dependencies
 * 
 * @param deps - Service dependencies
 * @returns Object containing all node functions
 */
export function createExpenseNodes(deps: {
  intentClassifier: any;
  transactionExtractor: any;
  editParser: any;
  queryInterpreter: any;
  answerGenerator: any;
  schemaValidator: any;
  toolExecutor: any;
  redis: any;
  flowTrackingService: any;
  /** agent_workflows.prompt from DB — injected into AnswerGenerator system prompt */
  workflowPrompt: string;
  /** tool_code strings from agent_workflows.toolsId — enforced in ToolExecutor calls */
  allowedToolCodes: string[];
}) {
  const {
    intentClassifier,
    transactionExtractor,
    editParser,
    queryInterpreter,
    answerGenerator,
    schemaValidator,
    toolExecutor,
    redis,
    flowTrackingService,
    workflowPrompt,
    allowedToolCodes,
  } = deps;

  return {
    // ========================================
    // CLASSIFICATION
    // ========================================

    classifyIntent: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(`Classifying intent for message: "${state.message.substring(0, 50)}..."`);

      const result = await intentClassifier.classify(
        state.message,
        !!state.pendingBatch,
        (state.retrievedTransactions?.length || 0) > 0,
      );

      // Architecture §2.3.3: low-confidence classifications are UNKNOWN,
      // never acted on. Without this, gibberish classified 0.62 as
      // NEW_TRANSACTION enters extraction and gets presented for confirmation.
      const intent =
        result.confidence < EXPENSE_CONFIG.INTENT_CONFIDENCE_THRESHOLD
          ? 'UNKNOWN'
          : result.intent;
      if (intent !== result.intent) {
        logger.warn(
          `Classification confidence ${result.confidence} below threshold — forcing UNKNOWN (was ${result.intent})`,
        );
      }

      // Topic-switch divert lands here with the old waiting mode still set
      // (routeFromStart can only choose a node, not reset state). A diverted
      // clarification is ABANDONED: clear its context and drop to IDLE, or the
      // answered query leaves the old question armed and the NEXT message
      // resumes it ("cur" gets the stale mode question). A
      // PENDING_CONFIRMATION divert keeps batch + mode — only per-turn output
      // is cleared.
      const divertedFromClarification =
        state.workflowMode === WorkflowMode.AWAITING_CLARIFICATION;

      return {
        intent,
        classificationConfidence: result.confidence,
        // A understood intent resets the gibberish counter; UNKNOWN keeps it
        // (request_user_clarification increments and bounds it).
        unknownAttempts: intent === 'UNKNOWN' ? state.unknownAttempts || 0 : 0,
        // Fresh turn: clear any STALE error/status left in the checkpoint by
        // an earlier failed turn. Without this, one failure poisons every
        // later response (cached error banner + failed tracking forever).
        error: null,
        status: null,
        // A chart belongs to the single turn that generated it. The channel
        // persists in the checkpoint, so every entry node must clear it —
        // otherwise one chart is re-attached to every later balance, confirm
        // card and write receipt (62KB each, accumulating in DOM + checkpoint).
        chartImage: null,
        ...(divertedFromClarification
          ? {
              workflowMode: WorkflowMode.IDLE,
              validationStatus: null,
              missingFields: [],
              extractionAmbiguities: [],
              clarificationAttempts: 0,
              clarificationRounds: 0,
              pendingClarificationContext: null,
              clarificationData: null,
              rawTransactions: [],
            }
          : {}),
        // Transcript: this node is the entry point for new requests
        // (and AWAITING_USER_CLARIFICATION resumes).
        ...userEntry(state),
        ...countLlm(state, result.usage),
      };
    },

    // ========================================
    // TRANSACTION PATH
    // ========================================

    parseTransactions: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Parsing transactions from message');

      // Segment-fallback extraction: multi-line batches whose lines the LLM
      // silently drops are re-extracted per segment (see helper).
      const result = await extractWithSegmentFallback(
        state.message,
        transactionExtractor,
      );

      // Validate LLM output shape before it enters graph state. On failure,
      // SANITIZE rows into incomplete-but-valid form instead of dropping the
      // batch: a missing amount is a clarification slot, not corruption, and
      // nuking loses perfectly-parsed siblings. Every incomplete slot is
      // re-derived by validate_transaction_data and asked about; COMPLETE
      // still requires amount>0, real description, explicit mode and a valid
      // direction, so nothing sanitized can reach the sheet.
      if (schemaValidator) {
        const validation = schemaValidator.validateTransactionBatch(
          result.transactions || [],
        );
        if (!validation.valid) {
          logger.warn(
            `Transaction extraction failed schema validation (${validation.errors.join('; ')}) — sanitizing rows instead of dropping`,
          );
          return {
            rawTransactions: (result.transactions || []).map(
              sanitizeExtractedRow,
            ),
            extractionConfidence: 0,
            extractionAmbiguities: [],
            clarificationAttempts: 0,
            clarificationRounds: 0,
            ...countLlm(state, result.usage, result.calls),
          };
        }
      }

      return {
        rawTransactions: result.transactions,
        extractionConfidence: result.confidence || 1.0,
        // needsClarification/ambiguities are part of the extractor contract —
        // carry them forward so validate_transaction_data can force
        // clarification instead of acting on a guess.
        extractionAmbiguities: result.ambiguities,
        // Fresh extraction = fresh clarification cycle: reset both counters.
        clarificationAttempts: 0,
        clarificationRounds: 0,
        ...countLlm(state, result.usage, result.calls),
      };
    },

    validateTransactionData: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(`Validating ${state.rawTransactions?.length || 0} transactions`);

      // Empty extraction (LLM found nothing, or schema validation rejected
      // the output) → treat as missing info so the user is asked to rephrase
      // with amount, description and payment mode.
      if (!state.rawTransactions || state.rawTransactions.length === 0) {
        logger.warn('No transactions extracted — requesting clarification');
        return {
          validationStatus: 'MISSING_INFO',
          missingFields: ['amount', 'description', 'mode'],
        };
      }

      const missingFields: string[] = [];

      // Per-item mode check: a batch message names many modes across lines
      // ("...phonepay\n...wallet"), so whole-message mode counting strips
      // EVERY item's mode and the merge later broadcasts one answer across
      // the batch. When line count matches transaction count, check each item
      // against its OWN line (the extractor emits rows in input order).
      // Otherwise (single message, count mismatch) keep the legacy
      // whole-message check.
      const messageLines = splitBatchSegments(state.message || '');
      const txnsForCheck = state.rawTransactions || [];
      const perItemModes =
        txnsForCheck.length > 0 &&
        messageLines.length === txnsForCheck.length;
      const wholeModes = detectMentionedModes(state.message || '');
      // Home lines (also used by the ambiguity guard below): the ORIGINAL
      // message's lines are a row's "home".
      const ctxOrig: string =
        state.pendingClarificationContext?.originalMessage || '';
      const homeLines = splitBatchSegments(ctxOrig);
      const homePerItem =
        txnsForCheck.length > 0 && homeLines.length === txnsForCheck.length;
      // Per-row verdicts via the shared mirror (validator and question
      // targeter MUST agree — see buildRowProbes).
      const probes = buildRowProbes(state, txnsForCheck);
      for (let i = 0; i < txnsForCheck.length; i++) {
        // Never accept an extractor default as "how they paid" — only the
        // user's own explicit mention counts (per item line for batches).
        // Never accept an invented placeholder as "what it was for".
        // Never accept an unconfirmed CREDIT — incoming money must carry a
        // credit signal in the user's own words, or be explicitly confirmed.
        // (DEBIT is the displayed default and is always shown at confirm.)
        missingFields.push(...rowMissingReasons(txnsForCheck[i], probes[i]));
      }

      // DETERMINISTIC mode-ambiguity guard (does not trust the LLM's pick).
      // Batch-scoped: a batch message legitimately carries many modes across
      // lines — that is DISTRIBUTION, not ambiguity. Strip the mode ONLY for
      // rows whose OWN line names 2+ methods. Single messages keep the legacy
      // whole-message rule (a guess is stripped back to null so the mode
      // stays missing until the user confirms one — it must never reach the
      // workbook unconfirmed).
      const ctxModes: string[] =
        state.pendingClarificationContext?.ambiguousModes || [];
      const mentionedModes = [
        ...new Set([
          ...wholeModes,
          ...ctxModes,
        ]),
      ];
      let rawTransactions = state.rawTransactions || [];
      if (perItemModes) {
        rawTransactions = txnsForCheck.map((txn, i) => {
          if (detectMentionedModes(messageLines[i]).length > 1) {
            logger.warn(
              `Ambiguous payment mode on batch line ${i + 1} — stripping guessed mode, forcing clarification.`,
            );
            missingFields.push('mode');
            return { ...txn, mode: null };
          }
          return txn;
        });
      } else if (mentionedModes.length > 1) {
        logger.warn(
          `Ambiguous payment mode — message mentions ${mentionedModes.join(', ')}. Stripping guessed mode, forcing clarification.`,
        );
        // Never wipe a mode established in the row's home (original) line or
        // by an earlier answer that filled this row — a confused reply
        // ("cash or bank") strips only unestablished rows.
        rawTransactions = rawTransactions.map((txn, i) => {
          const p = probes[i];
          const norm = normalizeModeLabel(txn.mode);
          if (
            txn.mode &&
            p &&
            ((p.homeModes.length === 1 && norm === p.homeModes[0]) ||
              (p.answeredModes.length > 0 &&
                p.answeredModes.includes(norm)))
          ) {
            return txn;
          }
          missingFields.push('mode');
          return {
            ...txn,
            mode: null,
          };
        });
      }

      if (missingFields.length > 0) {
        logger.warn(`Missing fields: ${[...new Set(missingFields)].join(', ')}`);
        return {
          rawTransactions,
          validationStatus: 'MISSING_INFO',
          missingFields: [...new Set(missingFields)],
        };
      }

      // Honor the extractor's own ambiguity flag (only when the basic fields
      // are otherwise complete). Maps its notes to missing fields so the user
      // is asked instead of the graph acting on a guess.
      if (state.extractionAmbiguities && state.extractionAmbiguities.length > 0) {
        const notes = state.extractionAmbiguities.join(' ').toLowerCase();
        const fields: string[] = [];
        if (/amount|much|price|cost|number/.test(notes)) fields.push('amount');
        if (/descri|merchant|what|item/.test(notes)) fields.push('description');
        if (/mode|pay|method|phonepe|wallet|money|bank|cash|card/.test(notes)) fields.push('mode');
        logger.warn(
          `Extractor reported ambiguities (${state.extractionAmbiguities.join('; ')}) — requesting clarification for: ${fields.length > 0 ? fields.join(', ') : 'amount, description, mode'}`,
        );
        return {
          validationStatus: 'MISSING_INFO',
          missingFields: fields.length > 0 ? [...new Set(fields)] : ['amount', 'description', 'mode'],
        };
      }

      // Infer category if missing (basic heuristic)
      // Descriptions are normalized to CAPS here so the user confirms EXACTLY
      // what lands in the sheet (matches the book's all-caps convention).
      const validated = (state.rawTransactions || []).map((txn) => ({
        ...txn,
        description:
          typeof txn.description === 'string'
            ? txn.description.trim().toUpperCase()
            : txn.description,
        category: txn.category || null, // Keep suggested category or null
        date: txn.date || new Date().toISOString().split('T')[0],
      }));

      logger.log(`Validation complete: ${validated.length} transactions validated`);

      return {
        validationStatus: 'COMPLETE',
        validatedTransactions: validated,
      };
    },

    requestClarification: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(`Requesting clarification for missing fields: ${state.missingFields?.join(', ')}`);

      // Targeted slot-fill: find the FIRST (field, row) still missing so the
      // question — and later the merge — addresses ONE item, never the whole
      // batch. (Asking "how did you pay for X?" then broadcasting the answer
      // to every row silently rewrites already-correct modes.)
      // Uses the validation-mirror reasons (not lax value-absence): a row
      // holding an unsignaled CREDIT guess IS still missing its direction,
      // and must be targeted — otherwise the target defaults to row 0 and
      // row 0's answered question repeats forever.
      const rows = state.rawTransactions || [];
      const missing = state.missingFields || [];
      // Same shared mirror as validation (same inputs → same verdicts).
      const probes = buildRowProbes(state, rows);
      let targetField = missing[0] || '';
      let targetIndex = 0;
      outer: for (const f of missing) {
        for (let i = 0; i < rows.length; i++) {
          if (rowMissingReasons(rows[i], probes[i]).includes(f)) {
            targetField = f;
            targetIndex = i;
            break outer;
          }
        }
      }

      // Contextual question: reference what the TARGET item already gave
      // (amount / description) so repeated flows don't read as the same script.
      const question = buildClarificationQuestion(
        [targetField],
        rows[targetIndex],
      );

      return {
        ...assistantReply(state, question),
        workflowMode: WorkflowMode.AWAITING_CLARIFICATION,
        pendingClarificationContext: {
          missing,
          targetField,
          targetIndex,
          rawTransactions: rows,
          // Answer trail survives across rounds (rebuilt context must not
          // drop it, or turn-3 answers re-dirty turn-2's settled slots).
          filledByAnswer:
            state.pendingClarificationContext?.filledByAnswer || {},
          // Original message: parse_clarification combines it with the reply
          // so bare answers ("100") extract in full context. Set ONCE — later
          // rounds must NOT overwrite it with the latest reply, or the
          // combined context degrades into reply-fragments ("dunno meh").
          originalMessage:
            state.pendingClarificationContext?.originalMessage ||
            state.message ||
            '',
          // Persisted ambiguity: union of any previous ambiguity with modes
          // mentioned in THIS message (never overwrite-drop it — merge clears
          // it only when the user answers with exactly one mode). Batch
          // messages legitimately carry many modes across lines, so they
          // store NO whole-message ambiguity (line-local check in validation
          // handles real per-item ambiguity instead).
          ambiguousModes: (() => {
            const lines = splitBatchSegments(state.message || '');
            if (rows.length > 0 && lines.length === rows.length) return [];
            return [
              ...new Set([
                ...((state.pendingClarificationContext?.ambiguousModes || []) as string[]),
                ...detectMentionedModes(state.message || ''),
              ]),
            ];
          })(),
        },
      };
      // Node returns → graph reaches END → checkpoint saved → HTTP response sent
    },

    parseClarification: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Parsing clarification response');

      // The reply ("100", "phonepay") is usually a bare value for one of the
      // known-missing fields. Parsing it IN ISOLATION mangles it (a lone
      // "100" has no description/mode context → empty extraction → merge over
      // an empty batch stays empty → ask-again loop → reject). Instead extract
      // from ORIGINAL + REPLY combined, then overlay deterministic coercion of
      // the reply itself. Accumulated answers survive via merge_with_pending
      // (meaningful-merge over checkpointed rawTransactions).
      const ctx = state.pendingClarificationContext || {};
      const missing: string[] = ctx.missing || [];
      const reply = state.message || '';
      const combined = `${ctx.originalMessage || ''} ${reply}`.trim();

      let usage = EMPTY_USAGE;
      let calls = 1;
      let base: Record<string, any> = {};
      try {
        // Same segment-fallback as the fresh path: the combined re-parse
        // must not silently drop batch lines either.
        const result = await extractWithSegmentFallback(
          combined,
          transactionExtractor,
        );
        usage = result.usage;
        calls = result.calls;
        // Targeted batch: re-parse yields rows in input order — read the
        // TARGET row, not always [0], or item 1's values land on item 3.
        const txList = result.transactions || [];
        const tIdx = Number.isInteger(ctx.targetIndex)
          ? (ctx.targetIndex as number)
          : 0;
        const safeIdx =
          txList.length > 0
            ? Math.min(Math.max(tIdx, 0), txList.length - 1)
            : 0;
        base = txList[safeIdx] || {};
      } catch {
        // Deterministic coercion below stands on its own.
      }

      // Deterministic coercion of the REPLY wins for the fields we asked about.
      const coerced: Record<string, any> = {};
      if (missing.includes('amount')) {
        const amt = parseAmountReply(reply);
        if (amt !== null) coerced.amount = amt;
      }
      if (missing.includes('mode')) {
        const modes = detectMentionedModes(reply);
        if (modes.length === 1) coerced.mode = modes[0];
      }
      if (missing.includes('description')) {
        const text = reply.trim();
        const looksLikeValue =
          /^\d+(\.\d+)?\s*k?$/i.test(text) ||
          detectMentionedModes(text).length > 0;
        if (text && !looksLikeValue) coerced.description = text;
      }
      if (missing.includes('direction')) {
        if (CREDIT_SIGNALS.test(reply)) coerced.direction = 'CREDIT';
        else if (DEBIT_SIGNALS.test(reply)) coerced.direction = 'DEBIT';
      }

      // Restrict the combined-parse overlay to the ASKED fields only, so a
      // re-parse can never overwrite already-good data (e.g. a re-guessed
      // amount clobbering the confirmed one).
      const allowed = new Set(missing);
      const filteredBase: Record<string, any> = {};
      for (const [key, value] of Object.entries(base)) {
        if (!allowed.has(key)) continue;
        if (value === undefined || value === null || value === '') continue;
        if (key === 'amount' && (typeof value !== 'number' || value <= 0))
          continue;
        filteredBase[key] = value;
      }

      return {
        clarificationData: { ...filteredBase, ...coerced },
        // Fresh turn: drop any stale error/status from an earlier failure,
        // and any stale chart from an earlier chart turn (the image belongs
        // to its own turn only — never re-attach it here).
        error: null,
        status: null,
        chartImage: null,
        // Transcript: this node is the resume entry for AWAITING_CLARIFICATION.
        ...userEntry(state),
        ...countLlm(state, usage, calls),
      };
    },

    mergeWithPending: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Merging clarification data with pending transactions');

      // Merge ONLY meaningful clarification fields (skip empties/zero-amount
      // so good checkpointed data is never clobbered by a bare reply parse).
      const meaningful: Record<string, any> = {};
      for (const [key, value] of Object.entries(state.clarificationData || {})) {
        if (value === undefined || value === null || value === '') continue;
        if (key === 'amount' && (typeof value !== 'number' || value <= 0)) continue;
        meaningful[key] = value;
      }

      // Skeleton base: when the initial extraction was EMPTY (schema-rejected),
      // there are no rows to merge into — start from one empty skeleton so the
      // clarification answer actually lands somewhere instead of mapping to [].
      const baseRows =
        state.rawTransactions && state.rawTransactions.length > 0
          ? state.rawTransactions
          : [{}];
      // Targeted slot-fill: the answer belongs to the item the question asked
      // about (ctx.targetIndex) — other rows keep their values even when they
      // share the field name. Without this, answering one item's mode
      // overwrites every row's mode (B4). Legacy fallback (no valid target):
      // fill only rows actually missing each field — never broadcast.
      const t = (state.pendingClarificationContext || {}).targetIndex;
      const targeted =
        Number.isInteger(t) && (t as number) >= 0 && (t as number) < baseRows.length;
      // Answer trail: record WHICH reply filled WHICH row, so later resume
      // turns accept those modes as established (a turn-3 direction answer
      // must not re-dirty the mode answered in turn 2).
      const replyText = state.message || '';
      const filledByAnswer: Record<number, string> = {
        ...((state.pendingClarificationContext || {}).filledByAnswer || {}),
      };
      const merged = baseRows.map((txn, i) => {
        if (targeted) {
          if (i === t) {
            filledByAnswer[i] = `${filledByAnswer[i] || ''} ${replyText}`.trim();
            return { ...txn, ...meaningful };
          }
          return txn;
        }
        if (baseRows.length === 1) {
          filledByAnswer[i] = `${filledByAnswer[i] || ''} ${replyText}`.trim();
          return { ...txn, ...meaningful };
        }
        const fill: Record<string, any> = {};
        for (const [k, v] of Object.entries(meaningful)) {
          if (rowMissingField(txn, k)) fill[k] = v;
        }
        if (Object.keys(fill).length > 0) {
          filledByAnswer[i] = `${filledByAnswer[i] || ''} ${replyText}`.trim();
        }
        return { ...txn, ...fill };
      });

      // Ambiguity resolution: if the original message named 2+ modes and the
      // user just answered with exactly ONE mode, the ambiguity is resolved —
      // clear it so validation stops stripping the confirmed mode.
      const ctx = state.pendingClarificationContext || {};
      let ambiguousModes: string[] = ctx.ambiguousModes || [];
      if (ambiguousModes.length > 1) {
        const replyModes = detectMentionedModes(state.message || '');
        if (replyModes.length === 1) {
          logger.log(
            `Mode ambiguity resolved by user reply (${replyModes[0]}) — clearing`,
          );
          ambiguousModes = [];
        }
      }

      // Progress-based retry budget: the counter grows ONLY when the answer
      // filled NONE of the asked fields with validation-acceptable values.
      // Sensible answers never consume budget, no matter how many turns the
      // chain takes; junk answers burn one retry each, so the loop still
      // provably terminates (plus an absolute round cap — see below).
      const asked: string[] = ctx.missing || [];
      const replyModes = detectMentionedModes(state.message || '');
      const filledAsked = asked.filter((k) => {
        const v = (meaningful as Record<string, any>)[k];
        if (k === 'amount') return typeof v === 'number' && v > 0;
        // A description only counts if it isn't a placeholder AND isn't bare
        // junk: require at least 3 letters (filters "dunno"/"meh"/"??").
        if (k === 'description')
          return (
            !isGenericDescription(v) &&
            /[a-zA-Z]{3,}/.test(String(v || ''))
          );
        // A mode only counts if the USER stated exactly that one mode —
        // extractor guesses never count as progress.
        if (k === 'mode')
          return (
            replyModes.length === 1 && normalizeModeLabel(v) === replyModes[0]
          );
        return v !== undefined;
      });
      const progressed = filledAsked.length > 0;
      const clarificationAttempts =
        (state.clarificationAttempts || 0) + (progressed ? 0 : 1);
      // Absolute backstop: total clarification rounds on this cycle, so even
      // a stubborn junk-answer loop (garbage that looks fillable) terminates.
      const clarificationRounds = (state.clarificationRounds || 0) + 1;
      if (!progressed) {
        logger.warn(
          `Clarification answer filled none of [${asked.join(', ')}] — retry budget ${clarificationAttempts}/${EXPENSE_CONFIG.MAX_CLARIFICATION_ATTEMPTS} (round ${clarificationRounds}/${EXPENSE_CONFIG.MAX_CLARIFICATION_ROUNDS})`,
        );
      }

      return {
        rawTransactions: merged,
        clarificationAttempts,
        clarificationRounds,
        workflowMode: WorkflowMode.PROCESSING, // Clear waiting state
        // Consume the ambiguities: the user just answered the clarification.
        // Without this, stale notes from the checkpoint would force a
        // second clarification round on the already-answered message.
        extractionAmbiguities: [],
        pendingClarificationContext: {
          ...ctx,
          ambiguousModes,
          filledByAnswer,
        },
      };
    },

    presentBatch: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(`Presenting batch of ${state.validatedTransactions?.length || 0} transactions`);

      const presentation = formatTransactionBatch(
        state.validatedTransactions || [],
      );

      const batchText = presentation + '\n\nConfirm? (yes/no/edit)';
      return {
        lastResponse: batchText,
        pendingBatch: state.validatedTransactions || [],
        workflowMode: WorkflowMode.PENDING_CONFIRMATION,
        // Transcript: user-visible turn, restored on refresh recovery.
        // The pending batch snapshot travels WITH the message so the
        // interactive review card (Confirm/Cancel buttons) survives reloads.
        messages: [
          {
            id: `${state.requestId}-asst`,
            role: 'assistant' as const,
            content: batchText,
            timestamp: new Date().toISOString(),
            pendingBatch: state.validatedTransactions || [],
          },
        ],
      };
      // Node returns → graph reaches END → checkpoint saved → HTTP response sent
    },

    parseEditOrConfirm: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Parsing edit/confirm response');

      const result = await editParser.parse(
        state.message,
        state.pendingBatch || [],
      );

      // Map parser result to confirmAction
      let confirmAction: 'CONFIRM' | 'EDIT' | 'CANCEL' = 'CONFIRM';
      if (result.edits && result.edits.length > 0) {
        confirmAction = 'EDIT';
      } else if (result.isConfirmation) {
        confirmAction = 'CONFIRM';
      } else if (result.needsClarification) {
        confirmAction = 'CANCEL';
      }

      return {
        confirmAction,
        edits: result.edits || [],
        // Fresh turn: drop any stale error/status from an earlier failure,
        // and any stale chart from an earlier chart turn (a write receipt or
        // re-presented card must never carry last month's chart image).
        error: null,
        status: null,
        chartImage: null,
        // Transcript: this node is the resume entry for PENDING_CONFIRMATION.
        ...userEntry(state),
        ...countLlm(state, result.usage),
      };
    },

    mergeEdits: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(`Merging ${state.edits?.length || 0} edits into batch`);

      const updated = applyEdits(state.pendingBatch || [], state.edits || []);

      return {
        validatedTransactions: updated,
        pendingBatch: updated,
      };
    },

    writeBatch: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(`Writing batch of ${state.pendingBatch?.length || 0} transactions`);

      // Defense in depth: NEVER attempt a financial write with an empty batch.
      // (Routing already prevents this; this guard makes it structurally
      // impossible even if routing changes.)
      if (!state.pendingBatch || state.pendingBatch.length === 0) {
        logger.error('write_batch reached with empty pendingBatch — refusing to write');
        return {
          status: 'failed',
          error: 'empty_batch',
          ...assistantReply(
            state,
            'There is nothing to save yet. Tell me a transaction first — e.g. "spent 500 on groceries via phonepay".',
          ),
          workflowMode: WorkflowMode.IDLE,
        };
      }

      // CRITICAL SAFETY CHECKS (see architecture Section 2.3.6)

      // 1. Check ownership loss
      const ownershipLostKey = `agent-fox:ownership-lost:${state.threadId}:${state.requestId}`;
      const ownershipLost = await redis.get(ownershipLostKey);
      if (ownershipLost === '1') {
        logger.error(`Ownership lost for thread ${state.threadId}, aborting write`);
        if (state.flowTrackingId) {
          await flowTrackingService.fail(state.flowTrackingId, {
            reason: 'ownership_lost',
            error: 'Lock ownership lost during execution',
          });
        }
        return {
          status: 'failed',
          error: 'ownership_lost',
          ...assistantReply(
            state,
            'Request terminated due to concurrent access. Please try again.',
          ),
        };
      }

      // 2. Check cancellation
      const cancelKey = `agent-fox:cancel:${state.threadId}:${state.requestId}`;
      const cancelled = await redis.get(cancelKey);
      if (cancelled === '1') {
        logger.log(`Execution cancelled for thread ${state.threadId}`);
        return {
          status: 'stopped',
          error: 'cancelled_by_user',
          ...assistantReply(state, 'Transaction cancelled.'),
        };
      }

      // 3. Check idempotency
      const idempotencyKey = `agent-fox:committed:${state.requestId}`;
      const alreadyCommitted = await redis.get(idempotencyKey);
      if (alreadyCommitted === '1') {
        logger.log(`Request ${state.requestId} already committed (idempotent)`);
        return {
          status: 'success',
          ...assistantReply(state, 'Transaction already recorded.'),
          pendingBatch: null,
          workflowMode: WorkflowMode.IDLE,
        };
      }

      // 4. ALL CHECKS PASSED - Execute write
      try {
        logger.log('Executing write batch tool');

        // Execute tool via ToolExecutor — pass allowedToolCodes to enforce DB allow-list.
        // Map suggestedCategory -> colourCategory: the graph carries the LLM's
        // suggested category, the tool contract expects colourCategory.
        // Without this mapping every write silently loses its category color.
        const result = await toolExecutor.execute(
          'log_transaction',
          {
            transactions: (state.pendingBatch || []).map((tx: any) => ({
              ...tx,
              colourCategory:
                tx.colourCategory ?? tx.suggestedCategory ?? null,
            })),
            userId: state.userId,
          },
          allowedToolCodes,
        );

        // The tool reports atomic batch outcome. A success:false means NOTHING
        // was persisted (validation abort, S3 concurrency rejection, or upload
        // failure) — surface it WITHOUT marking idempotency or clearing state.
        if (result && result.success === false) {
          logger.warn(`Write batch tool reported failure: ${result.error}`);
          const failureText =
            typeof result.error === 'string' && result.error.length > 0
              ? result.error
              : 'Failed to write transactions. Please try again.';
          return {
            status: 'failed',
            error: result.error || 'tool_execution_failed',
            ...assistantReply(state, failureText),
            ...countTool(state),
          };
        }

        // Mark as committed (idempotency protection)
        // node-redis v4 requires options object, not positional 'EX' string
        await redis.set(idempotencyKey, '1', { EX: 86400 }); // 24 hours

        logger.log(`Successfully wrote ${state.pendingBatch?.length || 0} transactions`);

        return {
          status: 'success',
          ...assistantReply(
            state,
            `Logged ${state.pendingBatch?.length || 0} transaction(s) successfully.`,
          ),
          pendingBatch: null,
          workflowMode: WorkflowMode.IDLE,
          ...countTool(state),
        };
      } catch (error) {
        logger.error(
          `Write batch failed: ${error instanceof Error ? error.message : String(error)}`,
        );

        // Handle specific error cases
        if (
          error instanceof Error &&
          error.message.includes('PreconditionFailed')
        ) {
          return {
            status: 'failed',
            error: 'workbook_modified_concurrently',
            ...assistantReply(
              state,
              'Your transaction conflicts with another recent update. Please retry.',
            ),
          };
        }

        if (
          error instanceof Error &&
          error.message.includes('ConditionalRequestConflict')
        ) {
          return {
            status: 'failed',
            error: 'conditional_write_conflict',
            ...assistantReply(
              state,
              'Workbook conflict detected. Please retry your request.',
            ),
          };
        }

        // Generic error
        const genericText = 'Failed to write transactions. Please try again.';
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          ...assistantReply(state, genericText),
        };
      }
    },

    clearBatch: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Clearing pending batch');

      // Full reset: cancel must leave no stale transaction/clarification
      // state in the checkpoint that a later validate could resurrect.
      return {
        pendingBatch: null,
        rawTransactions: [],
        validatedTransactions: [],
        clarificationData: null,
        extractionAmbiguities: [],
        clarificationAttempts: 0,
        clarificationRounds: 0,
        pendingClarificationContext: null,
        missingFields: [],
        validationStatus: null,
        confirmAction: null,
        edits: [],
        workflowMode: WorkflowMode.IDLE,
        ...assistantReply(state, 'Transaction cancelled.'),
      };
    },

    rejectIncompleteTransaction: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(
        `Rejecting incomplete transaction after ${state.clarificationAttempts || 0} attempts`,
      );

      return {
        ...assistantReply(
          state,
          `I couldn't get enough information after ${state.clarificationAttempts || 0} attempts. Please try again with: amount, description, and payment mode.`,
        ),
        workflowMode: WorkflowMode.IDLE,
      };
    },

    // ========================================
    // QUERY PATH
    // ========================================

    interpretQuery: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Interpreting query');

      const result = await queryInterpreter.interpret(state.message);

      // Follow-up resolution ("give their details", "show them"): when the new
      // interpretation carries NO content filters of its own but the thread
      // already holds retrieved rows, reuse the previous scope and list
      // details instead of querying the whole book (or worse, going UNKNOWN).
      // NOTE: `sheets` is deliberately NOT a scope signal — the schema forces
      // the LLM to always emit a sheets array, so it can never indicate a
      // bare follow-up. Same for amountMin/amountMax, which are always
      // emitted (0 = unset, not a real bound).
      const f = result.filters || {};
      const amountFloor = f.amountMin ?? 0;
      const amountCeil = f.amountMax ?? 0;
      const hasOwnScope =
        (f.modes?.length || 0) > 0 ||
        (f.categories?.length || 0) > 0 ||
        !!f.dateFrom || !!f.dateTo || !!f.descriptionContains ||
        (f.tags?.length || 0) > 0 ||
        amountFloor !== 0 || amountCeil !== 0 ||
        (result.limit ?? null) !== null ||
        !!result.wantsBalances || !!result.chartRequested;

      if (!hasOwnScope && (state.retrievedTransactions?.length || 0) > 0) {
        logger.log('Bare follow-up — reusing previous retrieval scope for details');
        return {
          queryIntent: 'DETAIL_LIST',
          filters: state.filters,
          aggregation: null,
          timeRange: state.timeRange,
          balanceRequested: false,
          chartRequested: false,
          chartType: null,
          ...countLlm(state, result.usage),
        };
      }

      // Forward the requested aggregation (if any) so the tool performs
      // deterministic SUM/COUNT/AVERAGE instead of the LLM doing arithmetic.
      const aggregationType = result.aggregationType || 'FILTER';
      const aggregation =
        aggregationType === 'SUM' ||
        aggregationType === 'COUNT' ||
        aggregationType === 'AVERAGE'
          ? {
              type: aggregationType,
              field: result.aggregationField || 'amount',
            }
          : null;

      // "Latest" support: newest-first row cap rides inside filters
      // (the tool applies it after all other filters).
      const filters = {
        ...(result.filters || {}),
        limit: result.limit ?? result.filters.limit ?? null,
      };

      logger.log(
        `Interpreted: intent=${aggregationType} limit=${filters.limit} balances=${!!result.wantsBalances} chart=${!!result.chartRequested} filters=${JSON.stringify(filters)}`,
      );

      // Balance routing has a deterministic backstop: if the MESSAGE asks
      // about balances, sheet balances are fetched even when the interpreter
      // forgot to set wantsBalances. Missing a balance answer is worse than
      // an extra read (which is free and side-effectless).
      const balanceHit = BALANCE_QUESTION_RE.test(state.message || '');
      const balanceRequested = !!result.wantsBalances || balanceHit;
      if (balanceRequested && !result.wantsBalances) {
        logger.log('Balance question detected deterministically — forcing sheet-balance read');
      }

      return {
        queryIntent: aggregationType,
        filters,
        aggregation,
        timeRange: {
          dateFrom: result.filters.dateFrom,
          dateTo: result.filters.dateTo,
        },
        balanceRequested,
        chartRequested: !!result.chartRequested,
        chartType: result.chartType || null,
        ...countLlm(state, result.usage),
      };
    },

    retrieveTransactions: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Retrieving transactions');

      // Pass allowedToolCodes so the executor enforces the DB tool allow-list.
      // Merge timeRange dates into filters as a fallback (the tool reads
      // filters only) and forward the aggregation request for deterministic math.
      const filters = {
        ...(state.filters || {}),
        dateFrom: state.filters?.dateFrom ?? state.timeRange?.dateFrom ?? undefined,
        dateTo: state.filters?.dateTo ?? state.timeRange?.dateTo ?? undefined,
      };
      const result = await toolExecutor.execute(
        'query_transactions',
        {
          filters,
          ...(state.aggregation ? { aggregation: state.aggregation } : {}),
          // Balance questions also fetch authoritative sheet balances
          // (last-row running balances — never recomputed from rows).
          ...(state.balanceRequested ? { includeBalances: true } : {}),
        },
        allowedToolCodes,
      );

      return {
        retrievedTransactions: result.transactions || [],
        retrievalCount:
          result.aggregation?.count ?? result.count ?? result.transactions?.length ?? 0,
        retrievedBalances: result.balances || null,
        ...countTool(state),
      };
    },

    validateQueryResult: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(`Validating query result: ${state.retrievalCount || 0} transactions retrieved`);

      const count = state.retrievalCount || 0;
      const classificationConfidence = state.classificationConfidence || 0;
      const hasCategoryFilter =
        (state.filters?.categories?.length || 0) > 0;

      // Balance answers don't depend on row counts — sheet balances are
      // authoritative on their own.
      if (state.retrievedBalances) {
        return {
          queryResultStatus: 'SUFFICIENT',
          queryResultType: 'BALANCE',
        };
      }

      // Zero hits behind a COLOR-category filter are suspect, not legitimate:
      // users can't see what's painted which color, so the mapping itself may
      // be wrong. Route to transform (which progressively drops the category)
      // instead of answering "nothing found".
      if (
        count === 0 &&
        hasCategoryFilter &&
        (state.transformationAttempt || 0) <
          EXPENSE_CONFIG.MAX_QUERY_TRANSFORMATIONS
      ) {
        return {
          queryResultStatus: 'INSUFFICIENT',
          insufficiencyReason: 'CATEGORY_TOO_NARROW',
        };
      }

      // Genuinely answerable zero-result query (no color-category involved)
      const genuinelyAnswerable =
        count === 0 &&
        !hasCategoryFilter &&
        (classificationConfidence > 0.8 ||
          (state.filters?.category && state.timeRange?.dateFrom));

      if (genuinelyAnswerable) {
        // User asked clear question, zero is honest answer
        return {
          queryResultStatus: 'SUFFICIENT',
          queryResultType: 'ZERO_LEGITIMATE',
        };
      }

      // Likely retrieval/interpretation problem
      const likelyProblem =
        (count === 0 && classificationConfidence < 0.5) ||
        (count === 0 && !state.timeRange?.dateFrom) ||
        count > 100;

      if (
        likelyProblem &&
        (state.transformationAttempt || 0) <
          EXPENSE_CONFIG.MAX_QUERY_TRANSFORMATIONS
      ) {
        return {
          queryResultStatus: 'INSUFFICIENT',
          insufficiencyReason:
            count === 0 ? 'AMBIGUOUS_OR_TOO_NARROW' : 'TOO_BROAD',
        };
      }

      // Sufficient (or max attempts reached)
      return {
        queryResultStatus: 'SUFFICIENT',
        queryResultType:
          count === 0 ? 'ZERO_AFTER_TRANSFORM' : 'SUCCESS',
      };
    },

    transformQuery: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      const attempt = state.transformationAttempt || 0;
      logger.log(`Transforming query (attempt ${attempt})`);

      // Progressive broadening: drop ONE constraint family per attempt so a
      // zero-hit query degrades gracefully instead of answering "nothing
      // found". Order: dates → modes → color-categories. The date/mode drops
      // are silent; dropping the COLOR category changes semantics, so it
      // sets queryNote which the answer generator must disclose.
      const filters = { ...(state.filters || {}) };
      let queryNote: string | null = state.queryNote || null;

      if (attempt === 0) {
        filters.dateFrom = null;
        filters.dateTo = null;
        queryNote =
          queryNote ||
          'No matches in the requested date range, so I broadened the dates.';
      } else if (attempt === 1) {
        filters.modes = [];
        queryNote =
          'No matches with the payment-mode filter, so I broadened to all modes.';
      } else {
        filters.categories = [];
        queryNote =
          'No transactions matched the color-category filter, so I broadened to all spending in range.';
      }

      return {
        filters,
        timeRange: { dateFrom: null, dateTo: null },
        transformationAttempt: attempt + 1,
        queryNote,
      };
    },

    generateAnswer: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Generating answer via LLM');

      // Call real LLM — uses workflowPrompt from agent_workflows.prompt (DB)
      // This is GENERIC: the prompt field drives domain context, not hardcoded logic
      const result = await answerGenerator.generate({
        transactions: state.retrievedTransactions || [],
        queryIntent: state.queryIntent || 'unknown',
        workflowPrompt,
        count: state.retrievalCount || 0,
        note: state.queryNote || undefined,
        balances: state.retrievedBalances || undefined,
        balanceModes:
          state.filters?.modes && state.filters.modes.length > 0
            ? state.filters.modes
            : null,
      });

      return {
        generatedAnswer: result.text,
        includesAggregation: result.hasNumbers,
        ...countLlm(state, result.usage),
      };
    },

    validateAnswer: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Validating generated answer');

      // Deterministic balance check: for balance questions the reply MUST
      // contain every expected sheet-balance figure. The LLM was given a
      // mandatory lead sentence — if the numbers are absent it disobeyed,
      // so regenerate (bounded) instead of serving recomputed sums as truth.
      if (state.balanceRequested && state.retrievedBalances) {
        const modes =
          state.filters?.modes && state.filters.modes.length > 0
            ? (state.filters.modes as string[]).map((m: string) => normalizeModeLabel(m))
            : Object.keys(state.retrievedBalances);
        const flattened = (state.generatedAnswer || '').replace(/,/g, '');
        const missing = modes.filter((mode: string) => {
          const value = state.retrievedBalances[mode];
          if (value === null || value === undefined) return false;
          const digits = String(value).replace(/,/g, '');
          return !new RegExp(`\\b${escapeRegExp(digits)}\\b`).test(flattened);
        });
        if (missing.length > 0) {
          logger.warn(
            `Answer omits sheet balance(s) for: ${missing.join(', ')} — regenerating`,
          );
          if (
            (state.regenerationAttempt || 0) >=
            EXPENSE_CONFIG.MAX_ANSWER_REGENERATIONS
          ) {
            // Bounded: fall back to a deterministic balance sentence built
            // from the sheet values — truth survives LLM disobedience.
            return {
              answerStatus: 'SATISFACTORY',
              lastResponse: deterministicBalanceText(
                state.retrievedBalances,
                state.filters?.modes,
              ),
            };
          }
          return {
            answerStatus: 'UNSATISFACTORY',
            answerFeedback: `Missing sheet balance(s) for ${missing.join(', ')} — start with the mandatory balance sentence`,
          };
        }
      }

      const satisfactory =
        state.generatedAnswer &&
        state.generatedAnswer.length > 20 &&
        (state.includesAggregation || state.retrievalCount === 0);

      if (
        satisfactory ||
        (state.regenerationAttempt || 0) >=
          EXPENSE_CONFIG.MAX_ANSWER_REGENERATIONS
      ) {
        // Preserve a REAL waiting state: a query answered mid-wait (diverted
        // topic switch) must leave the pending batch/clarification intact so
        // the user can still confirm it afterwards. Only the harmless
        // unknown-state resets to IDLE for clean status.
        const keepWaiting =
          state.workflowMode === WorkflowMode.PENDING_CONFIRMATION ||
          state.workflowMode === WorkflowMode.AWAITING_CLARIFICATION;
        return {
          answerStatus: 'SATISFACTORY',
          ...assistantReply(state, state.generatedAnswer || 'No answer generated.'),
          workflowMode: keepWaiting ? state.workflowMode : WorkflowMode.IDLE,
          unknownAttempts: 0,
        };
      }

      return {
        answerStatus: 'UNSATISFACTORY',
        answerFeedback: 'Too vague, needs numerical precision',
      };
    },

    regenerateAnswer: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log(
        `Regenerating answer via LLM (attempt ${(state.regenerationAttempt || 0) + 1})`,
      );

      // Call real LLM with feedback about why the previous answer was unsatisfactory
      // workflowPrompt ensures generic domain context from DB, not hardcoded
      const result = await answerGenerator.regenerate({
        transactions: state.retrievedTransactions || [],
        queryIntent: state.queryIntent || 'unknown',
        workflowPrompt,
        previousAnswer: state.generatedAnswer || '',
        feedback: state.answerFeedback || 'Answer was too vague',
        note: state.queryNote || undefined,
        balances: state.retrievedBalances || undefined,
        balanceModes:
          state.filters?.modes && state.filters.modes.length > 0
            ? state.filters.modes
            : null,
      });

      return {
        generatedAnswer: result.text,
        includesAggregation: result.hasNumbers,
        regenerationAttempt: (state.regenerationAttempt || 0) + 1,
        ...countLlm(state, result.usage),
      };
    },

    informUserInsufficient: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Informing user of insufficient query results');

      const message = `I couldn't find transactions matching your query after ${state.transformationAttempt || 0} attempts. Try: a different category, broader date range, or check your transaction history.`;

      return {
        ...assistantReply(state, message),
        workflowMode: WorkflowMode.IDLE,
      };
    },

    buildChart: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.log('Building spending chart via generate_chart tool');

      const txns = state.retrievedTransactions || [];
      if (txns.length === 0) {
        return {
          ...assistantReply(
            state,
            'There is no data to chart for that query.',
          ),
          workflowMode: WorkflowMode.IDLE,
        };
      }

      // Deterministic grouping: debit per color-category (uncategorized rows
      // grouped honestly instead of dropped).
      const sums: Record<string, number> = {};
      for (const t of txns) {
        const cat =
          t.colourCategory || t.category || 'UNCATEGORIZED';
        sums[cat] =
          (sums[cat] || 0) + (Number(t.debit) || Number(t.amount) || 0);
      }
      const labels = Object.keys(sums);
      const data = labels.map((l) => Math.round(sums[l] * 100) / 100);
      const total = data.reduce((a, b) => a + b, 0);
      const requested = state.chartType || 'pie';
      const chartType =
        requested === 'bar' || requested === 'line' || requested === 'pie'
          ? requested
          : 'pie';

      const result = await toolExecutor.execute(
        'generate_chart',
        {
          chartType,
          data: { labels, datasets: [{ label: 'Spending', data }] },
          title: 'Spending by category',
        },
        allowedToolCodes,
      );

      const chartImage = Buffer.from(result.imageBuffer).toString('base64');
      logger.log(`Chart rendered: ${result.imageBuffer.length} bytes`);

      return {
        chartImage,
        ...assistantReply(
          state,
          `Chart of your spending across ${labels.length} categor${labels.length === 1 ? 'y' : 'ies'} (total debit ₹${total.toLocaleString('en-IN')}).`,
        ),
        workflowMode: WorkflowMode.IDLE,
        ...countTool(state),
      };
    },

    // ========================================
    // RECOVERY
    // ========================================

    requestUserClarification: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      const attempts = (state.unknownAttempts || 0) + 1;

      // Bounded UNKNOWN loop: after 2 unrecognized turns, stop asking and
      // say plainly what this bot does. Prevents the infinite
      // "not sure → not sure → …" cycle on gibberish input.
      if (attempts > 2) {
        logger.log('Unknown intent limit reached — closing with guidance');
        return {
          ...assistantReply(
            state,
            "I can only help with expense tracking — logging spending or answering money questions. Try 'spent 500 on groceries via phonepay' or 'how much did I spend this month?'.",
          ),
          workflowMode: WorkflowMode.IDLE,
          unknownAttempts: 0,
        };
      }

      logger.log(`Requesting user clarification for unknown intent (attempt ${attempts})`);

      return {
        ...assistantReply(
          state,
          "I'm not sure what you're asking. Do you want to:\n1. Add a transaction\n2. Check your spending\n3. Something else?",
        ),
        workflowMode: WorkflowMode.AWAITING_USER_CLARIFICATION,
        unknownAttempts: attempts,
      };
      // Node returns → graph reaches END → checkpoint saved → HTTP response sent
    },

    handleError: async (
      state: ExpenseWorkflowStateType,
    ): Promise<Partial<ExpenseWorkflowStateType>> => {
      logger.error(`Error in workflow: ${state.error || 'unknown error'}`);

      return {
        ...assistantReply(state, 'An error occurred. Please try again.'),
        workflowMode: WorkflowMode.IDLE,
        error: state.error,
      };
    },
  };
}

// ========================================
// HELPER FUNCTIONS
// ========================================

// ========================================
// TRANSCRIPT HELPERS
// ========================================

/**
 * Real per-request metering helpers. Every node that calls an LLM or a tool
 * folds +1 call and the actual token usage into checkpointed metadata, so
 * FlowTracking and API responses report measured figures — never zeroes.
 */
function countLlm(
  state: ExpenseWorkflowStateType,
  usage?: LlmUsage | null,
  calls = 1,
): Partial<ExpenseWorkflowStateType> {
  return {
    metadata: {
      ...state.metadata,
      llmCalls: (state.metadata?.llmCalls || 0) + calls,
      tokens: (state.metadata?.tokens || 0) + (usage?.totalTokens || 0),
    },
  };
}

function countTool(
  state: ExpenseWorkflowStateType,
): Partial<ExpenseWorkflowStateType> {
  return {
    metadata: {
      ...state.metadata,
      toolCalls: (state.metadata?.toolCalls || 0) + 1,
    },
  };
}

/**
 * Parse a bare amount reply ("100", "2k", "1,500") without needing the LLM.
 */
function parseAmountReply(reply: string): number | null {
  const text = (reply || '').trim().replace(/,/g, '');
  const k = text.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (k) return parseFloat(k[1]) * 1000;
  const n = text.match(/(\d+(?:\.\d+)?)/);
  if (n) {
    const v = parseFloat(n[1]);
    return v > 0 ? v : null;
  }
  return null;
}

/**
 * Split a possibly multi-item message into segments (newline/semicolon).
 * Amounts ("1,000") never contain these separators, so splitting is safe.
 */
function splitBatchSegments(text: string): string[] {
  return (text || '')
    .split(/\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Sanitize an extractor row into "incomplete but shape-valid" form instead of
 * dropping the whole batch on schema failure. A missing amount (0/null) or
 * an unrecognized mode is a CLARIFICATION slot, not a corrupt row — nuking
 * it destroys sibling rows that parsed perfectly (the amazon line vanished
 * because the siva line lacked an amount). Every incomplete slot is
 * re-derived deterministically by validate_transaction_data and asked
 * about; nothing sanitized can reach the sheet (COMPLETE requires amount>0,
 * non-placeholder description, explicit mode, DEBIT/CREDIT direction, and
 * the tool itself rejects amount<=0).
 */
const SANITIZE_MODES = ['PHONEPAY', 'WALLET', 'MONEY', 'BANK'];
const SANITIZE_DIRECTIONS = ['DEBIT', 'CREDIT'];
function sanitizeExtractedRow(tx: any): any {
  if (!tx || typeof tx !== 'object') return {};
  const amount =
    typeof tx.amount === 'number' && isFinite(tx.amount) && tx.amount > 0
      ? tx.amount
      : null;
  return {
    ...tx,
    date:
      typeof tx.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(tx.date)
        ? tx.date
        : null,
    description:
      typeof tx.description === 'string' && tx.description.trim() !== ''
        ? tx.description
        : '',
    mode: SANITIZE_MODES.includes(tx.mode) ? tx.mode : null,
    amount,
    direction: SANITIZE_DIRECTIONS.includes(tx.direction) ? tx.direction : null,
    suggestedCategory:
      typeof tx.suggestedCategory === 'string' ||
      tx.suggestedCategory === null
        ? (tx.direction === 'CREDIT' ? null : tx.suggestedCategory)
        : null,
  };
}

/**
 * Extraction with deterministic segment fallback. The LLM extractor
 * silently DROPS lines from multi-line batches (a 2-line batch returned 1
 * row — the sibling never entered state, so no merge/validation fix can
 * recover it). Protocol: single call first (today's path, zero change when
 * it returns at least one row per segment); when rows < segments, re-extract
 * EACH segment independently (in order, in parallel) and concatenate, so no
 * line's transaction is ever lost. Segments yielding nothing are omitted
 * (no padded skeletons interrogating polite chatter like "thanks!").
 */
async function extractWithSegmentFallback(
  text: string,
  extractor: { extract: (text: string) => Promise<any> },
): Promise<{
  transactions: any[];
  confidence: number;
  needsClarification: boolean;
  ambiguities: string[];
  usage: LlmUsage;
  calls: number;
}> {
  const first = await extractor.extract(text);
  const segments = splitBatchSegments(text);
  const firstRows = first.transactions || [];
  if (segments.length <= 1 || firstRows.length >= segments.length) {
    return {
      transactions: firstRows,
      confidence: first.confidence || 1.0,
      needsClarification: !!first.needsClarification,
      ambiguities: first.needsClarification
        ? first.ambiguities || ['extractor flagged needsClarification']
        : [],
      usage: first.usage,
      calls: 1,
    };
  }

  logger.warn(
    `Extractor dropped batch lines (${firstRows.length} rows for ${segments.length} segments) — re-extracting per segment`,
  );
  const parts = await Promise.all(
    segments.map((seg) => extractor.extract(seg).catch(() => null)),
  );
  const transactions: any[] = [];
  const ambiguities: string[] = [];
  let needsClarification = false;
  let confidence = 1.0;
  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let calls = 0;
  for (const part of parts) {
    if (!part) continue;
    calls++;
    usage.promptTokens += part.usage?.promptTokens || 0;
    usage.completionTokens += part.usage?.completionTokens || 0;
    usage.totalTokens += part.usage?.totalTokens || 0;
    confidence = Math.min(confidence, part.confidence ?? 1.0);
    for (const t of part.transactions || []) transactions.push(t);
    if (part.needsClarification) {
      needsClarification = true;
      ambiguities.push(
        ...(part.ambiguities || ['extractor flagged needsClarification']),
      );
    }
  }
  return { transactions, confidence, needsClarification, ambiguities, usage, calls };
}
/**
 * Record the user's turn in checkpointed transcript state.
 * Returned by the three graph entry nodes (classify_intent for new requests,
 * parse_clarification / parse_edit_or_confirm for resumes) so every invoke
 * appends exactly one user message.
 */
function userEntry(
  state: ExpenseWorkflowStateType,
): Partial<ExpenseWorkflowStateType> {
  return {
    messages: [
      {
        id: `${state.requestId}-user`,
        role: 'user' as const,
        content: state.message,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Record an assistant turn: sets lastResponse AND appends to the transcript
 * so refresh recovery restores the visible conversation.
 */
function assistantReply(
  state: ExpenseWorkflowStateType,
  text: string,
): Partial<ExpenseWorkflowStateType> {
  return {
    lastResponse: text,
    messages: [
      {
        id: `${state.requestId}-asst`,
        role: 'assistant' as const,
        content: text,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Deterministic balance-question detector. Backstops the interpreter: if the
 * message asks about balances / how-much-is-there, sheet balances are fetched
 * even when the LLM forgot wantsBalances. Missing a balance answer is worse
 * than an extra free side-effectless read.
 */
const BALANCE_QUESTION_RE =
  /\b(balance|balances|how much (is|are) there|how much .* (left|remaining|at present|right now)|kitna)\b/i;

/**
 * Credit signals: words indicating money came IN. A CREDIT direction is only
 * accepted unchallenged when the user's own message carries one of these.
 * Anything else claiming CREDIT (e.g. a bare "found 200") must be confirmed
 * via the direction question — incoming money is never assumed.
 * NOTE: must cover the direction question's OWN vocabulary ("coming in
 * (income)") — offering words the parser can't hear re-asks forever.
 */
const CREDIT_SIGNALS =
  /\breceived\b|\brefund\b|\bsalary\b|\bstipend\b|\bincome\b|\bincoming\b|\bcoming\s?in\b|\bcredited?\b|\bcashback\b|\brewards?\b|\bpaid\s+back\b|\bgot\b.{0,20}\b(from|back)\b/i;

/**
 * Debit signals: words indicating money went OUT (the common case).
 * NOTE: must cover the direction question's OWN vocabulary ("going out
 * (expense)") — "going out" unmatched means the user's answer, given in the
 * question's words, is ignored and the question repeats.
 */
const DEBIT_SIGNALS =
  /\bpaid\b|\bspent\b|\bbought\b|\bpay\b|\bexpense\b|\bgoing\s?out\b|\boutgoing\b|\bout\b|\bdebit\b|\bdebited\b|\bsent\b|\blent\b|\bwithdraw\b/i;

/**
 * Payment-mode keywords for the deterministic ambiguity guard.
 * Whole-word match only (so "cashback" does not count as "cash").
 * NOTE: "savings"/"account" alone are NOT keywords — "akka gave 1500 to
 * savings" must stay a clean single-mode (BANK) extraction.
 */
const MODE_KEYWORDS: Record<string, RegExp> = {
  PHONEPAY: /\b(phone\s?pay|phonepe|phnpe|gpay|google\s?pay|upi)\b/i,
  MONEY: /\b(money|cash)\b/i,
  WALLET: /\b(wallet|paytm)\b/i,
  BANK: /\b(bank|savings?|account|card|netbanking|neft|imps)\b/i,
};

/**
 * Which distinct payment modes does the raw user message name?
 * 0 = none mentioned (extractor default applies), 1 = unambiguous,
 * 2+ = ambiguous → validate_transaction_data forces clarification.
 */
function detectMentionedModes(message: string): string[] {
  return Object.entries(MODE_KEYWORDS)
    .filter(([, re]) => re.test(message))
    .map(([mode]) => mode);
}

/**
 * Anti-assumption rule: a mode counts as given ONLY if the user's own message
 * names exactly that one mode. An extractor default (e.g. MONEY for a message
 * that never mentions money) is NOT consent — it stays missing until the user
 * confirms it. "Who told you I paid by money" must be impossible.
 */
function isExplicitMode(txnMode: unknown, mentionedModes: string[]): boolean {
  return (
    mentionedModes.length === 1 &&
    normalizeModeLabel(txnMode) === mentionedModes[0]
  );
}

/**
 * Single-field emptiness test for one batch row — mirrors the validation
 * rules above. Used to target clarification questions/merges at the exact
 * (field, item) still missing instead of treating the batch as one slot.
 */
function rowMissingField(row: any, field: string): boolean {
  if (!row) return true;
  if (field === 'amount') return !(row.amount > 0);
  if (field === 'description') return isGenericDescription(row.description);
  if (field === 'mode') return !row.mode;
  if (field === 'direction')
    return row.direction !== 'DEBIT' && row.direction !== 'CREDIT';
  return false;
}

/**
 * Full validation-mirror reasons for one row: the EXACT predicates the
 * validator applies (explicit/established mode, signaled credit). The
 * question-targeting MUST use these — not the lax value-absence check —
 * or validator and targeter disagree: the validator flags row 2's
 * unsignaled CREDIT while the targeter sees "has a value" on every row,
 * defaults to row 0, and row 0's answered question repeats forever.
 */
interface RowProbe {
  /** modes named for this item in the current message (or whole message) */
  itemModes: string[];
  /** modes named for this item in the ORIGINAL message's home line */
  homeModes: string[];
  /** modes named in EARLIER replies that filled this row (accumulated) */
  answeredModes: string[];
  /** text searched for credit signals: reply + original + this row's answers */
  signalText: string;
}

function rowMissingReasons(txn: any, probe: RowProbe): string[] {
  const out: string[] = [];
  if (!txn) return ['amount', 'description', 'mode', 'direction'];
  if (!(txn.amount > 0)) out.push('amount');
  if (isGenericDescription(txn.description)) out.push('description');
  // Established = stated in the home line OR in an earlier reply that
  // filled THIS row. Without the second clause, answering row 0's mode in
  // turn 2 gets re-dirtied by turn 3's direction answer (the reply-only
  // message justifies one slot, so every settled row looks guessed again).
  const normMode = normalizeModeLabel(txn.mode);
  const established =
    !!txn.mode &&
    ((probe.homeModes.length === 1 && normMode === probe.homeModes[0]) ||
      (probe.answeredModes.length > 0 &&
        probe.answeredModes.includes(normMode)));
  if (
    !txn.mode ||
    !(established || isExplicitMode(txn.mode, probe.itemModes))
  ) {
    out.push('mode');
  }
  if (
    txn.direction !== 'DEBIT' &&
    !(txn.direction === 'CREDIT' && CREDIT_SIGNALS.test(probe.signalText))
  ) {
    out.push('direction');
  }
  return out;
}

/**
 * Build per-row probes shared by validator and question-targeter (same
 * inputs → same verdicts by construction; they must never disagree).
 */
function buildRowProbes(
  state: ExpenseWorkflowStateType,
  rows: any[],
): RowProbe[] {
  const messageLines = splitBatchSegments(state.message || '');
  const perItem = rows.length > 0 && messageLines.length === rows.length;
  const wholeModes = detectMentionedModes(state.message || '');
  const ctx = state.pendingClarificationContext || {};
  const ctxOrig: string = ctx.originalMessage || '';
  const homeLines = splitBatchSegments(ctxOrig);
  const homePerItem = rows.length > 0 && homeLines.length === rows.length;
  const homeWhole = ctxOrig ? detectMentionedModes(ctxOrig) : [];
  const filledMap: Record<number, string> = ctx.filledByAnswer || {};
  return rows.map((_, i) => {
    const answered = filledMap[i] || '';
    return {
      itemModes: perItem ? detectMentionedModes(messageLines[i]) : wholeModes,
      homeModes: homePerItem
        ? detectMentionedModes(homeLines[i])
        : homeWhole,
      answeredModes: answered ? detectMentionedModes(answered) : [],
      signalText: `${state.message || ''} ${ctxOrig} ${answered}`,
    };
  });
}

/**
 * Anti-assumption rule for descriptions: empty or LLM-invented placeholders
 * ("unspecified transaction") are missing — the user must say what it was for.
 */
function isGenericDescription(desc: unknown): boolean {
  if (!desc || typeof desc !== 'string' || desc.trim() === '') return true;
  const t = desc.trim();
  return (
    /^(unspecified|unknown|n\/a|none|misc|miscellaneous)\b/i.test(t) ||
    /^(transaction|payment|expense)s?$/i.test(t)
  );
}

/**
 * Escape a string for literal RegExp use.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministic balance sentence from sheet values. Last-resort truth when
 * the LLM drops the mandatory balance figures twice — served verbatim.
 */
function deterministicBalanceText(
  balances: Record<string, number | null>,
  modes?: string[] | null,
): string {
  const wanted =
    modes && modes.length > 0
      ? modes.map((m) => normalizeModeLabel(m))
      : Object.keys(balances);
  const parts = wanted.map((mode) => {
    const value = balances[mode];
    return value === null || value === undefined
      ? `${mode}: no recorded balance`
      : `${mode}: ₹${Number(value).toLocaleString('en-IN')}`;
  });
  return `Your balance${wanted.length === 1 ? '' : 's'}: ${parts.join('; ')} (as per your sheet).`;
}
/**
 * Build the clarification question deterministically from what's missing AND
 * what's already known. Same safety as fixed templates (no LLM on the hot
 * path), but the question references the user's own words — "How did you pay
 * for coffee?" instead of a context-free "How did you pay?" every time.
 */
function buildClarificationQuestion(
  missingFields: string[],
  partialTxn?: any,
): string {
  const amount =
    partialTxn?.amount > 0 ? `₹${partialTxn.amount}` : null;
  const desc =
    partialTxn?.description && !isGenericDescription(partialTxn.description)
      ? partialTxn.description
      : null;

  if (missingFields.includes('amount')) {
    return desc ? `How much was ${desc}?` : 'How much was the transaction?';
  }
  if (missingFields.includes('description')) {
    return amount
      ? `You mentioned ${amount} — what was it for?`
      : 'What was the transaction for?';
  }
  if (missingFields.includes('mode')) {
    return desc
      ? `How did you pay for ${desc}? (PhonePay/Wallet/Money/Bank)`
      : 'How did you pay? (PhonePay/Wallet/Money/Bank)';
  }
  if (missingFields.includes('direction')) {
    // Avoid stutter when the description already ends with "money"
    // ("amma gave money money going out").
    const descMoney =
      desc && /money$/i.test(desc) ? desc : desc ? `${desc} money` : null;
    return descMoney
      ? `Was ${descMoney} going out (expense) or coming in (income)?`
      : 'Was this money going out (expense) or coming in (income)?';
  }
  return 'Please provide more details about the transaction.';
}

function generateClarificationQuestion(missingFields: string[]): string {
  return buildClarificationQuestion(missingFields);
}

/**
 * Canonicalize a user-typed category ("personal", "pay home", "none") to the
 * workbook enum. Deterministic — never trust the LLM's casing/variants.
 * Unknown words return undefined (caller IGNORES the edit, keeping the old
 * value — a typo must not nuke a good suggestion into null).
 */
function normalizeCategoryLabel(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const t = String(value).trim().toUpperCase().replace(/[\s_-]+/g, '_');
  if (t === '' || t === 'NULL' || t === 'NONE' || t === 'NO' || t === 'REMOVE' || t === 'UNCATEGORIZED' || t === 'UNCATEGORISED') {
    return null;
  }
  const map: Record<string, string> = {
    AVOID: 'AVOID_EXPENSE',
    AVOID_EXPENSE: 'AVOID_EXPENSE',
    PAY_HOME: 'PAY_HOME_CASH',
    PAY_HOME_CASH: 'PAY_HOME_CASH',
    FAMILY: 'PAY_HOME_CASH',
    HOME_CASH: 'PAY_HOME_CASH',
    PERSONAL: 'PERSONAL_EXPENSE',
    PERSONAL_EXPENSE: 'PERSONAL_EXPENSE',
    HOME: 'HOME_EXPENSE',
    HOME_EXPENSE: 'HOME_EXPENSE',
    FOR_HOME: 'HOME_EXPENSE',
    WISHLIST: 'WISHLIST_EXPENSE',
    WISHLIST_EXPENSE: 'WISHLIST_EXPENSE',
    WISH_LIST: 'WISHLIST_EXPENSE',
  };
  return map[t];
}

/**
 * The category that will actually paint the row: explicit colourCategory,
 * else the LLM suggestion, else the legacy field. Normalized (or null).
 */
function effectiveCategory(txn: any): string | null {
  const raw =
    txn?.colourCategory ?? txn?.suggestedCategory ?? txn?.category ?? null;
  if (raw === null || raw === undefined) return null;
  return normalizeCategoryLabel(raw) ?? null;
}

function formatTransactionBatch(transactions: any[]): string {
  if (transactions.length === 0) {
    return 'No transactions to display.';
  }

  let formatted = `I'll log ${transactions.length} transaction(s):\n\n`;
  transactions.forEach((txn, idx) => {
    // Direction is always shown — the user confirms money-out vs money-in
    // explicitly, never blind. Category is always shown too — it decides
    // the row's color, and a wrong guess (SIVA → yellow PAY_HOME_CASH) must
    // be visible and editable BEFORE it hits the sheet.
    const cat = effectiveCategory(txn) || 'UNCATEGORIZED';
    formatted += `${idx + 1}. ${txn.description} - ₹${txn.amount} (${txn.mode}, ${txn.direction || 'DEBIT'}) [${cat}]\n`;
  });

  return formatted;
}

function applyEdits(batch: any[], edits: any[]): any[] {
  const updated = [...batch];

  for (const edit of edits) {
    const idx = edit.itemNumber - 1; // Convert to 0-indexed
    if (idx >= 0 && idx < updated.length) {
      // Category edits are canonicalized deterministically ("personal" →
      // PERSONAL_EXPENSE) and fanned out to every category-carrying field so
      // display, color mapping and the tool contract all agree. Unknown words
      // leave the row untouched (a typo must not erase a good suggestion).
      // "remove"/"none" clears to null (row lands uncolored) deliberately.
      if (
        edit.field === 'category' ||
        edit.field === 'suggestedCategory' ||
        edit.field === 'colourCategory'
      ) {
        const canonical = normalizeCategoryLabel(edit.newValue);
        if (canonical !== undefined) {
          updated[idx] = {
            ...updated[idx],
            category: canonical,
            suggestedCategory: canonical,
            colourCategory: canonical,
          };
        } else {
          logger.warn(
            `Ignoring unrecognized category edit "${edit.newValue}" on item ${edit.itemNumber}`,
          );
        }
        continue;
      }
      updated[idx] = {
        ...updated[idx],
        [edit.field]: edit.newValue,
      };
    }
  }

  return updated;
}
