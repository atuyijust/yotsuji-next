import * as sp from './spotify.js';
import { generate, orderTracks } from './engine.js';
import { parseRequest, getClaudeKey } from './nl.js';
import { FEATURES, GENRES, COUNTRIES, COUNTRY_NAME, MOODS, ORDERS, THEMES, themeOf } from './data.js';
import { store, esc, norm } from './util.js';

const $ = (s) => document.querySelector(s);

// ---------------- 状態 ----------------
const state = {
  genres: [],
  seeds: [], // {id, name, image}
  seedTracks: [], // {id, name, artist, image}
  labels: [],
  countries: [],
  exCountries: [],
  exArtists: [],
  features: Object.fromEntries(FEATURES.map((f) => [f.key, { on: false, lo: f.min, hi: f.max }])),
  tracks: [],
  busy: false,
};

// ---------------- 小物 ----------------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function showError(err) {
  const el = $('#error');
  if (!err) {
    el.hidden = true;
    return;
  }
  console.error(err);
  el.textContent = err.message || String(err);
  el.hidden = false;
}

function renderChips(sel, list, label, onRemove, image) {
  const box = $(sel);
  box.innerHTML = list
    .map(
      (item, i) =>
        `<span class="chip">${image && image(item) ? `<img src="${esc(image(item))}" alt="">` : ''}${esc(label(item))}<button type="button" data-i="${i}" aria-label="削除">×</button></span>`,
    )
    .join('');
  box.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      onRemove(Number(b.dataset.i));
    }),
  );
}

function renderAllChips() {
  renderChips('#genres', state.genres, (g) => g, (i) => (state.genres.splice(i, 1), renderAllChips()));
  renderChips('#seeds', state.seeds, (a) => a.name, (i) => (state.seeds.splice(i, 1), renderAllChips()), (a) => a.image);
  renderChips('#seed-tracks', state.seedTracks, (t) => `${t.name} – ${t.artist}`, (i) => (state.seedTracks.splice(i, 1), renderAllChips()), (t) => t.image);
  renderChips('#labels', state.labels, (l) => l, (i) => (state.labels.splice(i, 1), renderAllChips()));
  renderChips('#countries', state.countries, (c) => `${COUNTRY_NAME[c] || c}`, (i) => (state.countries.splice(i, 1), renderAllChips()));
  renderChips('#ex-countries', state.exCountries, (c) => `${COUNTRY_NAME[c] || c} を除外`, (i) => (state.exCountries.splice(i, 1), renderAllChips()));
  renderChips('#ex-artists', state.exArtists, (a) => a, (i) => (state.exArtists.splice(i, 1), renderAllChips()));
}

// ---------------- 特徴量スライダー ----------------
const fmtFeat = (f, v) => (f.pct ? `${Math.round(v * 100)}` : `${Math.round(v)}`);

function buildFeatures() {
  const wrap = $('#features');
  wrap.innerHTML = FEATURES.map(
    (f) => `
    <div class="feat" data-key="${f.key}">
      <div class="feat-head">
        <input type="checkbox" class="feat-on" id="feat-${f.key}" />
        <label for="feat-${f.key}" class="name">${esc(f.label)}</label>
        <span class="sub">${esc(f.hint)}</span>
        <span class="val"></span>
      </div>
      <div class="dual">
        <div class="rail"></div><div class="fill"></div>
        <input type="range" class="lo" min="${f.min}" max="${f.max}" step="${f.step}" aria-label="${esc(f.label)} 下限" />
        <input type="range" class="hi" min="${f.min}" max="${f.max}" step="${f.step}" aria-label="${esc(f.label)} 上限" />
      </div>
    </div>`,
  ).join('');

  for (const f of FEATURES) {
    const row = wrap.querySelector(`[data-key="${f.key}"]`);
    const lo = row.querySelector('.lo');
    const hi = row.querySelector('.hi');
    const on = row.querySelector('.feat-on');
    const touch = () => {
      const s = state.features[f.key];
      let a = Number(lo.value);
      let b = Number(hi.value);
      if (a > b) [a, b] = document.activeElement === lo ? [b, b] : [a, a];
      s.lo = a;
      s.hi = b;
      s.on = true;
      syncFeature(f.key);
    };
    lo.addEventListener('input', touch);
    hi.addEventListener('input', touch);
    on.addEventListener('change', () => {
      state.features[f.key].on = on.checked;
      syncFeature(f.key);
    });
    syncFeature(f.key);
  }
}

function syncFeature(key) {
  const f = FEATURES.find((x) => x.key === key);
  const s = state.features[key];
  const row = document.querySelector(`.feat[data-key="${key}"]`);
  const lo = row.querySelector('.lo');
  const hi = row.querySelector('.hi');
  lo.value = s.lo;
  hi.value = s.hi;
  row.querySelector('.feat-on').checked = s.on;
  row.classList.toggle('on', s.on);
  const pct = (v) => ((v - f.min) / (f.max - f.min)) * 100;
  const fill = row.querySelector('.fill');
  fill.style.left = `${pct(s.lo)}%`;
  fill.style.width = `${pct(s.hi) - pct(s.lo)}%`;
  row.querySelector('.val').textContent = s.on ? `${fmtFeat(f, s.lo)} 〜 ${fmtFeat(f, s.hi)}` : '指定なし';
  // 重なったときに上側のつまみを掴めるように
  lo.style.zIndex = s.lo > (f.min + f.max) / 2 ? 3 : 1;
}

