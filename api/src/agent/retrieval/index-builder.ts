import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { loadCatalogue } from './catalogue.js';
import { ensureSchema, insertCatalogueRows } from './database.js';
import { embedTexts } from './models.js';
import type { RetrievalConfig } from './config.js';
import { normalizedEndpoint, retrievalIndexKey } from './config.js';

export async function buildRetrievalIndex(pool: Pool, config: RetrievalConfig, repoRoot: string, rebuild = false) {
  const { rows, hash } = loadCatalogue(repoRoot);
  if (!rows.length || new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error('Public exercise catalogue is empty or contains duplicate IDs');
  }
  await ensureSchema(pool);
  const lockKey = `retrieval-index:${retrievalIndexKey(hash, config)}`;
  const client = await pool.connect();
  const identity = [hash, config.embeddingBackend, normalizedEndpoint(config.embeddingUrl), config.embeddingModel, config.embeddingDim];
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    const existing = await client.query(`SELECT build_id, doc_count FROM retrieval_index_builds
      WHERE catalogue_hash=$1 AND embedding_backend=$2 AND embedding_endpoint=$3 AND embedding_model=$4 AND embedding_dim=$5 AND status='ready'
      ORDER BY activated_at DESC LIMIT 1`, identity);
    const summary = {
      catalogueHash: hash, model: config.embeddingModel, dimension: config.embeddingDim, count: rows.length, status: 'ready',
    };
    if (!rebuild && Number(existing.rows[0]?.doc_count) === rows.length) {
      await cleanupRetired(client, config.indexRetention).catch(() => undefined);
      return { buildId: existing.rows[0].build_id as string, ...summary };
    }

    const buildId = crypto.randomUUID();
    await client.query(`INSERT INTO retrieval_index_builds (build_id,catalogue_hash,embedding_backend,embedding_endpoint,embedding_model,embedding_dim,status,doc_count)
      VALUES ($1,$2,$3,$4,$5,$6,'building',$7)`, [buildId, ...identity, rows.length]);
    await embedTexts(config, [rows[0].embedText]);
    for (let offset = 0; offset < rows.length; offset += 32) {
      const batch = rows.slice(offset, offset + 32);
      const vectors = await embedTexts(config, batch.map(row => row.embedText));
      await client.query('BEGIN');
      try {
        await insertCatalogueRows(client, buildId, batch, vectors);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    const indexed = await client.query(`SELECT exercise_id, vector_dims(embedding) AS embedding_dim
      FROM retrieval_exercise_docs WHERE build_id=$1`, [buildId]);
    const indexedIds = new Set(indexed.rows.map(row => row.exercise_id));
    if (indexed.rowCount !== rows.length || rows.some(row => !indexedIds.has(row.id))
      || indexed.rows.some(row => row.embedding_dim !== config.embeddingDim)) {
      throw new Error('Index exercise IDs or vector dimensions do not match the public catalogue');
    }

    const indexName = vectorIndexName(buildId);
    await client.query(`CREATE INDEX ${indexName} ON retrieval_exercise_docs USING hnsw (embedding vector_cosine_ops) WHERE build_id = '${buildId}'`);
    await client.query('ANALYZE retrieval_exercise_docs');
    await client.query('ANALYZE retrieval_exercise_terms');
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE retrieval_index_builds SET status='retired'
        WHERE catalogue_hash=$1 AND embedding_backend=$2 AND embedding_endpoint=$3 AND embedding_model=$4 AND embedding_dim=$5 AND status='ready'`, identity);
      await client.query(`UPDATE retrieval_index_builds SET status='ready', activated_at=now() WHERE build_id=$1`, [buildId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    await cleanupRetired(client, config.indexRetention).catch(() => undefined);
    return { buildId, ...summary };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
      .then(() => client.release(), error => client.release(error));
  }
}

function vectorIndexName(buildId: string) {
  return `retrieval_hnsw_${buildId.replace(/-/g, '').slice(0, 24)}`;
}

async function cleanupRetired(client: PoolClient, keep: number) {
  const old = await client.query(`SELECT build_id FROM retrieval_index_builds WHERE status='retired'
    ORDER BY activated_at DESC NULLS LAST OFFSET $1`, [keep]);
  for (const { build_id: id } of old.rows) {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [id]);
    if (!result.rows[0]?.locked) continue;
    try {
      await client.query('BEGIN');
      await client.query(`DROP INDEX IF EXISTS ${vectorIndexName(id)}`);
      await client.query('DELETE FROM retrieval_exercise_terms WHERE build_id=$1', [id]);
      await client.query('DELETE FROM retrieval_exercise_docs WHERE build_id=$1', [id]);
      await client.query("DELETE FROM retrieval_index_builds WHERE build_id=$1 AND status='retired'", [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [id]);
    }
  }
}
