// Spotify Web API（Authorization Code + PKCE。クライアントシークレット不要）
// 2026年2月の Development Mode 変更に対応：
//  - 検索の limit は最大 10
//  - プレイリスト作成は POST /me/playlists、追加は POST /playlists/{id}/items
//  - 一括取得系（GET /tracks?ids= など）は使わない
import { store, sleep, pLimit, norm, baseTitle } from './util.js';

const AUTH = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'playlist-modify-private playlist-modify-public user-read-private user-top-read user-modify-playback-state user-read-playback-state';
const TOKEN_KEY = 'spm.token';

// 置いてあるフォルダの URL（例: https://atuyijust.github.io/yotsuji-next/forge/、ローカルなら http://127.0.0.1:8000/）
export const redirectUri = () => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
// 同じサイトの四辻 NEXT に Client ID が入っていれば、それを使う
export const getClientId = () => store.get('spm.clientId', '') || store.get('cid', '');

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function randomString(bytes = 64) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

export async function login() {
  const clientId = getClientId();
  if (!clientId) throw new Error('設定で Spotify の Client ID を入力してください');
  const verifier = randomString(64);
  const state = randomString(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set('spm.pkce', { verifier, state });
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  location.href = `${AUTH}/authorize?${params}`;
}

export function logout() {
  store.del(TOKEN_KEY);
}

async function tokenRequest(body) {
  const res = await fetch(`${AUTH}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify 認証エラー: ${data.error_description || data.error || res.status}`);
  const prev = store.get(TOKEN_KEY, {});
  const token = {
    access: data.access_token,
    refresh: data.refresh_token || prev.refresh,
    exp: Date.now() + (data.expires_in || 3600) * 1000,
    scope: data.scope || prev.scope || '',
  };
  store.set(TOKEN_KEY, token);
  return token;
}

// リダイレクトで戻ってきたときの処理。ログイン完了なら true
export async function handleCallback() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!code && !error) return false;
  history.replaceState(null, '', url.pathname);
  if (error) throw new Error(`Spotify ログインがキャンセルされました（${error}）`);
  const pkce = store.get('spm.pkce');
  if (!pkce || pkce.state !== url.searchParams.get('state')) throw new Error('ログイン状態が一致しません。もう一度お試しください');
  store.del('spm.pkce');
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: getClientId(),
    code_verifier: pkce.verifier,
  });
  return true;
}

// 再生操作の権限があるか（権限を追加する前にログインした場合は、ログインし直しが必要）
export const canControlPlayback = () => /user-modify-playback-state/.test(store.get(TOKEN_KEY)?.scope || '');

export const isLoggedIn = () => !!store.get(TOKEN_KEY)?.refresh || !!store.get(TOKEN_KEY)?.access;

let refreshing = null;
async function accessToken(force = false) {
  const t = store.get(TOKEN_KEY);
  if (!t) throw new Error('Spotify にログインしてください');
  if (!force && t.exp - 60_000 > Date.now()) return t.access;
  if (!t.refresh) throw new Error('ログインの有効期限が切れました。もう一度ログインしてください');
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: getClientId() }).finally(() => {
    refreshing = null;
  });
  return (await refreshing).access;
}

const limit = pLimit(4);

export function api(path, { method = 'GET', body, query } = {}) {
  return limit(async () => {
    let url = path.startsWith('http') ? path : `${API}${path}`;
    if (query) url += `?${new URLSearchParams(query)}`;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await accessToken(lastStatus === 401)}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      lastStatus = res.status;
      if (res.status === 429) {
        const wait = Math.min(Number(res.headers.get('Retry-After') || 2), 30);
        await sleep(wait * 1000 + 250);
        continue;
      }
      if (res.status === 401 && attempt === 0) continue;
      if (res.status >= 500 && attempt < 2) {
        await sleep(800);
        continue;
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = data?.error?.message || res.statusText;
        const err = new Error(`Spotify API エラー (${res.status}): ${msg}`);
        err.status = res.status;
        throw err;
      }
      return data;
    }
    throw new Error('Spotify API のレート制限に達しました。少し待ってから再度お試しください');
  });
}

const pickImage = (images) => (images?.length ? (images[images.length - 1] || images[0]).url : null);

