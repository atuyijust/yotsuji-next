// Spotify 以外のデータ源
//  - ReccoBeats: 曲の特徴量（BPM・エネルギー等）、人気度、似た曲のおすすめ（キー不要）
//  - Last.fm:    似たアーティスト（API キーが必要・無料）
//  - MusicBrainz: アーティストの出身国（キー不要・1 秒 1 リクエストまで）
import { chunk, pLimit, sleep, store, norm, idFromHref } from './util.js';

const RB = 'https://api.reccobeats.com/v1';
const rbLimit = pLimit(3);

async function rbGet(path, params) {
  return rbLimit(async () => {
    const url = `${RB}${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url);
      if (res.status === 429) {
        await sleep(Math.min(Number(res.headers.get('Retry-After') || 2), 20) * 1000);
        continue;
      }
      if (res.status === 404) return { content: [] };
      if (!res.ok) {
        if (attempt < 1 && res.status >= 500) {
          await sleep(600);
          continue;
        }
        const t = await res.text().catch(() => '');
        throw new Error(`ReccoBeats エラー (${res.status}) ${t.slice(0, 120)}`);
      }
      return res.json();
    }
    throw new Error('ReccoBeats のレート制限に達しました');
  });
}

// 特徴量キャッシュ（同じ曲を何度も取りに行かない）
const FEAT_CACHE_KEY = 'spm.featCache';
const featCache = new Map(Object.entries(store.get(FEAT_CACHE_KEY, {})));
let featDirty = false;
function saveFeatCache() {
  if (!featDirty) return;
  // 肥大化防止：新しい方から 8000 件だけ保持
  const entries = [...featCache.entries()].slice(-8000);
  store.set(FEAT_CACHE_KEY, Object.fromEntries(entries));
  featDirty = false;
}

/** Spotify の曲 ID 配列 → Map(id → 特徴量 | null) */
export async function audioFeatures(ids, onProgress) {
  const result = new Map();
  const todo = [];
  for (const id of ids) {
    if (featCache.has(id)) result.set(id, featCache.get(id));
    else todo.push(id);
  }
  const groups = chunk(todo, 40);
  let done = 0;
  await Promise.all(
    groups.map(async (g) => {
      const d = await rbGet('/audio-features', { ids: g.join(',') }).catch(() => ({ content: [] }));
      const found = new Set();
      for (const f of d.content || []) {
        const id = idFromHref(f.href);
        if (!id) continue;
        const feat = {
          tempo: f.tempo,
          energy: f.energy,
          danceability: f.danceability,
          valence: f.valence,
          acousticness: f.acousticness,
          instrumentalness: f.instrumentalness,
          liveness: f.liveness,
          speechiness: f.speechiness,
          loudness: f.loudness,
          key: f.key,
          mode: f.mode,
        };
        result.set(id, feat);
        featCache.set(id, feat);
        found.add(id);
      }
      for (const id of g) {
        if (!found.has(id)) {
          result.set(id, null);
          featCache.set(id, null);
        }
      }
      featDirty = true;
      done += g.length;
      onProgress?.(done, todo.length);
    }),
  );
  saveFeatCache();
  return result;
}

/** Spotify の曲 ID 配列 → Map(id → 人気度) */
export async function popularity(ids) {
  const result = new Map();
  await Promise.all(
    chunk(ids, 40).map(async (g) => {
      const d = await rbGet('/track', { ids: g.join(',') }).catch(() => ({ content: [] }));
      for (const t of d.content || []) {
        const id = idFromHref(t.href);
        if (id && typeof t.popularity === 'number') result.set(id, t.popularity);
      }
    }),
  );
  return result;
}

/** 種曲（最大 5）に似た曲をおすすめ。返り値は簡易トラック（アルバム情報なし） */
export async function recommend(seedIds, size = 100) {
  const seeds = seedIds.slice(0, 5);
  if (!seeds.length) return [];
  const d = await rbGet('/track/recommendation', { seeds: seeds.join(','), size: Math.min(size, 100) }).catch(() => ({ content: [] }));
  return (d.content || [])
    .map((t) => {
      const id = idFromHref(t.href);
      if (!id) return null;
      return {
        id,
        uri: `spotify:track:${id}`,
        name: t.trackTitle,
        artists: (t.artists || []).slice(0, 1).map((a) => ({ id: idFromHref(a.href), name: a.name })),
        album: null,
        durationMs: t.durationMs ?? null,
        explicit: null,
        popularity: typeof t.popularity === 'number' ? t.popularity : null,
        partial: true,
      };
    })
    .filter(Boolean);
}

// ---------------- Last.fm ----------------
export const getLastfmKey = () => store.get('spm.lastfmKey', '');

const lfLimit = pLimit(4);
const lfMemo = new Map();

async function lastfm(method, params) {
  const key = getLastfmKey();
  if (!key) return null;
  const qs = new URLSearchParams({ method, ...params, api_key: key, format: 'json', autocorrect: '1' });
  const memoKey = qs.toString();
  if (lfMemo.has(memoKey)) return lfMemo.get(memoKey);
  const p = lfLimit(async () => {
    const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${qs}`).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) : {};
    if (d.error) {
      if (d.error === 10 || d.error === 26) throw new Error('Last.fm の API キーが正しくありません（設定を確認してください）');
      return null;
    }
    return d;
  });
  lfMemo.set(memoKey, p);
  p.catch(() => lfMemo.delete(memoKey));
  return p;
}