function setFeatures(map, reset = true) {
  for (const f of FEATURES) {
    const r = map?.[f.key];
    const s = state.features[f.key];
    if (Array.isArray(r)) {
      s.on = true;
      s.lo = Math.max(f.min, Math.min(f.max, r[0]));
      s.hi = Math.max(f.min, Math.min(f.max, r[1]));
    } else if (reset) {
      s.on = false;
      s.lo = f.min;
      s.hi = f.max;
    }
    syncFeature(f.key);
  }
}

// ---------------- アーティスト・曲の検索 ----------------
function setupArtistSearch() {
  setupSuggest({
    input: $('#artist-input'),
    list: $('#artist-suggest'),
    search: (v) => sp.searchArtists(v),
    row: (a) => [a.image, a.name, a.genres.slice(0, 3).join(', ')],
    choose: (a) => {
      if (!state.seeds.some((s) => s.id === a.id)) state.seeds.push(a);
    },
  });
  setupSuggest({
    input: $('#track-input'),
    list: $('#track-suggest'),
    search: (v) => sp.searchTracks(v),
    row: (t) => [t.album?.image, t.name, `${t.artists.map((a) => a.name).join(', ')}${t.album?.year ? ` ・ ${t.album.year}` : ''}`],
    choose: (t) => {
      if (!state.seedTracks.some((s) => s.id === t.id)) state.seedTracks.push(seedTrackOf(t));
    },
  });
}

const seedTrackOf = (t) => ({ id: t.id, name: t.name, artist: t.artists[0]?.name || '', image: t.album?.image || null });

function setupSuggest({ input, list, search, row, choose: onChoose }) {
  let timer;
  let items = [];
  let active = -1;
  const close = () => {
    list.hidden = true;
    active = -1;
  };
  const choose = (a) => {
    onChoose(a);
    input.value = '';
    close();
    renderAllChips();
  };
  const render = () => {
    list.innerHTML = items
      .map(
        (a, i) => {
          const [img, title, sub] = row(a);
          return `<li data-i="${i}" class="${i === active ? 'active' : ''}">${img ? `<img src="${esc(img)}" alt="">` : '<span class="ph"></span>'}<span>${esc(title)}<small>${esc(sub)}</small></span></li>`;
        },
      )
      .join('');
    list.hidden = !items.length;
    list.querySelectorAll('li').forEach((li) => li.addEventListener('mousedown', (e) => (e.preventDefault(), choose(items[li.dataset.i]))));
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const v = input.value.trim();
    if (!v) return close();
    timer = setTimeout(async () => {
      if (!sp.isLoggedIn()) {
        items = [];
        list.innerHTML = '<li>先に Spotify にログインしてください</li>';
        list.hidden = false;
        return;
      }
      items = await search(v).catch(() => []);
      active = -1;
      render();
    }, 280);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden || !items.length) return;
    if (e.key === 'ArrowDown') (active = (active + 1) % items.length), render(), e.preventDefault();
    else if (e.key === 'ArrowUp') (active = (active - 1 + items.length) % items.length), render(), e.preventDefault();
    else if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), choose(items[Math.max(active, 0)]));
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

async function resolveSeedNames() {
  for (const s of state.seeds) {
    if (s.id) continue;
    const found = await sp.searchArtists(s.name).catch(() => []);
    const best = found.find((a) => norm(a.name) === norm(s.name)) || found[0];
    if (best) Object.assign(s, best);
  }
  state.seeds = state.seeds.filter((s) => s.id);
  for (const s of state.seedTracks) {
    if (s.id) continue;
    const found = await findTrack(`${s.name} ${s.artist}`, s);
    if (found) Object.assign(s, seedTrackOf(found));
  }
  state.seedTracks = state.seedTracks.filter((s) => s.id);
  // キーワードが「曲名＋アーティスト名」になっていたら、似せたい曲として扱う（単語一致で集めないため）
  const kw = $('#keywords').value.trim();
  if (kw) {
    const found = await findTrack(kw);
    if (found) {
      if (!state.seedTracks.some((s) => s.id === found.id)) state.seedTracks.push(seedTrackOf(found));
      $('#keywords').value = '';
      toast(`キーワードを「似せたい曲：${found.name} – ${found.artists[0]?.name}」に置き換えました`);
    } else if (themeOf(kw) && !$('#theme').value.trim()) {
      // 「halloween」のような行事・季節の語は、曲名の絞り込みではなくテーマとして使う
      $('#theme').value = themeOf(kw).label;
      $('#keywords').value = '';
      toast(`キーワード「${kw}」をテーマに移しました（その時期によく流れる曲を集めます）`);
    } else if (looksLikeGenre(kw)) {
      // 「hardcore punk」のようなジャンル名は、曲名の絞り込みではなくジャンルとして使う
      const g = kw.toLowerCase();
      if (!state.genres.includes(g)) state.genres.push(g);
      $('#keywords').value = '';
      toast(`キーワード「${kw}」をジャンルに移しました`);
    }
  }
  renderAllChips();
}

