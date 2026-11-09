// 候補収集 → 特徴量取得 → 絞り込み → スコアリング → 選曲
import * as sp from './spotify.js';
import * as src from './sources.js';
import { FEATURES, themeTags } from './data.js';
import { suggestThemeTracks, getClaudeKey } from './nl.js';
import { norm, baseTitle, shuffle, pLimit } from './util.js';

const FEAT_DEF = Object.fromEntries(FEATURES.map((f) => [f.key, f]));

const q = (s) => `"${String(s).replace(/"/g, '')}"`;

function yearFilter(c) {
  const from = c.yearFrom || null;
  const to = c.yearTo || null;
  if (!from && !to) return '';
  return `year:${from || 1900}-${to || new Date().getFullYear()}`;
}

const join = (...parts) => parts.filter(Boolean).join(' ');

// 文字種から国を推定（かな → 日本、ハングル → 韓国）
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
function scriptCountry(text) {
  if (KANA.test(text)) return 'JP';
  if (HANGUL.test(text)) return 'KR';
  return '';
}

// 年代タグ（Last.fm の表記：80s, 90s, 00s, 2010s など）
function decadeTagOf(c) {
  if (!c.yearFrom || !c.yearTo || c.yearTo - c.yearFrom !== 9 || c.yearFrom % 10 !== 0) return null;
  const y = c.yearFrom;
  if (y < 2000) return `${String(y).slice(2)}s`;
  if (y === 2000) return '00s';
  return `${y}s`;
}


