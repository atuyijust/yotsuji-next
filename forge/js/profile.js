// 好みプロフィール：Spotify のお気に入り（Liked Songs）全体から、
// 自分のジャンルの範囲・中核アーティスト・年代の偏りを集計する。
// 「自分がよく聴く曲をもとに似た曲を探す」の基準として engine が使う。
// お気に入り全件と集計結果はブラウザにキャッシュし、7 日間は再取得しない。
import * as sp from './spotify.js';
import { store, chunk, shuffle } from './util.js';

const LIKED_KEY = 'spm.likedCache';
const PROFILE_KEY = 'spm.tasteProfile';
const STALE_MS = 7 * 24 * 3600 * 1000;

// お気に入り全曲を [曲ID, アーティストID, アーティスト名, 年] の配列で取得（7 日キャッシュ）
async function fetchLiked(log) {
  const cache = store.get(LIKED_KEY);
  if (cache?.tracks?.length && Date.now() - cache.at < STALE_MS) return cache.tracks;
  const tracks = [];
  let total = Infinity;
  for (let offset = 0; offset < total; offset += 50) {
    const d = await sp.api('/me/tracks', { query: { limit: 50, offset } });
    const items = d?.items || [];
    total = d?.total ?? items.length;
    for (const it of items) {
      const t = it?.track;
      const a = t?.artists?.[0];
      if (!t?.id || !a) continue;
      const year = parseInt(String(t.album?.release_date || '').slice(0, 4), 10) || 0;
      tracks.push([t.id, a.id || '', a.name || '', year]);
    }
    if (!items.length) break;
    if (offset === 0 || (offset / 50) % 10 === 9) log?.(`お気に入りを取得しています… ${tracks.length.toLocaleString()} / ${total.toLocaleString()} 曲`, null);
  }
  if (tracks.length) store.set(LIKED_KEY, { at: Date.now(), tracks });
  return tracks;
}

// アーティスト ID → ジャンル配列（小文字）。ids は曲数の多い順に渡すこと
async function fetchArtistGenres(ids, log) {
  const genres = new Map();
  const groups = chunk(ids, 50);
  let done = 0;
  await Promise.all(
    groups.map(async (g) => {
      const d = await sp.api('/artists', { query: { ids: g.join(',') } }).catch(() => null);
      for (const a of d?.artists || []) if (a?.id) genres.set(a.id, (a.genres || []).map((x) => String(x).toLowerCase()));
      done++;
      if (done === 10 || done === groups.length) log?.('アーティストのジャンルを集計しています…', null);
    }),
  );
  // 一括取得が使えない環境（開発モードの制限など）では、曲数の多い上位だけでも個別に取る
  const missing = ids.slice(0, 60).filter((id) => !genres.has(id));
  if (missing.length) {
    await Promise.all(
      missing.map(async (id) => {
        const a = await sp.api(`/artists/${id}`).catch(() => null);
        if (a?.id) genres.set(a.id, (a.genres || []).map((x) => String(x).toLowerCase()));
      }),
    );
  }
  return genres;
}

// お気に入りから好みプロフィールを集計する。お気に入りが取れなければ null
export async function buildTasteProfile(log = () => {}) {
  const liked = await fetchLiked(log);
  if (!liked.length) return null;
  const perArtist = new Map(); // id -> {id, name, count}
  const decades = {};
  for (const [, aid, aname, year] of liked) {
    if (aid) {
      const e = perArtist.get(aid) || { id: aid, name: aname, count: 0 };
      e.count++;
      perArtist.set(aid, e);
    }
    if (year) {
      const d = `${Math.floor(year / 10) * 10}s`;
      decades[d] = (decades[d] || 0) + 1;
    }
  }
  const byCount = [...perArtist.values()].sort((a, b) => b.count - a.count);
  log(`お気に入り ${liked.length.toLocaleString()} 曲から好みのプロフィールを構築しています…`, null);
  const genreMap = await fetchArtistGenres(byCount.map((a) => a.id), log);
  const genreCount = new Map();
  for (const [, aid] of liked) {
    for (const g of genreMap.get(aid) || []) genreCount.set(g, (genreCount.get(g) || 0) + 1);
  }
  const genres = [...genreCount.entries()].sort((a, b) => b[1] - a[1]);
  const profile = {
    at: Date.now(),
    trackCount: liked.length,
    artistCount: perArtist.size,
    genres,
    topGenres: genres.slice(0, 12).map(([g]) => g),
    coreArtists: byCount.slice(0, 30).map(({ id, name, count }) => ({ id, name, count })),
    decades,
  };
  store.set(PROFILE_KEY, profile);
  return profile;
}

// キャッシュ済みのプロフィールを返す。古ければ作り直す。失敗したら古いもの（なければ null）
export async function getTasteProfile(log = () => {}) {
  const p = store.get(PROFILE_KEY);
  if (p?.topGenres && Date.now() - p.at < STALE_MS) return p;
  try {
    return (await buildTasteProfile(log)) || p || null;
  } catch (e) {
    console.warn('[playlist-forge] taste profile', e);
    return p || null;
  }
}

// 中核アーティストのお気に入り曲から、ReccoBeats の種にする曲 ID を取り出す
export function likedSeedTrackIds(profile, limit = 10) {
  const cache = store.get(LIKED_KEY);
  if (!cache?.tracks?.length || !profile?.coreArtists?.length) return [];
  const core = new Set(profile.coreArtists.slice(0, 8).map((a) => a.id));
  const ids = [];
  for (const [tid, aid] of shuffle(cache.tracks)) {
    if (!core.has(aid)) continue;
    ids.push(tid);
    if (ids.length >= limit) break;
  }
  return ids;
}

// ジャンルが好みの範囲（topGenres）と重なるか。部分一致も認める（'deep house' と 'house' など）
export function genreInProfile(genres, profile) {
  if (!genres?.length || !profile?.topGenres?.length) return false;
  return genres.some((g) => profile.topGenres.some((t) => g === t || g.includes(t) || t.includes(g)));
}

// ジャンルの柵の判定：候補のジャンルが判明していて、好みの範囲と 1 つも重ならなければ落とす。
// ジャンル不明の候補は落とさない（データ不足を罰しない）。プロフィールがなければ無効
export function fencedOut(genres, profile) {
  if (!profile?.topGenres?.length) return false;
  if (!genres?.length) return false;
  return !genreInProfile(genres, profile);
}

// 候補アーティストのジャンル（実行内キャッシュ付き）。取れなかった ID は空配列になる
const candGenreMemo = new Map();
export async function artistGenresById(ids) {
  const todo = [...new Set(ids.filter((id) => id && !candGenreMemo.has(id)))];
  for (const g of chunk(todo, 50)) {
    const d = await sp.api('/artists', { query: { ids: g.join(',') } }).catch(() => null);
    const found = new Map((d?.artists || []).filter(Boolean).map((a) => [a.id, (a.genres || []).map((x) => String(x).toLowerCase())]));
    for (const id of g) candGenreMemo.set(id, found.get(id) || []);
  }
  return candGenreMemo;
}