// ジャンル名らしい語か（既知のジャンル名、または punk・rock などジャンルの語を含む）
const GENRE_ROOTS = /\b(punk|rock|pop|metal|core|hardcore|emo|ska|jazz|soul|funk|disco|house|techno|trance|dub|dubstep|garage|grime|drill|trap|rap|hip ?hop|r&b|blues|folk|country|indie|wave|gaze|shoegaze|ambient|electro|electronica|edm|breaks|breakbeat|jungle|drum and bass|dnb|reggae|reggaeton|latin|bossa|samba|afro\w*|gospel|grunge|psych\w*|prog|lo-?fi|city pop|j-?pop|j-?rock|k-?pop|anime|vocaloid|enka|classical|soundtrack|bebop|industrial|goth\w*|post-\w+|screamo|thrash|doom|sludge|stoner|black metal|death metal|grind\w*|rockabilly)\b/i;
function looksLikeGenre(text) {
  const t = text.trim().toLowerCase();
  if (!t || t.split(/\s+/).length > 4) return false;
  return GENRES.includes(t) || GENRE_ROOTS.test(t);
}

// 文字列から曲を特定する。曲名とアーティスト名の両方が文字列に含まれる曲だけを採用
async function findTrack(text, hint) {
  const loose = (x) => norm(x).replace(/\s*[\(\[（〜~-].*$/, '').replace(/[^\p{L}\p{N}]/gu, '');
  const hay = loose(text);
  const items = await sp.searchTracks(text).catch(() => []);
  return (
    items.find((t) => {
      const title = loose(t.name);
      const artist = loose(t.artists[0]?.name || '');
      if (hint) return title === loose(hint.name) && artist === loose(hint.artist);
      return title.length >= 2 && artist.length >= 2 && hay.includes(title) && hay.includes(artist);
    }) || null
  );
}

// ---------------- 条件の読み書き ----------------
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, v) => {
  const el = document.querySelector(`input[name="${name}"][value="${v}"]`);
  if (el) el.checked = true;
};
const num = (sel) => {
  const v = $(sel).value;
  return v === '' ? null : Number(v);
};

function collectCriteria() {
  const features = {};
  for (const f of FEATURES) {
    const s = state.features[f.key];
    if (s.on) features[f.key] = [s.lo, s.hi];
  }
  return {
    genres: [...state.genres],
    seedArtists: state.seeds.map((s) => ({ id: s.id, name: s.name, image: s.image })),
    seedMode: radio('seedMode'),
    seedTracks: state.seedTracks.map((t) => ({ ...t })),
    labels: [...state.labels],
    keywords: $('#keywords').value.trim(),
    theme: $('#theme').value.trim(),
    useMyTop: $('#use-mytop').checked,
    yearFrom: num('#year-from'),
    yearTo: num('#year-to'),
    monthFrom: num('#month-from'),
    monthTo: num('#month-to'),
    countries: [...state.countries],
    excludeCountries: [...state.exCountries],
    durationMin: num('#dur-min'),
    durationMax: num('#dur-max'),
    excludeArtists: [...state.exArtists],
    excludeExplicit: $('#ex-explicit').checked,
    features,
    mode: radio('mode'),
    halfDouble: $('#half-double').checked,
    requireFeatures: $('#require-features').checked,
    size: num('#size') || 200,
    maxPerArtist: num('#max-per-artist') || 2,
    order: $('#order').value,
    depth: Number($('#depth').value),
  };
}

function applyCriteria(c, { merge = false } = {}) {
  const pick = (k, d) => (c[k] !== undefined ? c[k] : merge ? undefined : d);
  const setList = (key, val) => {
    if (val !== undefined) state[key] = [...val];
  };
  setList('genres', pick('genres', []));
  const seeds = pick('seedArtists', []);
  if (seeds !== undefined) state.seeds = seeds.map((s) => (typeof s === 'string' ? { id: null, name: s } : { ...s }));
  const sts = pick('seedTracks', []);
  if (sts !== undefined) state.seedTracks = sts.map((t) => ({ id: t.id || null, name: t.name || t.title, artist: t.artist, image: t.image || null }));
  setList('labels', pick('labels', []));
  setList('countries', pick('countries', []));
  setList('exCountries', pick('excludeCountries', []));
  setList('exArtists', pick('excludeArtists', []));
  const setVal = (sel, v) => {
    if (v !== undefined) $(sel).value = v ?? '';
  };
  setVal('#keywords', pick('keywords', ''));
  setVal('#theme', pick('theme', ''));
  setVal('#year-from', pick('yearFrom', null));
  setVal('#year-to', pick('yearTo', null));
  setVal('#month-from', pick('monthFrom', null));
  setVal('#month-to', pick('monthTo', null));
  setVal('#dur-min', pick('durationMin', null));
  setVal('#dur-max', pick('durationMax', null));
  if (pick('size', 200) != null) setVal('#size', pick('size', 200));
  setVal('#max-per-artist', pick('maxPerArtist', 2));
  setVal('#order', pick('order', 'score'));
  setVal('#depth', pick('depth', 2));
  const sm = pick('seedMode', 'similar');
  if (sm) setRadio('seedMode', sm);
  const md = pick('mode', 'any');
  if (md) setRadio('mode', md);
  const chk = (sel, v) => {
    if (v !== undefined) $(sel).checked = !!v;
  };
  chk('#use-mytop', pick('useMyTop', false));
  chk('#ex-explicit', pick('excludeExplicit', false));
  chk('#half-double', pick('halfDouble', true));
  chk('#require-features', pick('requireFeatures', true));
  if (c.features !== undefined || !merge) setFeatures(c.features || {});
  renderAllChips();
  store.set('spm.lastCriteria', collectCriteria());
}

// ---------------- プリセット ----------------
const PRESET_KEY = 'spm.presets';
function renderPresets() {
  const presets = store.get(PRESET_KEY, {});
  const sel = $('#preset-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">保存した条件を読み込む</option>' + Object.keys(presets).map((n) => `<option>${esc(n)}</option>`).join('');
  if (presets[cur]) sel.value = cur;
  $('#btn-delete-preset').hidden = !sel.value;
}

// ---------------- 生成 ----------------
function setProgress(msg, pct) {
  $('#progress').hidden = false;
  if (matchMedia('(max-width: 900px)').matches) $('#progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#progress-text').textContent = msg;
  if (pct != null) $('#progress-bar').style.width = `${pct}%`;
}

async function runGenerate() {
  if (state.busy) return;
  if (!sp.isLoggedIn()) return toast('先に Spotify にログインしてください');
  showError(null);
  state.busy = true;
  $('#btn-generate').disabled = true;
  $('#btn-regen').disabled = true;
  $('#empty').hidden = true;
  $('#result').hidden = true;
  $('#saved').hidden = true;
  try {
    setProgress('準備しています…', 2);
    await resolveSeedNames();
    const c = collectCriteria();
    store.set('spm.lastCriteria', c);
    if (!c.theme && !c.genres.length && !c.seedArtists.length && !c.seedTracks.length && !c.labels.length && !c.keywords && !c.useMyTop && !c.countries.length) {
      throw new Error('ジャンル・テーマ・似せたい曲・似せたいアーティスト・レーベル・キーワード・国のうち、少なくとも 1 つを指定してください（文章で指定してもOKです）');
    }
    const { tracks, stats } = await generate(c, setProgress);
    state.tracks = tracks;
    state.stats = stats;
    // 手で名前を編集していなければ、条件に合わせて付け直す
    if (!$('#pl-name').dataset.edited) $('#pl-name').value = $('#pl-name').dataset.suggested || suggestName(c);
    delete $('#pl-name').dataset.suggested;
    if (!tracks.length) {
      throw new Error(
        stats.keywordDropped && stats.keywordDropped >= stats.candidates * 0.9
          ? `条件に合う曲が見つかりませんでした（候補 ${stats.candidates} 曲のうち ${stats.keywordDropped} 曲が、キーワード「${stats.keywords}」を曲名・アルバム名・アーティスト名に含まないため外れました）。\nキーワードは曲名などの絞り込みです。ジャンルとして使いたい場合は「ジャンル」に入れてください。`
          : `条件に合う曲が見つかりませんでした（候補 ${stats.candidates} 曲 → 該当 0 曲）。\nサウンドの範囲を広げる、年代や国の条件をゆるめる、「探す範囲」を広くする、などをお試しください。`,
      );
    }
    renderTracks();
  } catch (e) {
    showError(e);
    if (!state.tracks.length) $('#empty').hidden = false;
    else $('#result').hidden = false;
  } finally {
    state.busy = false;
    $('#progress').hidden = true;
    $('#btn-generate').disabled = false;
    $('#btn-regen').disabled = false;
  }
}

function suggestName(c) {
  const parts = [];
  if (c.theme) parts.push(themeOf(c.theme)?.label || c.theme);
  if (c.seedTracks.length) parts.push(`${c.seedTracks.map((t) => t.name).join('・')} 好きに`);
  else if (c.seedArtists.length) parts.push(`${c.seedArtists.map((a) => a.name).join('・')} 好きに`);
  if (c.monthFrom || c.monthTo) {
    const f = c.yearFrom ? `${c.yearFrom}年${c.monthFrom ? `${c.monthFrom}月` : ''}` : '';
    const t = c.yearTo ? `${c.yearTo}年${c.monthTo ? `${c.monthTo}月` : ''}` : '';
    parts.push(f === t ? f : `${f}〜${t}`);
  } else if (c.yearFrom && c.yearTo && c.yearTo - c.yearFrom === 9) parts.push(`${c.yearFrom}年代`);
  else if (c.yearFrom || c.yearTo) parts.push(`${c.yearFrom || ''}〜${c.yearTo || ''}`);
  if (c.genres.length) parts.push(c.genres.slice(0, 2).join(' / '));
  return parts.join(' ') || 'My Mix';
}

const SRC_LABEL = { seed: '指定', similar: '似ている', genre: 'ジャンル', label: 'レーベル', keyword: 'キーワード', country: '国', mytop: 'あなた向け', tag: '定番', related: '関連', theme: 'テーマ' };

function renderTracks() {
  const list = $('#tracks');
  const t = state.tracks;
  const s = state.stats;
  const mins = Math.round(t.reduce((a, x) => a + (x.durationMs || 0), 0) / 60000);
  $('#stats').textContent = `${t.length} 曲 ・ ${mins >= 60 ? `${Math.floor(mins / 60)}時間` : ''}${mins % 60}分（候補 ${s.candidates} 曲 / 条件一致 ${s.matched} 曲）`;
  const notes = [];
  if (s.requested && t.length < s.requested) {
    notes.push(
      `指定の ${s.requested} 曲に届きませんでした（条件に合う曲が ${s.matched} 曲）。` +
        (s.cappedByArtist ? `「1 アーティストあたり最大」の上限で ${s.cappedByArtist} 曲を外しています。上限を上げると増えます。` : '') +
        '「探す範囲」を広くする、似せたいアーティストやジャンルを増やす、条件をゆるめる、でも増やせます。',
    );
  }
  if (s.requested && t.length < s.requested && s.drops) {
    const top = Object.entries(s.drops).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (top.length) notes.push(`外れた理由：${top.map(([k, n]) => `${k} ${n} 曲`).join('、')}。いちばん多い条件をゆるめると増えます。`);
  }
  if (s.theme) {
    const th = s.theme;
    notes.push(
      `テーマの曲の出どころ：Last.fm のタグ ${th.fromLastfm} 曲、Claude ${th.fromClaude} 曲、両方 ${th.fromBoth} 曲。` +
        (!th.claudeUsed ? '\nClaude の API キーがこのページに設定されていないため、Last.fm のタグだけで選んでいます（Last.fm のタグは洋楽のマニアックな曲に偏りがちです）。「設定」でキーを入れると、誰もが知っている定番曲が増えます。' : '') +
        (th.claudeError ? `\nClaude への問い合わせに失敗しました：${th.claudeError}` : '') +
        (th.soundActive ? '\nBPM などのサウンド条件が付いています。定番曲がこの条件で外れていることがあるので、テーマで探すときは外すのがおすすめです。' : ''),
    );
  }
  if (s.nearUsed) notes.push(`条件どおりの曲だけでは足りなかったため、サウンドの範囲からわずかに外れた曲を ${s.nearUsed} 曲入れています（一覧の後ろの方）。`);
  if (s.relaxedCap) notes.push(`足りない分を補うため、${s.relaxedCap} 組のアーティストは上限より 1 曲多く入れています。`);
  if (s.noLastfm) notes.push('Last.fm の API キーが未設定のため、似ている曲の精度が低くなっています。「設定」でキーを入れてください。');
  $('#gen-note').hidden = !notes.length;
  $('#gen-note').textContent = notes.join('\n');
  list.innerHTML = t
    .map((x, i) => {
      const f = x.features || {};
      const tags = [];
      if (f.tempo) tags.push(`BPM ${f.tempo.toFixed(1)}`);
      const ck = camelot(f.key, f.mode);
      if (ck) tags.push(`<span class="key">${ck}</span>`);
      if (f.energy != null) tags.push(`E ${Math.round(f.energy * 100)}`);
      if (f.danceability != null) tags.push(`D ${Math.round(f.danceability * 100)}`);
      if (f.valence != null) tags.push(`明 ${Math.round(f.valence * 100)}`);
      if (x.popularity != null) tags.push(`人気 ${x.popularity}`);
      const src = [...x.sources.keys()][0];
      return `<li class="track" data-i="${i}">
        <span class="num">${i + 1}</span>
        ${x.album?.image ? `<img src="${esc(x.album.image)}" alt="" loading="lazy">` : '<span class="ph"></span>'}
        <div class="meta">
          <div class="title">${esc(x.name)}${x.explicit ? '<span class="e">E</span>' : ''}</div>
          <div class="sub">${esc(x.artists.map((a) => a.name).join(', '))}${x.album ? ` ・ ${esc(x.album.name)}` : ''}${x.album?.year ? ` ・ ${x.album.year}` : ''}</div>
          <div class="tags">${src ? `<span class="tag src">${SRC_LABEL[src] || src}</span>` : ''}${tags.map((g) => `<span class="tag">${g}</span>`).join('')}</div>
        </div>
        <div class="acts">
          <button class="btn-sm act-copy" title="曲名とアーティスト名をコピー">⎘</button>
          <button class="btn-sm act-queue" title="Spotify のキューに追加">キュー</button>
          <button class="btn-sm act-play" title="Spotify アプリで再生">再生</button>
          <button class="icon-btn play" title="このページで試聴">▶</button>
          <button class="icon-btn up" title="上へ">↑</button>
          <button class="icon-btn rm" title="外す">×</button>
        </div>
      </li>`;
    })
    .join('');
  list.querySelectorAll('.track').forEach((li) => {
    const i = Number(li.dataset.i);
    li.querySelector('.play').addEventListener('click', () => play(state.tracks[i].id));
    li.querySelector('.act-play').addEventListener('click', () => playInApp(state.tracks[i]));
    li.querySelector('.act-queue').addEventListener('click', () => queueInApp(state.tracks[i]));
    li.querySelector('.act-copy').addEventListener('click', () => copyTitle(state.tracks[i]));
    li.querySelector('.rm').addEventListener('click', () => {
      state.tracks.splice(i, 1);
      renderTracks();
    });
    li.querySelector('.up').addEventListener('click', () => {
      if (i === 0) return;
      [state.tracks[i - 1], state.tracks[i]] = [state.tracks[i], state.tracks[i - 1]];
      renderTracks();
    });
  });
  $('#result').hidden = false;
  $('#empty').hidden = true;
}

// Camelot 表記のキー（DJ 向け。yotsuji-next と同じ）
const CAMELOT_MAJ = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MIN = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
function camelot(key, mode) {
  if (key == null || key < 0 || key > 11 || (mode !== 0 && mode !== 1)) return '';
  return mode === 1 ? `${CAMELOT_MAJ[key]}B` : `${CAMELOT_MIN[key]}A`;
}

// Spotify アプリで再生（動いているデバイスがなければ開いている Spotify を探す）
async function playInApp(t) {
  if (!sp.canControlPlayback()) return toast('再生の権限を追加しました。いったんログアウトして、もう一度ログインしてください');
  toast('Spotify に再生を指示中…');
  try {
    const r = await sp.playTrack(t, toast);
    toast(r === 'ok' ? `再生：${t.name}` : 'Spotify で再生が始まりませんでした。Spotify アプリでこの曲を開きます');
  } catch (e) {
    toast(sp.playErr(e, '再生'));
  }
}

async function queueInApp(t) {
  if (!sp.canControlPlayback()) return toast('再生の権限を追加しました。いったんログアウトして、もう一度ログインしてください');
  toast('Spotify のキューに追加中…');
  try {
    await sp.queueTrack(t);
    toast(`キューに追加：${t.name}`);
  } catch (e) {
    toast(sp.playErr(e, 'キュー追加'));
  }
}

async function copyTitle(t) {
  const text = `${t.name} ${t.artists.map((a) => a.name).join(' ')}`;
  try {
    await navigator.clipboard.writeText(text);
    toast(`コピー：${text}`);
  } catch {
    toast('コピーできませんでした');
  }
}

function play(id) {
  $('#player-frame').src = `https://open.spotify.com/embed/track/${id}?utm_source=generator&theme=0`;
  $('#player').hidden = false;
}

async function savePlaylist() {
  if (!state.tracks.length) return;
  const btn = $('#btn-save');
  btn.disabled = true;
  btn.textContent = '保存中…';
  showError(null);
  try {
    const name = $('#pl-name').value.trim() || 'My Mix';
    const wantPublic = document.querySelector('input[name="plVisibility"]:checked')?.value === 'public';
    const pl = await sp.createPlaylist({
      name,
      description: $('#pl-desc').value.trim() || 'Playlist Forge で作成',
      isPublic: wantPublic,
    });
    await sp.addItems(pl.id, state.tracks.map((t) => t.uri));
    // 作成時の公開設定が反映されないことがあるので、設定し直して実際の状態を確認する
    let isPublic = pl.public;
    try {
      isPublic = await sp.setPlaylistPublic(pl.id, wantPublic);
    } catch (e) {
      console.warn('公開設定の変更に失敗', e);
    }
    const url = pl.external_urls?.spotify || `https://open.spotify.com/playlist/${pl.id}`;
    const saved = $('#saved');
    const mismatch = isPublic != null && !!isPublic !== wantPublic;
    saved.innerHTML =
      `「${esc(name)}」を${isPublic ? '公開' : '非公開'}で保存しました（${state.tracks.length} 曲）。 <a href="${esc(url)}" target="_blank" rel="noopener">Spotify で開く</a>` +
      (mismatch
        ? `<br><strong>Spotify 側で${wantPublic ? '公開' : '非公開'}に切り替えられませんでした。</strong>Spotify アプリでプレイリストの「…」メニューから${wantPublic ? '公開' : '非公開'}に変更してください。`
        : '');
    saved.hidden = false;
    toast('Spotify に保存しました');
  } catch (e) {
    showError(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Spotify に保存';
  }
}

// ---------------- 文章で指定 ----------------
async function runNL() {
  const text = $('#nl-input').value.trim();
  if (!text) return;
  const btn = $('#btn-nl');
  btn.disabled = true;
  btn.textContent = getClaudeKey() ? 'Claude が解釈中…' : '解析中…';
  showError(null);
  try {
    const r = await parseRequest(text);
    applyCriteria({
      genres: r.genres,
      seedArtists: r.seedArtists,
      seedMode: r.seedMode,
      seedTracks: r.seedTracks || [],
      labels: r.labels,
      keywords: r.keywords,
      theme: r.theme || '',
      yearFrom: r.yearFrom,
      yearTo: r.yearTo,
      monthFrom: r.monthFrom ?? null,
      monthTo: r.monthTo ?? null,
      countries: r.countries,
      excludeCountries: r.excludeCountries,
      features: r.features,
      mode: r.mode,
      excludeExplicit: r.excludeExplicit,
      ...(r.size ? { size: r.size } : {}),
    }, { merge: true });
    if (r.playlistName) {
      $('#pl-name').dataset.suggested = r.playlistName;
      delete $('#pl-name').dataset.edited;
    }
    const note = $('#nl-note');
    note.textContent = `${r.explanation}　→ 下の条件に反映しました。必要なら調整して「曲を探す」を押してください。`;
    note.hidden = false;
    if (sp.isLoggedIn()) resolveSeedNames();
  } catch (e) {
    showError(new Error(`文章の解釈に失敗しました：${e.message}`));
  } finally {
    btn.disabled = false;
    btn.textContent = '条件に変換';
  }
}

// ---------------- 設定 ----------------
function openSettings() {
  $('#set-client').value = sp.getClientId();
  $('#set-lastfm').value = store.get('spm.lastfmKey', '');
  $('#set-claude').value = store.get('spm.claudeKey', '');
  $('#redirect-uri').textContent = sp.redirectUri();
  $('#settings').showModal();
}

function setupSettings() {
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue !== 'save') return;
    store.set('spm.clientId', $('#set-client').value.trim());
    store.set('spm.lastfmKey', $('#set-lastfm').value.trim());
    store.set('spm.claudeKey', $('#set-claude').value.trim());
    toast('設定を保存しました');
  });
}

