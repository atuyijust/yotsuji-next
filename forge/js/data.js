// 静的データ：特徴量の定義、ジャンル候補、国、ムードプリセット

export const FEATURES = [
  { key: 'tempo', label: 'BPM', hint: 'テンポ', min: 50, max: 210, step: 1, unit: '' },
  { key: 'energy', label: 'エネルギー', hint: '激しさ・勢い', min: 0, max: 1, step: 0.01, pct: true },
  { key: 'danceability', label: 'ダンサビリティ', hint: '踊りやすさ', min: 0, max: 1, step: 0.01, pct: true },
  { key: 'valence', label: '明るさ', hint: 'ポジティブさ（Valence）', min: 0, max: 1, step: 0.01, pct: true },
  { key: 'acousticness', label: 'アコースティック度', hint: '生楽器っぽさ', min: 0, max: 1, step: 0.01, pct: true },
  { key: 'instrumentalness', label: 'インスト度', hint: 'ボーカルの少なさ', min: 0, max: 1, step: 0.01, pct: true },
  { key: 'liveness', label: 'ライブ感', hint: 'ライブ録音らしさ', min: 0, max: 1, step: 0.01, pct: true },
  { key: 'speechiness', label: '語り・ラップ度', hint: '話し声の多さ', min: 0, max: 1, step: 0.01, pct: true },
  { key: 'popularity', label: '人気度', hint: '0〜100', min: 0, max: 100, step: 1, unit: '' },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

export const GENRES = [
  'pop', 'j-pop', 'j-rock', 'anime', 'vocaloid', 'city pop', 'k-pop', 'rock', 'alternative rock',
  'indie', 'indie pop', 'indie rock', 'hard rock', 'punk', 'pop punk', 'emo', 'metal', 'shoegaze',
  'math rock', 'post-rock', 'new wave', 'synthpop', 'synthwave', 'hip hop', 'japanese hip hop',
  'rap', 'trap', 'r&b', 'soul', 'funk', 'disco', 'jazz', 'bossa nova', 'blues', 'country', 'folk',
  'singer-songwriter', 'reggae', 'latin', 'reggaeton', 'edm', 'house', 'deep house', 'techno',
  'trance', 'drum and bass', 'dubstep', 'future bass', 'lo-fi', 'chillhop', 'ambient', 'classical',
  'soundtrack', 'gospel', 'afrobeats', 'dance pop', 'electropop', 'acoustic',
];

export const COUNTRIES = [
  ['JP', '日本'], ['US', 'アメリカ'], ['GB', 'イギリス'], ['KR', '韓国'], ['CA', 'カナダ'],
  ['AU', 'オーストラリア'], ['IE', 'アイルランド'], ['FR', 'フランス'], ['DE', 'ドイツ'],
  ['SE', 'スウェーデン'], ['NO', 'ノルウェー'], ['FI', 'フィンランド'], ['DK', 'デンマーク'],
  ['IS', 'アイスランド'], ['NL', 'オランダ'], ['BE', 'ベルギー'], ['IT', 'イタリア'], ['ES', 'スペイン'],
  ['PT', 'ポルトガル'], ['BR', 'ブラジル'], ['MX', 'メキシコ'], ['AR', 'アルゼンチン'],
  ['CO', 'コロンビア'], ['PR', 'プエルトリコ'], ['JM', 'ジャマイカ'], ['NG', 'ナイジェリア'],
  ['ZA', '南アフリカ'], ['IN', 'インド'], ['CN', '中国'], ['TW', '台湾'], ['HK', '香港'],
  ['TH', 'タイ'], ['ID', 'インドネシア'], ['PH', 'フィリピン'], ['NZ', 'ニュージーランド'],
  ['RU', 'ロシア'], ['PL', 'ポーランド'],
];
export const COUNTRY_NAME = Object.fromEntries(COUNTRIES);

// ムードプリセット（特徴量の範囲だけを設定する）
export const MOODS = {
  'ドライブ': { tempo: [100, 135], energy: [0.55, 0.9], valence: [0.45, 1] },
  'ワークアウト': { tempo: [120, 165], energy: [0.75, 1], danceability: [0.55, 1] },
  'パーティー': { danceability: [0.7, 1], energy: [0.7, 1], valence: [0.55, 1] },
  'チル': { tempo: [60, 110], energy: [0, 0.45], acousticness: [0.3, 1] },
  '集中・作業用': { energy: [0.2, 0.6], speechiness: [0, 0.1], instrumentalness: [0.5, 1] },
  '朝・爽やか': { tempo: [95, 130], energy: [0.45, 0.8], valence: [0.6, 1], acousticness: [0.15, 1] },
  '切ない夜': { valence: [0, 0.35], energy: [0.15, 0.6] },
  'ライブ音源': { liveness: [0.7, 1] },
};

export const ORDERS = [
  ['score', 'マッチ度順'],
  ['shuffle', 'シャッフル'],
  ['tempoAsc', 'BPM が上がっていく'],
  ['tempoDesc', 'BPM が下がっていく'],
  ['energyRise', 'だんだん盛り上がる'],
  ['energyArc', '盛り上がって落ち着く'],
  ['yearAsc', '年代順（古い→新しい）'],
  ['popularity', '人気順'],
];

// テーマ（季節・行事・場面）→ Last.fm のタグ。先頭 2 つがテーマそのもの、3 つ目以降は雰囲気が近いだけのタグ（弱く扱う）。曲名に含む語ではなく「連想される曲」を集めるのに使う
export const THEMES = [
  { key: 'halloween', label: 'ハロウィン', words: /ハロウィン|ハロウィーン|halloween/i, tags: ['halloween', 'halloween songs', 'spooky', 'horror', 'creepy'] },
  { key: 'christmas', label: 'クリスマス', words: /クリスマス|x'?mas|christmas/i, tags: ['christmas', 'christmas songs', 'xmas', 'christmas music', 'holiday'] },
  { key: 'valentine', label: 'バレンタイン', words: /バレンタイン|valentine/i, tags: ['valentine', 'love songs', 'love', 'romantic'] },
  { key: 'summer', label: '夏', words: /夏|サマー|summer/i, tags: ['summer', 'summer songs', 'summer vibes', 'beach'] },
  { key: 'winter', label: '冬', words: /冬|ウィンター|winter/i, tags: ['winter', 'snow', 'cold'] },
  { key: 'spring', label: '春', words: /春|桜|spring/i, tags: ['spring', 'sakura'] },
  { key: 'autumn', label: '秋', words: /秋|autumn|fall/i, tags: ['autumn', 'fall'] },
  { key: 'rain', label: '雨', words: /雨|梅雨|rain/i, tags: ['rain', 'rainy day', 'rainy'] },
  { key: 'graduation', label: '卒業', words: /卒業|graduation/i, tags: ['graduation', 'farewell'] },
  { key: 'new year', label: '新年', words: /新年|正月|new year/i, tags: ['new year', 'new years eve'] },
  { key: 'wedding', label: '結婚式', words: /結婚式|ウェディング|wedding/i, tags: ['wedding', 'wedding songs', 'love songs'] },
  { key: 'birthday', label: '誕生日', words: /誕生日|バースデー|birthday/i, tags: ['birthday'] },
];
export const themeOf = (text) => {
  const t = String(text || '').trim();
  if (!t) return null;
  return THEMES.find((x) => x.key === t.toLowerCase() || x.words.test(t)) || null;
};
// テーマ → 使う Last.fm タグ（登録がなければ入力した語をそのままタグに）
export const themeTags = (text) => {
  const th = themeOf(text);
  return th ? th.tags : String(text || '').trim() ? [String(text).trim().toLowerCase()] : [];
};
