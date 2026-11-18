#!/usr/bin/env node
/**
 * Fills the missing Chinese `instructions` in catalogue/i18n/zh.json.
 *
 * The English catalogue has more exercises than the Chinese locale: every entry already has a
 * Chinese name, but only a subset has translated steps. This script translates the remaining
 * English steps with the public Google Translate endpoint, reuses the existing English/Chinese
 * pairs as a translation memory, de-duplicates identical sentences, and caches every result so an
 * interrupted run can continue.
 *
 * Run from the repository root:
 *   node scripts/translate-zh-instructions.mjs
 *   node scripts/translate-zh-instructions.mjs --assemble-only
 *
 * The endpoint is reached through HTTPS_PROXY/HTTP_PROXY (Node 22+: NODE_USE_ENV_PROXY=1).
 * The cache lives in .tmp/ and is intentionally not committed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const exercisesDir = join(root, 'catalogue', 'exercises');
const zhPath = join(root, 'catalogue', 'i18n', 'zh.json');
const cachePath = join(root, '.tmp', 'zh-translation-cache.json');

const args = new Set(process.argv.slice(2));
const assembleOnly = args.has('--assemble-only');
const limitArg = [...args].find(arg => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const batchSize = 20;
const requestDelayMs = 500;
const maxAttempts = 8;

const CJK = /[\u3400-\u9fff]/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  // Windows occasionally reports EPERM/EBUSY while a reader or the indexer holds the target.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 11) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        // Last resort: copying keeps the data, even though the swap is not atomic.
        copyFileSync(tmp, file);
        unlinkSync(tmp);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function loadCache() {
  if (!existsSync(cachePath)) return { translations: {}, targets: [] };
  try {
    const parsed = readJson(cachePath);
    const source = parsed?.translations ?? parsed;
    const translations = {};
    for (const [english, chinese] of Object.entries(source)) {
      if (typeof chinese === 'string' && isValidTranslation(english, chinese)) translations[english] = chinese;
    }
    const targets = Array.isArray(parsed?.targets) ? parsed.targets.filter(id => typeof id === 'string') : [];
    return { translations, targets };
  } catch (error) {
    console.warn(`cache unreadable, starting fresh: ${error.message}`);
    return { translations: {}, targets: [] };
  }
}

function saveCache(cache, targets) {
  writeJsonAtomic(cachePath, {
    version: 2,
    updatedAt: new Date().toISOString(),
    targets: [...targets],
    translations: cache,
  });
}

function isValidTranslation(english, chinese) {
  if (typeof chinese !== 'string') return false;
  const text = chinese.trim();
  if (!text || !CJK.test(text)) return false;
  // A response that is still mostly Latin text means the endpoint echoed the source.
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return cjk >= 2 && latin < cjk * 3;
}

const text = value => (typeof value === 'string' ? value.trim() : '');

/** Existing translated entries double as a translation memory, so shared steps stay consistent. */
function buildTranslationMemory(englishById, zh) {
  const memory = new Map();
  let pairs = 0;
  for (const [id, translated] of Object.entries(zh)) {
    const source = englishById.get(id);
    if (!source || !Array.isArray(source.instructions) || !source.instructions.length) continue;
    if (!Array.isArray(translated?.instructions) || translated.instructions.length !== source.instructions.length) continue;
    source.instructions.forEach((english, index) => {
      const key = text(english);
      const chinese = text(translated.instructions[index]);
      if (!key || !chinese || memory.has(key)) return;
      memory.set(key, chinese);
      pairs++;
    });
  }
  return { memory, pairs };
}

function collectMissing(englishById, zh) {
  const missing = [];
  const sentences = new Set();
  let missingSteps = 0;
  let doneExercises = 0;
  let doneSteps = 0;
  for (const [id, exercise] of englishById) {
    if (!Array.isArray(exercise.instructions) || !exercise.instructions.length) continue;
    const translated = zh[id];
    if (!translated) throw new Error(`zh.json has no name for ${id}`);
    if (Array.isArray(translated.instructions) && translated.instructions.length) {
      doneExercises++;
      doneSteps += exercise.instructions.length;
      continue;
    }
    missing.push(exercise);
    for (const instruction of exercise.instructions) {
      const key = text(instruction);
      if (!key) throw new Error(`${id} has an empty English instruction`);
      sentences.add(key);
      missingSteps++;
    }
  }
  return { missing, sentences, missingSteps, doneExercises, doneSteps };
}

function normalizeResponse(payload, expected) {
  if (!Array.isArray(payload)) throw new Error('translation response is not an array');
  let items = payload;
  if (items.length && Array.isArray(items[0])) items = items.map(item => (Array.isArray(item) ? item[0] : item));
  if (items.length !== expected) throw new Error(`expected ${expected} translations, got ${items.length}`);
  return items.map(item => (typeof item === 'string' ? item : ''));
}