async function refreshUser() {
  const loggedIn = sp.isLoggedIn();
  $('#btn-login').hidden = loggedIn;
  $('#btn-logout').hidden = !loggedIn;
  $('#user').textContent = '';
  if (loggedIn) {
    try {
      const u = await sp.me();
      $('#user').textContent = u.display_name || u.id;
    } catch (e) {
      if (e.status === 401 || /ログイン/.test(e.message)) {
        sp.logout();
        refreshUser();
      }
    }
  }
}

// ---------------- 起動 ----------------
function init() {
  // 127.0.0.1 以外（localhost など）で開かれたらリダイレクト URI が合わないので寄せる
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }

  $('#genre-list').innerHTML = GENRES.map((g) => `<option value="${esc(g)}">`).join('');
  const opts = COUNTRIES.map(([c, n]) => `<option value="${c}">${esc(n)}（${c}）</option>`).join('');
  $('#country-select').insertAdjacentHTML('beforeend', opts);
  $('#ex-country-select').insertAdjacentHTML('beforeend', opts);
  $('#order').innerHTML = ORDERS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  $('#reorder').innerHTML = '<option value="">並び替え…</option>' + ORDERS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');

  const decades = [1960, 1970, 1980, 1990, 2000, 2010, 2020];
  $('#decades').innerHTML = decades.map((d) => `<button type="button" data-d="${d}">${String(d).slice(2)}年代</button>`).join('') + '<button type="button" data-d="">指定なし</button>';
  $('#decades').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      const d = b.dataset.d;
      $('#year-from').value = d || '';
      $('#year-to').value = d ? Number(d) + 9 : '';
      $('#month-from').value = '';
      $('#month-to').value = '';
    }),
  );

  $('#moods').innerHTML = Object.keys(MOODS).map((m) => `<button type="button" data-m="${esc(m)}">${esc(m)}</button>`).join('') + '<button type="button" data-m="">クリア</button>';
  $('#moods').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      setFeatures(b.dataset.m ? MOODS[b.dataset.m] : {});
      if (b.dataset.m) toast(`「${b.dataset.m}」の設定を反映しました`);
    }),
  );

  buildFeatures();
  for (const [sel, key, tf] of [['#genre-input', 'genres', (v) => v.toLowerCase()], ['#label-input', 'labels'], ['#ex-artist-input', 'exArtists']]) {
    const input = $(sel);
    const commit = () => {
      const v = (tf || ((x) => x))(input.value.trim());
      if (v && !state[key].some((x) => norm(x) === norm(v))) state[key].push(v);
      input.value = '';
      renderAllChips();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        commit();
      }
    });
    // datalist の候補をクリックで選んだとき
    if (key === 'genres') input.addEventListener('change', () => GENRES.includes(input.value.trim()) && commit());
  }

  for (const [sel, key] of [['#country-select', 'countries'], ['#ex-country-select', 'exCountries']]) {
    $(sel).addEventListener('change', (e) => {
      const v = e.target.value;
      if (v && !state[key].includes(v)) state[key].push(v);
      e.target.value = '';
      renderAllChips();
    });
  }

  setupArtistSearch();
  $('#theme-list').innerHTML = THEMES.map((t) => `<option value="${t.label}"></option>`).join('');
  setupSettings();

  $('#btn-login').addEventListener('click', () => {
    // ログインから戻ったときに条件を戻せるよう保存しておく
    store.set('spm.lastCriteria', collectCriteria());
    sp.login().catch((e) => (toast(e.message), openSettings()));
  });
  $('#btn-logout').addEventListener('click', () => {
    sp.logout();
    refreshUser();
  });
  $('#pl-name').addEventListener('input', () => ($('#pl-name').dataset.edited = '1'));
  $('#btn-generate').addEventListener('click', runGenerate);
  $('#btn-regen').addEventListener('click', runGenerate);
  $('#btn-save').addEventListener('click', savePlaylist);
  $('#btn-nl').addEventListener('click', runNL);
  $('#nl-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runNL();
  });
  $('#reorder').addEventListener('change', (e) => {
    if (!e.target.value) return;
    state.tracks = orderTracks(state.tracks, e.target.value);
    e.target.value = '';
    renderTracks();
  });
  $('#player-close').addEventListener('click', () => {
    $('#player').hidden = true;
    $('#player-frame').src = 'about:blank';
  });

  // プリセット
  renderPresets();
  $('#preset-select').addEventListener('change', (e) => {
    const p = store.get(PRESET_KEY, {})[e.target.value];
    if (p) {
      applyCriteria(p);
      toast(`「${e.target.value}」を読み込みました`);
    }
    $('#btn-delete-preset').hidden = !e.target.value;
  });
  $('#btn-save-preset').addEventListener('click', () => {
    const name = prompt('条件の名前', $('#pl-name').value || '');
    if (!name) return;
    const presets = store.get(PRESET_KEY, {});
    presets[name] = collectCriteria();
    store.set(PRESET_KEY, presets);
    renderPresets();
    $('#preset-select').value = name;
    $('#btn-delete-preset').hidden = false;
    toast('条件を保存しました');
  });
  $('#btn-delete-preset').addEventListener('click', () => {
    const name = $('#preset-select').value;
    const presets = store.get(PRESET_KEY, {});
    delete presets[name];
    store.set(PRESET_KEY, presets);
    $('#preset-select').value = '';
    renderPresets();
  });
  $('#btn-reset').addEventListener('click', () => {
    applyCriteria({});
    $('#nl-input').value = '';
    $('#nl-note').hidden = true;
    toast('条件をリセットしました');
  });

  // 開いたときは条件を初期状態にする。Spotify ログインから戻ってきたときだけ、直前の条件を戻す
  const params = new URLSearchParams(location.search);
  const backFromLogin = params.has('code');
  // 四辻 NEXT から「この曲に似たプレイリスト」で開かれたとき（?seedTrack=曲ID）
  if (params.get('seedTrack')) {
    store.set('spm.pendingSeed', params.get('seedTrack'));
    history.replaceState(null, '', location.pathname);
  }
  // 四辻 NEXT と同じサイトに置いたときは、戻るリンクを出す
  $('#link-next').hidden = !/\/forge\/(index\.html)?$/.test(location.pathname);
  const last = store.get('spm.lastCriteria');
  if (backFromLogin && last) applyCriteria(last);
  else applyCriteria({});

  sp.handleCallback()
    .then((done) => {
      if (done) toast('Spotify にログインしました');
    })
    .catch((e) => showError(e))
    .finally(async () => {
      await refreshUser();
      applyPendingSeed();
    });

  if (!sp.getClientId()) setTimeout(openSettings, 300);
}

// 四辻 NEXT から渡された曲を「似せたい曲」に入れる（未ログインならログイン後に）
async function applyPendingSeed() {
  const id = store.get('spm.pendingSeed');
  if (!id) return;
  if (!sp.isLoggedIn()) return toast('Spotify にログインすると、四辻 NEXT の曲を「似せたい曲」に入れます');
  store.del('spm.pendingSeed');
  const t = await sp.getTrack(id).catch(() => null);
  if (!t) return toast('四辻 NEXT から渡された曲を Spotify で見つけられませんでした');
  state.seedTracks = [seedTrackOf(t)];
  renderAllChips();
  store.set('spm.lastCriteria', collectCriteria());
  toast(`似せたい曲に「${t.name} – ${t.artists[0]?.name || ''}」を入れました`);
}

init();
