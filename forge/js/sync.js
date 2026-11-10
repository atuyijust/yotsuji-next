// 設定（Last.fm / Claude / Gemini の API キー）を端末間で受け渡す。
// 四辻 NEXT と同じサイトなので、四辻 NEXT の GitHub トークン（localStorage の ghTok）と同期用の非公開 Gist をそのまま使う。
// Gist にファイル「playlist-forge-settings.json」を 1 つ足すだけで、四辻 NEXT のデータには触らない。
import { store } from './util.js';

const SYNC_FILE = 'yotsuji-next-sync.json'; // 四辻 NEXT の同期ファイル（この Gist を探す目印）
const FILE = 'playlist-forge-settings.json';
const KEYS = ['spm.lastfmKey', 'spm.claudeKey', 'spm.geminiKey', 'spm.clientId'];
const PRESETS = 'spm.presets';

const token = () => store.get('ghTok', '');
export const canSync = () => !!token();

async function gh(path, opt = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opt,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(opt.headers || {}),
    },
  });
  if (res.status === 401) throw new Error('GitHub のトークンが無効です');
  if (res.status === 403) throw new Error('GitHub のトークンに Gist の権限がありません');
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${res.status}`);
  return res;
}

async function findGist() {
  const id = store.get('gistId', '');
  if (id && (await gh(`/gists/${id}`)).ok) return id;
  for (let p = 1; p <= 5; p++) {
    const list = await (await gh(`/gists?per_page=100&page=${p}`)).json();
    if (!list.length) break;
    const g = list.find((x) => x.files && x.files[SYNC_FILE]);
    if (g) {
      store.set('gistId', g.id);
      return g.id;
    }
  }
  return null;
}

// この端末に無いキーだけを Gist から受け取る。受け取ったキーの数を返す
export async function pullKeys() {
  if (!canSync()) return 0;
  const id = await findGist();
  if (!id) return 0;
  const g = await (await gh(`/gists/${id}`)).json();
  const f = g.files?.[FILE];
  if (!f) return 0;
  const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
  const d = JSON.parse(text || '{}');
  let n = 0;
  for (const k of KEYS) {
    if (d[k] && !store.get(k, '')) {
      store.set(k, d[k]);
      n++;
    }
  }
  // 保存した条件は、この端末に無い名前のものだけ足す
  const mine = store.get(PRESETS, {});
  let added = 0;
  for (const [name, c] of Object.entries(d[PRESETS] || {})) if (!(name in mine)) (mine[name] = c), added++;
  if (added) store.set(PRESETS, mine);
  return n + added;
}

// この端末のキーを Gist に送る（ほかの端末で設定なしに使えるように）
export async function pushKeys() {
  if (!canSync()) return false;
  const id = await findGist();
  if (!id) return false;
  const data = { v: 1, at: Date.now() };
  for (const k of KEYS) data[k] = store.get(k, '');
  data[PRESETS] = store.get(PRESETS, {});
  await gh(`/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(data) } } }) });
  return true;
}

// ---------------- 端末の引き継ぎ（コピー＆ペースト） ----------------
// iPhone のホーム画面に追加したアプリは Safari と保存場所が別なので、四辻 NEXT の GitHub トークンも見えない。
// Mac でコピーした「引き継ぎデータ」を iPhone で貼り付けると、キー・Client ID・同期のトークン・保存した条件がそのまま入る。
// （Apple の「ユニバーサルクリップボード」なら、Mac でコピーして iPhone でそのまま貼り付けられる）
const HANDOFF = 'PLAYLISTFORGE1:';
const HANDOFF_KEYS = ['spm.clientId', 'spm.lastfmKey', 'spm.claudeKey', 'spm.geminiKey', 'ghTok', 'gistId', PRESETS, 'spm.lastCriteria'];

export function makeHandoff() {
  const d = {};
  for (const k of HANDOFF_KEYS) {
    const v = store.get(k, null);
    if (v != null && v !== '') d[k] = v;
  }
  if (!d['spm.clientId'] && store.get('cid', '')) d['spm.clientId'] = store.get('cid', '');
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return HANDOFF + btoa(bin);
}

// 貼り付けた文字列を読み込む。入れた項目の数を返す（形式が違えば例外）
export function applyHandoff(text) {
  const i = String(text || '').indexOf(HANDOFF);
  if (i < 0) throw new Error('引き継ぎデータではありません。Mac の「設定」→「引き継ぎデータをコピー」でコピーしたものを貼り付けてください');
  const b64 = text.slice(i + HANDOFF.length).trim().split(/\s/)[0];
  const bin = atob(b64);
  const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  let n = 0;
  for (const k of HANDOFF_KEYS) {
    if (d[k] == null) continue;
    if (k === PRESETS) {
      store.set(k, { ...store.get(k, {}), ...d[k] });
    } else store.set(k, d[k]);
    n++;
  }
  store.del('spm.geminiModel');
  return n;
}
