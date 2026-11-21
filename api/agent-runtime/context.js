/* Run context: the trusted scope plus the evidence table the model may cite.
 *
 * The context is the only object a tool handler receives. Every id that came
 * from a request is resolved inside it; a raw id from a model is never
 * authoritative.
 */
import { AgentError } from './errors.js';
import { withRunDefaults } from './contracts.js';

const asArray = value => (Array.isArray(value) ? value : []);

function ensureScope(scope) {
  if (typeof scope !== 'string' || !scope.trim()) {
    throw new AgentError('invalid_request', 'agent context needs a workspace or account scope');
  }
  return scope;
}

/**
 * @param {{
 *   scope: string,
 *   runId: string,
 *   request: Record<string, unknown>,
 *   execution: 'local' | 'server',
 *   profileRef: Record<string, unknown>,
 *   dataVersion?: string | number,
 *   targetScope?: Iterable<string>,
 *   deadline?: number | null,
 *   signal?: AbortSignal | null,
 *   memories?: unknown[],
 *   history?: unknown[],
 *   meta?: Record<string, unknown>,
 *   ids?: { evidence?: () => string },
 *   now?: () => number,
 * }} options
 */
export function bindContext(options) {
  const {
    scope,
    runId,
    request,
    execution,
    profileRef,
    dataVersion,
    targetScope,
    deadline = null,
    signal = null,
    memories = [],
    history = [],
    meta = {},
    ids,
    now = Date.now,
  } = options || {};
  if (typeof runId !== 'string' || !runId) throw new AgentError('invalid_request', 'agent context needs a run id');
  if (execution !== 'local' && execution !== 'server') {
    throw new AgentError('invalid_request', 'execution must be local or server');
  }
  const scopeSet = new Set();
  for (const id of asArray(targetScope ?? [])) {
    if (typeof id !== 'string' || !id) {
      throw new AgentError('invalid_request', 'targetScope must contain string ids');
    }
    scopeSet.add(id);
  }
  return {
    scope: ensureScope(scope),
    runId,
    request,
    execution,
    profileRef,
    dataVersion,
    targetScope: scopeSet,
    evidence: new Map(),
    evidenceSeq: 0,
    memories: [...asArray(memories)],
    history: [...asArray(history)],
    deadline,
    signal,
    startedAt: now(),
    meta: { ...meta },
    ids: ids || {},
  };
}

/** True when the target id is a string and inside the bound task scope. */
export function inTargetScope(context, id) {
  return typeof id === 'string' && context.targetScope.has(id);
}

/**
 * Record a fact or tool result as evidence and return the id given to the
 * model. The caller's object is copied so later mutations cannot rewrite what
 * the model saw.
 */
export function addEvidence(context, fact) {
  if (!fact || typeof fact !== 'object') throw new AgentError('invalid_request', 'evidence must be an object');
  const { source, objectId } = fact;
  if (typeof source !== 'string' || !source) {
    throw new AgentError('invalid_request', 'evidence needs a source');
  }
  if (typeof objectId !== 'string' || !objectId) {
    throw new AgentError('invalid_request', 'evidence needs an objectId');
  }
  if (!inTargetScope(context, objectId)) {
    throw new AgentError('scope_denied', 'evidence object is outside this task scope', {
      details: { objectId },
    });
  }
  const evidenceId = fact.evidenceId || (typeof context.ids.evidence === 'function'
    ? context.ids.evidence()
    : `ev_${context.runId}_${++context.evidenceSeq}`);
  if (context.evidence.has(evidenceId)) {
    throw new AgentError('invalid_request', 'duplicate evidence id');
  }
  const content = fact.content === undefined ? null : structuredCloneSafe(fact.content);
  const record = {
    evidenceId,
    source,
    objectId,
    ...(fact.version === undefined ? {} : { version: fact.version }),
    content,
    ...(fact.kind ? { kind: fact.kind } : {}),
  };
  context.evidence.set(evidenceId, record);
  return record;
}

/** Map a model citation back to the real object and the version it saw. */
export function resolveEvidence(context, evidenceId) {
  const found = context.evidence.get(evidenceId);
  if (!found) {
    throw new AgentError('fact_missing', 'the cited evidence is not in this run', {
      details: { evidenceId },
    });
  }
  return found;
}

/** Evidence without the bulky content, for the final result. */
export function evidenceList(context) {
  return [...context.evidence.values()].map(({ evidenceId, objectId, version, source }) => ({
    evidenceId,
    objectId,
    ...(version === undefined ? {} : { version }),
    source,
  }));
}

/**
 * The text budget a model sees: attachment payloads are media, not text. The
 * data URL can be megabytes, so counting it here would make every real image
 * fail the text budget even though the media budget is separate.
 */
function budgetView(modelInput) {
  const attachments = modelInput?.user?.attachments;
  if (!Array.isArray(attachments) || !attachments.length) return modelInput;
  return {
    ...modelInput,
    user: {
      ...modelInput.user,
      attachments: attachments.map(({ dataUrl, ...rest }) => rest),
    },
  };
}

export function contextChars(modelInput) {
  return JSON.stringify(budgetView(modelInput)).length;
}

function attachmentSize(attachment) {
  const size = Number(attachment?.size);
  if (Number.isFinite(size) && size >= 0) return size;
  const dataUrl = typeof attachment?.dataUrl === 'string' ? attachment.dataUrl : '';
  return dataUrl.length;
}

/**
 * Trim optional history and memories until the model input fits. Facts,
 * instructions, the current input and the latest tool results are kept; if
 * they alone exceed the budget the run fails with a stable error.
 */
export function trimContext(modelInput, budgets = {}) {
  const limits = withRunDefaults(budgets);
  const next = {
    ...modelInput,
    user: { ...modelInput.user },
    facts: [...asArray(modelInput.facts)],
    memories: [...asArray(modelInput.memories)],
    history: [...asArray(modelInput.history)],
    tools: [...asArray(modelInput.tools)],
    toolResults: [...asArray(modelInput.toolResults)],
  };
  if (next.user.attachments) next.user.attachments = [...next.user.attachments];

  // Hard item caps first, keeping the most recent entries the caller supplied.
  if (next.history.length > limits.historyItems) next.history = next.history.slice(-limits.historyItems);
  if (next.memories.length > limits.memoryItems) next.memories = next.memories.slice(0, limits.memoryItems);
  if (next.user.attachments && next.user.attachments.length > limits.attachments) {
    next.user.attachments = next.user.attachments.slice(0, limits.attachments);
  }
  for (const attachment of next.user.attachments || []) {
    const bytes = attachmentSize(attachment);
    if (bytes > limits.attachmentBytes) {
      throw new AgentError('context_budget_exceeded', 'an attachment exceeds the media budget', {
        details: {
          attachmentId: attachment?.id,
          size: bytes,
          limit: limits.attachmentBytes,
        },
      });
    }
  }

  let size = contextChars(next);
  while (size > limits.contextChars) {
    if (next.history.length) {
      next.history.shift();
    } else if (next.memories.length) {
      next.memories.pop();
    } else if (next.toolResults.length > 1) {
      next.toolResults.shift();
    } else if (next.user.attachments && next.user.attachments.length > 1) {
      next.user.attachments.shift();
    } else {
      throw new AgentError('context_budget_exceeded', 'the required context does not fit the model budget', {
        details: { size, limit: limits.contextChars },
      });
    }
    size = contextChars(next);
  }
  return next;
}

function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    // A function or a platform object cannot be cloned; JSON keeps the data
    // shape and never leaks a live reference into the evidence table.
    return JSON.parse(JSON.stringify(value));
  }
}
