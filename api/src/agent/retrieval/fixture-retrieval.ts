import { Injectable } from '@nestjs/common';
import type { RerankDocument, RerankResult } from './models.js';
import catalogue from '../../../agent-runtime/tasks/exercise-search-catalogue.json' with { type: 'json' };

import type { WeightedTerm } from './ranking.js';

type FixtureHit = { exercise_id: string; name_en: string; name_zh: string; aliases: string[]; rerank_text: string; equipment: string; body_part: string; target: string; posture: string; score: number };
const FIXTURE_IDS = ['0091', '1231', '1162'];
const ROWS: FixtureHit[] = FIXTURE_IDS.map((id, index) => {
  const exercise = catalogue.find(row => row.id === id);
  if (!exercise) throw new Error(`Missing fixture exercise ${id} from the public catalogue snapshot`);
  const aliases = Array.isArray(exercise.a) ? exercise.a : [];
  const attributes = [exercise.bp, exercise.eq, exercise.tg, exercise.p].filter(Boolean).join(' ');
  return {
    exercise_id: exercise.id, name_en: exercise.n, name_zh: exercise.zh, aliases,
    rerank_text: [exercise.n, exercise.zh, ...aliases, attributes].join(' '),
    equipment: exercise.eq, body_part: exercise.bp, target: exercise.tg || '', posture: exercise.p || '',
    score: [.94, .82, .64][index],
  };
});

@Injectable()
export class FixtureRetrievalAdapter {
  readonly buildId = 'fixture-exercise-index-v1';
  hasId(id: string) { return ROWS.some(row => row.exercise_id === id); }
  textRecall(terms: ReadonlyArray<string | WeightedTerm>, equipment?: string) {
    const weighted = terms.map(entry => typeof entry === 'string' ? { term: entry, weight: 1 } : entry);
    return this.filtered(equipment).map(row => ({ ...row, score: Math.max(0, ...weighted.map(({ term, weight }) => similarity(term, `${row.name_en} ${row.name_zh} ${row.aliases.join(' ')} ${row.rerank_text}`) * weight)) }))
      .filter(row => row.score > 0).sort((a,b) => b.score-a.score || a.exercise_id.localeCompare(b.exercise_id)).slice(0,75);
  }
  embed(text: string) { return Array.from({ length: 1024 }, (_, i) => ((text.charCodeAt(i % Math.max(1,text.length)) || 1) + i % 11) / 2048); }
  vectorRecall(_vector: number[], equipment?: string) { return this.filtered(equipment).sort((a,b) => b.score-a.score || a.exercise_id.localeCompare(b.exercise_id)).slice(0,75); }
  rerank(documents: RerankDocument[]): RerankResult[] {
    const scores = new Map([['0091',.94],['1231',.82],['0034',.64]]);
    return documents.map((document,index) => ({ index, relevanceScore: scores.get(document.id) ?? .25 }));
  }
  private filtered(equipment?: string) { return ROWS.filter(row => !equipment || row.equipment === equipment).map(row => ({...row})); }
}

function similarity(query: string, text: string) {
  const q = query.toLocaleLowerCase().normalize('NFKC');
  const t = text.toLocaleLowerCase().normalize('NFKC');
  if (q && t.includes(q)) return 1;
  const words = q.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  return words.length ? words.filter(word => t.includes(word)).length / words.length : 0;
}
