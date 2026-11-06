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
`S.meta[id] = {bpm, key(Camelot "8A"等), genre, src, af?}`。`SRC_RANK = manual:4 > rekordbox:3 > exportify:2 > deezer:1 = discogs:1`。上位の src を下位で上書きしない。
- **manual**: デッキで手入力／TAP
- **rekordbox**: ライブラリXMLエクスポートを曲名＋アーティストで照合（`importXml`, `norm`/`normLoose`）
- **exportify**: exportify.app のCSV（「Include audio features data」ON）。`Track URI` でID直接照合。Key(0-11)+Mode → Camelot（`PC_MAJ`/`PC_MIN`）。energy等は `meta.af`（`importCsv`）
- **deezer**: JSONP（`jsonp()`）。ISRC → `/track/isrc:` → 検索フォールバック。BPMのみ（キーなし）。`fillBpm` で一括、`gatherInfo` で曲ごと
- **discogs**: 無認証 `database/search?artist=&track=`（25req/分）。ジャンル空のときだけ style を補う。`S.dg[id]` にキャッシュ、`rid` があれば `/releases/{id}` で詳細（`discogsRelease`）

## スコアリング（`suggest()`）
重み: wFlow（自分のプレイリスト内で直前／直後に並べた曲）、wCo（同じプレイリストに共起、1/log2(len+2)で重み付け）、wBpm（±2/4/6/8%、倍／半分テンポ可）、wKey（Camelot相性 `keyCompat`）、wGen（ジャンル一致）。
フィルタ: BPM幅、キー一致のみ、同アーティスト回避、倍／半分可。

## 曲情報の自動収集（`gatherInfo(id)` → `S.ex[id]`, IndexedDB "ex", 14日キャッシュ）
Spotify（人気度・レーベル・リリース・アーティストのジャンル／フォロワー・トップ曲・別バージョン検索）／Deezer（BPM・ゲイン・ランク・アルバム）／MusicBrainz（ISRC→recording、タグ・初リリース、1req/秒）／Wikipedia REST summary（ja→en、音楽系記事のみ採用）／Discogs。
いずれも **APIキー不要** のものだけ。鍵が要るサービス（Last.fm等）はコードに鍵を埋め込まない方針。
表示は `renderInfo()`（#infoBody）。チェックボックス `#autoInfo` でON/OFF。

## 同期・保存
- IndexedDB "yotsuji-next" store "kv"（`DB.get/set`）: tracks, meta, dz, dg, ex, plIndex。localStorage（`LS`）: cid, tok, now, hist, weights, 各設定
- GitHub Gist 同期（`syncPush/syncPull/mergeMeta`）: ファイル `yotsuji-next-sync.json`、トークンは LS `ghTok`（UIで入力、コードに書かない）。meta は SRC_RANK の高い方を採用してマージ

## UI
- キーボード: ↑↓/j/k 選択、Enter→Nowへ、/ 検索、Esc、U 取り消し、C 曲名コピー（`#copyMode`）
- DJモード（`setDj`）: 再生／キューボタンを隠し追従を止める
- モバイル（@media max-width:760px）: 1カラム、`#mobileNow` 固定バー、`<details class="side">` で重み付け／履歴を折りたたみ

## やらないこと
- 第三者APIキーのコード埋め込み
- 歌詞の取得・表示
