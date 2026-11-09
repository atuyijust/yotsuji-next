// 設定（Last.fm / Claude の API キー）を端末間で受け渡す。
// 四辻 NEXT と同じサイトなので、四辻 NEXT の GitHub トークン（localStorage の ghTok）と同期用の非公開 Gist をそのまま使う。
// Gist にファイル「playlist-forge-settings.json」を 1 つ足すだけで、四辻 NEXT のデータには触らない。
import { store } from './util.js';

const SYNC_FILE = 'yotsuji-next-sync.json'; // 四辻 NEXT の同期ファイル（この Gist を探す目印）
const FILE = 'playlist-forge-settings.json';
const KEYS = ['spm.lastfmKey', 'spm.claudeKey'];

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
  return n;
}

// この端末のキーを Gist に送る（ほかの端末で設定なしに使えるように）
export async function pushKeys() {
  if (!canSync()) return false;
  const id = await findGist();
  if (!id) return false;
  const data = { v: 1, at: Date.now() };
  for (const k of KEYS) data[k] = store.get(k, '');
  await gh(`/gists/${id}`, { method: 'PATCH', body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(data) } } }) });
  return true;
}
