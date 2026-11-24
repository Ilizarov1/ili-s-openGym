import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AgentError } from '../../../agent-runtime/errors.js';
import type { ExerciseSearchTrace } from '../../../agent-runtime/exercise-search-diagnostics.js';
import { catalogueHash } from './catalogue.js';
import { asRetrievalError, normalizedEndpoint, retrievalConfigured, type RetrievalConfig } from './config.js';
import { CONFIG_TOKEN, FIXTURE_RETRIEVAL_TOKEN, MODEL_CLIENT_TOKEN, POOL_TOKEN } from './database.js';
import { FixtureRetrievalAdapter } from './fixture-retrieval.js';
import type { RerankDocument, RerankResult } from './models.js';

import {
  buildRerankQuery,
  buildVectorQuery,
  buildWeightedTerms,
  calibrateLevels,
  deriveClarificationChips,
  normText,
  postureLabel,
  postureMatches,
  postureTerms,
  scoreAndRankCandidates,
  shouldRejectToFallback,
  type ClarificationChip,
  type ConfidenceLevel,
  type RetrievalCandidate as Candidate,
  type RetrievalInput,
  type RetrievalRecognition as Recognition,
  type RetrievalRow as Row,
  type ScoredHit as Hit,
  type WeightedTerm,
} from './ranking.js';

type Diagnostic = ExerciseSearchTrace;
type PinnedBuild = { buildId: string; client: PoolClient; readonly released: boolean; release(error?: Error): void };
type SearchItem = { id: string; level?: ConfidenceLevel; rationale?: string };
type RetrievalModelClient = {
  embedText(text: string, signal?: AbortSignal): Promise<number[]>;
  rerank(query: string, documents: RerankDocument[], signal?: AbortSignal): Promise<RerankResult[]>;
};

@Injectable()
export class RetrievalService implements OnModuleDestroy {
  constructor(@Inject(POOL_TOKEN) private readonly pool: Pool, @Inject(CONFIG_TOKEN) private readonly config: RetrievalConfig,
    @Optional() @Inject(FIXTURE_RETRIEVAL_TOKEN) private readonly fixtureAdapter?: FixtureRetrievalAdapter,
    @Optional() @Inject(MODEL_CLIENT_TOKEN) private readonly modelClient?: RetrievalModelClient) {}
  async onModuleDestroy() { await this.pool.end(); }