/** 似たアーティスト [{name, match(0-1)}] */
export async function similarArtists(name, limit = 15) {
  const d = await lastfm('artist.getsimilar', { artist: name, limit: String(limit) });
  return (d?.similarartists?.artist || []).map((a) => ({ name: a.name, match: Number(a.match) || 0 }));
}

/** アーティストの代表曲（再生数順） [{name, artist}] */
export async function artistTopTracks(name, limit = 10) {
  const d = await lastfm('artist.gettoptracks', { artist: name, limit: String(limit) });
  return (d?.toptracks?.track || []).map((t) => ({ name: t.name, artist: t.artist?.name || name }));
}

/** 曲単位で似ている曲（Last.fm の聴取傾向ベース） [{name, artist, match(0-1)}] */
export async function similarTracks(artist, track, limit = 100) {
  const d = await lastfm('track.getsimilar', { artist, track, limit: String(limit) });
  return (d?.similartracks?.track || [])
    .map((t) => ({ name: t.name, artist: t.artist?.name, match: Number(t.match) || 0 }))
    .filter((t) => t.artist);
}

/** タグ（ジャンル・年代）の定番曲。page は 1 から。 {tracks:[{name, artist}], totalPages} */
export async function tagTopTracks(tag, page = 1, limit = 50) {
  const d = await lastfm('tag.gettoptracks', { tag, page: String(page), limit: String(limit) });
  const tracks = (d?.tracks?.track || []).map((t) => ({ name: t.name, artist: t.artist?.name })).filter((t) => t.artist);
  const totalPages = Number(d?.tracks?.['@attr']?.totalPages) || 0;
  return { tracks, totalPages };
}

// ---------------- Wikidata（Spotify のアーティスト ID → 国） ----------------
// P1902 = Spotify artist ID, P495 = 起源国, P740 = 結成地, P27 = 国籍, P297 = ISO 国コード
const WD_KEY = 'spm.wdCountry';
const wdCache = store.get(WD_KEY, {}); // id -> { o: [起源国・結成国], n: [国籍] }
const wdLimit = pLimit(2);

