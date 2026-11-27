// data/ フォルダの isou_スレ番号_スレID.json を読み、data/manifest.json(スレ一覧)を作る。
// GitHub Actions から自動で実行される。手元で試すときは  node tools/build_manifest.mjs
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'data';
const PATTERN = /^isou_(\d+)_(\d+)\.json$/;

// "26/11/26(木) 21:13:08" → ミリ秒(日本時間)
function ts(s) {
  const m = /(\d\d)\/(\d\d)\/(\d\d).*?(\d\d):(\d\d):(\d\d)/.exec(s || '');
  if (!m) return 0;
  return Date.parse(`20${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`);
}

const names = fs.readdirSync(DIR);
const ignored = names.filter((f) => f.endsWith('.json') && f !== 'manifest.json' && !PATTERN.test(f));
const byId = new Map();
const warnings = [];

for (const f of names.filter((n) => PATTERN.test(n))) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  } catch (e) {
    warnings.push(`読めないファイル: ${f}`);
    continue;
  }
  const posts = d.posts || [];
  const entry = {
    id: String(d.threadId),
    number: d.number,
    title: d.title,
    count: posts.length,
    expectedCount: d.expectedCount ?? null,
    deleted: posts.filter((p) => p.deleted).length,
    images: posts.reduce((a, p) => a + (p.images ? p.images.length : 0), 0),
    likes: posts.reduce((a, p) => a + (p.likes || 0), 0),
    first: posts[0] ? posts[0].posted : '',
    last: posts.length ? posts[posts.length - 1].posted : '',
    firstTs: posts[0] ? ts(posts[0].posted) : 0,
    lastTs: posts.length ? ts(posts[posts.length - 1].posted) : 0,
    prevId: d.prevId || null,
    savedAt: d.savedAt || '',
    file: f,
    bytes: fs.statSync(path.join(DIR, f)).size,
  };
  const old = byId.get(entry.id);
  if (!old || entry.count > old.count || (entry.count === old.count && entry.savedAt > old.savedAt)) byId.set(entry.id, entry);
}

const threads = [...byId.values()].sort((a, b) => b.number - a.number);

// 抜けや重複のチェック
const nums = new Map();
for (const t of threads) nums.set(t.number, (nums.get(t.number) || []).concat(t.id));
const duplicateNumbers = [...nums.entries()].filter(([, ids]) => ids.length > 1).map(([n, ids]) => ({ number: n, ids }));
const missingNumbers = [];
if (threads.length) {
  const max = threads[0].number, min = threads[threads.length - 1].number;
  for (let n = min; n <= max; n++) if (!nums.has(n)) missingNumbers.push(n);
}
for (const t of threads) {
  if (t.expectedCount !== null && t.expectedCount !== t.count) warnings.push(`件数不一致: ${t.number} (ページ表記${t.expectedCount} / 取得${t.count})`);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  total: threads.length,
  missingNumbers,
  duplicateNumbers,
  ignoredFiles: ignored,
  warnings,
  threads,
};
fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest));
console.log(`manifest: ${threads.length} threads, missing ${missingNumbers.length}, duplicates ${duplicateNumbers.length}, ignored ${ignored.length}, warnings ${warnings.length}`);