  async retrieve({ input, recognition, signal, diagnostic, fixture = false }: {
    input: RetrievalInput; recognition: Recognition; signal?: AbortSignal; diagnostic?: Diagnostic; fixture?: boolean;
  }): Promise<{ structured: { rankedIds: string[]; items?: SearchItem[]; fallback: Recognition['fallback']; clarifications?: ClarificationChip[] }; historyMeta: { matches: Array<{id:string;nameEn:string;nameZh:string}> } }> {
    const candidates = (recognition.candidates ?? []).slice(0, 5);
    const hint = typeof input.hintText === 'string' ? input.hintText : '';
    const emptyResult = () => {
      const clarifications = deriveClarificationChips([], recognition, hint);
      return {
        structured: {
          rankedIds: [] as string[],
          fallback: recognition.fallback,
          ...(clarifications.length ? { clarifications } : {}),
        },
        historyMeta: { matches: [] as Array<{ id: string; nameEn: string; nameZh: string }> },
      };
    };
    if (!candidates.length) return emptyResult();
    if (fixture && !this.fixtureAdapter) throw new AgentError('retrieval_unavailable', 'The fixture retrieval adapter is not configured.');
    if (signal?.aborted) throw new AgentError('run_cancelled', 'Exercise retrieval was cancelled.');
    let buildId: string;
    let pin: PinnedBuild | undefined;
    try {
      if (fixture) buildId = this.fixtureAdapter!.buildId;
      else {
        if (!retrievalConfigured()) throw new AgentError('retrieval_unavailable', 'Exercise retrieval is not configured.');
        pin = await this.pinReadyBuild(signal);
        buildId = pin.buildId;
      }
    } catch (error) {
      if (signal?.aborted) throw new AgentError('run_cancelled', 'Exercise retrieval was cancelled.');
      throw asRetrievalError(error, isTimeout(error));
    }

    let embedController: AbortController | undefined;
    let removeEmbedAbort: (() => void) | undefined;
    let embedSettled = false;
    try {
    const weightedTerms = buildWeightedTerms(candidates, hint);
    const vectorQuery = buildVectorQuery({ hint, recognition, confirmedEquipment: input.confirmedEquipment });
    let embedPromise: Promise<number[]> | undefined;
    if (!fixture) {
      embedController = new AbortController();
      const onAbort = () => embedController!.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      removeEmbedAbort = () => signal?.removeEventListener('abort', onAbort);
      try {
        embedPromise = this.modelClient!.embedText(vectorQuery, embedController.signal);
      } catch (error) {
        embedPromise = Promise.reject(error);
      }
      embedPromise.catch(() => undefined);
    }

    const started = Date.now();
    let textHits: Hit[];
    try { textHits = fixture
      ? this.fixtureAdapter!.textRecall(weightedTerms, input.confirmedEquipment)
      : await this.textRecall(buildId, weightedTerms, input.confirmedEquipment, signal, pin!); }
      catch (error) {
        embedController?.abort(error instanceof Error ? error : undefined);
        throw this.fail(error, diagnostic, 'retrieval_text', 'retrieval', signal, Boolean(input.confirmedEquipment));
      }
    this.emit(diagnostic, 'retrieval_text', { backend: fixture ? 'fixture' : 'postgres', elapsedMs: Date.now() - started, candidateCount: textHits.length, top: topOf(textHits, 'score', 75), hasConfirmedEquipment: Boolean(input.confirmedEquipment) });

    const vectorStarted = Date.now();
    let vectorHits: Hit[];
    try {
      const vector = fixture ? this.fixtureAdapter!.embed(vectorQuery) : await embedPromise!;
      embedSettled = true;
      vectorHits = fixture
        ? this.fixtureAdapter!.vectorRecall(vector, input.confirmedEquipment)
        : await this.vectorRecall(buildId, vector, input.confirmedEquipment, signal, pin!);
    } catch (error) {
      embedSettled = true;
      embedController?.abort(error instanceof Error ? error : undefined);
      throw this.fail(error, diagnostic, 'retrieval_vector', 'retrieval', signal, Boolean(input.confirmedEquipment));
    }
    this.emit(diagnostic, 'retrieval_vector', { backend: fixture ? 'fixture' : this.config.embeddingBackend, elapsedMs: Date.now() - vectorStarted, candidateCount: vectorHits.length, top: topOf(vectorHits, 'score', 75), hasConfirmedEquipment: Boolean(input.confirmedEquipment) });

    const fuseStarted = Date.now();
    const merged = fuseRrf(textHits, vectorHits)
      .filter(row => !fixture || this.fixtureAdapter!.hasId(row.exercise_id))
      .slice(0, 30);
    const clueTerms = [...new Set([
      ...candidates.flatMap(c => [c.equipment, c.bodyPart]),
      ...(recognition.fallback.equipment || []), ...(recognition.fallback.bodyParts || []),
      ...postureTerms(hint, candidates),
    ].filter((value): value is string => Boolean(value)).map(normText))];
    for (const row of merged) {
      const fields = normText(`${row.name_en} ${row.name_zh} ${row.equipment} ${row.body_part} ${row.posture}`);
      row.matches = clueTerms.filter(term => fields.includes(term)).length;
    }
    this.emit(diagnostic, 'retrieval_fusion', { elapsedMs: Date.now() - fuseStarted, candidateCount: merged.length, top: topOf(merged, 'rrf', 30), hasConfirmedEquipment: Boolean(input.confirmedEquipment) });
    if (!merged.length) return emptyResult();

    const rerankTopK = Math.max(10, Math.min(30, this.config.rerankTopK ?? 30));
    const rerankPool = merged.slice(0, rerankTopK);
    const rerankQuery = buildRerankQuery({ hint, recognition, confirmedEquipment: input.confirmedEquipment });
    const docs: RerankDocument[] = rerankPool.map(row => ({ id: row.exercise_id, text: row.rerank_text }));
    const rerankStarted = Date.now();
    let ranks: RerankResult[];
    try {
      ranks = fixture ? this.fixtureAdapter!.rerank(docs) : await this.modelClient!.rerank(rerankQuery, docs, signal);
      if (docs.length && !ranks.length) throw new AgentError('retrieval_unavailable', 'Reranker returned no valid result indices.', { details: { phase: 'rerank' } });
    }
    catch (error) { throw this.fail(error, diagnostic, 'rerank', 'rerank', signal, Boolean(input.confirmedEquipment)); }
    const ranked = scoreAndRankCandidates({ merged: rerankPool, rerankResults: ranks, recognition, input });
    if (!ranked.length) return emptyResult();
    this.emit(diagnostic, 'rerank', { backend: fixture ? 'fixture' : this.config.rerankBackend, elapsedMs: Date.now()-rerankStarted, candidateCount: ranked.length,
      top: ranked.map(item => ({ id: item.row.exercise_id, score: item.rawScore })), hasConfirmedEquipment: Boolean(input.confirmedEquipment) });
    if (shouldRejectToFallback(ranked, recognition, hint)) return emptyResult();
    const calibrated = calibrateLevels(ranked, recognition, hint);
    const clarifications = deriveClarificationChips(calibrated, recognition, hint);
    const rankedIds = calibrated.map(item => item.row.exercise_id);
    const items: SearchItem[] = calibrated.map(item => {
      const rationale = verifiedRationale(item.row, input, recognition, hint, candidates);
      return { id: item.row.exercise_id, ...(item.level ? { level: item.level } : {}), ...(rationale ? { rationale } : {}) };
    });
    return {
      structured: {
        rankedIds,
        items,
        fallback: recognition.fallback,
        ...(clarifications.length ? { clarifications } : {}),
      },
      historyMeta: { matches: calibrated.map(({ row }) => ({ id: row.exercise_id, nameEn: row.name_en, nameZh: row.name_zh })) },
    };
    } finally {
      if (!embedSettled) embedController?.abort();
      removeEmbedAbort?.();
      if (pin) await this.releasePinnedBuild(pin);
    }
  }

