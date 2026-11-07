# 四辻 NEXT — 選曲アシスト（yotsuji-next）

DJ中に「次の曲」を自分のSpotifyライブラリから提案するブラウザアプリ。
公開URL: https://atuyijust.github.io/yotsuji-next/ （GitHub Pages / main ブランチ直下）

## 構成
- `index.html` … アプリ本体。**1ファイル完結**（HTML+CSS+vanilla JS、ビルド不要）
- `manifest.json`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` … PWA（Macの Dock／iPhoneのホーム画面に追加用）
- 外部ライブラリなし。npm なし。

## 開発・公開
- ローカル確認: `python3 -m http.server 8899` → http://127.0.0.1:8899/ （Spotifyログインは Redirect URI の都合で公開URLでのみ動く。ローカルでは `S.tracks`/`S.meta` をJSで直接入れて動作確認する）
- 構文チェック: `node -e "const s=require('fs').readFileSync('index.html','utf8');new Function(s.match(/<script>([\s\S]*)<\/script>/)[1])"`
- 公開: `git push origin main` するだけ（Pages反映まで1〜2分）。ユーザーは開いているタブをリロードする必要あり（キャッシュ max-age=600）
- 応答・UI文言は日本語。

## Spotify API
- PKCE認証。Client ID はユーザーがアプリ内「ライブラリ」画面で入力し localStorage `cid` に保存（コードに埋め込まない）
- Redirect URI: `https://atuyijust.github.io/yotsuji-next/`（Spotify Dashboardに登録済み）
- 2026年のAPI仕様: プレイリスト曲は `/playlists/{id}/items`（`it.item || it.track`）。読めるのは自分が作成／共同編集のプレイリストのみ
- **`/audio-features`, `/audio-analysis`, `/recommendations`, related-artists は 403（2024-11以降の新規アプリは使えない）** → BPM/キーは別経路で取得（下記）
- 使える: `/tracks`, `/albums`, `/artists`, `/artists/{id}/top-tracks`, `/search`, `/me/player/*`, `/me/tracks`
- rekordbox でSpotify音源を再生しても `/me/player/currently-playing` には出ない（追従不可）→ DJモード＋手動「Nowへ」が運用

## BPM・キー・ジャンルの取得経路（src と優先順位）
`S.meta[id] = {bpm, key(Camelot "8A"等), genre, src, af?}`。`SRC_RANK = manual:4 > rekordbox:3 > exportify:2 = reccobeats:2 > deezer:1 = discogs:1`。上位の src を下位で上書きしない。ただし上位 src でキー／BPMが空の曲は ReccoBeats が空欄だけ埋める（src は据え置き、`kSrc`/`bSrc` に出どころを記録。rekordbox XML は Spotify 配信曲や未解析曲で Tonality が空のことがある）。
- **manual**: デッキで手入力／TAP
- **rekordbox**: ライブラリXMLエクスポートを曲名＋アーティストで照合（`importXml`, `norm`/`normLoose`）
- **exportify**: exportify.app のCSV（「Include audio features data」ON）。`Track URI` でID直接照合。Key(0-11)+Mode → Camelot（`PC_MAJ`/`PC_MIN`）。energy等は `meta.af`（`importCsv`）
- **reccobeats**: `https://api.reccobeats.com/v1/audio-features?ids=`（Spotify曲IDそのまま、最大40件/回、無料・キー不要・CORS可）。tempo/key/mode → bpm・Camelot、energy等 → `meta.af`（`rbFill`, `rbApply`）。照合は返り値の `href` のトラックID。確認済みは IndexedDB "rb"（`S.rb[id]=2` 取得済み／1＝旧形式（特徴量を足すため一度だけ取り直す）／タイムスタンプ＝未登録、30日後に再確認）。特徴量 `RB_FEAT` → af の en/da/va/lo/ac/ins/sp。上位 src の曲も問い合わせ、空欄と af だけ埋める。読み込み後（`autoMeta`）・起動時・`setNow` で自動。収録漏れの曲あり
- **deezer**: JSONP（`jsonp()`）。ISRC → `/track/isrc:` → 検索フォールバック。BPMのみ（キーなし）。ReccoBeatsで取れなかった曲の補完用。新しい曲は bpm=0 のことが多い。`fillBpm` で一括、`gatherInfo` で曲ごと
- **discogs**: 無認証 `database/search?artist=&track=`（25req/分）。ジャンル空のときだけ style を補う。`S.dg[id]` にキャッシュ、`rid` があれば `/releases/{id}` で詳細（`discogsRelease`）

## 曲データ（`slimTrack`）
`{id, uri, name, artists, album, albumId, dur, isrc, img, pop, year}`。`pop` は Spotify人気度（TRACK_VER=2 で追加。LS `trackVer` が古いと次の読み込みで全PLを一度だけ読み直す）。
候補行の下 `subLine()`: 1行目 長さ・年・POP・レーベル、2行目 ジャンル（meta.genre → 集めたアーティストのSpotifyジャンル）・AF（E/D/V＝energy/danceability/valence×100）。レーベルは通信せず、集めた曲情報（`S.ex`）→ 同じアルバムの曲の情報（`labelMap`）→ Exportify → Discogs の順で分かるものだけ。

