import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface CatalogueRow {
  id: string;
  nameEn: string;
  nameZh: string;
  aliases: string[];
  equipment: string;
  bodyPart: string;
  target: string;
  posture: string;
  embedText: string;
  rerankText: string;
}

type SnapshotEntry = {
  id: string;
  n: string;
  zh?: string;
  a?: string[];
  bp?: string;
  eq?: string;
  tg?: string;
  p?: string;
};

type ExerciseSource = {
  name?: string;
  description?: string;
  instructions?: string[];
  bodyPart?: string;
  equipment?: string;
  target?: string;
  variantOf?: string;
};

const TEMPLATE_VERSION = 'exercise-search-retrieval-docs-v2';
const SNAPSHOT_RELATIVE_PATH = 'api/agent-runtime/tasks/exercise-search-catalogue.json';
const PACKAGED_SNAPSHOT = new URL('../../../agent-runtime/tasks/exercise-search-catalogue.json', import.meta.url);
const GENERIC_STEP = /^(?:repeat (?:for|the desired)\b|return to the starting position[.! ]*$|重复(?:所需|上述)|回到起始位置[。！ ]*$)/i;

const tidy = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

function usefulSteps(steps?: string[]): string[] {
  return (Array.isArray(steps) ? steps : []).map(tidy).filter(step => step && !GENERIC_STEP.test(step)).slice(0, 3);
}

function limitRerankText(text: string): string {
  let budget = 384;
  // Estimate Latin words at most three characters per token and count CJK and punctuation individually.
  for (const match of text.matchAll(/[A-Za-z0-9]+|[^\s]/gu)) {
    budget -= Math.ceil(match[0].length / 3);
    if (budget < 0) return text.slice(0, match.index).trimEnd();
  }
  return text;
}

function readSnapshot(file: string | URL): SnapshotEntry[] {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotEntry[];
}

export function catalogueHash(snapshot = readSnapshot(PACKAGED_SNAPSHOT)): string {
  return crypto.createHash('sha256').update(TEMPLATE_VERSION).update('\0').update(JSON.stringify(snapshot)).digest('hex');
}

export function loadCatalogue(repoRoot: string): { rows: CatalogueRow[]; hash: string } {
  const snapshot = readSnapshot(path.join(repoRoot, SNAPSHOT_RELATIVE_PATH));
  const exerciseDir = path.join(repoRoot, 'catalogue/exercises');
  const translations = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalogue/i18n/zh.json'), 'utf8')) as Record<string, ExerciseSource>;
  const rows: CatalogueRow[] = [];
  for (const item of snapshot) {
    const id = String(item.id);
    const file = path.join(exerciseDir, id + '.json');
    const exercise = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as ExerciseSource : {};
    if (exercise.variantOf) continue;

    const nameEn = tidy(item.n || exercise.name);
    if (!nameEn) throw new Error('Public exercise is missing its name: ' + id);
    const nameZh = tidy(item.zh || translations[id]?.name) || nameEn;
    const aliases = (item.a ?? []).map(tidy).filter(Boolean);
    const equipment = tidy(item.eq || exercise.equipment);
    const bodyPart = tidy(item.bp || exercise.bodyPart);
    const target = tidy(item.tg || exercise.target);
    const posture = tidy(item.p);
    const tags = [bodyPart, equipment, target, posture].filter(Boolean);
    const enSteps = usefulSteps(exercise.instructions);
    const zhSteps = usefulSteps(translations[id]?.instructions);
    const description = tidy(exercise.description);
    const fields = [
      'English: ' + nameEn, 'Chinese: ' + nameZh,
      ...(aliases.length ? ['Aliases: ' + aliases.join(', ')] : []),
      'Attributes: ' + tags.join(', '),
    ];
    const embedText = [...fields, description, ...enSteps, ...zhSteps].filter(Boolean).join('. ');
    const rerankText = limitRerankText([...fields, ...enSteps.slice(0, 2), ...zhSteps.slice(0, 2), description].filter(Boolean).join('. '));
    rows.push({ id, nameEn, nameZh, aliases, equipment, bodyPart, target, posture, embedText, rerankText });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { rows, hash: catalogueHash(snapshot) };
}