  private async pinReadyBuild(signal?: AbortSignal): Promise<PinnedBuild> {
    const hash = this.config.catalogueHash === 'runtime' ? runtimeHash() : this.config.catalogueHash;
    const client = await this.pool.connect();
    if (signal?.aborted) {
      client.release(new Error('retrieval query cancelled'));
      throw signal.reason ?? new DOMException('Aborted','AbortError');
    }
    const pin = createPinnedBuild(client, signal);
    try {
      while (!signal?.aborted) {
        await client.query('BEGIN READ ONLY');
        await client.query("SELECT set_config('statement_timeout',$1,true)", [`${this.config.pgTimeoutMs}ms`]);
        const selected = await client.query(`SELECT build_id FROM retrieval_index_builds
          WHERE catalogue_hash=$1 AND embedding_backend=$2 AND embedding_endpoint=$3 AND embedding_model=$4 AND embedding_dim=$5 AND status='ready'
          ORDER BY activated_at DESC LIMIT 1`, [hash, this.config.embeddingBackend, normalizedEndpoint(this.config.embeddingUrl), this.config.embeddingModel, this.config.embeddingDim]);
        const id = selected.rows[0]?.build_id as string | undefined;
        if (!id) {
          await client.query('COMMIT');
          pin.release();
          throw new AgentError('retrieval_index_not_ready', 'The exercise search index is not ready.');
        }
        await client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [id]);
        const stillReady = await client.query("SELECT 1 FROM retrieval_index_builds WHERE build_id=$1 AND status='ready'", [id]);
        if (stillReady.rowCount) {
          await client.query('COMMIT');
          pin.buildId = id;
          return pin;
        }
        await client.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [id]);
        await client.query('COMMIT');
      }
      throw signal?.reason ?? new DOMException('Aborted','AbortError');
    } catch (error) {
      if (!pin.released) pin.release(error instanceof AgentError ? undefined : error instanceof Error ? error : new Error('Retrieval index query failed'));
      throw error;
    }
  }

  private async releasePinnedBuild(pin: PinnedBuild) {
    if (pin.released) return;
    try {
      await pin.client.query('BEGIN READ ONLY');
      await pin.client.query("SELECT set_config('statement_timeout',$1,true)", [`${this.config.pgTimeoutMs}ms`]);
      await pin.client.query('SELECT pg_advisory_unlock_shared(hashtext($1))', [pin.buildId]);
      await pin.client.query('COMMIT');
      pin.release();
    } catch (error) {
      pin.release(error instanceof Error ? error : new Error('Unable to release pinned retrieval build'));
    }
  }

  private textRecall(buildId: string, terms: WeightedTerm[], equipment: string | undefined, signal: AbortSignal | undefined, pin: PinnedBuild): Promise<Hit[]> {
    return this.withReadClient(signal, pin, async client => {
      if (!terms.length) return [];
      const normTerms = terms.map(({ term }) => normText(term));
      const shortCjkFlags = terms.map(({ term }) => /[\u3400-\u9fff]/u.test(term) && [...term].length <= 8);
      const likePatterns = terms.map(({ term }) => `%${escapeLike(term)}%`);
      const weights = terms.map(({ weight }) => weight);
      const result = await client.query(`WITH q AS MATERIALIZED (
        SELECT * FROM UNNEST($2::text[], $3::boolean[], $4::text[], $5::double precision[])
          AS u(term, short_cjk, like_pattern, weight)
      ),
      hits AS (
        SELECT t.build_id, t.exercise_id,
          greatest(
            CASE WHEN t.normalized = q.term THEN 1.0 ELSE 0 END,
            CASE WHEN q.short_cjk AND t.term ILIKE q.like_pattern THEN 0.88 ELSE 0 END,
            word_similarity(q.term, t.normalized),
            similarity(q.term, t.normalized),
            ts_rank(t.english_vector, plainto_tsquery('english', q.term))
          ) * q.weight AS score
        FROM q
        CROSS JOIN LATERAL (
          SELECT t.build_id, t.exercise_id, t.term, t.normalized, t.english_vector
          FROM retrieval_exercise_terms t
          WHERE t.build_id = $1 AND t.normalized = q.term
          UNION
          SELECT t.build_id, t.exercise_id, t.term, t.normalized, t.english_vector
          FROM retrieval_exercise_terms t
          WHERE t.build_id = $1 AND t.normalized % q.term
          UNION
          SELECT t.build_id, t.exercise_id, t.term, t.normalized, t.english_vector
          FROM retrieval_exercise_terms t
          WHERE t.build_id = $1 AND t.english_vector @@ plainto_tsquery('english', q.term)
        ) t
        UNION ALL
        SELECT t.build_id, t.exercise_id,
          greatest(
            CASE WHEN t.normalized = q.term THEN 1.0 ELSE 0 END,
            0.88,
            word_similarity(q.term, t.normalized),
            similarity(q.term, t.normalized),
            ts_rank(t.english_vector, plainto_tsquery('english', q.term))
          ) * q.weight AS score
        FROM retrieval_exercise_terms t
        JOIN q ON q.short_cjk AND t.term ILIKE q.like_pattern
        WHERE t.build_id = $1 AND EXISTS (SELECT 1 FROM q WHERE q.short_cjk)
      ),
      agg AS (
        SELECT build_id, exercise_id, max(score) AS score
        FROM hits
        GROUP BY build_id, exercise_id
      )
      SELECT d.exercise_id, d.name_en, d.name_zh, d.aliases, d.rerank_text,
             d.equipment, d.body_part, d.target, d.posture, agg.score
      FROM agg
      JOIN retrieval_exercise_docs d USING (build_id, exercise_id)
      WHERE d.build_id = $1 AND ($6::text IS NULL OR d.equipment = $6)
      ORDER BY agg.score DESC, d.exercise_id
      LIMIT 75`, [buildId, normTerms, shortCjkFlags, likePatterns, weights, equipment ?? null]);
      return (result.rows as Hit[]).map(row => ({ ...row, aliases: Array.isArray(row.aliases) ? row.aliases : [], score: Number(row.score) }));
    });
  }

  private vectorRecall(buildId: string, vector: number[], equipment: string | undefined, signal: AbortSignal | undefined, pin: PinnedBuild): Promise<Hit[]> {
    return this.withReadClient(signal, pin, async client => {
      const result = await client.query(`WITH nearest AS MATERIALIZED (
        SELECT exercise_id,name_en,name_zh,aliases,rerank_text,equipment,body_part,target,posture,
          embedding <=> $2::vector AS distance
        FROM retrieval_exercise_docs WHERE build_id=$1 AND ($3::text IS NULL OR equipment=$3)
        ORDER BY embedding <=> $2::vector LIMIT 75
      )
      SELECT exercise_id,name_en,name_zh,aliases,rerank_text,equipment,body_part,target,posture,1-distance AS score
      FROM nearest ORDER BY distance + 0`, [buildId, `[${vector.join(',')}]`, equipment ?? null]);
      return (result.rows as Hit[]).map(row => ({ ...row, aliases: Array.isArray(row.aliases) ? row.aliases : [] }));
    }, Boolean(equipment), true);
  }

  private async withReadClient<T>(signal: AbortSignal | undefined, pin: PinnedBuild, callback: (client: PoolClient) => Promise<T>, equipment = false, vectorSearch = false): Promise<T> {
    const client = pin.client;
    if (signal?.aborted || pin.released) {
      pin.release(new Error('retrieval query cancelled'));
      throw signal?.reason ?? new DOMException('Aborted','AbortError');
    }
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SELECT set_config('statement_timeout',$1,true)", [`${this.config.pgTimeoutMs}ms`]);
      if (vectorSearch) {
        await client.query("SELECT set_config('hnsw.ef_search','100',true)");
        // Windows staging chose Seq Scan + Sort for a real bound vector on the full 5,632-row batch.
        // Discourage that inner explicit sort so HNSW is selected when eligible; the outer relaxed-order re-sort remains necessary.
        await client.query("SELECT set_config('enable_sort','off',true)");
      }
      if (equipment) await client.query("SET LOCAL hnsw.iterative_scan = 'relaxed_order'");
      if (signal?.aborted || pin.released) throw signal?.reason ?? new DOMException('Aborted','AbortError');
      const value = await callback(client);
      if (signal?.aborted || pin.released) throw signal?.reason ?? new DOMException('Aborted','AbortError');
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (!signal?.aborted && !pin.released && isTimeout(error)) {
        pin.release(error instanceof Error ? error : new Error('retrieval query timed out'));
      } else if (!signal?.aborted && !pin.released) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private fail(error: unknown, diagnostic: Diagnostic | undefined, stage: string, phase: 'retrieval' | 'rerank', signal?: AbortSignal, hasConfirmedEquipment = false) {
    if (signal?.aborted || error instanceof Error && error.name === 'AbortError') return new AgentError('run_cancelled', 'Exercise retrieval was cancelled.');
    const mapped = asRetrievalError(error, isTimeout(error), phase);
    this.emit(diagnostic, stage, { errorCode: mapped.code, elapsedMs: 0, candidateCount: 0, hasConfirmedEquipment });
    return mapped;
  }
  private emit(diagnostic: Diagnostic | undefined, stage: string, fields: Record<string, unknown>) { try { diagnostic?.({ stage, ...fields } as Parameters<Diagnostic>[0]); } catch { /* diagnostics are best effort */ } }
}

