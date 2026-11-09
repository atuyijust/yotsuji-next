// 文章（フリーワード）→ 検索条件 への変換
//  - Claude API キーがあれば Claude で解釈（高精度）
//  - なければ簡易ルールで解釈
import { FEATURE_KEYS, GENRES, COUNTRIES, MOODS, THEMES } from './data.js';
import { store } from './util.js';

export const getClaudeKey = () => store.get('spm.claudeKey', '');

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.1.0/+esm';
const MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'playlistName', 'explanation', 'genres', 'seedTracks', 'seedArtists', 'seedMode', 'labels', 'keywords',
    'theme', 'yearFrom', 'yearTo', 'monthFrom', 'monthTo', 'countries', 'excludeCountries', 'features', 'mode', 'excludeExplicit', 'size',
  ],
  properties: {
    playlistName: { type: 'string', description: 'プレイリスト名（日本語可・短く）' },
    explanation: { type: 'string', description: 'どう解釈したかを日本語で1〜2文' },
    genres: { type: 'array', items: { type: 'string' }, description: 'Spotify のジャンル名（英小文字。例: rock, new wave, synthpop, j-pop, city pop）。最大4つ' },
    seedTracks: {
      type: 'array',
      description: '似せたい曲（曲名が出てきた場合のみ）。曲名とアーティスト名に分ける',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'artist'],
        properties: { title: { type: 'string' }, artist: { type: 'string' } },
      },
    },
    seedArtists: { type: 'array', items: { type: 'string' }, description: '似せたいアーティスト名（文中に出てきた場合のみ。曲名とセットのアーティストは seedTracks 側に入れ、ここには入れない）' },
    seedMode: { type: 'string', enum: ['include', 'similar', 'only'], description: 'include=本人の曲＋似た曲, similar=本人以外の似たアーティストのみ, only=本人の曲のみ' },
    labels: { type: 'array', items: { type: 'string' }, description: 'レコードレーベル名（指定があれば）' },
    keywords: { type: 'string', description: '曲名・アルバム名に必ず含まれるべき語（「タイトルに love が入る曲」のように明示された場合だけ。それ以外は必ず空文字）' },
    theme: { type: 'string', description: '季節・行事・場面のテーマ（例: ハロウィン、クリスマス、夏、雨、卒業）。その時期によく流れる曲・連想される曲を集めるためのもの。なければ空文字' },
    yearFrom: { type: ['integer', 'null'] },
    yearTo: { type: ['integer', 'null'] },
    monthFrom: { type: ['integer', 'null'], description: 'リリース開始月（1-12）。月の指定がある場合のみ。yearFrom とセット' },
    monthTo: { type: ['integer', 'null'], description: 'リリース終了月（1-12）。月の指定がある場合のみ。yearTo とセット' },
    countries: { type: 'array', items: { type: 'string' }, description: 'アーティストの出身国を限定する ISO 3166-1 alpha-2 コード' },
    excludeCountries: { type: 'array', items: { type: 'string' }, description: '除外する国コード。「洋楽」なら ["JP"]' },
    features: {
      type: 'array',
      description: '音の特徴の範囲。tempo は BPM、popularity は 0-100、他は 0-1',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'min', 'max'],
        properties: {
          key: { type: 'string', enum: FEATURE_KEYS },
          min: { type: 'number' },
          max: { type: 'number' },
        },
      },
    },
    mode: { type: 'string', enum: ['any', 'major', 'minor'] },
    excludeExplicit: { type: 'boolean' },
    size: { type: ['integer', 'null'], description: '曲数の指定があれば' },
  },
};