/** Spotify アーティスト ID の配列 → キャッシュに国を入れる（見つからなければ空） */
export async function lookupCountriesById(ids) {
  const todo = [...new Set(ids.filter((id) => id && !(id in wdCache)))];
  await Promise.all(
    chunk(todo, 80).map((g) =>
      wdLimit(async () => {
        const values = g.map((id) => `"${id.replace(/[^A-Za-z0-9]/g, '')}"`).join(' ');
        const query = `SELECT ?sid ?oc ?fc ?nc WHERE { VALUES ?sid { ${values} } ?item wdt:P1902 ?sid .
          OPTIONAL { ?item wdt:P495 ?o . ?o wdt:P297 ?oc }
          OPTIONAL { ?item wdt:P740 ?f . ?f wdt:P17 ?fco . ?fco wdt:P297 ?fc }
          OPTIONAL { ?item wdt:P27 ?n . ?n wdt:P297 ?nc } }`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        try {
          const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, {
            headers: { Accept: 'application/sparql-results+json' },
            signal: ctrl.signal,
          });
          if (!res.ok) return; // 失敗時はキャッシュしない（次回また調べる）
          const d = await res.json();
          const found = new Map();
          for (const b of d.results?.bindings || []) {
            const id = b.sid.value;
            const e = found.get(id) || { o: new Set(), n: new Set() };
            if (b.oc) e.o.add(b.oc.value);
            if (b.fc) e.o.add(b.fc.value);
            if (b.nc) e.n.add(b.nc.value);
            found.set(id, e);
          }
          for (const id of g) {
            const e = found.get(id);
            wdCache[id] = e ? { o: [...e.o], n: [...e.n] } : { o: [], n: [] };
          }
        } catch {
          /* タイムアウトなどは無視 */
        } finally {
          clearTimeout(timer);
        }
      }),
    ),
  );
  store.set(WD_KEY, wdCache);
}

/** キャッシュ済みの国コード配列（起源国を優先し、なければ国籍）。未調査なら undefined */
export function cachedCountriesById(id) {
  const e = wdCache[id];
  if (!e) return undefined;
  return e.o.length ? e.o : e.n;
}

// ---------------- MusicBrainz ----------------
const MB = 'https://musicbrainz.org/ws/2';
const MB_CACHE_KEY = 'spm.mbCountry2';
const mbCache = store.get(MB_CACHE_KEY, {});
let mbChain = Promise.resolve();
let mbLast = 0;