function runtimeHash() {
  try { return catalogueHash(); }
  catch { throw new AgentError('retrieval_index_not_ready', 'The exercise search index is not ready.'); }
}
function escapeLike(value: string) { return value.replace(/[\\%_]/g, '\\$&'); }
function verifiedRationale(row: Row, input: RetrievalInput, recognition: Recognition, hint: string, candidates: Candidate[]) {
  const equipmentClues = [input.confirmedEquipment, ...candidates.map(c => c.equipment), ...(recognition.fallback.equipment || [])].filter(Boolean).map(x => normText(x!));
  const bodyPartClues = [...candidates.map(c => c.bodyPart), ...(recognition.fallback.bodyParts || [])].filter(Boolean).map(x => normText(x!));
  const positions = postureTerms(hint, candidates);
  const labels: string[] = [];
  if (equipmentClues.includes(normText(row.equipment))) labels.push('器械与识别条件一致');
  if (bodyPartClues.includes(normText(row.body_part))) labels.push('部位与识别条件一致');
  if (postureMatches(row.posture, positions)) labels.push(`姿势${postureLabel(row.posture)}与识别条件一致`);
  return labels.length ? labels.join(' · ') : undefined;
}
function topOf(rows: Hit[], score: 'score' | 'rrf' = 'score', limit = 5) {
  return rows.slice(0, limit).map(row => ({ id: row.exercise_id, score: row[score] }));
}
function fuseRrf(text: Hit[], vector: Hit[]): Hit[] {
  const byId = new Map<string, Hit>();
  const add = (row: Hit, rank: number) => {
    const hit = byId.get(row.exercise_id) ?? { ...row, rrf: 0, matches: 0 };
    hit.rrf = (hit.rrf || 0) + 1 / (60 + rank + 1);
    hit.matches = (hit.matches || 0) + 1;
    byId.set(row.exercise_id,hit);
  };
  text.forEach((row,i) => add(row,i)); vector.forEach((row,i) => add(row,i));
  return [...byId.values()].sort((a,b) => b.rrf!-a.rrf! || (b.matches||0)-(a.matches||0) || a.exercise_id.localeCompare(b.exercise_id));
}
function isTimeout(error: unknown) { return error instanceof Error && (error.name === 'TimeoutError' || /timeout|statement timeout/i.test(error.message) || (error as NodeJS.ErrnoException).code === '57014'); }

function createPinnedBuild(client: PoolClient, signal?: AbortSignal): PinnedBuild {
  let buildId = '';
  let released = false;
  const pin: PinnedBuild = {
    get buildId() { return buildId; },
    set buildId(value: string) { buildId = value; },
    client,
    get released() { return released; },
    release(error?: Error) {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', abort);
      client.release(error);
    },
  };
  const abort = () => pin.release(new Error('retrieval query cancelled'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return pin;
}
