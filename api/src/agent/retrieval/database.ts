import { Pool, type PoolClient } from 'pg';
import type { RetrievalConfig } from './config.js';
import type { CatalogueRow } from './catalogue.js';

export const POOL_TOKEN = Symbol('RETRIEVAL_POOL');
export const CONFIG_TOKEN = Symbol('RETRIEVAL_CONFIG');
export const FIXTURE_RETRIEVAL_TOKEN = Symbol('FIXTURE_RETRIEVAL');
export const MODEL_CLIENT_TOKEN = Symbol('RETRIEVAL_MODEL_CLIENT');

export function createRetrievalPool(config: RetrievalConfig): Pool {
  return new Pool({ connectionString: config.pgUrl, max: 8, connectionTimeoutMillis: config.pgTimeoutMs, application_name: 'opengym-exercise-retrieval' });
}

export async function ensureSchema(pool: Pick<Pool, 'query'>): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await pool.query(`CREATE TABLE IF NOT EXISTS retrieval_index_builds (
    build_id text PRIMARY KEY, catalogue_hash text NOT NULL, embedding_backend text NOT NULL,
    embedding_endpoint text NOT NULL, embedding_model text NOT NULL, embedding_dim integer NOT NULL CHECK (embedding_dim = 1024),
    status text NOT NULL CHECK (status IN ('building','ready','retired')), doc_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS retrieval_exercise_docs (
    build_id text NOT NULL, exercise_id text NOT NULL, name_en text NOT NULL, name_zh text NOT NULL,
    aliases text[] NOT NULL, equipment text NOT NULL, body_part text NOT NULL, target text NOT NULL,
    posture text NOT NULL, embed_text text NOT NULL, rerank_text text NOT NULL, embedding vector(1024) NOT NULL,
    PRIMARY KEY (build_id, exercise_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS retrieval_exercise_terms (
    build_id text NOT NULL, exercise_id text NOT NULL, term text NOT NULL,
    normalized text NOT NULL, english_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', term)) STORED
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS retrieval_terms_exact_idx ON retrieval_exercise_terms(build_id, normalized)');
  await pool.query('CREATE INDEX IF NOT EXISTS retrieval_terms_trgm_idx ON retrieval_exercise_terms USING gin(normalized gin_trgm_ops)');
  await pool.query('CREATE INDEX IF NOT EXISTS retrieval_terms_english_idx ON retrieval_exercise_terms USING gin(english_vector)');
  await pool.query('CREATE INDEX IF NOT EXISTS retrieval_docs_equipment_idx ON retrieval_exercise_docs(build_id, equipment)');
}

const normalized = (text: string) => text.toLocaleLowerCase('en').normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();

export async function insertCatalogueRows(client: PoolClient, buildId: string, rows: CatalogueRow[], embeddings: number[][]): Promise<void> {
  const docValues: unknown[] = [];
  const termValues: unknown[] = [];
  const docs: string[] = [];
  const termsSql: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const base = docValues.length;
    docValues.push(buildId, row.id, row.nameEn, row.nameZh, row.aliases, row.equipment, row.bodyPart, row.target, row.posture, row.embedText, row.rerankText, `[${embeddings[i].join(',')}]`);
    docs.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12}::vector)`);
    const terms = [...new Set([row.nameEn, row.nameZh, ...row.aliases].map(tidyTerm).filter(Boolean))];
    for (const term of terms) {
      const index = termValues.length;
      termValues.push(buildId, row.id, term, normalized(term));
      termsSql.push(`($${index+1},$${index+2},$${index+3},$${index+4})`);
    }
  }
  if (docs.length) await client.query(`INSERT INTO retrieval_exercise_docs
    (build_id, exercise_id, name_en, name_zh, aliases, equipment, body_part, target, posture, embed_text, rerank_text, embedding) VALUES ${docs.join(',')}`, docValues);
  if (termsSql.length) await client.query(`INSERT INTO retrieval_exercise_terms (build_id, exercise_id, term, normalized) VALUES ${termsSql.join(',')}`, termValues);
}

function tidyTerm(term: string) { return term.replace(/\s+/g, ' ').trim(); }