// MusicBrainz は 1 秒 1 リクエストの制限があるので直列化する
function mbFetch(path, params) {
  const run = async () => {
    const wait = mbLast + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    mbLast = Date.now();
    const res = await fetch(`${MB}${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.status === 503) {
      await sleep(1500);
      mbLast = Date.now();
      const r2 = await fetch(`${MB}${path}?${new URLSearchParams({ ...params, fmt: 'json' })}`);
      return r2.ok ? r2.json() : null;
    }
    return res.ok ? res.json() : null;
  };
  const p = mbChain.then(run, run);
  mbChain = p.catch(() => {});
  return p;
}

// 地域（国・都道府県・都市）から ISO 国コードを取り出す
const areaCountry = (area) =>
  area?.['iso-3166-1-codes']?.[0] || (area?.['iso-3166-2-codes']?.[0] || '').slice(0, 2).toUpperCase() || '';

const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

/** アーティスト名 → ISO 国コード（不明なら ''） */
export async function artistCountry(name) {
  const k = norm(name);
  if (k in mbCache) return mbCache[k];
  const d = await mbFetch('/artist/', { query: `artist:${quote(name)}`, limit: '5' }).catch(() => null);
  let code = '';
  const list = d?.artists || [];
  const exact = list.filter((a) => norm(a.name) === k || (a.aliases || []).some((al) => norm(al.name) === k));
  const best = exact.sort((a, b) => (b.score || 0) - (a.score || 0))[0] || (list[0]?.score === 100 ? list[0] : null);
  if (best) code = best.country || areaCountry(best.area) || areaCountry(best['begin-area']) || '';
  if (d) {
    mbCache[k] = code;
    store.set(MB_CACHE_KEY, mbCache);
  }
  return code;
}

export const cachedCountry = (name) => mbCache[norm(name)];

/** 国（＋ジャンルタグ）からアーティスト名を探す */
export async function artistsByCountry(code, tag, limit = 20) {
  let q = `country:${code}`;
  if (tag) q += ` AND tag:${quote(tag)}`;
  const d = await mbFetch('/artist/', { query: q, limit: String(limit) }).catch(() => null);
  const names = [];
  for (const a of d?.artists || []) {
    names.push(a.name);
    mbCache[norm(a.name)] = a.country || code;
  }
  store.set(MB_CACHE_KEY, mbCache);
  return names;
}

// ---------------- Deezer（キー不要）：テーマの公開プレイリスト ----------------
// Deezer の API はブラウザからの fetch を許していないので JSONP で呼ぶ（四辻 NEXT と同じ）
const dzLimit = pLimit(4);
function jsonp(url, timeout = 12000) {
  return dzLimit(
    () =>
      new Promise((resolve, reject) => {
        const cb = 'pfdz' + Math.random().toString(36).slice(2);
        const s = document.createElement('script');
        const done = () => {
          clearTimeout(timer);
          delete window[cb];
          s.remove();
        };
        const timer = setTimeout(() => (done(), reject(new Error('Deezer が応答しません'))), timeout);
        window[cb] = (d) => (done(), resolve(d));
        s.onerror = () => (done(), reject(new Error('Deezer に接続できません')));
        s.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
        document.head.appendChild(s);
      }),
  );
}

/**
 * テーマの言葉で Deezer の公開プレイリストを探し、何本のプレイリストに入っているかで曲を並べる。
 * 人が「ハロウィンのプレイリスト」に入れた曲＝その時期に実際によく流れる曲。
 * 返り値: { tracks: [{title, artist, isrc, lists, score, from: [プレイリスト名]}], playlists }（score＝収録数、映画系は 0.5 として数える。多い順）
 */
// 映画・ドラマのサントラ、子ども向け、作業用 BGM などのプレイリストは「その場面で流れる曲」とは限らないので、半分の重みにする
// （例: ハロウィンで『ビートルジュース』の Jump in the Line が入る）
const DZ_WEAK = /soundtrack|movie|film|cin[eé]ma|\bost\b|score|tim burton|wednesday|buffy|addams|beetlejuice|series|tv|kids|enfant|kinder|bibi|lofi|lo-fi|classical|classique|klassik|piano|sleep|study|サントラ|映画|ドラマ|キッズ|子ども/i;
export const dzWeak = (title) => DZ_WEAK.test(title || '');

export async function deezerThemeTracks(queries, { maxLists = 20 } = {}) {
  const seen = new Map();
  for (const q of queries) {
    const d = await jsonp(`https://api.deezer.com/search/playlist?q=${encodeURIComponent(q)}&limit=25`).catch(() => null);
    for (const p of d?.data || []) {
      // 曲が少なすぎる・多すぎる（全集のような）プレイリストは外す
      if (p.nb_tracks < 10 || p.nb_tracks > 400 || seen.has(p.id)) continue;
      seen.set(p.id, p);
    }
    if (seen.size >= maxLists) break;
  }
  const lists = [...seen.values()].slice(0, maxLists);
  const count = new Map();
  await Promise.all(
    lists.map(async (p) => {
      const d = await jsonp(`https://api.deezer.com/playlist/${p.id}/tracks?limit=100`).catch(() => null);
      const inList = new Set();
      for (const t of d?.data || []) {
        const key = t.isrc || `${norm(t.artist?.name)}|${norm(t.title_short || t.title)}`;
        if (inList.has(key)) continue;
        inList.add(key);
        const e = count.get(key) || { title: t.title_short || t.title, artist: t.artist?.name || '', isrc: t.isrc || '', lists: 0, score: 0, from: [], rank: 0 };
        e.lists++;
        e.score += dzWeak(p.title) ? 0.5 : 1;
        e.from.push(p.title);
        e.rank = Math.max(e.rank, t.rank || 0);
        count.set(key, e);
      }
    }),
  );
  const tracks = [...count.values()].sort((a, b) => b.score - a.score || b.rank - a.rank);
  return { tracks, playlists: lists.length };
}

// ---------------- ジャンル（表示用） ----------------
// Last.fm のアーティストのタグからジャンルらしいものを最大 2 つ。キーがない・見つからないときは Deezer のアルバムのジャンル
const GENRE_RE = /\b(punk|rock|pop|metal|core|emo|ska|jazz|soul|funk|disco|house|techno|trance|dub|dubstep|garage|grime|drill|trap|rap|hip ?hop|r&b|rnb|blues|folk|country|indie|wave|gaze|ambient|electro\w*|edm|breaks|breakbeat|jungle|drum and bass|dnb|reggae\w*|latin|bossa|samba|afro\w*|gospel|grunge|psych\w*|prog\w*|lo-?fi|city pop|j-?pop|j-?rock|k-?pop|anime|vocaloid|enka|classical|soundtrack|bebop|industrial|goth\w*|post-\w+|thrash|doom|stoner|grind\w*|rockabilly|dance|synth\w*|chill\w*|downtempo|trip.hop|idm|swing|motown|new jack|acid|big beat|eurobeat|italo|hyperpop|phonk|amapiano|kayokyoku|shibuya-kei|singer-songwriter|acoustic|instrumental|experimental|alternative|bluegrass|americana|calypso|exotica|surf|doo.wop|crooner|easy listening|lounge|bass|club|footwork|juke|ballad)\b/i;
const GENRE_NG = /seen live|favou?rite|vocalists?|^\d0s$|\d{4}|best|awesome|love|beautiful|my |spotify|under \d|american|british|english|japanese|german|french|swedish|canadian|australian|korean|usa|uk$/i;
const GENRE_KEY = 'spm.genreCache';
const genreCache = store.get(GENRE_KEY, {});
let genreTimer = null;
const saveGenres = () => {
  clearTimeout(genreTimer);
  genreTimer = setTimeout(() => {
    const keys = Object.keys(genreCache);
    for (const k of keys.slice(0, Math.max(0, keys.length - 5000))) delete genreCache[k];
    store.set(GENRE_KEY, genreCache);
  }, 1000);
};
export const cachedGenres = (artist) => genreCache[norm(artist)];

export async function artistGenres(artist, title = '') {
  const k = norm(artist);
  if (k in genreCache) return genreCache[k];
  let out = [];
  if (getLastfmKey()) {
    const d = await lastfm('artist.gettoptags', { artist }).catch(() => null);
    out = (d?.toptags?.tag || [])
      .map((t) => String(t.name || '').toLowerCase().trim())
      .filter((t) => t && t.split(/\s+/).length <= 3 && GENRE_RE.test(t) && !GENRE_NG.test(t))
      .slice(0, 2);
  }
  if (!out.length) {
    // Deezer：曲を検索 → アルバムのジャンル（Pop・Rock のような大まかな分類）
    const q = `${artist} ${title}`.trim(); // Deezer の artist:"…" 指定は JSONP では効かないので、普通の検索で
    const s = await jsonp(`https://api.deezer.com/search?limit=1&q=${encodeURIComponent(q)}`).catch(() => null);
    const al = s?.data?.[0]?.album?.id;
    if (al) {
      const a = await jsonp(`https://api.deezer.com/album/${al}`).catch(() => null);
      out = (a?.genres?.data || []).map((g) => String(g.name).toLowerCase()).slice(0, 2);
    }
  }
  genreCache[k] = out;
  saveGenres();
  return out;
}
