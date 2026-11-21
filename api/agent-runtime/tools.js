/* The tool-call fence.
 *
 * Order matters: the current step's allow-list, the argument schema, the call
 * budget, then the target scope, and only then the read-only implementation.
 * A refused call increments neither the executed-call count nor anything the
 * underlying tool can observe.
 */
import { AgentError } from './errors.js';
import { validate, assertValid } from './schema.js';

function checkDefinition(tool) {
  if (!tool || typeof tool !== 'object') throw new Error('tool definition must be an object');
  if (typeof tool.id !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(tool.id)) {
    throw new Error(`tool id is invalid: ${String(tool.id)}`);
  }
  if (typeof tool.description !== 'string' || !tool.description) {
    throw new Error(`tool ${tool.id} needs a description`);
  }
  if (!tool.argsSchema || typeof tool.argsSchema !== 'object') {
    throw new Error(`tool ${tool.id} needs an argsSchema`);
  }
  if (typeof tool.run !== 'function') throw new Error(`tool ${tool.id} needs a run function`);
  if (tool.target !== undefined && typeof tool.target !== 'function') {
    throw new Error(`tool ${tool.id} target must be a function`);
  }
}

export function createToolRegistry(tools) {
  const map = new Map();
  for (const tool of tools || []) {
    checkDefinition(tool);
    if (map.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
    map.set(tool.id, Object.freeze({ ...tool }));
  }
  return {
    get: id => map.get(id) || null,
    has: id => map.has(id),
    all: () => [...map.values()],
    list: (allowedIds) => {
      const allowed = allowedIds == null ? null : new Set(allowedIds);
      return [...map.values()]
        .filter(tool => !allowed || allowed.has(tool.id))
        .map(tool => ({
          name: tool.id,
          description: tool.description,
          parameters: tool.argsSchema,
        }));
    },
  };
}

function targetIdsOf(tool, args) {
  if (typeof tool.target !== 'function') return null;
  const raw = tool.target(args);
  if (raw == null) return null;
  const ids = Array.isArray(raw) ? raw : [raw];
  if (!ids.length) return null;
  for (const id of ids) {
    if (typeof id !== 'string' || !id) {
      throw new AgentError('tool_args_invalid', 'tool target returned an invalid id', {
        details: { toolId: tool.id },
      });
    }
  }
  return ids;
}

/**
 * @param {{
 *   registry: ReturnType<typeof createToolRegistry>,
 *   context: import('./contracts.js').RunContext,
 *   allowedToolIds?: string[],
 *   maxCalls?: number,
 *   signal?: AbortSignal | null,
 *   authorize?: (input: { toolId: string, args: Record<string, unknown>, targets: string[] | null, context: unknown }) => boolean,
 * }} options
 */
export function createDispatcher(options) {
  const {
    registry,
    context,
    allowedToolIds = [],
    maxCalls = 8,
    signal = context && context.signal,
    authorize,
  } = options || {};
  if (!registry) throw new AgentError('invalid_request', 'the tool dispatcher needs a registry');
  if (!context) throw new AgentError('invalid_request', 'the tool dispatcher needs a run context');
  const allowed = new Set(allowedToolIds || []);
  let calls = 0;
  let rejected = 0;
  const limit = Math.max(0, Math.floor(Number(maxCalls) || 0));

  const deny = error => {
    rejected++;
    throw error;
  };

  return {
    list() {
      return registry.list(allowed);
    },
    get calls() {
      return calls;
    },
    get rejected() {
      return rejected;
    },
    /**
     * @param {string} toolId
     * @param {Record<string, unknown>} args
     * @param {{ callId?: string }} [callOptions]
     */
    async call(toolId, args, callOptions = {}) {
      const tool = registry.get(toolId);
      // An unknown tool and a tool outside this step are the same refusal to
      // the model, and both keep the underlying implementation untouched.
      if (!allowed.has(toolId) || !tool) {
        deny(new AgentError('tool_not_allowed', 'tool is not open in this step', { details: { toolId } }));
      }
      const argsResult = validate(tool.argsSchema, args ?? {});
      if (!argsResult.ok) {
        deny(new AgentError('tool_args_invalid', `${argsResult.path}: ${argsResult.message}`, {
          details: { toolId, path: argsResult.path, reason: argsResult.message },
        }));
      }
      if (calls >= limit) {
        deny(new AgentError('tool_budget_exceeded', 'tool call budget for this step is exhausted', {
          details: { limit },
        }));
      }
      const targets = targetIdsOf(tool, args ?? {});
      if (targets) {
        for (const id of targets) {
          if (!context.targetScope.has(id)) {
            deny(new AgentError('tool_target_out_of_scope', 'tool target is outside this task scope', {
              details: { toolId, targetId: id },
            }));
          }
        }
      }
      if (typeof authorize === 'function' && !authorize({ toolId, args: args ?? {}, targets, context })) {
        deny(new AgentError('tool_target_out_of_scope', 'tool call is not allowed for this task', {
          details: { toolId, targets },
        }));
      }

      // Past every fence: this is the one place the underlying read runs.
      calls++;
      const result = await tool.run(args ?? {}, {
        context,
        signal: signal || null,
        callId: callOptions.callId,
      });
      if (tool.resultSchema) {
        const resultCheck = validate(tool.resultSchema, result);
        if (!resultCheck.ok) {
          throw new AgentError('invalid_request', 'tool returned an invalid result', {
            details: { toolId, path: resultCheck.path, reason: resultCheck.message },
          });
        }
      }
      return { toolId, result, calls, ...(callOptions.callId ? { callId: callOptions.callId } : {}) };
    },
  };
}

/** Validate arguments without running anything, for a task that wants to pre-check. */
export function checkToolArgs(tool, args) {
  checkDefinition(tool);
  assertValid(tool.argsSchema, args ?? {});
  return true;
}
