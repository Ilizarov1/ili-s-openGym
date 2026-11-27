/* Type declarations for the incremental NDJSON node parser.
 *
 * Mirrors ndjson-parser.js exactly; both hosts import the JavaScript module.
 */

export const NDJSON_EVENT_KINDS: Readonly<{
  PROSE_DELTA: 'prose_delta';
  NODE_PENDING: 'node_pending';
  NODE_RAW: 'node_raw';
  LEGACY_PAYLOAD: 'legacy_payload';
  PLAIN_TEXT: 'plain_text';
  MALFORMED_LINE: 'malformed_line';
}>;

export type ProseTone = 'normal' | 'lead' | 'closing';

export interface ProseDeltaEvent {
  kind: 'prose_delta';
  nodeId: string;
  delta: string;
  tone?: ProseTone;
}

export interface NodePendingEvent {
  kind: 'node_pending';
  nodeId: string;
  nodeType: string;
}

export interface NodeRawEvent {
  kind: 'node_raw';
  nodeId: string;
  raw: Record<string, unknown>;
  hadPending: boolean;
  emittedProseChars: number;
}

export interface LegacyPayloadEvent {
  kind: 'legacy_payload';
  raw: Record<string, unknown>;
}

export interface PlainTextEvent {
  kind: 'plain_text';
  text: string;
}

export interface MalformedLineEvent {
  kind: 'malformed_line';
  nodeId: string | null;
  hadPending: boolean;
  rawLine: string;
}

export type ParserEvent =
  | ProseDeltaEvent
  | NodePendingEvent
  | NodeRawEvent
  | LegacyPayloadEvent
  | PlainTextEvent
  | MalformedLineEvent;

export interface NdjsonNodeParser {
  push(chunk: string): ParserEvent[];
  flush(): ParserEvent[];
}

export function createNdjsonNodeParser(): NdjsonNodeParser;
