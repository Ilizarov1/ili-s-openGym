/**
 * Stages the 180 px animation clips in the Android asset bundle.
 *
 * Stills are small enough to go through Metro's asset registry. The 5,600 MP4
 * clips are not: Metro opens every required asset while bundling and hits the
 * Windows file-handle limit. Android's own asset pipeline packages them without
 * that scan, and expo-video reads them through `asset:///`.
 *
 * Run after `expo prebuild` and before `assembleDebug` / `assembleRelease`:
 *   node scripts/stage-catalogue-media.mjs
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const source = join(root, 'catalogue', 'media', 'clip');
const target = resolve(here, '../android/app/src/main/assets/exercise-media/clip');

if (!statSync(source).isDirectory()) throw new Error(`missing catalogue clips: ${source}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let copied = 0;
let bytes = 0;
for (const name of readdirSync(source)) {
  if (!name.endsWith('.mp4')) continue;
  const from = join(source, name);
  copyFileSync(from, join(target, name));
  copied++;
  bytes += statSync(from).size;
}
console.log(`staged ${copied} clips (${(bytes / 1024 / 1024).toFixed(1)} MB) in ${target}`);