async function requestBatch(batch) {
  const query = new URLSearchParams();
  query.set('client', 'gtx');
  query.set('sl', 'en');
  query.set('tl', 'zh-CN');
  for (const sentence of batch) query.append('q', sentence);
  const response = await fetch(`https://translate.googleapis.com/translate_a/t?${query}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) openGym catalogue translation',
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (response.status === 429) {
    const error = new Error('HTTP 429 rate limited');
    error.status = 429;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return normalizeResponse(await response.json(), batch.length);
}

async function translateSentence(sentence) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const [translation] = await requestBatch([sentence]);
      if (!isValidTranslation(sentence, translation)) throw new Error(`invalid translation: ${JSON.stringify(translation)}`);
      return translation.trim();
    } catch (error) {
      lastError = error;
      if (error.status === 429) await sleep(60_000 * attempt);
      else await sleep(Math.min(30_000, 500 * 2 ** attempt) + Math.random() * 300);
    }
  }
  throw lastError;
}

async function translateBatch(batch) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const translations = await requestBatch(batch);
      if (translations.some((translation, index) => !isValidTranslation(batch[index], translation))) {
        throw new Error('batch contained an empty or untranslated step');
      }
      return translations.map(translation => translation.trim());
    } catch (error) {
      lastError = error;
      if (error.status === 429) {
        console.warn(`  429 rate limited, backing off (attempt ${attempt}/${maxAttempts})`);
        await sleep(60_000 * attempt);
      } else {
        console.warn(`  request failed: ${error.message} (attempt ${attempt}/${maxAttempts})`);
        await sleep(Math.min(30_000, 750 * 2 ** attempt) + Math.random() * 400);
      }
    }
  }
  throw lastError;
}

/**
 * Google Translate is literal about gym vocabulary: "plate" becomes 盘子, "hamstrings" 腿筋,
 * "good morning" a greeting, and "jerk" an insult. Fix the recurring mistakes after translation.
 * Only Chinese output is rewritten; numbers, units and exercise names are left alone.
 */
const REPLACEMENTS = [
  // Equipment and places.
  [/导轨/g, '栏杆'],
  [/铃声/g, '壶铃'],
  [/铃铛/g, '壶铃'],
  [/啤酒花/g, '跳跃'],
  [/史密斯杠/g, '史密斯机杠铃'],
  [/史密斯吧台/g, '史密斯机杠铃'],
  [/吧台/g, '杠铃杆'],
  [/高滑轮/g, '高位滑轮'],
  [/向后降低/g, '向后下放'],
  [/将其打开/g, '出架'],
  [/酒吧/g, '杠铃杆'],
  [/电缆机/g, '绳索器械'],
  [/缆绳机/g, '绳索器械'],
  [/电缆/g, '绳索'],
  [/缆绳/g, '绳索'],
  [/有线电视/g, '绳索'],
  [/马车/g, '雪橇'],
  [/地雷棒/g, '地雷架杠铃'],
  [/地雷端/g, '地雷架末端'],
  [/地雷装置/g, '地雷架'],
  [/地雷(?!架)/g, '地雷架'],
  [/盘子/g, '杠铃片'],
  [/配重板/g, '杠铃片'],
  [/配重片/g, '杠铃片'],
  [/陷阱栏/g, '六角杠铃'],
  [/陷阱杆/g, '六角杠铃'],
  [/EZ\s*栏/g, 'EZ 杆'],
  [/T\s*形杆/g, 'T 杆'],
  [/牧师弯举/g, '牧师凳弯举'],
  [/牧师垫/g, '牧师凳垫'],
  [/机器垫/g, '器械垫'],
  [/机器/g, '器械'],
  [/健身球/g, '药球'],
  [/(?<!泡沫)滚轮/g, '健腹轮'],
  [/长矛/g, '折体'],
  [/博苏球/g, 'BOSU 球'],
  [/博苏/g, 'BOSU 球'],
  [/战斗绳/g, '战绳'],
  [/锤子/g, '锤铃'],
  [/地雷附件/g, '地雷架'],
  [/长椅/g, '长凳'],
  [/工作台/g, '卧推凳'],
  [/圆锥体/g, '标志锥'],
  [/阻力带/g, '弹力带'],
  [/带子/g, '弹力带'],
  [/乐队/g, '弹力带'],
  [/光线阻力/g, '轻阻力'],
  [/抵抗光线/g, '提供轻微阻力'],
  [/颅骨底部/g, '后脑勺'],
  [/头骨底部/g, '后脑勺'],
  [/木片/g, '伐木'],
  [/娘娘腔/g, '西斯'],
  [/尺蠖/g, '毛毛虫'],
  [/抢夺握法/g, '抓举握法'],
  [/抢夺/g, '抓举'],
  [/(\d+)\s*套/g, '$1 组'],
  [/([两三四五六七八九十])\s*套/g, '$1 组'],

  // Grip and body cues.
  [/支撑你的核心/g, '收紧核心'],
  [/支撑你的腹肌/g, '收紧腹肌'],
  [/支撑核心/g, '收紧核心'],
  [/支撑腹肌/g, '收紧腹肌'],
  [/收紧臀肌并收紧腹肌/g, '收紧臀肌和腹肌'],
  [/保持核心紧张/g, '保持核心收紧'],
  [/核心紧张/g, '核心收紧'],
  [/臀部铰接/g, '以髋为轴俯身'],
  [/铰接臀部/g, '以髋为轴俯身'],
  [/臀部铰链/g, '髋铰链'],
  [/铰接/g, '屈髋'],
  [/以臀部为铰链/g, '以髋为轴屈髋'],
  [/铰链位于臀部/g, '以髋为轴屈髋'],
  [/弯曲臀部和膝盖/g, '屈髋屈膝'],
  [/降低身体高度/g, '下放身体'],
  [/杠铃间距/g, '握距'],
  [/双手分开比肩宽/g, '双手间距比肩宽'],
  [/双手分开略宽于肩宽/g, '双手间距略宽于肩宽'],
  [/双手分开的距离略大于肩宽/g, '双手间距略宽于肩宽'],
  [/用窄握法/g, '以窄握'],
  [/中立握把/g, '对握'],
  [/中立握法/g, '对握'],
  [/中性握法/g, '对握'],
  [/正手握法/g, '正握'],
  [/正手握/g, '正握'],
  [/正握住/g, '正握'],
  [/反手握法/g, '反握'],
  [/反手握/g, '反握'],
  [/反握住/g, '反握'],
  [/下手握法/g, '反握'],
  [/上手握法/g, '正握'],
  [/腿筋/g, '腘绳肌'],
  [/陷阱/g, '斜方肌'],
  [/(?<!肱)二头肌/g, '肱二头肌'],
  [/(?<!肱)三头肌/g, '肱三头肌'],
  [/观察者/g, '保护者'],
  [/发现者/g, '保护者'],
  [/三角肌后飞鸟/g, '三角肌后束飞鸟'],
  [/后三角肌/g, '三角肌后束'],
  [/侧板(?!支撑)/g, '侧平板支撑'],
  [/死虫子(?!式)/g, '死虫式'],
  [/鸟狗(?!式)/g, '鸟狗式'],
  [/登山者(?!跑)/g, '登山跑'],
  [/背部平坦/g, '背部平直'],
  [/躯干直立/g, '躯干保持直立'],
  [/臀部推力/g, '臀推'],
  [/小腿抬高/g, '提踵'],
  [/脚趾抬高/g, '抬脚尖'],
  [/腿部伸展/g, '腿屈伸'],
  [/腿部卷曲/g, '腿弯举'],
  [/腿部推举/g, '腿举'],
  [/手腕弯举/g, '腕弯举'],
  [/反向手腕弯举/g, '反向腕弯举'],
  [/弓箭步/g, '弓步'],
  [/高高地坐/g, '坐直'],
  [/转动上背部/g, '弓起上背部'],
  [/制造紧张感/g, '制造张力'],
  [/产生紧张感/g, '产生张力'],
  [/有拉力/g, '有拉伸感'],
  [/拉力时/g, '拉伸感时'],
  [/轻微的拉力/g, '轻微的拉伸感'],
  [/拉力而不是疼痛/g, '拉伸感而不是疼痛'],
  [/拉力(?!器|带|绳)/g, '拉伸感'],
  [/泵重复/g, '重复'],
  [/继续泵/g, '继续做'],
  [/重复重复/g, '重复'],
  [/高高地站在/g, '站直'],
  [/高高地放/g, '放在高处'],
  [/泵奶/g, '摆动'],
  [/返回脚/g, '收回脚'],
  [/用脚掌起身/g, '踮起脚尖'],
  [/保持在脚掌上/g, '保持前脚掌着地'],
  [/用脚掌着地/g, '用前脚掌着地'],
  [/收紧臀部/g, '收紧臀肌'],
  [/脚趾轻柔/g, '脚步轻盈'],
  [/(?<!前)脚掌放在/g, '前脚掌放在'],
  [/挤压臀部/g, '收紧臀肌'],
  [/挤压臀肌/g, '收紧臀肌'],
  [/膝盖柔软/g, '膝盖微屈'],
  [/膝盖跟随脚趾/g, '膝盖与脚尖方向一致'],
  [/以肘部引导/g, '以肘部带动'],
  [/摇动手臂/g, '摆动手臂'],
  [/重置平衡/g, '恢复平衡'],
  [/守卫位置/g, '防守姿势'],
  [/正常的跳跃/g, '普通跳跃'],
  [/高平板支撑/g, '高位平板支撑'],
  [/木板支撑/g, '平板支撑'],
  [/回到木板/g, '回到平板支撑'],
  [/压到木板上/g, '推回平板支撑'],
  [/用木板支撑/g, '保持平板支撑'],
  [/向下倾斜并向上推/g, '向下屈臂并向上推'],
  [/降低胸部/g, '下放胸部'],
  [/向前转动/g, '屈髋前俯'],
  [/身体向前弯曲/g, '屈髋前俯'],
  [/有控制地降低/g, '有控制地下放'],
  [/稍等一下/g, '保持片刻'],
  [/轻载/g, '较轻的重量'],
  [/挤压板/g, '挤压杠铃片'],
  [/推起压/g, '推起'],
  [/干净、平坦/g, '空旷、平坦'],
  [/回头看看肩膀/g, '回头看一眼'],
  [/小心地走开/g, '小心走下器械'],
  [/保持体重在脚上保持平衡/g, '让体重均匀分布在双脚上'],
  [/在重复次数后换边/g, '完成次数后换边'],
  [/仅达到舒适的程度/g, '只伸展到舒适的范围'],
  [/控制移动/g, '有控制地移动'],
  [/缓慢下降/g, '缓慢下放'],
  [/挤压背阔肌/g, '收紧背阔肌'],
  [/工作臂/g, '发力臂'],
  [/在控制下降低自己/g, '有控制地下放身体'],
  [/舒适的背包/g, '贴身的背包'],
  [/体形受到影响/g, '动作变形'],
  [/减少负荷/g, '减轻负重'],
  [/脚掌保持轻柔/g, '前脚掌保持轻盈'],
  [/推起下手柄/g, '推手柄'],
  [/缓慢降低/g, '缓慢下放'],
  [/松开架子/g, '出架'],
  [/捏在一起/g, '收紧'],
  [/你肩胛骨/g, '肩胛骨'],
  [/你脸部/g, '面部'],
  [/较轻的重量缓慢地进行举升/g, '用较轻的重量缓慢举升'],
  [/拍摄一组照片/g, '拍摄一组动作'],
  [/向另一只手降低/g, '向下放向另一只手'],
  [/敲击手/g, '碰手'],
  [/低缆/g, '低位绳索'],
  [/背靠低绳索/g, '背对低位绳索'],
  [/根据你身体状况/g, '根据自身体能'],
  [/将轭放回/g, '将轭架放回'],
  [/将臀部向后倾斜/g, '臀部后坐'],
  [/向前推动臀部/g, '髋部向前发力'],
  [/复位到铰链/g, '回到屈髋姿势'],
  [/圆锥线/g, '标志锥线'],
  [/锥体/g, '标志锥'],
  [/控制下下降/g, '有控制地下放'],
  [/在下一次保持之前/g, '下一次保持前'],
  [/朝方向卷起/g, '向上卷起'],
  [/挤压顶部/g, '在顶部收紧'],
  [/次平稳重复/g, '次'],
  [/一个轻的重量/g, '较轻的重量'],
  [/控制降低/g, '有控制地下放'],
  [/面朝上躺下/g, '仰卧'],
  [/返回中间/g, '回到中间'],
  [/动作小且受控制/g, '动作幅度小且有控制'],
  [/将手臂放回原处/g, '将手臂举回原位'],
  [/握住锚/g, '握住固定点'],
  [/锚点/g, '固定点'],
  [/踏上木板/g, '进入平板支撑'],
  [/放回木板上/g, '回到平板支撑'],
  [/高木板/g, '高位平板支撑'],
  [/进入木板/g, '进入平板支撑'],
  [/木板位置/g, '平板支撑姿势'],
  [/高处的木板/g, '高位平板支撑'],
  [/木板线/g, '直线'],
  [/踩回木板上/g, '迈回平板支撑'],
  [/踢回木板上/g, '踢入平板支撑'],
  [/伸入木板上/g, '伸入平板支撑'],
  [/趴在木板上/g, '进入平板支撑'],
  [/向地板降低/g, '向地板下放'],
  [/降低俯卧撑姿势/g, '下放进入俯卧撑'],
  [/向后按压弹力带/g, '对抗弹力带向上推起'],
  [/挤压臀肌和腹肌/g, '收紧臀肌和腹肌'],
  [/下降到地板/g, '下放到地板'],
  [/重复该组的顺序/g, '按顺序重复该组'],
  [/将一只脚向前迈出手/g, '将一只脚向前迈到手的旁边'],
  [/降低臀部，进行弓步伸展/g, '臀部下沉，进入弓步拉伸'],
  [/每次重复交替弓步腿/g, '每次重复时交替弓步腿'],
  [/退一步进入弓步/g, '向后一步回到弓步'],
  [/降低杆/g, '下放杠铃杆'],
  [/你体重/g, '身体重量'],
  [/保持核心支撑/g, '保持核心收紧'],
  [/肘部柔软/g, '肘部微屈'],
  [/受控的/g, '有控制的'],
  [/降低并以/g, '下放并以'],
  [/的间隔进行工作/g, '为一组进行'],
  [/进行舒适的深蹲/g, '下蹲到舒适深度'],
  [/置于控制之下/g, '有控制地'],
  [/次轻松重复/g, '次'],
  [/向后压，直到/g, '向上推起，直到'],
  [/观察器/g, '保护者'],
  [/卷向肩膀/g, '弯举向肩膀'],
  [/挤压肱二头肌/g, '收紧肱二头肌'],
  [/向额头弯曲/g, '弯举向额头'],
  [/保持肘部高/g, '保持肘部抬高'],
  [/降低成弓步/g, '下蹲成弓步'],
  [/压住前脚站立/g, '前脚蹬地站起'],
  [/降低直到/g, '下放直到'],
  [/通过腿向上行驶/g, '双腿发力向上'],
  [/坐回下一个深蹲/g, '回到下一次深蹲'],
  [/用一个动作/g, '一口气'],
  [/将球向前推进/g, '将球向前送'],
  [/把脚跳得更宽/g, '双脚向外跳宽'],
  [/将它们跳回一起/g, '再跳回并拢'],
  [/执行计划/g, '完成计划'],
  [/降低手腕/g, '下放手腕'],
  [/伸展运动/g, '拉伸'],
  [/挤压小腿/g, '收紧小腿'],
  [/脚的顶部/g, '脚背'],
  [/卷曲在下面/g, '向下卷曲'],
  [/小腿和脚踝前部/g, '小腿前侧和脚踝'],
  [/前脚跟/g, '前脚脚跟'],
  [/轻的重物/g, '较轻的重量'],
  [/加深转弯/g, '加大转动幅度'],
  [/坐或站得高/g, '坐直或站直'],
  [/跪高/g, '跪直'],
  [/下巴斜向胸部下降/g, '下巴斜向胸部内收'],
  [/将下巴向后拉直/g, '下巴向后收'],
  [/尽可能舒适/g, '在舒适范围内'],
  [/缓慢释放/g, '缓慢松开'],
  [/如果拉伸是一侧/g, '如果拉伸感只在一侧'],
  [/侧向站立/g, '侧身站立'],
  [/将绳索放置/g, '将绳索调至'],
  [/完成重复次数/g, '完成目标次数'],
  [/将其降低/g, '将其下放'],
  [/紧张的地方/g, '紧绷处'],
  [/暂停几次呼吸/g, '停留几次呼吸'],
  [/保持躯干保持直立/g, '保持躯干直立'],
  [/弯曲肘部降低/g, '弯曲肘部下放'],
  [/轻微的帮助/g, '轻微辅助'],
  [/向上压至/g, '向上推至'],
  [/下降得到控制/g, '有控制地下放'],
  [/挤压肱三头肌/g, '收紧肱三头肌'],
  [/挤压腹肌/g, '收紧腹肌'],
  [/比肩膀稍宽/g, '略宽于肩'],
  [/向箱子方向降低/g, '向箱子方向下放'],
  [/通过脚后跟/g, '用脚跟'],
  [/计划的重复次数/g, '计划次数'],
  [/脚下绑带/g, '脚下踩住弹力带'],
  [/脚后跟平直/g, '脚跟贴地'],
  [/推动双脚站立/g, '蹬地站起'],
  [/向外按/g, '向前推'],
  [/呈直角/g, '朝前'],
  [/脚后跟向上抬起/g, '用脚跟发力向上'],
  [/无抽搐/g, '不要猛甩'],
  [/返回中心/g, '回到中间'],
  [/向前铰链/g, '屈髋前俯'],
  [/固定在头旁边/g, '握在头两侧'],
  [/肋骨向臀部方向挤压/g, '肋骨向臀部方向卷起'],
  [/桌面位置/g, '桌面姿势'],
  [/弯曲离开地板/g, '卷离地板'],
  [/保持肘部靠近。/g, '保持肘部靠近身体。'],
  [/指向前方/g, '朝前'],

  // Pressing, lowering and common literal phrasing.
  [/代表/g, '次'],
  [/集合/g, '组'],
  [/向上按/g, '向上推起'],
  [/向下按/g, '向下推'],
  [/按压手柄/g, '推手柄'],
  [/按压杠铃/g, '推杠铃'],
  [/按压脚后跟/g, '蹬脚跟'],
  [/推动脚后跟/g, '蹬脚跟'],
  [/推动双腿/g, '蹬腿'],
  [/用脚后跟推动/g, '蹬脚跟发力'],
  [/慢慢降低/g, '慢慢下放'],
  [/降低至/g, '下放至'],
  [/降低到/g, '下放到'],
  [/降低身体/g, '下放身体'],
  [/降低哑铃/g, '下放哑铃'],
  [/降低杠铃/g, '下放杠铃'],
  [/降低平台/g, '下放平台'],
  [/降低重量/g, '下放重量'],
  [/完成你的次/g, '完成本组次数'],
  [/完成你的重复次数/g, '完成目标次数'],
  [/完成你的重复/g, '完成目标次数'],
  [/完成所有重复/g, '完成所有次数'],
  [/清洁至胸部/g, '翻至胸前'],
  [/每位次的清洁/g, '每次动作标准'],
  [/保持每位次/g, '保持每次动作'],
  [/计划的次次数/g, '计划的次数'],
  [/下一次次/g, '下一次'],
  [/次次/g, '次'],
  [/组组/g, '组'],
  [/片片/g, '片'],
  [/向下推动/g, '向下压'],
  [/重复所需的重复次数/g, '重复至目标次数'],
  [/所需的重复次数/g, '目标次数'],
  [/将板带回/g, '将杠铃片带回'],
  [/将板放/g, '将杠铃片放'],
  [/板滑动/g, '杠铃片滑动'],
  [/进行一个/g, '做'],
  [/进行一次/g, '做'],
  [/做一个/g, '做'],

  // Second-person filler and duplicated words.
  [/你的/g, ''],
  [/您的/g, ''],
  [/您/g, '你'],
  [/并再次再次/g, '再次'],
  [/并并/g, '并'],
  [/的的/g, '的'],
  [/强力清洁/g, '高翻'],
  [/清洁和混蛋/g, '挺举'],
  [/混蛋/g, '挺举'],
  [/猛地结束/g, '以挺举结束'],
  [/颅骨破碎机/g, '碎颅式'],
  [/颅骨粉碎机/g, '碎颅式'],
  [/脸部拉扯/g, '面拉'],
  [/拉向脸部/g, '拉向面部'],
  [/遮住脸部/g, '遮住面部'],
  [/反向飞翔/g, '反向飞鸟'],
  [/胸部飞鸟/g, '飞鸟'],
  [/下推动作/g, '下压'],
  [/做一个回扣/g, '做后踢'],
  [/回扣/g, '后踢'],
  [/祝你早上好/g, '早安式'],
  [/推进器/g, '蹲推'],
  [/肌肉向上/g, '双力臂'],
  [/平面支撑/g, '俄挺'],
  [/靠墙坐/g, '靠墙静蹲'],
  [/手倒立/g, '倒立'],
  [/长矛位置/g, '折体位置'],
  [/长矛俯卧撑/g, '折体俯卧撑'],
  [/前架位置/g, '前架位'],
  [/架子位置/g, '前架位'],
  [/机架位置/g, '前架位'],
  [/架位置/g, '架位'],
  [/下巴向上/g, '反握引体向上'],
  [/过度伸展/g, '超伸'],
  [/推起压/g, '推起'],
  [/推起推起/g, '推起'],
  [/你体重/g, '身体重量'],
  [/你肩胛骨/g, '肩胛骨'],
  [/你脸部/g, '面部'],
  [/你手臂/g, '手臂'],
  [/你前臂/g, '前臂'],
  [/你手腕/g, '手腕'],
  [/你肘部/g, '肘部'],
  [/你肩膀/g, '肩膀'],
  [/你背部/g, '背部'],
  [/你胸部/g, '胸部'],
  [/你膝盖/g, '膝盖'],
  [/你臀部/g, '臀部'],
  [/你核心/g, '核心'],
  [/你身体/g, '身体'],
  [/你腿部/g, '腿部'],
  [/你腿/g, '腿'],
  [/你脚/g, '脚'],
  [/你头/g, '头'],
  [/你脖子/g, '脖子'],
  [/核心支撑/g, '核心收紧'],
  [/在有控制的情况下/g, '有控制地'],
  [/肘部高(?!度)/g, '肘部抬高'],
  [/推动前脚/g, '前脚蹬地'],
  [/中足/g, '脚掌中部'],
  [/稳定地放在/g, '稳定贴在'],
  [/将脚踩住/g, '脚掌踩地'],
  [/放回到肩膀/g, '下放回肩部'],

  // Common phrasing.
];

const MANUAL_OVERRIDES = new Map([
  ['Avoid overarching at the top.', '避免在顶部过度挺腰。'],
  ['Repeat without overarching.', '重复，但不要过度挺腰。'],
  ['Stand tall with your arms ready to pump.', '站直，双臂准备好摆动。'],
  ['Stay high on your toes.', '保持脚尖支撑，身体抬高。'],
  ['Hold for a few breaths, then lower your feet gently.', '保持几次呼吸的时间，然后轻轻放下双脚。'],
  ['Follow through with your arms.', '双臂顺势跟随。'],
  ['Catch it, reset your stance and go again.', '接住球，调整姿势后再次进行。'],
  ['Wind the ball slightly away from the target.', '将球稍微向后引，远离目标。'],
  ['Return the foot and bring the plate back to your thighs.', '收回脚，将杠铃片带回大腿处。'],
  ['Place a band around your forefeet or ankles.', '将弹力带绕在前脚掌或脚踝上。'],
  ['Quickly move your feet in and out.', '双脚快速开合。'],
  ['Ease off gently and shake out your hands.', '轻轻放松，然后甩动双手。'],
  ['Round your upper back, draw your belly in and gaze slightly ahead.', '弓起上背部，收腹，目光略微向前。'],
  ['Use your hips and keep your core tight. Finish the reps, then switch sides.', '用髋部发力并保持核心收紧。完成本组次数后换边。'],
  ['Keep the knee straight for the calf, then slightly bent for the soleus.', '保持膝盖伸直以拉伸小腿，然后稍微弯曲以拉伸比目鱼肌。'],
  ['Roll onto your elbow, then your hand.', '先翻到肘部，再撑到手掌。'],
  ['Lift your hips and sweep the straight leg back to kneel.', '抬起臀部，将伸直的那条腿向后摆，转为跪姿。'],
  ['Reverse the steps slowly to lie down.', '按相反顺序缓慢回到躺姿。'],
  ['Keep your hips square. Finish the reps, then switch sides.', '髋部保持朝前。完成本组次数后换边。'],
  ['Kneel on one knee holding one end of a barbell in a landmine setup near your hip.', '单膝跪地，将杠铃一端固定在地雷架中，靠近髋部。'],
  ['Attach a bar to a high pulley and face away from the machine.', '将直杆连接到高位滑轮，背对器械。'],
  ['Hold the bar behind your head with elbows pointing forward.', '将直杆放在脑后，肘部朝前。'],
  ['Extend your arms to press the bar overhead.', '伸展双臂，将直杆推过头顶。'],
  ['Lower slowly back and keep your elbows in place.', '慢慢向后下放，保持肘部位置不变。'],
  ['Place a bench behind you under the smith bar.', '在身后放一张长凳，位于史密斯机杠铃下方。'],
  ['Rest the bar on your upper back and unrack it.', '将杠铃放在上背部，然后出架。'],
  ['Drive through your heels to stand and rerack when finished.', '用脚跟发力站起，完成后将杠铃放回架上。'],
  ['Reverse slowly to stand.', '缓慢反向回到站姿。'],
  ['Hold for a moment.', '保持片刻。'],
  ['Start in a high plank.', '从高位平板支撑开始。'],
  ['Lower your chest and push back up.', '下放胸部，然后向上推起。'],
  ['Press back up to a plank.', '向上推回平板支撑。'],
  ['Dip down and press up, then repeat the cycle.', '向下屈臂，再向上推起，然后重复。'],
  ['Keep your weight balanced over your feet.', '让体重均匀分布在双脚上。'],
  ['Stand tall and start with a few normal jumps.', '站直，先做几次普通跳跃。'],
  ['Squeeze the plate firmly.', '用力挤压杠铃片。'],
  ['Hold a dumbbell in one hand and hinge forward with a flat back.', '一只手握住哑铃，屈髋前俯，背部平直。'],
  ['Sit on the recumbent bike and adjust the seat so your knees stay slightly bent at full extension.', '坐在卧式健身车上，调整座椅，使膝盖在完全伸展时仍略微弯曲。'],
  ['Cool down by slowing the pedalling gradually.', '逐渐放慢踩踏速度进行放松。'],
  ['Find a clear, flat area or treadmill at a low speed.', '找一块空旷平坦的场地，或以低速使用跑步机。'],
  ['Glance over your shoulder from time to time.', '不时回头看一眼。'],
  ['Place hands on parallel bars and support yourself in a plank.', '双手撑在双杠上，保持平板支撑。'],
  ['Shift your hands to the edge of the bars, body upright.', '将双手移到双杠边缘，身体保持直立。'],
  ['Release and repeat on the other hand.', '换另一只手松开并重复。'],
  ['Use the straps only for balance.', '吊带仅用于保持平衡。'],
  ['Stop at a mild pull, never at pain.', '感到轻微拉伸就停止，不要拉到疼痛。'],
  ['Sit on a bench wearing a head harness with a light weight hanging in front.', '坐在长凳上，佩戴头部固定带，前方悬挂较轻的重量。'],
  ['Sit upright holding the EZ bar with a close grip at your chest.', '坐直，以窄握将 EZ 杆握在胸前。'],
  ['Anchor the band at chest height and stand side-on to it.', '将弹力带固定在胸部高度，侧身站在弹力带旁。'],
  ['Go to at least parallel without letting your knees cave in.', '至少下蹲到大腿与地面平行，不要让膝盖内扣。'],
  ['Keep your hips and shoulders square as you squat down.', '下蹲时保持髋部和肩部朝前。'],
  ['Drive up through your heels and repeat.', '用脚跟发力站起并重复。'],
  ['Keep your torso upright.', '保持躯干直立。'],
  ['Keep your elbows close.', '保持肘部靠近身体。'],
  ['Press up to straight arms.', '向上推至手臂伸直。'],
  ['Lower under control.', '有控制地下放。'],
  ['Use your legs for light help.', '用双腿提供轻微辅助。'],
  ['Grab the bar overhand.', '正握抓住杠铃杆。'],
  ['Push back up.', '向上推起。'],
  ['Slide the towel hand back in.', '将撑毛巾的手滑回原位。'],
  ['Stand facing a wall with a towel under your forearm on the wall.', '面朝墙壁站立，前臂与墙之间夹一条毛巾。'],
  ['Lower it and switch quickly to the other knee.', '放下膝盖，快速换到另一侧。'],
  ['Walk for 20-45 minutes and slow down before stepping off.', '步行 20-45 分钟，走下跑步机前先放慢速度。'],
  ['Return the arms up and stand tall in one smooth motion.', '将手臂举回原位，流畅地站直。'],
  ['Lie on your back on a bench with your head past the edge and the harness fitted.', '仰卧在长凳上，头部越过边缘，戴好头部固定带。'],
  ['Let your head hang back slightly in a comfortable range.', '让头在舒适范围内稍微后仰。'],
  ['Lower under control and keep the weight light with smooth reps.', '有控制地下放，使用较轻的重量，平稳完成次数。'],
  ['Gently nod your chin and let your head relax into the roller.', '轻轻点头，让头部放松地靠在泡沫轴上。'],
  ['Step back with the leg on the same side as the bell.', '与壶铃同侧的那条腿向后退一步。'],
  ['Keep your hips on the floor.', '保持臀部贴地。'],
  ['Extend the other leg against the band.', '另一条腿对抗弹力带伸展。'],
  ['Place your hands on a medicine ball in a plank.', '双手撑在药球上，保持平板支撑。'],
  ['Catch it on the bounce or pick it up.', '接住弹起的球，或把它捡起来。'],
  ['Place your hands on the floor and step into a plank.', '双手撑地，进入平板支撑。'],
  ['Return the foot back to the plank.', '将脚收回平板支撑。'],
  ['Set the rings low and take a plank with your hands on them.', '将吊环调低，双手撑在吊环上，保持平板支撑。'],
  ['Set up in a high plank.', '摆好高位平板支撑。'],
  ['Place your feet in the straps and set up in a high plank.', '双脚套入吊带，摆好高位平板支撑。'],
  ['Place the board on a flat, non-slip surface.', '将板放在平坦、防滑的表面上。'],
  ['Put your feet in the straps and set a plank with one hand on the floor.', '双脚套入吊带，一只手撑地，保持平板支撑。'],
  ['Anchor one end of a barbell and hold the other end at your shoulder with both hands.', '固定杠铃一端，双手握住另一端置于肩部。'],
  ['Bend your knees and open them out, heels together, in a frog shape.', '弯曲膝盖并向两侧打开，脚跟并拢，呈青蛙姿势。'],
  ['Circle them out, around and back together.', '双腿向外画圈，绕一圈后再并拢。'],
  ['Reverse the circle direction after a few reps.', '重复几次后反方向画圈。'],
  ['Hold the bar at shoulder height with hands just outside shoulder-width.', '双手略宽于肩，将杠铃握在与肩同高的位置。'],
  ['Lift the barbell from the floor to your collarbone using a safe clean or deadlift and curl.', '用安全的翻站，或硬拉加弯举，将杠铃从地面提到锁骨处。'],
  ['Use the assistance as needed to keep every rep clean.', '按需使用辅助，确保每一次动作都标准。'],
  ['Fix the cue before adding weight, and rest between sets so form stays clean.', '先纠正动作提示再增加重量，并在组间休息以保持动作标准。'],
  ['Pull it up the thighs with a flat back and clean it to your chest.', '保持背部平直，将它沿大腿上拉并翻至胸前。'],
  ['Clean and press a kettlebell overhead with one arm.', '单臂将壶铃高翻并推举过头顶。'],
  ['Clean two kettlebells to the front rack, elbows tucked and close to your ribs.', '将两个壶铃高翻至前架位，肘部内收贴近肋骨。'],
  ['Hinge and swing the kettlebell back, then clean it to your shoulder.', '屈髋将壶铃向后摆，然后翻至肩部。'],
  ['Start with the barbell on the floor and pull it to your shoulders in a clean.', '从地面上的杠铃开始，以高翻动作将其拉至肩部。'],
  ['Swing it up, then clean it to the rack position at your shoulder.', '将它向上摆起，然后翻至肩部的前架位。'],
  ['Drive your hips forward to swing, catching it in a clean position at your chest.', '髋部向前发力摆起，在胸前以翻站姿势接住。'],
  ['Place your heels on small plates and hold a bar across your upper back with a clean-width grip.', '将脚跟放在小杠铃片上，以翻站握距将杠铃杆横放在上背部。'],
  ['Clean a kettlebell so it is upside down with the bell above your fist.', '将壶铃高翻成倒置姿势，使铃体位于拳头上方。'],
  ['Hold the bar at mid-thigh with a wide snatch grip and a flat back.', '以宽抓举握法在大腿中部握住杠铃杆，保持背部平直。'],
  ['Rest the bar on your upper back and take a wide snatch grip.', '将杠铃杆放在上背部，采用宽抓举握法。'],
  ['Stand with the bar over your mid-foot and take a wide snatch grip.', '站立，杠铃杆位于脚掌中部上方，采用宽抓举握法。'],
  ['Hold a barbell with a wide snatch grip at your thighs.', '以宽抓举握法在大腿处握住杠铃。'],
  ["Don't let your hips sag or pike up.", '不要让臀部下沉或向上折起。'],
  ['Set the straps low and place your hands in the handles in a pike position.', '将吊带调低，双手握住把手，呈折体姿势。'],
  ['Raise your hips into a pike.', '抬起臀部，进入折体姿势。'],
  ['Walk your feet back and lift your hips into a pike.', '双脚向后走，抬起臀部进入折体姿势。'],
  ['Lift your hips into a pike shape.', '抬起臀部，形成折体姿势。'],
  ['Lift your hips into a pike.', '抬起臀部，进入折体姿势。'],
  ['Reverse the path, pushing your hips back up into the pike, and repeat smoothly.', '沿原路返回，将臀部推回折体姿势，然后流畅地重复。'],
  ['Start on your knees and hands with hips high, like a pike.', '从跪姿双手撑地开始，臀部抬高，呈折体姿势。'],
  ['Slide your feet toward your hands as your hips rise into a pike.', '双脚向双手方向滑动，同时臀部抬起进入折体姿势。'],
  ['Raise your hips into a pike shape.', '抬起臀部，形成折体姿势。'],
]);

/** Sentences the endpoint refuses, echoes, or translates too literally; keep them consistent. */
const FALLBACK_TRANSLATIONS = new Map([
  ['Lower slowly.', '缓慢下放。'],
  ['Return slowly.', '缓慢返回。'],
  ['Pause briefly.', '短暂停顿。'],
  ['Switch legs.', '换腿。'],
  ['Switch sides.', '换边。'],
  ['Alternate sides.', '交替两侧。'],
  ['Release slowly.', '缓慢松开。'],
  ['Switch arms.', '换手臂。'],
  ['Stand tall.', '站直。'],
  ['Alternate legs.', '交替双腿。'],
  ['Avoid swinging.', '避免摆动。'],
  ['Hold briefly.', '短暂保持。'],
  ['Breathe steadily.', '保持稳定呼吸。'],
  ['Pause.', '停顿。'],
  ['Alternate arms.', '交替双臂。'],
  ['Repeat smoothly.', '流畅地重复。'],
  ['Press up.', '向上推起。'],
  ['Breathe slowly.', '缓慢呼吸。'],
  ['Land softly.', '轻柔落地。'],
  ['Repeat.', '重复。'],
  ['Squat down.', '蹲下。'],
  ['Avoid shrugging.', '避免耸肩。'],
  ['Close slowly.', '缓慢合拢。'],
  ['Lock out.', '锁定关节。'],
  ['Repeat slowly.', '缓慢重复。'],
  ['Rise slowly.', '缓慢起身。'],
  ['Sit tall.', '坐直。'],
  ['Stand up.', '站起。'],
  ['Switch feet.', '换脚。'],
  ['Alternate smoothly.', '流畅地交替。'],
  ['Brace.', '收紧核心。'],
  ['Breathe normally.', '正常呼吸。'],
  ['Continue smoothly.', '流畅地继续。'],
  ['Curl up.', '卷起。'],
  ['Drive up.', '向上发力。'],
  ['Extend slowly.', '缓慢伸展。'],
  ['Keep alternating.', '继续交替。'],
  ['Lean back.', '向后倾斜。'],
  ['Lower down.', '下放。'],
  ['Move slowly.', '缓慢移动。'],
  ['Open arms.', '张开双臂。'],
  ['Press again.', '再次推起。'],
  ['Push up.', '向上推。'],
  ['Reach forward.', '向前伸。'],
  ['Relax fully.', '完全放松。'],
  ['Relax slowly.', '缓慢放松。'],
  ['Release fully.', '完全松开。'],
  ['Repeat quickly.', '快速重复。'],
  ['Reset.', '重置。'],
  ['Return overhead.', '举回头顶。'],
  ['Return.', '返回。'],
  ['Reverse direction.', '反向进行。'],
  ['Sit upright.', '坐直。'],
  ['Squat again.', '再次下蹲。'],
  ['Squeeze glutes.', '收紧臀肌。'],
  ['Squeeze.', '收紧。'],
  ['Stand wide.', '双脚宽站。'],
  ['Stay controlled.', '保持控制。'],
  ['Stay tall.', '保持站直。'],
  ['Stay upright.', '保持直立。'],
  ['Step off.', '走下器械。'],
  ['Tap lightly.', '轻触。'],
]);

function postprocess(sentence, translation) {
  const override = MANUAL_OVERRIDES.get(sentence);
  if (override) return override;
  let result = translation;
  // "roller" in the catalogue is a foam roller, except for the ab wheel and wrist roller.
  if (/\bwrist rollers?\b/i.test(sentence)) {
    result = result.replace(/健腹轮|滚轮|滚筒|滚轴/g, '腕力滚轴');
  } else if (/\brollers?\b/i.test(sentence) && !/\b(ab wheel|wheel roller)\b/i.test(sentence)) {
    result = result.replace(/健腹轮|滚轮|滚筒|滚轴/g, '泡沫轴');
  }
  // Suspension-trainer and reformer parts are not resistance bands or sleds.
  if (/\bstraps?\b/i.test(sentence) && !/\bband\b/i.test(sentence)) {
    result = result.replace(/弹力带|带子|皮带/g, '吊带');
  }
  if (/\bcarriage\b/i.test(sentence)) result = result.replace(/马车|雪橇|车厢/g, '滑车');
  if (/\breformer\b/i.test(sentence)) result = result.replace(/塑身机|改革者|普拉提床/g, '普拉提核心床');
  for (const [pattern, replacement] of REPLACEMENTS) result = result.replace(pattern, replacement);
  return result;
}

async function main() {
  const zh = readJson(zhPath);
  const englishById = new Map();
  for (const file of readdirSync(exercisesDir)) {
    if (!file.endsWith('.json')) continue;
    const exercise = readJson(join(exercisesDir, file));
    englishById.set(exercise.id, exercise);
  }

  const { memory, pairs } = buildTranslationMemory(englishById, zh);
  const { missing, missingSteps, doneExercises, doneSteps } = collectMissing(englishById, zh);
  console.log(`catalogue: ${englishById.size} exercises, ${doneExercises} translated (${doneSteps} steps), ${missing.length} missing (${missingSteps} steps)`);
  console.log(`translation memory: ${pairs} English/Chinese step pairs, ${memory.size} unique sentences`);

  const { translations: cache, targets: savedTargets } = loadCache();
  for (const [sentence, fallback] of FALLBACK_TRANSLATIONS) cache[sentence] = fallback;
  const targetIds = new Set(savedTargets);
  for (const exercise of missing) targetIds.add(exercise.id);
  const targetExercises = [...targetIds]
    .map(id => englishById.get(id))
    .filter(exercise => exercise && Array.isArray(exercise.instructions) && exercise.instructions.length);
  const effectiveTargets = targetExercises.map(exercise => exercise.id);
  const sentences = new Set();
  let targetSteps = 0;
  for (const exercise of targetExercises) {
    for (const instruction of exercise.instructions) {
      sentences.add(text(instruction));
      targetSteps++;
    }
  }
  console.log(`targets: ${targetExercises.length} exercises, ${targetSteps} steps, ${sentences.size} unique sentences`);

  let reused = 0;
  for (const sentence of sentences) {
    if (cache[sentence]) continue;
    const remembered = memory.get(sentence);
    if (remembered) {
      cache[sentence] = remembered;
      reused++;
    }
  }
  console.log(`cache: ${Object.keys(cache).length} sentences (${reused} seeded from the existing translations)`);

  const pending = [...sentences].filter(sentence => !cache[sentence]);
  console.log(`pending: ${pending.length} unique sentences, ${Math.ceil(pending.length / batchSize)} batches`);

  let completed = 0;
  if (!assembleOnly) {
    const started = Date.now();
    let failed = 0;
    for (let offset = 0; offset < pending.length && completed < limit; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      try {
        const translations = await translateBatch(batch);
        batch.forEach((sentence, index) => {
          cache[sentence] = translations[index];
        });
        completed += batch.length;
      } catch (error) {
        console.warn(`batch failed after retries (${batch.length} steps): ${error.message}`);
        for (const sentence of batch) {
          try {
            cache[sentence] = await translateSentence(sentence);
            completed++;
          } catch (singleError) {
            failed++;
            console.error(`  untranslated: ${sentence}\n  ${singleError.message}`);
          }
        }
      }
      saveCache(cache, effectiveTargets);
      writeChinese(zh, targetExercises, cache, { postprocess: true, partial: true });
      const elapsed = Math.round((Date.now() - started) / 1000);
      const rate = completed / Math.max(1, elapsed);
      const eta = Math.round((pending.length - completed) / Math.max(0.01, rate));
      console.log(`  ${completed}/${pending.length} sentences, ${elapsed}s elapsed, ~${eta}s left`);
      await sleep(requestDelayMs + Math.random() * 80);
    }
    if (failed) console.warn(`${failed} sentences still need a manual translation`);
  }

  const translatedAll = [...sentences].every(sentence => Boolean(cache[sentence]));
  const applied = writeChinese(zh, targetExercises, cache, { postprocess: true, partial: !translatedAll });
  saveCache(cache, effectiveTargets);
  if (!translatedAll) {
    console.log(`partial run: ${applied} exercises written, ${pending.length - completed} sentences still pending`);
    return;
  }
  const report = validate(englishById, zh);
  console.log(`applied: ${applied} exercises, ${report.translatedExercises}/${report.exercisesWithSteps} have Chinese steps, ${report.translatedSteps}/${report.englishSteps} steps`);
  if (report.problems.length) {
    console.error(`validation failed with ${report.problems.length} problems:`);
    for (const problem of report.problems.slice(0, 20)) console.error(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('validation: every exercise with English steps has a Chinese step for each one');
  }
}

/** Writes the translated steps into the locale object and returns how many exercises changed. */
function writeChinese(zh, missing, cache, { postprocess: applyPostprocess, partial = false }) {
  let applied = 0;
  for (const exercise of missing) {
    if (partial && exercise.instructions.some(instruction => !cache[text(instruction)])) continue;
    const steps = exercise.instructions.map(instruction => {
      const key = text(instruction);
      const translation = cache[key];
      if (!translation) throw new Error(`missing translation while assembling ${exercise.id}: ${key}`);
      return applyPostprocess ? postprocess(key, translation) : translation;
    });
    zh[exercise.id].instructions = steps;
    applied++;
  }
  writeJsonAtomic(zhPath, zh);
  return applied;
}

function validate(englishById, zh) {
  let exercisesWithSteps = 0;
  let translatedExercises = 0;
  let englishSteps = 0;
  let translatedSteps = 0;
  const problems = [];
  for (const [id, exercise] of englishById) {
    if (!Array.isArray(exercise.instructions) || !exercise.instructions.length) continue;
    exercisesWithSteps++;
    englishSteps += exercise.instructions.length;
    const translated = zh[id]?.instructions;
    if (!Array.isArray(translated) || !translated.length) {
      problems.push(`${id} has no Chinese instructions`);
      continue;
    }
    translatedExercises++;
    translatedSteps += translated.length;
    if (translated.length !== exercise.instructions.length) {
      problems.push(`${id} has ${translated.length} Chinese steps for ${exercise.instructions.length} English steps`);
    }
    translated.forEach((step, index) => {
      if (!text(step)) problems.push(`${id} step ${index + 1} is empty`);
      else if (!CJK.test(step)) problems.push(`${id} step ${index + 1} has no Chinese text: ${step}`);
    });
  }
  return { exercisesWithSteps, translatedExercises, englishSteps, translatedSteps, problems };
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