const SYSTEM = `あなたは Spotify プレイリスト作成アプリの条件変換係です。
ユーザーの日本語の要望を、検索条件の JSON に変換してください。

- 「洋楽」は日本以外のアーティスト（excludeCountries: ["JP"]）、「邦楽」は countries: ["JP"]、「K-POP」は countries: ["KR"] と genres: ["k-pop"]。
- 「1980年代」「80年代」は yearFrom 1980, yearTo 1989。
- 月の指定があれば monthFrom / monthTo も入れる（例:「2024年3月リリース」→ yearFrom 2024, monthFrom 3, yearTo 2024, monthTo 3。「2023年夏」→ 2023年6月〜8月）。月の指定がなければ null。
- シーン（ドライブ・作業・ワークアウト・寝る前など）は、BPM・エネルギー・明るさなどの範囲に置き換える。範囲は狭くしすぎない（例: エネルギー 0.55〜0.9）。
- 年代・地域・シーンからジャンルを推測できる場合は、その時代を代表する Spotify のジャンル名を 2〜4 個入れる（例: 80年代洋楽ドライブ → rock, new wave, synthpop, pop）。
- 「〇〇みたいな」「〇〇っぽい」など、アーティスト名が出てきたら seedArtists に入れる。「〇〇以外で」「〇〇本人は除いて」なら seedMode は similar。特に指定がなければ include。
- 曲名が出てきたら（例:「Cramp Your Style Breakestra」「September / Earth, Wind & Fire みたいな曲」）、その曲に似た曲を求めていると解釈し、seedTracks に { title, artist } で入れる。曲名やアーティスト名を keywords に入れてはいけない。
- 曲名だけで似た曲を求めている場合、ジャンル・年代・国は文中に明示されたときだけ入れる（曲から推測して足さない。似た曲探しの邪魔になるため）。
- ハロウィン・クリスマス・夏・雨・卒業など季節や行事のテーマは theme に入れる（keywords には入れない）。テーマから BPM などの範囲を推測して足さない。
- 指定されていない項目は空配列・null・空文字・any・false にする。`;

let sdkPromise = null;

async function viaClaude(text, apiKey) {
  sdkPromise ??= import(SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude がこの文章の解釈を断りました。言い回しを変えてお試しください');
  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new Error('Claude から結果を受け取れませんでした');
  const out = JSON.parse(block.text);
  const features = {};
  for (const f of out.features || []) features[f.key] = [Math.min(f.min, f.max), Math.max(f.min, f.max)];
  const seedTracks = (out.seedTracks || []).map((t) => ({ name: t.title, artist: t.artist }));
  return { ...out, seedTracks, features, via: 'claude' };
}

// ---------------- テーマに合う曲を Claude に挙げてもらう ----------------
// 返すのは {title, artist} の配列。実在するかは呼び出し側で Spotify に照合して確かめる
const THEME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tracks'],
  properties: {
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'artist'],
        properties: { title: { type: 'string' }, artist: { type: 'string' } },
      },
    },
  },
};

export async function suggestThemeTracks({ theme, genres = [], yearFrom, yearTo, countries = [], excludeCountries = [], n = 80 }) {
  const apiKey = getClaudeKey();
  if (!apiKey) return [];
  sdkPromise ??= import(SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const cond = [
    genres.length ? `ジャンル: ${genres.join(', ')}` : '',
    yearFrom || yearTo ? `リリース年: ${yearFrom || ''}〜${yearTo || ''}` : '',
    countries.length ? `アーティストの国: ${countries.join(', ')}` : '',
    excludeCountries.length ? `除外する国: ${excludeCountries.join(', ')}` : '',
  ].filter(Boolean);
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: THEME_SCHEMA } },
    system:
      'あなたは音楽に詳しい選曲家です。指定されたテーマ（季節・行事・場面）の時期によく流れる曲や、そのテーマを強く連想させる曲を挙げてください。' +
      '曲名にテーマの単語が入っているかどうかは問いません。実在する曲だけを、Spotify で検索できる正式な曲名とアーティスト名で書いてください。定番を優先し、同じアーティストは 2 曲までにしてください。',
    messages: [{ role: 'user', content: `テーマ: ${theme}\n${cond.join('\n')}\n${n} 曲挙げてください。` }],
  });
  const block = res.content.find((b) => b.type === 'text');
  if (!block) return [];
  return (JSON.parse(block.text).tracks || []).filter((t) => t.title && t.artist);
}

