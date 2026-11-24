/* Stable agent error codes and their HTTP mapping.
 *
 * The shared core throws AgentError; each host maps it once. Keeping the
 * mapping here means the server, web client and RN client cannot drift on what
 * "tool_not_allowed" means.
 */

export const ERROR_STATUS = Object.freeze({
  invalid_request: 400,
  scope_denied: 403,
  profile_not_found: 404,
  profile_capability_missing: 422,
  context_budget_exceeded: 413,
  fact_missing: 409,
  tool_not_allowed: 403,
  tool_args_invalid: 400,
  tool_target_out_of_scope: 403,
  tool_budget_exceeded: 429,
  proposal_not_found: 404,
  proposal_conflict: 409,
  proposal_consumed: 409,
  run_not_found: 404,
  run_terminal: 409,
  run_cancelled: 409,
  run_interrupted: 409,
  request_conflict: 409,
  model_unavailable: 503,
  model_timeout: 504,
  model_response_too_large: 502,
  retrieval_unavailable: 503,
  retrieval_index_not_ready: 503,
  retrieval_timeout: 504,
  session_deleted: 409,
  session_busy: 409,
  session_conflict: 409,
  turn_limit: 429,
  memory_not_found: 404,
  agent_disabled: 503,
  agent_config_disabled: 503,
  agent_config_corrupt: 500,
  agent_store_corrupt: 500,
  agent_media_invalid: 400,
  agent_media_too_large: 413,
});

export const ERROR_MESSAGES = Object.freeze({
  invalid_request: 'The request is not valid.',
  scope_denied: 'That object is outside this workspace or account.',
  profile_not_found: 'That model configuration does not exist.',
  profile_capability_missing: 'The selected model configuration cannot do what this task needs.',
  context_budget_exceeded: 'The task needs more context than the model budget allows.',
  fact_missing: 'A fact this task requires is missing.',
  tool_not_allowed: 'The model asked for a tool that is not open in this step.',
  tool_args_invalid: 'The tool arguments do not match the tool schema.',
  tool_target_out_of_scope: 'The tool target is outside this task scope.',
  tool_budget_exceeded: 'This step has used its tool calls.',
  proposal_not_found: 'That proposal does not exist.',
  proposal_conflict: 'The target changed after this proposal was made. Generate it again.',
  proposal_consumed: 'That proposal was already handled.',
  run_not_found: 'That run does not exist.',
  run_terminal: 'That run has already ended.',
  run_cancelled: 'That run was cancelled.',
  run_interrupted: 'That run was interrupted before it finished.',
  request_conflict: 'This request id was already used with different input.',
  model_unavailable: 'The model provider is not available.',
  model_timeout: 'The model provider did not answer in time.',
  model_response_too_large: 'The model provider answered with more data than the runtime accepts.',
  retrieval_unavailable: 'Exercise retrieval is temporarily unavailable.',
  retrieval_index_not_ready: 'The exercise retrieval index is not ready for this configuration.',
  retrieval_timeout: 'Exercise retrieval did not finish in time.',
  session_deleted: 'That conversation was deleted.',
  session_busy: 'Another search is already running in this conversation.',
  session_conflict: 'That conversation belongs to a different task or changed while this answer was running.',
  turn_limit: 'This conversation has used all its follow-up turns. Start a new search.',
  memory_not_found: 'That memory does not exist.',
  agent_disabled: 'The agent runtime is disabled on this instance.',
  agent_config_disabled: 'Server-held model credentials are disabled because this instance has no secret.',
  agent_config_corrupt: 'A stored model credential could not be decrypted with this instance secret.',
  agent_store_corrupt: 'The stored agent data could not be read.',
  agent_media_invalid: 'The attachment is not an image this runtime accepts.',
  agent_media_too_large: 'The attachment is larger than the runtime accepts.',
});

export class AgentError extends Error {
  /**
   * @param {keyof typeof ERROR_STATUS} code
   * @param {string} [message]
   * @param {{ details?: unknown, cause?: unknown, status?: number }} [options]
   */
  constructor(code, message, options = {}) {
    super(message || ERROR_MESSAGES[code] || code);
    this.name = 'AgentError';
    this.code = code;
    this.status = options.status || ERROR_STATUS[code] || 400;
    this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const isAgentError = value => value instanceof AgentError;

export function agentError(code, message, options) {
  return new AgentError(code, message, options);
}

/** HTTP status for any thrown value; unknown failures are a 500. */
export function statusOf(error) {
  return error instanceof AgentError ? error.status : 500;
}