export function normalizeAlbum(al) {
  if (!al) return null;
  return {
    id: al.id,
    name: al.name,
    image: pickImage(al.images),
    imageLarge: al.images?.[0]?.url || null,
    year: parseInt(String(al.release_date || '').slice(0, 4), 10) || null,
    // release_date_precision が year のときは月が分からない
    month: al.release_date_precision !== 'year' ? parseInt(String(al.release_date || '').slice(5, 7), 10) || null : null,
  };
}

export function normalizeTrack(t, albumOverride) {
  if (!t?.id) return null;
  return {
    id: t.id,
    uri: t.uri || `spotify:track:${t.id}`,
    name: t.name,
    artists: (t.artists || []).map((a) => ({ id: a.id, name: a.name })),
    album: normalizeAlbum(t.album) || albumOverride || null,
    durationMs: t.duration_ms ?? null,
    explicit: t.explicit ?? null,
  };
}

export const me = () => api('/me');

export async function searchTracks(q, offset = 0) {
  const d = await api('/search', { query: { q, type: 'track', limit: 10, offset, market: 'from_token' } });
  return (d?.tracks?.items || []).map((t) => normalizeTrack(t)).filter(Boolean);
}

// 曲名＋アーティスト名 → Spotify の曲（見つからなければ null）。結果はブラウザに保存
const RESOLVE_KEY = 'spm.resolveCache';
const resolveCache = store.get(RESOLVE_KEY, {});
for (const k of Object.keys(resolveCache)) if (!k.startsWith('v3|')) delete resolveCache[k];
let resolveTimer = null;
function saveResolveCache() {
  const keys = Object.keys(resolveCache);
  for (const k of keys.slice(0, Math.max(0, keys.length - 4000))) delete resolveCache[k];
  store.set(RESOLVE_KEY, resolveCache);
}

export async function resolveTrack(artist, title, yearFilter = '') {
  const k = `v3|${norm(artist)}|${norm(title)}|${yearFilter}`;
  if (k in resolveCache) return resolveCache[k];
  const clean = (s) => String(s).replace(/"/g, '');
  const q = [`track:"${clean(title)}"`, `artist:"${clean(artist)}"`, yearFilter].filter(Boolean).join(' ');
  const items = await searchTracks(q, 0);
  const na = norm(artist);
  const ok = items.filter((t) => t.artists.some((a) => norm(a.name) === na));
  // 表記ゆれ（feat.・記号・リマスター表記など）を吸収して比べる
  const loose = (x) => baseTitle(x).replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s*(feat\.?|ft\.?)\s.*$/i, '').replace(/[^\p{L}\p{N}]/gu, '');
  const lt = loose(title);
  const best =
    ok.find((t) => norm(t.name) === norm(title)) ||
    ok.find((t) => baseTitle(t.name) === baseTitle(title)) ||
    ok.find((t) => loose(t.name) === lt) ||
    (lt.length >= 4 ? ok.find((t) => loose(t.name).startsWith(lt) || lt.startsWith(loose(t.name))) : null) ||
    null;
  resolveCache[k] = best;
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(saveResolveCache, 800);
  return best;
}

// ISRC（曲ごとの国際コード）→ Spotify の曲。Deezer などほかのサービスの曲を正確に照合する
export async function resolveIsrc(isrc, yearFilter = '') {
  const k = `v3|isrc|${isrc}|${yearFilter}`;
  if (k in resolveCache) return resolveCache[k];
  const items = await searchTracks([`isrc:${isrc}`, yearFilter].filter(Boolean).join(' '), 0);
  const best = items[0] || null;
  resolveCache[k] = best;
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(saveResolveCache, 800);
  return best;
}

export async function searchArtists(q) {
  const d = await api('/search', { query: { q, type: 'artist', limit: 8 } });
  return (d?.artists?.items || []).filter(Boolean).map((a) => ({
    id: a.id,
    name: a.name,
    image: pickImage(a.images),
    genres: a.genres || [],
  }));
}

export async function searchAlbums(q, offset = 0) {
  const d = await api('/search', { query: { q, type: 'album', limit: 10, offset, market: 'from_token' } });
  return (d?.albums?.items || []).filter(Boolean);
}

export async function albumTracks(album) {
  const d = await api(`/albums/${album.id}/tracks`, { query: { limit: 50, market: 'from_token' } });
  const al = normalizeAlbum(album);
  return (d?.items || []).map((t) => normalizeTrack(t, al)).filter(Boolean);
}