// ---------------- 簡易ルール ----------------
const GENRE_WORDS = [
  [/ロック/, 'rock'], [/ハードロック/, 'hard rock'], [/パンク/, 'punk'], [/メタル/, 'metal'],
  [/ポップス?/, 'pop'], [/j-?pop|jポップ/i, 'j-pop'], [/j-?rock/i, 'j-rock'], [/アニソン|アニメ/, 'anime'],
  [/ボカロ|ボーカロイド/, 'vocaloid'], [/シティ\s?ポップ/, 'city pop'], [/k-?pop/i, 'k-pop'],
  [/ヒップホップ|ラップ/, 'hip hop'], [/r&b|アールアンドビー/i, 'r&b'], [/ソウル/, 'soul'], [/ファンク/, 'funk'],
  [/ディスコ/, 'disco'], [/ジャズ/, 'jazz'], [/ボサ\s?ノヴァ|ボサノバ/, 'bossa nova'], [/ブルース/, 'blues'],
  [/カントリー/, 'country'], [/フォーク/, 'folk'], [/レゲエ/, 'reggae'], [/ラテン/, 'latin'],
  [/edm|エレクトロ|クラブ/i, 'edm'], [/ハウス/, 'house'], [/テクノ/, 'techno'], [/トランス/, 'trance'],
  [/ドラムンベース|drum ?(and|&|n) ?bass/i, 'drum and bass'], [/ダブステップ/, 'dubstep'],
  [/lo-?fi|ローファイ/i, 'lo-fi'], [/アンビエント/, 'ambient'], [/クラシック/, 'classical'],
  [/サントラ|サウンドトラック/, 'soundtrack'], [/インディー/, 'indie'], [/シューゲ/, 'shoegaze'],
  [/ニューウェ[ー|イ]ブ/, 'new wave'], [/シンセ\s?ポップ/, 'synthpop'], [/シンセウェ[ー|イ]ブ/, 'synthwave'],
  [/エモ/, 'emo'], [/アコースティック/, 'acoustic'], [/ゴスペル/, 'gospel'], [/アフロ/, 'afrobeats'],
];

const ERA_GENRES = {
  1960: ['rock', 'soul', 'pop'], 1970: ['rock', 'disco', 'soul', 'funk'], 1980: ['rock', 'new wave', 'synthpop', 'pop'],
  1990: ['rock', 'alternative rock', 'pop', 'hip hop'], 2000: ['pop', 'rock', 'r&b'], 2010: ['pop', 'edm', 'indie pop'],
  2020: ['pop', 'indie pop', 'hip hop'],
};

const MOOD_WORDS = [
  [/ドライブ/, 'ドライブ'], [/ワークアウト|筋トレ|ランニング|ジョギング|運動/, 'ワークアウト'],
  [/パーティ|パーリー|盛り上が/, 'パーティー'], [/チル|リラックス|まったり|癒/, 'チル'],
  [/作業|集中|勉強|仕事/, '集中・作業用'], [/朝|爽やか|さわやか/, '朝・爽やか'], [/切ない|泣|失恋|寂し|夜/, '切ない夜'],
  [/ライブ音源|ライブ盤/, 'ライブ音源'],
];