## スコアリング（`suggest()`）
重み: wFlow（自分のプレイリスト内で直前／直後に並べた曲）、wCo（同じプレイリストに共起、1/log2(len+2)で重み付け）、wBpm（±2/4/6/8%、倍／半分テンポ可）、wKey（Camelot相性 `keyCompat`）、wGen（ジャンル一致）。
フィルタ: BPM幅、キー一致のみ、同アーティスト回避、倍／半分可。
選び方 `MODES`（LS `mode`、候補欄上部のボタン／Mキー）: 各モードの倍率 `m` をスライダーの重みに掛ける。
- flow いつもの流れ（従来どおり）／similar 似た曲（`vibe()`: 音 `afSim` 0.6＋ジャンル `genreSim` 0.25＋同じPL 0.15。`afSim` は7特徴量 `AF_W` をライブラリ内の標準偏差 `afStats()` で割った重み付き距離 → 散らばり1つ分で50%。ジャンルはmeta.genre＋集めたアーティストのSpotifyジャンル、完全一致1・単語一致0.5。チップに理由（音・ジャンル・同じPL））／surprise 意外性（並べたことのある曲を減点、初めての組み合わせ・人気の低さ・ゆらぎ `rnd01(now:seed)` を加点。🎲／Rで `S.seed` を変えて入れ替え）／up 上げる・down 落とす（energy 差 +0.03〜0.25 を加点）
- af（energy等）は ReccoBeats／Exportify 由来。無い曲は雰囲気・エネルギーの加点なし

## 曲情報の自動収集（`gatherInfo(id)` → `S.ex[id]`, IndexedDB "ex", 14日キャッシュ）
Spotify（人気度・レーベル・リリース・アーティストのジャンル／フォロワー・トップ曲・別バージョン検索）／Deezer（BPM・ゲイン・ランク・アルバム）／MusicBrainz（ISRC→recording、タグ・初リリース、1req/秒）／Wikipedia REST summary（ja→en、音楽系記事のみ採用）／Discogs。
いずれも **APIキー不要** のものだけ。鍵が要るサービス（Last.fm等）はコードに鍵を埋め込まない方針。
表示は `renderInfo()`（#infoBody）。チェックボックス `#autoInfo` でON/OFF。

## 同期・保存
- IndexedDB "yotsuji-next" store "kv"（`DB.get/set`）: tracks, meta, dz, dg, rb, ex, plIndex。localStorage（`LS`）: cid, tok, now, hist, weights, 各設定
- GitHub Gist 同期（`syncPush/syncPull/mergeMeta`）: ファイル `yotsuji-next-sync.json`、トークンは LS `ghTok`（UIで入力、コードに書かない）。meta は SRC_RANK の高い方を採用してマージ

## 自動化（「極力自動で」の方針）
- `autoRefreshLib(force)`: 起動時・画面復帰時・表示中10分おき（30分スロットル、LS `libAt`）にプレイリスト一覧の snapshot_id を比べ、変わったPLだけ `scan({auto:true})`。お気に入りは `/me/tracks?limit=1` の total+先頭ID（LS `savedSig`）が変わったときだけ再取得。設定 `#autoLib`
- `checkUpdate()`/`maybeReload()`: 公開中 index.html の `<style>`+`<script>` のハッシュを `APP_SIG` と比べ、新版なら `#updBtn` を出し、タブが隠れたとき（DJモード以外は画面復帰時も）に自動リロード。入力中・ダイアログ表示中・読み込み中はしない。設定 `#autoUpd`
- `tryAutoLogin()`: 一度ログインした端末（LS `hadLogin`）でトークンが切れていたら、タブごとに1回だけ自動で再認証へ（sessionStorage `autoLogin` でループ防止）
- 再生追従 `follow` は既定ON（DJモード中は止まる）
- 自動化できないもの: rekordbox XML／Exportify CSV の取り込み（ブラウザはファイルを勝手に読めない）、rekordbox再生中の「Nowへ」

## UI
- キーボード: ↑↓/j/k 選択、Enter→Nowへ、/ 検索、Esc、U 取り消し、C 曲名コピー（`#copyMode`）
- 左右の仕切り `#split`: ドラッグ／←→キーで左ペイン幅（CSS変数 `--side`、240px〜画面幅−380px）。LS `sideW` に保存、ダブルクリックで340pxに戻す。モバイルでは非表示
- Nowの取り消し: デッキ／モバイルバーの「↶ 戻す」（`data-undo`）とUキー → `undoNow()`
- 押している最中は描き直さない: `pressing`/`later(fn)`。renderCands・renderDeck・renderInfo は押下中なら離した後に回す（押した要素が差し替わるとクリックが消え「2回押さないと効かない」になるため）。renderCands は HTML が同じなら書き換えない
- DJモード（`setDj`）: 再生／キューボタンを隠し追従を止める
- モバイル（@media max-width:760px）: 1カラム、`#mobileNow` 固定バー、`<details class="side">` で重み付け／履歴を折りたたみ

## やらないこと
- 第三者APIキーのコード埋め込み
- 歌詞の取得・表示