export async function generate(c, onProgress = () => {}) {
  const log = (msg, pct) => onProgress(msg, pct);
  const depth = c.depth || 2;
  const size = c.size || 200;
  const maxPer = c.maxPerArtist || 2;
  // 1 回に検索するページ数（Spotify 検索は 1 回 10 曲まで）。足りなければ回数を重ねて増やす
  const pages = { 1: 2, 2: 3, 3: 5 }[depth];
  // 追加で探す時間の目安。指定曲数に届くまでは、候補が尽きるか上限時間まで探し続ける
  const softMs = { 1: 2, 2: 4, 3: 8 }[depth] * 60000;
  const hardMs = 15 * 60000;
  const useLastfm = !!src.getLastfmKey();
  const seedTrackIds = [];
  const yf = yearFilter(c);
  const pool = new Map();
  const seedIds = new Set((c.seedArtists || []).map((a) => a.id));
  const seedNames = new Set((c.seedArtists || []).map((a) => norm(a.name)));
  const excludeArtistNames = new Set((c.excludeArtists || []).map(norm));
  // 似せたい曲（Spotify の曲 {id, name, artist}）
  const seedTracks = (c.seedTracks || []).filter((t) => t?.id);
  const seedTrackSet = new Set(seedTracks.map((t) => t.id));
  const seedTrackKeys = new Set(seedTracks.map((t) => `${norm(t.artist)}|${baseTitle(t.name)}`));
  const hasSimilarSeeds = ((c.seedArtists || []).length > 0 && c.seedMode !== 'only') || seedTracks.length > 0;
  // テーマ（例: halloween）。指定したら、テーマに合う曲だけから選ぶ（年代・国・サウンドは絞り込みとして効く）
  const tTags = themeTags(c.theme);
  const themeMode = tTags.length > 0;
  // キーワードは「曲名・アルバム名・アーティスト名に全部の語が含まれる曲だけ」の絞り込みとして使う
  const kwWords = norm(c.keywords || '').split(/\s+/).filter(Boolean);
  const hasKeywords = (t) => {
    if (!kwWords.length) return true;
    const hay = norm(`${t.name} ${t.album?.name || ''} ${t.artists.map((a) => a.name).join(' ')}`);
    return kwWords.every((w) => hay.includes(w));
  };

  // themeHit: テーマの別々の根拠（タグ・Claude）で何回見つかったか
  const add = (t, source, weight = 0, themeHit = 0) => {
    if (!t?.id) return;
    let e = pool.get(t.id);
    if (!e) {
      e = { ...t, sources: new Map() };
      pool.set(t.id, e);
    } else if (e.partial && !t.partial) {
      Object.assign(e, t, { sources: e.sources, partial: false });
    }
    e.sources.set(source, Math.max(e.sources.get(source) || 0, weight));
    if (themeHit) e.themeHits = (e.themeHits || 0) + themeHit;
  };

  const searchPages = async (query, n, filterFn) => {
    const offsets = Array.from({ length: n }, (_, i) => i * 10);
    const results = await Promise.all(offsets.map((o) => sp.searchTracks(query, o).catch(() => [])));
    const out = results.flat();
    return filterFn ? out.filter(filterFn) : out;
  };

  const isArtist = (name) => (t) => t.artists.some((a) => norm(a.name) === norm(name));
  const excCodes = new Set(c.excludeCountries || []);
  const scriptExcluded = (text) => {
    const sc = scriptCountry(text);
    return !!sc && excCodes.has(sc);
  };

  const tasks = [];

  // 似ている曲（Last.fm：曲単位の類似＋似たアーティストの代表曲）
  async function gatherSimilar() {
    log('似ている曲を Last.fm で探しています…', 12);
    const lf = new Map();
    const put = (artist, name, score) => {
      const ak = norm(artist);
      if (c.seedMode === 'similar' && seedNames.has(ak)) return;
      if (excludeArtistNames.has(ak) || scriptExcluded(`${artist} ${name}`)) return;
      const k = `${ak}|${baseTitle(name)}`;
      if (seedTrackKeys.has(k)) return;
      const e = lf.get(k);
      if (!e) lf.set(k, { artist, name, score, hits: 1 });
      else {
        e.score = Math.max(e.score, score);
        e.hits++;
      }
    };
    const topN = { 1: 3, 2: 5, 3: 8 }[depth];
    // 1 アーティストあたりの上限があるので、曲数をそろえるには十分な人数のアーティストが必要
    const needArtists = Math.ceil((size / maxPer) * 1.6);
    const perArtistTop = maxPer + 2;
    const simScore = new Map(); // 似たアーティスト（正規化名 → {name, match}）
    const setSim = (name, match) => {
      const k = norm(name);
      if (seedNames.has(k) || excludeArtistNames.has(k)) return;
      if ((simScore.get(k)?.match ?? -1) < match) simScore.set(k, { name, match });
    };
    // 似せたい曲：その曲と「一緒に聴かれている曲」がいちばん確か。曲のアーティストに似た人も候補にする
    await Promise.all(
      seedTracks.map(async (st) => {
        const [sims, simA] = await Promise.all([
          src.similarTracks(st.artist, st.name, 250).catch(() => []),
          src.similarArtists(st.artist, Math.min(100, Math.max(30, needArtists))).catch(() => []),
        ]);
        sims.forEach((x) => put(x.artist, x.name, 0.4 + 0.5 * x.match));
        simA.forEach((x) => setSim(x.name, x.match * 0.85));
      }),
    );
    await Promise.all(
      (c.seedMode === 'only' ? [] : c.seedArtists || []).map(async (a) => {
        const [tops, simA] = await Promise.all([
          src.artistTopTracks(a.name, topN),
          src.similarArtists(a.name, Math.min(100, Math.max(30, needArtists))),
        ]);
        simA.forEach((x) => setSim(x.name, x.match));
        // 本人の代表曲と「一緒に聴かれている曲」= いちばん精度が高い
        await Promise.all(
          tops.map(async (t) => {
            const sims = await src.similarTracks(t.artist, t.name, 100).catch(() => []);
            sims.forEach((x) => put(x.artist, x.name, 0.25 + 0.45 * x.match));
          }),
        );
      }),
    );
    // Spotify で照合できた曲を、アーティストごとに数える
    const resolvedPerArtist = new Map();
    const capacity = () => [...resolvedPerArtist.values()].reduce((sum, n) => sum + Math.min(n, maxPer), 0);
    const target = Math.ceil(size * 1.15);
    const tried = new Set(); // 照合済みの曲キー
    const toppedArtists = new Set(); // 代表曲を取得済みのアーティスト
    const usedHubs = new Set();
    let lookups = 0;

    const fetchTopTracks = (artists) =>
      Promise.all(
        artists.map(async (x) => {
          const k = norm(x.name);
          if (toppedArtists.has(k)) return;
          toppedArtists.add(k);
          const tt = await src.artistTopTracks(x.name, perArtistTop).catch(() => []);
          tt.forEach((t, i) => put(x.name, t.name, 0.1 + 0.35 * x.match * (1 - i / (perArtistTop * 2))));
        }),
      );

    const resolveRound = async (limitN, pct) => {
      const capA = new Map();
      for (const [k, e] of lf) if (tried.has(k)) capA.set(norm(e.artist), (capA.get(norm(e.artist)) || 0) + 1);
      const ranked = [...lf.entries()]
        .filter(([k]) => !tried.has(k))
        .map(([k, e]) => ({ k, ...e, score: e.score + Math.min(0.15, 0.05 * (e.hits - 1)) }))
        .sort((x, y) => y.score - x.score);
      const pick = [];
      for (const e of ranked) {
        if (pick.length >= limitN) break;
        const ak = norm(e.artist);
        const n = capA.get(ak) || 0;
        if (n >= maxPer + 1) continue;
        capA.set(ak, n + 1);
        pick.push(e);
      }
      let done = 0;
      await Promise.all(
        pick.map(async (e) => {
          tried.add(e.k);
          lookups++;
          const t = await sp.resolveTrack(e.artist, e.name, yf).catch(() => null);
          done++;
          if (done % 10 === 0) log(`似ている曲を Spotify で照合しています… ${capacity()}/${target}`, pct);
          if (t) {
            add(t, 'similar', e.score);
            const ak = norm(e.artist);
            resolvedPerArtist.set(ak, (resolvedPerArtist.get(ak) || 0) + 1);
          }
        }),
      );
      return pick.length;
    };

    // 1 回目：直接似ているアーティストと、一緒に聴かれている曲
    await fetchTopTracks([...simScore.values()]);
    log('似ている曲を Spotify で照合しています…', 20);
    await resolveRound(Math.min(500, Math.ceil(size * { 1: 1.5, 2: 2.5, 3: 4 }[depth])), 24);

    // 足りなければ「似たアーティストに似たアーティスト」へ広げて、照合を繰り返す
    for (let round = 0; round < 4 && capacity() < target; round++) {
      const short = target - capacity();
      log(`似ているアーティストの範囲を広げています…（あと ${short} 曲分）`, 26 + round * 2);
      const hubs = [...simScore.values()]
        .filter((h) => !usedHubs.has(norm(h.name)))
        .sort((x, y) => y.match - x.match)
        .slice(0, Math.min(20, Math.ceil(short / maxPer / 6) + 3));
      const fresh = new Map();
      await Promise.all(
        hubs.map(async (h) => {
          usedHubs.add(norm(h.name));
          const s2 = await src.similarArtists(h.name, 50).catch(() => []);
          for (const x of s2) {
            const k = norm(x.name);
            if (seedNames.has(k) || excludeArtistNames.has(k) || simScore.has(k)) continue;
            const m = h.match * x.match * 0.8;
            if ((fresh.get(k)?.match ?? -1) < m) fresh.set(k, { name: x.name, match: m });
          }
        }),
      );
      const add2 = [...fresh.values()].sort((x, y) => y.match - x.match).slice(0, Math.ceil((short / maxPer) * 1.8) + 5);
      add2.forEach((x) => setSim(x.name, x.match));
      await fetchTopTracks(add2);
      const n = await resolveRound(Math.min(300, Math.ceil(short * 2)), 28 + round * 2);
      if (!n && !add2.length) break;
    }
    console.info('[playlist-forge] similar', { lookups, artists: resolvedPerArtist.size, capacity: capacity(), target });
  }

  // ---- 1. 候補を集める（一度だけ実行するもの） ----
  log('候補曲を集めています…', 5);
  if (!themeMode) {

  // レーベル（アルバム検索 → 収録曲）
  for (const label of c.labels || []) {
    tasks.push(
      (async () => {
        const offsets = Array.from({ length: pages + 2 }, (_, i) => i * 10);
        const albums = (await Promise.all(offsets.map((o) => sp.searchAlbums(join(`label:${q(label)}`, yf), o).catch(() => [])))).flat();
        const uniq = [...new Map(albums.map((a) => [a.id, a])).values()].slice(0, 60);
        const lim = pLimit(3);
        const lists = await Promise.all(uniq.map((al) => lim(() => sp.albumTracks(al).catch(() => []))));
        lists.flat().forEach((t) => add(t, 'label', 0.15));
      })(),
    );
  }

  // 似せたいアーティスト
  const rbSeeds = [];
  for (const a of c.seedArtists || []) {
    tasks.push(
      (async () => {
        // 種曲用（年代フィルタなし）
        const own = await searchPages(`artist:${q(a.name)}`, 1, (t) => t.artists.some((x) => x.id === a.id));
        seedTrackIds.push(...own.map((t) => t.id));
        if (!useLastfm) rbSeeds.push(...own.slice(0, 3).map((t) => t.id));
        if (c.seedMode !== 'similar') {
          const ts = await searchPages(join(`artist:${q(a.name)}`, yf), pages + 2, (t) => t.artists.some((x) => x.id === a.id));
          ts.forEach((t) => add(t, 'seed', 0.25));
        }
      })(),
    );
  }

  // 似せたい曲：音の傾向の基準にする（Last.fm キーがなければ ReccoBeats のおすすめの種にも）
  for (const st of seedTracks) {
    seedTrackIds.push(st.id);
    if (!useLastfm) rbSeeds.push(st.id);
  }

  // 自分のよく聴く曲
  if (c.useMyTop) {
    tasks.push(
      sp
        .myTopTracks()
        .then((ts) => rbSeeds.push(...shuffle(ts).slice(0, 5).map((t) => t.id)))
        .catch(() => {}),
    );
  }

  await Promise.all(tasks);
  tasks.length = 0;

  // 似ている曲（Last.fm：曲単位の類似＋似たアーティストの代表曲）
  if (hasSimilarSeeds && useLastfm) {
    await gatherSimilar();
  }
  if (rbSeeds.length) {
    const groups = [];
    const seedsShuffled = shuffle([...new Set(rbSeeds)]);
    for (let i = 0; i < seedsShuffled.length && groups.length < Math.max(depth, Math.ceil(size / 50)); i += 5) groups.push(seedsShuffled.slice(i, i + 5));
    for (const g of groups) {
      tasks.push(src.recommend(g, 100).then((ts) => ts.forEach((t) => add(t, c.useMyTop && !seedIds.size ? 'mytop' : 'similar', 0.2))));
    }
  }

  // 国からアーティストを探す（MusicBrainz）
  if ((c.countries || []).length) {
    log('指定した国のアーティストを探しています…', 25);
    const tags = (c.genres || []).length ? c.genres.slice(0, 3) : [null];
    for (const code of c.countries.slice(0, 3)) {
      for (const tag of tags) {
        const names = await src.artistsByCountry(code, tag, 15).catch(() => []);
        for (const name of names.slice(0, { 1: 5, 2: 10, 3: 15 }[depth])) {
          tasks.push(searchPages(join(`artist:${q(name)}`, yf), 1, isArtist(name)).then((ts) => ts.forEach((t) => add(t, 'country', 0.1))));
        }
      }
    }
  }
  await Promise.all(tasks);
  tasks.length = 0;

  }

  // ---- 2. 足りなければ何度でも追加で集める候補源 ----
  const expanders = [];
  // ジャンル検索（ページを進めていく）
  const searchExpander = (query, source, weight) => {
    let offset = 0;
    const ex = {
      done: false,
      async next() {
        const offsets = Array.from({ length: pages }, (_, i) => offset + i * 10).filter((o) => o < 1000);
        offset += pages * 10;
        if (!offsets.length) return (ex.done = true);
        const results = await Promise.all(offsets.map((o) => sp.searchTracks(query, o).catch(() => [])));
        results.flat().forEach((t) => add(t, source, weight));
        if (results.some((r) => r.length < 10) || offset >= 1000) ex.done = true;
      },
    };
    return ex;
  };
  if (!themeMode) for (const g of c.genres || []) expanders.push(searchExpander(join(`genre:${q(g)}`, yf), 'genre', 0.1));
  // キーワードだけで探すのは、ほかに手がかりがないときだけ（単語が似ているだけの曲を集めないため）
  const otherSources = (c.genres || []).length || (c.seedArtists || []).length || seedTracks.length || (c.labels || []).length || (c.countries || []).length || c.useMyTop;
  if (kwWords.length && !otherSources && !themeMode) expanders.push(searchExpander(join(c.keywords, yf), 'keyword', 0.1));

  // Last.fm のタグ（ジャンル・年代）の定番曲。よく聴かれている代表曲なので重みを高めに
  const decadeTag = decadeTagOf(c);
  const hasSeeds = (c.seedArtists || []).length > 0 || seedTracks.length > 0;
  const tagList = [];
  if (useLastfm && !themeMode) {
    if (decadeTag && ((c.genres || []).length || (!hasSeeds && !(c.labels || []).length))) tagList.push([decadeTag, 0.3]);
    for (const g of (c.genres || []).slice(0, 4)) {
      if (decadeTag) tagList.push([`${decadeTag} ${g}`, 0.3]);
      tagList.push([g, 0.2]);
    }
  }
  const tagTried = new Map(); // アーティスト → 照合した曲数
  const tagExpander = (tag, weight, source = 'tag') => {
    let page = 0;
    let totalPages = 1;
    let buffer = [];
    const ex = {
      done: false,
      async next() {
        while (buffer.length < 60 && page < Math.min(totalPages, 20)) {
          page++;
          const r = await src.tagTopTracks(tag, page, 50).catch(() => ({ tracks: [], totalPages: 0 }));
          totalPages = r.totalPages || 0;
          buffer.push(...r.tracks.map((t, i) => ({ ...t, rank: (page - 1) * 50 + i })));
          if (!r.tracks.length) break;
        }
        // 1 アーティストに偏らないよう、照合は 1 人あたり (上限＋1) 曲まで。除外国の文字（かな・ハングル）は先に外す
        const pick = [];
        const rest = [];
        for (const t of buffer) {
          const ak = norm(t.artist);
          if (excludeArtistNames.has(ak) || (c.seedMode === 'similar' && seedNames.has(ak)) || scriptExcluded(t.artist + ' ' + t.name)) continue;
          if ((tagTried.get(ak) || 0) >= maxPer + 1) continue;
          if (pick.length < 60) {
            pick.push(t);
            tagTried.set(ak, (tagTried.get(ak) || 0) + 1);
          } else rest.push(t);
        }
        buffer = rest;
        await Promise.all(
          pick.map(async (t) => {
            const tr = await sp.resolveTrack(t.artist, t.name, yf).catch(() => null);
            if (tr) add(tr, source, weight * (1 - Math.min(0.5, t.rank / 1000)), source === 'theme' ? 1 : 0);
          }),
        );
        if (!buffer.length && page >= Math.min(totalPages, 20)) ex.done = true;
      },
    };
    return ex;
  };
  for (const [tag, w] of tagList) expanders.push(tagExpander(tag, w));

  // テーマ：Last.fm でそのテーマのタグが付いた曲（聴いた人が「ハロウィンの曲」と認めている曲）＋ Claude が挙げた定番曲
  if (themeMode) {
    // 先頭 2 つ（例: halloween, halloween songs）がテーマそのもの。spooky・horror などは雰囲気が近いだけなので弱く
    if (useLastfm) tTags.forEach((tag, i) => expanders.push(tagExpander(tag, i < 2 ? 0.45 : 0.15, 'theme')));
    if (!useLastfm && !getClaudeKey()) {
      throw new Error('テーマで探すには、Last.fm の API キーか Claude の API キーが必要です。「設定」で入力してください');
    }
    // Claude に定番曲を挙げてもらう。足りなければ「挙げ済み以外で」と何度か頼む（音の条件も伝えて、絞り込みで外れにくくする）
    if (getClaudeKey()) {
      const asked = new Set();
      const soundText = () => {
        const sound = active.map(([k, [lo, hi]]) => {
          const f = FEAT_DEF[k];
          return f.pct ? `${f.label} ${Math.round(lo * 100)}〜${Math.round(hi * 100)}（0〜100）` : `${f.label} ${Math.round(lo)}〜${Math.round(hi)}`;
        });
        if (c.mode === 'major') sound.push('長調');
        if (c.mode === 'minor') sound.push('短調');
        return sound;
      };
      let rounds = 0;
      const ex = {
        done: false,
        async next() {
          rounds++;
          log(`「${c.theme}」に合う曲を Claude に挙げてもらっています…（${rounds} 回目）`, null);
          const picks = await suggestThemeTracks({
            theme: c.theme,
            genres: c.genres || [],
            yearFrom: c.yearFrom,
            yearTo: c.yearTo,
            countries: c.countries || [],
            excludeCountries: c.excludeCountries || [],
            sound: soundText(),
            avoid: [...asked],
            n: Math.min(150, Math.max(60, Math.ceil(size * 0.8))),
          }).catch((e) => {
            console.warn('[playlist-forge] theme picks', e);
            return [];
          });
          const fresh = picks.filter((t) => !asked.has(`${t.title} / ${t.artist}`));
          fresh.forEach((t) => asked.add(`${t.title} / ${t.artist}`));
          if (fresh.length < 10 || rounds >= 6) ex.done = true;
          await Promise.all(
            fresh.map(async (t, i) => {
              if (excludeArtistNames.has(norm(t.artist)) || scriptExcluded(`${t.artist} ${t.title}`)) return;
              const tr = await sp.resolveTrack(t.artist, t.title, yf).catch(() => null);
              if (tr) add(tr, 'theme', 0.5 - Math.min(0.15, (rounds - 1) * 0.03 + i / 1000), 1);
            }),
          );
        },
      };
      expanders.push(ex);
    }
  }

  // 条件に合った曲のアーティストに「似ているアーティスト」の代表曲（Last.fm）。他の候補源が尽きても広げ続けられる
  if (useLastfm && !themeMode) {
    const usedHubs = new Set();
    const relTried = new Set();
    const ex = {
      done: false,
      async next() {
        const hubs = [];
        for (const t of [...accepted].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))) {
          const k = norm(t.artists[0]?.name);
          if (!k || usedHubs.has(k)) continue;
          usedHubs.add(k);
          hubs.push(t.artists[0].name);
          if (hubs.length >= 8) break;
        }
        if (!hubs.length) {
          if (accepted.length) ex.done = true;
          return;
        }
        const sims = (await Promise.all(hubs.map((h) => src.similarArtists(h, 20).catch(() => [])))).flat();
        const fresh = [];
        for (const x of sims.sort((a, b) => b.match - a.match)) {
          const k = norm(x.name);
          if (relTried.has(k) || excludeArtistNames.has(k) || (c.seedMode === 'similar' && seedNames.has(k)) || scriptExcluded(x.name)) continue;
          relTried.add(k);
          fresh.push(x);
          if (fresh.length >= 30) break;
        }
        await Promise.all(
          fresh.map(async (x) => {
            const tops = await src.artistTopTracks(x.name, maxPer + 1).catch(() => []);
            await Promise.all(
              tops.map(async (t) => {
                if (scriptExcluded(t.artist + ' ' + t.name)) return;
                const tr = await sp.resolveTrack(t.artist, t.name, yf).catch(() => null);
                if (tr) add(tr, 'related', 0.12 + 0.1 * x.match);
              }),
            );
          }),
        );
      },
    };
    expanders.push(ex);
  }

  // ---- 3. 評価（特徴量・絞り込み・国）。新しく入った曲だけを毎回処理する ----
  const inc = new Set(c.countries || []);
  const exc = new Set(c.excludeCountries || []);
  const active = Object.entries(c.features || {}).filter(([, r]) => Array.isArray(r));
  const valueOf = (t, k) => (k === 'popularity' ? t.popularity : t.features?.[k]);
  const inRange = (t, k, [lo, hi]) => {
    const v = valueOf(t, k);
    if (v == null) return !c.requireFeatures;
    if (k === 'tempo' && c.halfDouble) return [v, v * 2, v / 2].some((x) => x >= lo && x <= hi);
    return v >= lo && v <= hi;
  };
  // 範囲からの外れ具合（0 = 範囲内。範囲の幅の 25%（BPM は最低 8）までの外れを 0〜1 で表し、それ以上は 2）
  const missOf = (t) => {
    let worst = 0;
    for (const [k, r] of active) {
      if (inRange(t, k, r)) continue;
      const v = valueOf(t, k);
      if (v == null) return 2;
      const [lo, hi] = r;
      const cands = k === 'tempo' && c.halfDouble ? [v, v * 2, v / 2] : [v];
      const dist = Math.min(...cands.map((x) => (x < lo ? lo - x : x - hi)));
      const tol = Math.max((hi - lo) * 0.25, k === 'tempo' ? 8 : k === 'popularity' ? 8 : 0.05);
      if (dist > tol) return 2;
      worst = Math.max(worst, dist / tol);
    }
    return worst;
  };
  const seen = new Set();
  const accepted = [];
  const nearMiss = [];
  let totalCandidates = 0;
  let keywordDropped = 0;
  // どの条件で何曲外れたか（足りないときの説明用）
  const drops = {};
  const drop = (why, n = 1) => n > 0 && (drops[why] = (drops[why] || 0) + n);
  let withFeatures = 0;
  let mbBudget = inc.size ? 80 : 0;

  // 国コードの配列（不明なら []）。Wikidata（Spotify ID で厳密に一致）→ MusicBrainz（名前）→ 文字種の順
  const countriesOf = async (t, allowNetwork) => {
    const a = t.artists[0];
    if (!a) return [];
    let codes = a.id ? src.cachedCountriesById(a.id) : undefined;
    if (codes?.length) return codes;
    const sc = scriptCountry(`${a.name} ${t.name} ${t.album?.name || ''}`);
    if (sc) return [sc];
    let mb = src.cachedCountry(a.name);
    if (mb === undefined && allowNetwork && mbBudget > 0) {
      mbBudget--;
      log(`アーティストの国を確認中… ${a.name}`, null);
      mb = await src.artistCountry(a.name).catch(() => '');
    }
    return mb ? [mb] : [];
  };

  const evaluateNew = async (pct) => {
    let batch = [...pool.values()].filter((t) => !seen.has(t.id));
    batch.forEach((t) => seen.add(t.id));
    batch = batch.filter((t) => {
      if (c.seedMode === 'similar' && t.artists.some((a) => seedIds.has(a.id) || seedNames.has(norm(a.name)))) return false;
      if (t.artists.some((a) => excludeArtistNames.has(norm(a.name)))) return false;
      if (seedTrackSet.has(t.id) || seedTrackKeys.has(`${norm(t.artists[0]?.name)}|${baseTitle(t.name)}`)) return false;
      return true;
    });
    totalCandidates += batch.length;
    const beforeKw = batch.length;
    batch = batch.filter(hasKeywords);
    keywordDropped += beforeKw - batch.length;
    if (!batch.length) return;

    log(`${batch.length} 曲の特徴量（BPM など）を取得しています…`, pct);
    const feats = await src.audioFeatures(batch.map((t) => t.id));
    batch.forEach((t) => (t.features = feats.get(t.id) || null));
    withFeatures += batch.filter((t) => t.features).length;

    {
      // メジャーな曲を優先するため、人気度は常に取得する
      const need = batch.filter((t) => t.popularity == null).map((t) => t.id);
      const pop = await src.popularity(need);
      batch.forEach((t) => {
        if (t.popularity == null && pop.has(t.id)) t.popularity = pop.get(t.id);
      });
    }

    // サウンド条件。わずかに外れた曲は「惜しい曲」として取っておき、曲数が足りないときの補充に使う
    batch = batch.filter((t) => {
      if (c.requireFeatures && active.some(([k]) => k !== 'popularity') && !t.features) return drop('特徴量データがない'), false;
      if (c.mode === 'major' && t.features && t.features.mode !== 1) return drop('調（メジャー）'), false;
      if (c.mode === 'minor' && t.features && t.features.mode !== 0) return drop('調（マイナー）'), false;
      t.miss = missOf(t);
      if (t.miss > 1) {
        const k = active.find(([k, r]) => !inRange(t, k, r))?.[0];
        drop(k ? FEAT_DEF[k].label : 'サウンド');
        return false;
      }
      return true;
    });

    // ReccoBeats 由来の曲はアルバム情報がないので補完
    const partial = batch.filter((t) => t.partial);
    if (partial.length) {
      const lim = pLimit(4);
      await Promise.all(
        shuffle(partial)
          .slice(0, 150)
          .map((t) =>
            lim(async () => {
              const full = await sp.getTrack(t.id).catch(() => null);
              if (full) Object.assign(t, full, { partial: false });
            }),
          ),
      );
      batch = batch.filter((t) => !t.partial);
    }

    // 年代・月・長さ・露骨な表現
    batch = batch.filter((t) => {
      const y = t.album?.year;
      const mo = t.album?.month;
      if (c.yearFrom && (!y || y < c.yearFrom)) return drop('リリース時期'), false;
      if (c.yearTo && (!y || y > c.yearTo)) return drop('リリース時期'), false;
      if (c.yearFrom && c.monthFrom && y === c.yearFrom && (!mo || mo < c.monthFrom)) return drop('リリース時期'), false;
      if (c.yearTo && c.monthTo && y === c.yearTo && (!mo || mo > c.monthTo)) return drop('リリース時期'), false;
      if (c.durationMin && t.durationMs && t.durationMs < c.durationMin * 60000) return drop('曲の長さ'), false;
      if (c.durationMax && t.durationMs && t.durationMs > c.durationMax * 60000) return drop('曲の長さ'), false;
      if (c.excludeExplicit && t.explicit) return drop('Explicit 除外'), false;
      if (c.seedMode === 'similar' && t.artists.some((a) => seedIds.has(a.id))) return false;
      return true;
    });

    // 国
    if (inc.size || exc.size) {
      log('アーティストの国を確認しています…', pct);
      await src.lookupCountriesById(batch.map((t) => t.artists[0]?.id));
      const out = [];
      for (const t of batch) {
        // 含める指定は国が分からないと判定できないので MusicBrainz でも調べる。除外指定は少しだけ
        const codes = await countriesOf(t, inc.size > 0);
        t.countryUnknown = !codes.length;
        if (inc.size && !codes.some((x) => inc.has(x))) {
          drop('アーティストの国');
          continue;
        }
        if (exc.size && codes.some((x) => exc.has(x))) {
          drop('アーティストの国');
          continue;
        }
        out.push(t);
      }
      batch = out;
    }
    for (const t of batch) (t.miss > 0 ? nearMiss : accepted).push(t);
  };

  // 1 人あたりの上限と同名曲を考えたうえで、何曲そろうか
  const capacity = () => {
    const per = new Map();
    const titles = new Set();
    let n = 0;
    for (const t of accepted) {
      const a = t.artists[0]?.id || norm(t.artists[0]?.name);
      const key = `${baseTitle(t.name)}|${norm(t.artists[0]?.name)}`;
      if (titles.has(key) || (per.get(a) || 0) >= maxPer) continue;
      titles.add(key);
      per.set(a, (per.get(a) || 0) + 1);
      n++;
    }
    return n;
  };

  // 多めに集めてから上位を選ぶ（精度優先）
  const target = Math.ceil(size * 1.8);
  if (expanders.length) {
    log('候補曲を集めています…', 28);
    await Promise.all(expanders.map((e) => e.next()));
  }
  if (!pool.size) {
    throw new Error(
      themeMode
        ? `テーマ「${c.theme}」に合う曲が見つかりませんでした。英語のテーマ名（例: halloween, christmas）にするか、年代などの条件をゆるめてください`
        : '条件に合う候補曲が見つかりませんでした。ジャンル・アーティスト・レーベル・キーワードのどれかを指定するか、条件をゆるめてください',
    );
  }
  await evaluateNew(35);
  const startedAt = Date.now();
  let stale = 0;
  for (let round = 1; ; round++) {
    const cap = capacity();
    const elapsed = Date.now() - startedAt;
    // 多めの目標に届いた／指定曲数に届いて目安時間を過ぎた／上限時間／しばらく増えない → 終了
    if (cap >= target || (cap >= size && elapsed > softMs) || elapsed > hardMs || stale >= 5) break;
    const live = expanders.filter((e) => !e.done);
    if (!live.length) break;
    const pct = Math.min(90, 35 + Math.round((cap / target) * 55));
    log(`条件に合う曲 ${cap} / ${size} 曲。追加で探しています…（${round} 回目・${Math.round(elapsed / 1000)} 秒）`, pct);
    await Promise.all(live.map((e) => e.next()));
    await evaluateNew(pct);
    stale = capacity() > cap ? 0 : stale + 1;
  }

  const seedFeats = seedTrackIds.length ? [...(await src.audioFeatures(seedTrackIds)).values()].filter(Boolean) : [];
  // 惜しい曲は、条件どおりの曲で足りないときだけ使う（スコアの末尾に回す）
  let cands = [...accepted, ...nearMiss];

  // ---- 4. スコア ----
  const closeness = (t) => {
    if (!active.length) return 0.5;
    let sum = 0;
    let n = 0;
    for (const [k, [lo, hi]] of active) {
      let v = valueOf(t, k);
      if (v == null) continue;
      if (k === 'tempo' && c.halfDouble) v = [v, v * 2, v / 2].sort((a, b) => Math.abs(a - (lo + hi) / 2) - Math.abs(b - (lo + hi) / 2))[0];
      const half = Math.max((hi - lo) / 2, FEAT_DEF[k].step);
      sum += Math.max(0, 1 - Math.abs(v - (lo + hi) / 2) / half);
      n++;
    }
    return n ? sum / n : 0.3;
  };
  // 似せたいアーティストの「音の傾向」（平均とばらつき）。ユーザーが範囲を指定した項目は除く
  const activeKeys = new Set(active.map(([k]) => k));
  const PROFILE_KEYS = ['energy', 'danceability', 'valence', 'acousticness', 'instrumentalness', 'speechiness', 'tempo'];
  let profile = null;
  if (seedFeats.length >= 3 || (seedTracks.length && seedFeats.length)) {
    profile = PROFILE_KEYS.filter((k) => !activeKeys.has(k))
      .map((k) => {
        const vs = seedFeats.map((f) => f[k]).filter((v) => typeof v === 'number');
        if (vs.length < Math.min(3, seedFeats.length)) return null;
        const mu = vs.reduce((a, b) => a + b, 0) / vs.length;
        const sd = Math.sqrt(vs.reduce((a, b) => a + (b - mu) ** 2, 0) / vs.length);
        return { k, mu, sd: Math.max(sd, k === 'tempo' ? 12 : 0.1) };
      })
      .filter(Boolean);
  }
  const profileSim = (t) => {
    if (!profile?.length || !t.features) return 0.4;
    let sum = 0;
    for (const { k, mu, sd } of profile) {
      let v = t.features[k];
      if (typeof v !== 'number') {
        sum += 0.4;
        continue;
      }
      if (k === 'tempo') v = [v, v * 2, v / 2].sort((a, b) => Math.abs(a - mu) - Math.abs(b - mu))[0];
      const z = (v - mu) / sd;
      sum += Math.exp(-0.5 * z * z);
    }
    return sum / profile.length;
  };
  for (const t of cands) {
    const srcBonus = Math.max(0, ...t.sources.values()) + 0.05 * (t.sources.size - 1);
    // 人気度（メジャーさ）。似たアーティスト探しでは控えめ、ジャンル・年代指定では強め
    // テーマでは「その時期に聴かれているか」を優先し、人気度は控えめに
    const popWeight = activeKeys.has('popularity') ? 0.1 : themeMode ? 0.15 : hasSimilarSeeds ? 0.2 : 0.45;
    const themeBonus = themeMode ? Math.min(0.3, 0.1 * ((t.themeHits || 1) - 1)) : 0;
    const popBonus = t.popularity != null ? (t.popularity / 100) * popWeight : 0;
    // 国を除外する指定で国が分からなかった曲は、分かっている曲より後ろに
    const unknownPenalty = exc.size && t.countryUnknown ? 0.12 : 0;
    // テーマでは BPM などは「絞り込み」として効けば十分なので、範囲の中央に近いかどうかはあまり重視しない
    t.score = closeness(t) * (themeMode ? 0.15 : 0.6) + srcBonus + profileSim(t) * 0.35 + popBonus + themeBonus + Math.random() * 0.04 - unknownPenalty - (t.miss > 0 ? 10 + t.miss : 0);
  }
  cands.sort((a, b) => b.score - a.score);

  // ---- 5. 国を除外する指定：国が分からなかった上位の曲を MusicBrainz で確認 ----
  if (exc.size) {
    const kept = [];
    const per = new Map();
    let budget = Math.ceil(size * 0.8);
    for (const t of cands) {
      const ak = norm(t.artists[0]?.name);
      // 選ばれる見込みのある範囲（1 人あたりの上限まで）だけ確認する
      if ((per.get(ak) || 0) >= maxPer) {
        kept.push(t);
        continue;
      }
      if (t.countryUnknown && kept.length < size * 1.5) {
        let mb = src.cachedCountry(t.artists[0].name);
        if (mb === undefined && budget > 0) {
          budget--;
          log(`アーティストの国を確認中… ${t.artists[0].name}`, 92);
          mb = await src.artistCountry(t.artists[0].name).catch(() => '');
        }
        if (mb && exc.has(mb)) continue;
        if (mb) t.countryUnknown = false;
      }
      per.set(ak, (per.get(ak) || 0) + 1);
      kept.push(t);
    }
    cands = kept;
  }

  // ---- 6. 選曲（同一アーティスト上限・同名曲の重複排除） ----
  const perArtist = new Map();
  const titles = new Set();
  const picked = [];
  let cappedByArtist = 0;
  for (const t of cands) {
    if (picked.length >= size) break;
    const a = t.artists[0]?.id || norm(t.artists[0]?.name);
    const key = `${baseTitle(t.name)}|${norm(t.artists[0]?.name)}`;
    if (titles.has(key)) continue;
    if ((perArtist.get(a) || 0) >= maxPer) {
      cappedByArtist++;
      continue;
    }
    perArtist.set(a, (perArtist.get(a) || 0) + 1);
    titles.add(key);
    picked.push(t);
  }
  // それでも足りなければ、1 アーティストあたりの上限を 1 曲だけゆるめて補う（条件に合う曲を優先）
  let relaxedCap = 0;
  if (picked.length < size) {
    const pickedIds = new Set(picked.map((t) => t.id));
    for (const t of cands) {
      if (picked.length >= size) break;
      if (pickedIds.has(t.id)) continue;
      const a = t.artists[0]?.id || norm(t.artists[0]?.name);
      const key = `${baseTitle(t.name)}|${norm(t.artists[0]?.name)}`;
      if (titles.has(key) || (perArtist.get(a) || 0) >= maxPer + 1) continue;
      perArtist.set(a, (perArtist.get(a) || 0) + 1);
      titles.add(key);
      picked.push(t);
      relaxedCap++;
    }
  }
  const nearUsed = picked.filter((t) => t.miss > 0).length;

  log('完了', 100);
  return {
    tracks: orderTracks(picked, c.order),
    stats: {
      candidates: totalCandidates,
      keywordDropped,
      drops,
      keywords: c.keywords || '',
      withFeatures,
      matched: cands.filter((t) => !(t.miss > 0)).length,
      nearUsed,
      relaxedCap,
      picked: picked.length,
      requested: size,
      cappedByArtist,
      noLastfm: !useLastfm && hasSimilarSeeds,
    },
  };
}

export function orderTracks(tracks, order) {
  const t = tracks.slice();
  const f = (x, k) => x.features?.[k] ?? 0;
  switch (order) {
    case 'shuffle':
      return shuffle(t);
    case 'tempoAsc':
      return t.sort((a, b) => f(a, 'tempo') - f(b, 'tempo'));
    case 'tempoDesc':
      return t.sort((a, b) => f(b, 'tempo') - f(a, 'tempo'));
    case 'energyRise':
      return t.sort((a, b) => f(a, 'energy') - f(b, 'energy'));
    case 'energyArc': {
      const s = t.sort((a, b) => f(a, 'energy') - f(b, 'energy'));
      const up = s.filter((_, i) => i % 2 === 0);
      const down = s.filter((_, i) => i % 2 === 1).reverse();
      return [...up, ...down];
    }
    case 'yearAsc':
      return t.sort((a, b) => (a.album?.year || 0) * 100 + (a.album?.month || 0) - ((b.album?.year || 0) * 100 + (b.album?.month || 0)));
    case 'popularity':
      return t.sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1));
    default:
      return t.sort((a, b) => b.score - a.score);
  }
}