function viaRules(text) {
  const t = text.normalize('NFKC');
  const out = {
    playlistName: '', explanation: '', genres: [], seedArtists: [], seedMode: 'include', labels: [], keywords: '',
    yearFrom: null, yearTo: null, monthFrom: null, monthTo: null, countries: [], excludeCountries: [], features: {}, mode: 'any', excludeExplicit: false, size: null,
    via: 'rules',
  };
  const notes = [];

  // 年代
  let m = t.match(/(19|20)(\d)0\s*年代/) || t.match(/(?<!\d)(\d)0\s*年代/) || t.match(/(?<!\d)(\d)0'?s/i);
  if (m) {
    const decade = m.length === 3 ? Number(`${m[1]}${m[2]}0`) : Number(m[1]) >= 3 ? 1900 + Number(m[1]) * 10 : 2000 + Number(m[1]) * 10;
    out.yearFrom = decade;
    out.yearTo = decade + 9;
    notes.push(`${decade}年代`);
  }
  m = t.match(/((?:19|20)\d{2})\s*[〜~\-–から]+\s*((?:19|20)\d{2})/);
  if (m) {
    out.yearFrom = Number(m[1]);
    out.yearTo = Number(m[2]);
  }
  // 年月（例: 2023年4月〜2024年3月、2024年3月）
  m = t.match(/((?:19|20)\d{2})\s*[年\/\-.]\s*(\d{1,2})\s*月?\s*[〜~\-–から]+\s*((?:19|20)\d{2})\s*[年\/\-.]\s*(\d{1,2})\s*月?/);
  if (m) {
    out.yearFrom = Number(m[1]);
    out.monthFrom = Math.min(12, Math.max(1, Number(m[2])));
    out.yearTo = Number(m[3]);
    out.monthTo = Math.min(12, Math.max(1, Number(m[4])));
    notes.push(`${m[1]}年${out.monthFrom}月〜${m[3]}年${out.monthTo}月`);
  } else if ((m = t.match(/((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月/))) {
    out.yearFrom = out.yearTo = Number(m[1]);
    out.monthFrom = out.monthTo = Math.min(12, Math.max(1, Number(m[2])));
    notes.push(`${m[1]}年${out.monthFrom}月`);
  }

  // 地域
  if (/洋楽/.test(t)) {
    out.excludeCountries = ['JP'];
    notes.push('洋楽');
  }
  if (/邦楽|日本の/.test(t)) {
    out.countries = ['JP'];
    notes.push('邦楽');
  }
  if (/韓国|k-?pop/i.test(t)) out.countries = [...new Set([...out.countries, 'KR'])];
  for (const [code, name] of COUNTRIES) {
    if (code !== 'JP' && t.includes(name) && !out.countries.includes(code)) out.countries.push(code);
  }

  // ジャンル
  for (const [re, g] of GENRE_WORDS) if (re.test(t) && !out.genres.includes(g)) out.genres.push(g);
  for (const g of GENRES) if (g.length > 3 && new RegExp(`\\b${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t) && !out.genres.includes(g)) out.genres.push(g);

  // シーン
  for (const [re, mood] of MOOD_WORDS) {
    if (re.test(t)) {
      Object.assign(out.features, MOODS[mood]);
      notes.push(mood);
      break;
    }
  }
  if (/明るい|元気|ハッピー/.test(t)) out.features.valence = [0.6, 1];
  if (/暗い|ダーク|重い/.test(t)) out.features.valence = [0, 0.35];
  if (/激しい|アップテンポ|ノリ/.test(t)) out.features.energy = [0.7, 1];
  if (/静か|落ち着/.test(t)) out.features.energy = [0, 0.45];
  if (/踊れる|ダンス/.test(t)) out.features.danceability = [0.65, 1];
  if (/インスト|歌なし|歌詞なし/.test(t)) out.features.instrumentalness = [0.6, 1];
  if (/有名|定番|ヒット|人気/.test(t)) out.features.popularity = [55, 100];
  if (/マイナー|隠れた|知る人ぞ知る/.test(t)) out.features.popularity = [0, 45];
  m = t.match(/bpm\s*(\d{2,3})(?:\s*[〜~\-–]\s*(\d{2,3}))?/i) || t.match(/(\d{2,3})(?:\s*[〜~\-–]\s*(\d{2,3}))?\s*bpm/i);
  if (m) out.features.tempo = m[2] ? [Number(m[1]), Number(m[2])] : [Number(m[1]) - 5, Number(m[1]) + 5];

  // 年代からジャンル推測
  if (!out.genres.length && out.yearFrom) {
    const d = Math.floor(out.yearFrom / 10) * 10;
    if (out.countries.includes('JP')) out.genres = d === 1980 ? ['city pop', 'j-pop'] : ['j-pop', 'j-rock'];
    else out.genres = ERA_GENRES[d] || ['pop', 'rock'];
  }
  if (!out.genres.length && out.countries.includes('JP')) out.genres = ['j-pop', 'j-rock'];

  // アーティスト（「〇〇みたいな」「〇〇っぽい」「〇〇に似た」）
  const am = t.match(/([^\s、。,「」]+?)(?:みたいな|っぽい|に似た|風の|のような)/);
  if (am && !/ドライブ|夏|冬|夜|朝|雨|カフェ/.test(am[1])) out.seedArtists = [am[1]];
  if (/以外|本人(は|を)?除/.test(t)) out.seedMode = 'similar';

  // 曲数
  m = t.match(/(\d{1,3})\s*曲/);
  if (m) out.size = Number(m[1]);

  if (/クリーン|子供|こども/.test(t)) out.excludeExplicit = true;

  // テーマ（季節・行事）
  const th = THEMES.find((x) => x.words.test(t));
  if (th) {
    out.theme = th.label;
    notes.push(th.label);
  }

  // 何も読み取れなかったら、曲名＋アーティスト名かもしれないのでキーワードに入れておく（検索時に曲として照合する）
  if (!out.genres.length && !out.seedArtists.length && !out.yearFrom && !notes.length && !Object.keys(out.features).length) out.keywords = text.trim();

  out.playlistName = text.length <= 24 ? text : `${notes.join(' ・ ') || 'おまかせ'} ミックス`;
  out.explanation = `簡易解析で「${[...notes, ...out.genres].join(' / ') || '特徴なし'}」として解釈しました。Claude の API キーを設定すると、より正確に解釈できます。`;
  return out;
}

export async function parseRequest(text) {
  const key = getClaudeKey();
  if (key) return viaClaude(text, key);
  return viaRules(text);
}
