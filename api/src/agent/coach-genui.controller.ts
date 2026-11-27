/* SSE endpoint for the Coach generative-UI stream.
 *
 * Validates the request before a single byte of SSE is written (401 by the access
 * guard, 503 when the agent surface is off, 400 for an unusable body), then hands the
 * response to CoachGenUIService and writes each AG-UI event as it is emitted.
 *
 * The client owns the connection: a disconnect aborts the run immediately and clears
 * the 15s ping, so an abandoned tab does not keep a model call alive.
 */
import { Controller, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { readBody } from '../common/http/body-reader.js';
import { HttpError } from '../common/http/http-error.js';
import { agentUid } from './agent.http.js';
import { agentEnabled } from './agent.flags.js';
import { formatSseEvent, MAX_COACH_GENUI_TURNS, MAX_VISUAL_NODES_LIMIT } from '../../agent-runtime/genui/index.js';
import {
  CoachGenUIService,
  MAX_COACH_TEXT,
  normalizeCoachPlan,
  type CoachFormSubmission,
  type CoachHistoryMessage,
  type CoachStreamRequest,
} from './coach-genui.service.js';

const PING_INTERVAL_MS = 15_000;
const MAX_ID_CHARS = 120;
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CONTENT_CHARS = 4000;

function agentRuntimeDisabled(): boolean {
  return !agentEnabled();
}

function optionalId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_CHARS) return undefined;
  return trimmed;
}

function normalizeFormSubmission(raw: unknown): CoachFormSubmission | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const answersRaw = record.answers ?? record.values;
  if (!answersRaw || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) return null;
  const answers = answersRaw as Record<string, unknown>;
  const formId = typeof record.formId === 'string' ? record.formId.trim().slice(0, 80) : '';
  if (!formId && Object.keys(answers).length === 0) return null;
  return { ...(formId ? { formId } : {}), answers };
}

/**
 * Validate and sanitize the optional multi-turn history.
 *
 * Every entry is checked before any length cap, so a caller cannot hide extra user
 * turns behind a 24-message slice. The 10-turn limit is enforced on the validated
 * user turns, which makes an 11th turn a 429 before SSE is opened.
 */
function normalizeHistory(raw: unknown): CoachHistoryMessage[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'history must be an array');

  const validated: CoachHistoryMessage[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(400, `history[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (record.role !== 'user' && record.role !== 'assistant') {
      throw new HttpError(400, `history[${index}].role must be 'user' or 'assistant'`);
    }
    if (typeof record.content !== 'string') {
      throw new HttpError(400, `history[${index}].content must be a string`);
    }
    const content = record.content.trim().slice(0, MAX_HISTORY_CONTENT_CHARS);
    if (!content) return;
    validated.push({ role: record.role, content });
  });

  const userTurns = validated.filter(message => message.role === 'user').length;
  if (userTurns >= MAX_COACH_GENUI_TURNS) {
    throw new HttpError(
      429,
      `This conversation has reached the ${MAX_COACH_GENUI_TURNS}-turn limit. Start a new conversation to continue.`,
      { extra: { code: 'turn_limit' } },
    );
  }

  return validated.length > MAX_HISTORY_MESSAGES ? validated.slice(-MAX_HISTORY_MESSAGES) : validated;
}

/** Body validation for POST /api/agent/coach/stream. Throws HttpError(400). */
export function parseCoachStreamBody(body: Record<string, unknown>): CoachStreamRequest {
  if (body.text !== undefined && typeof body.text !== 'string') {
    throw new HttpError(400, 'text must be a string');
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > MAX_COACH_TEXT) {
    throw new HttpError(400, `text must be at most ${MAX_COACH_TEXT} characters`);
  }
  const formSubmission = normalizeFormSubmission(body.formSubmission);
  if (!text && !formSubmission) {
    throw new HttpError(400, 'text or a formSubmission is required');
  }

  const profileId = optionalId(body.profileId);
  if (body.profileId !== undefined && typeof body.profileId !== 'string') {
    throw new HttpError(400, 'profileId must be a string');
  }

  const planRaw = body.plan ?? body.planSummary;
  const plan = normalizeCoachPlan(planRaw);

  const langRaw = typeof body.lang === 'string' ? body.lang.trim() : '';
  const lang = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(langRaw) ? langRaw : undefined;

  const history = normalizeHistory(body.history);

  let maxVisuals: number | undefined;
  if (body.maxVisuals !== undefined) {
    if (
      typeof body.maxVisuals !== 'number'
      || !Number.isFinite(body.maxVisuals)
      || !Number.isInteger(body.maxVisuals)
    ) {
      throw new HttpError(400, 'maxVisuals must be an integer');
    }
    maxVisuals = Math.min(MAX_VISUAL_NODES_LIMIT, Math.max(0, body.maxVisuals));
  }

  return {
    text,
    ...(formSubmission ? { formSubmission } : {}),
    ...(plan ? { plan } : {}),
    ...(profileId ? { profileId } : {}),
    ...(lang ? { lang } : {}),
    ...(history.length ? { history } : {}),
    ...(maxVisuals !== undefined ? { maxVisuals } : {}),
    ...(optionalId(body.threadId) ? { threadId: optionalId(body.threadId) } : {}),
    ...(optionalId(body.runId) ? { runId: optionalId(body.runId) } : {}),
    ...(optionalId(body.today) ? { today: optionalId(body.today) } : {}),
    ...(body.fixture === true ? { fixture: true } : {}),
  };
}

@Controller()
export class CoachGenUIController {
  constructor(
    private readonly sessions: SessionService,
    private readonly coach: CoachGenUIService,
  ) {}

  @SessionRequired()
  @Post('agent/coach/stream')
  async stream(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const uid = agentUid(req, this.sessions);
    if (agentRuntimeDisabled()) throw new HttpError(503, 'the agent runtime is disabled');
    const request = parseCoachStreamBody(await readBody(req));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay?.(true);

    const controller = new AbortController();
    const ping = setInterval(() => {
      if (res.writableEnded) return;
      try {
        res.write(': ping\n\n');
      } catch {
        /* the socket is gone; the close listener owns the cleanup */
      }
    }, PING_INTERVAL_MS);
    ping.unref?.();

    /* IncomingMessage emits 'close' as soon as the body is consumed, not only when the
     * client leaves, so the hook aborts on a dead response socket instead of blindly on
     * every close: a normal request keeps its socket open while the stream runs. */
    const onGone = () => {
      if (res.writableEnded) return;
      const socketGone = res.destroyed || res.socket?.destroyed === true;
      if (!socketGone) return;
      controller.abort();
      clearInterval(ping);
    };
    req.on('close', onGone);
    res.on('close', onGone);

    const emit = (event: Record<string, unknown>) => {
      if (res.writableEnded) return;
      try {
        res.write(formatSseEvent(event));
      } catch {
        controller.abort();
      }
    };

    try {
      await this.coach.stream(uid, request, { signal: controller.signal, emit });
    } finally {
      clearInterval(ping);
      req.off('close', onGone);
      res.off('close', onGone);
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
    }
  }
}