export async function getTrack(id) {
  return normalizeTrack(await api(`/tracks/${id}`, { query: { market: 'from_token' } }));
}

export async function myTopTracks() {
  const d = await api('/me/top/tracks', { query: { limit: 20, time_range: 'medium_term' } });
  return (d?.items || []).map((t) => normalizeTrack(t)).filter(Boolean);
}

export async function createPlaylist({ name, description, isPublic }) {
  return api('/me/playlists', { method: 'POST', body: { name, description, public: !!isPublic } });
}

// 公開設定を変更して、実際の状態を読み直す（作成時の指定が無視されることがあるため）
export async function setPlaylistPublic(playlistId, isPublic) {
  await api(`/playlists/${playlistId}`, { method: 'PUT', body: { public: !!isPublic } });
  const d = await api(`/playlists/${playlistId}`, { query: { fields: 'public' } });
  return d?.public;
}

export async function addItems(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) {
    await api(`/playlists/${playlistId}/items`, { method: 'POST', body: { uris: uris.slice(i, i + 100) } });
  }
}

// ---------------- 再生操作（Spotify Connect。yotsuji-next と同じ手順） ----------------
// 動いているデバイスがなければ、開いている Spotify（アクティブ → Computer → Smartphone）を探してそこで鳴らす
async function pickDevice() {
  const j = await api('/me/player/devices').catch(() => null);
  const ds = (j?.devices || []).filter((d) => !d.is_restricted);
  return ds.find((d) => d.is_active) || ds.find((d) => d.type === 'Computer') || ds.find((d) => d.type === 'Smartphone') || ds[0] || null;
}

export function playErr(e, what) {
  const m = e?.message || '';
  if (e?.status === 401 || /scope/i.test(m)) return `${what}できません：再生の権限がありません。いったんログアウトして、もう一度ログインしてください`;
  if (e?.status === 403) return `${what}できません：Spotify からの操作は Premium アカウントのみです`;
  if (e?.status === 404 || /NO_ACTIVE_DEVICE/i.test(m)) return `${what}できません：Spotify アプリ（PC／スマホ）を開いてから、もう一度押してください`;
  return `${what}に失敗：${m}`;
}

// fn(deviceId) を実行。デバイスがなくて失敗したら、開いている Spotify を探して再送
async function withDevice(fn) {
  try {
    await fn('');
    return '';
  } catch (e) {
    if (e.status !== 404) throw e;
    const d = await pickDevice();
    if (!d) throw e;
    await fn(d.id);
    return d.id;
  }
}

async function nowPlaying() {
  const j = await api('/me/player', { query: { market: 'from_token' } }).catch(() => null);
  return j ? { id: j.item?.id || '', from: j.item?.linked_from?.id || '', dev: j.device?.name || '' } : null;
}

async function confirmPlay(id) {
  for (let i = 0; i < 4; i++) {
    await sleep(700);
    const p = await nowPlaying();
    if (p && (p.id === id || p.from === id)) return true;
  }
  return false;
}

export function openInSpotify(id) {
  const a = document.createElement('a');
  a.href = `spotify:track:${id}`;
  a.click();
}

// 結果: 'ok'（再生した）/ 'opened'（アプリで曲を開いた）。失敗は例外
export async function playTrack(t, onStatus = () => {}) {
  const uri = t.uri || `spotify:track:${t.id}`;
  let dev = '';
  const send = async (body) => {
    const d = await withDevice((dv) => api('/me/player/play', { method: 'PUT', body, query: dv || dev ? { device_id: dv || dev } : undefined }));
    if (d) dev = d;
  };
  await send({ uris: [uri] });
  if (await confirmPlay(t.id)) return 'ok';
  // 単曲指定で読み込めないときは、アルバムの中のその曲として再生し直す
  if (t.album?.id) {
    onStatus('Spotify で読み込めなかったので、アルバムから再生し直しています…');
    await send({ context_uri: `spotify:album:${t.album.id}`, offset: { uri } });
    if (await confirmPlay(t.id)) return 'ok';
  }
  openInSpotify(t.id);
  return 'opened';
}

export async function queueTrack(t) {
  const uri = t.uri || `spotify:track:${t.id}`;
  await withDevice((dv) => api('/me/player/queue', { method: 'POST', query: { uri, ...(dv ? { device_id: dv } : {}) } }));
}
