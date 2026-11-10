# 四辻 NEXT — 選曲アシスト（yotsuji-next）

DJ中に「次の曲」を自分のSpotifyライブラリから提案するブラウザアプリ。
公開URL: https://atuyijust.github.io/yotsuji-next/ （GitHub Pages / main ブランチ直下）

## 構成
- `index.html` … アプリ本体。**1ファイル完結**（HTML+CSS+vanilla JS、ビルド不要）
- `genre-map.json` … Every Noise at Once（Glenn McDonald、everynoise.com/engenremap.html、2023年末で更新停止）のジャンル地図を抜き出したもの `[[名前, top, left, 色hex], …]`（約6300ジャンル、ユーザー指定で組み込み）。起動時に `loadGenreMap()` で読む
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
- **rekordbox**: ライブラリXMLエクスポートを曲名＋アーティストで照合（`importXml`, `norm`/`normLoose`）。ゆるい照合（括弧・「 - 」以降を除く）は「版」`verKey()` が同じときだけ（Remix/Edit/Bootleg等は別の曲、Original/Extended/Radio Edit・リマスター・feat. は同じ扱い `VER_NEUTRAL`）。以前の取り込みで別の版と取り違えた rekordbox 値は再取り込み時に消して（af は残す）ReccoBeats/Deezer で取り直す。消した印 `rbBad:1` を付け、Gist 同期の `mergeMeta` で他端末の古い rekordbox 値に戻されないようにする（逆に他端末の rbBad は受け取る）。照合した rekordbox の曲名を `meta.rbName` に保存し、名前が違えばデッキに「← rekordbox「…」」と出す
- **exportify**: exportify.app のCSV（「Include audio features data」ON）。`Track URI` でID直接照合。Key(0-11)+Mode → Camelot（`PC_MAJ`/`PC_MIN`）。energy等は `meta.af`（`importCsv`）
- **reccobeats**: `https://api.reccobeats.com/v1/audio-features?ids=`（Spotify曲IDそのまま、最大40件/回、無料・キー不要・CORS可）。tempo/key/mode → bpm・Camelot、energy等 → `meta.af`（`rbFill`, `rbApply`）。照合は返り値の `href` のトラックID。確認済みは IndexedDB "rb"（`S.rb[id]=2` 取得済み／1＝旧形式（特徴量を足すため一度だけ取り直す）／タイムスタンプ＝未登録、30日後に再確認）。特徴量 `RB_FEAT` → af の en/da/va/lo/ac/ins/sp。上位 src の曲も問い合わせ、空欄と af だけ埋める。読み込み後（`autoMeta`）・起動時・`setNow` で自動。収録漏れの曲あり
- **deezer**: JSONP（`jsonp()`）。ISRC → `/track/isrc:` → 検索フォールバック。BPMのみ（キーなし）。ReccoBeatsで取れなかった曲の補完用。新しい曲は bpm=0 のことが多い。倍テンポで返すことがあるので 185 超えは半分（`dzB`）。`setNow` で BPM が空なら取得済みの `S.dz[id]` を使う。`fillBpm` で一括、`gatherInfo` で曲ごと
- **discogs**: 無認証 `database/search?artist=&track=`（25req/分）。ジャンル空のときだけ style を補う。`S.dg[id]` にキャッシュ、`rid` があれば `/releases/{id}` で詳細（`discogsRelease`）

## 曲データ（`slimTrack`）
`{id, uri, name, artists, album, albumId, dur, isrc, img, pop, year, na?}`。`na:1`＝リンク切れ（Spotifyで再生できない。ユーザー指定）: プレイリスト・お気に入りは `market=from_token` で読み `is_playable:false` なら付ける（差し替え版は `linked_from` の元IDのまま持つ）。`naCheck()` が14日おき（LS `naAt`、起動時 agFill の後）に全曲を `/tracks?ids=`（50件ずつ）で確認、null か再生不可なら付け、直っていれば外す。`/tracks?ids=` が最初から失敗したら全PL読み直し（`scan({full})`）で代える。リンク切れは候補に出さず、デッキと検索に「リンク切れ」。曲データ同期の配列の11番目。`pop` は Spotify人気度（TRACK_VER=2 で追加。LS `trackVer` が古いと次の読み込みで全PLを一度だけ読み直す）。
ジャンルの情報は候補では曲名の横の1か所だけに出す（ユーザー指定）: 最大3つのラベル＋判定（同じジャンル／近いジャンル／ジャンル違い／ジャンル越え＝`c.gst`、同じ・近いはマウスを乗せると重なったジャンル `genreHit`、チップには出さない）。ラベルは系統ごとに色分け（`genrePill`、色は `GENRE_FAM` の系統 → `FAM_HUE`、不明は「？」）。デッキにも最大4つ。ジャンルの並び `genreList()` = meta.genre → アーティストのSpotifyジャンル。アーティストのジャンルは `agFill()` が全アーティスト分を `/artists?ids=`（50件ずつ）でまとめて取得し `S.ag[artistId]={g,at}`（IndexedDB "ag"、30日、空も記録）。起動時と `autoMeta` で自動。`labelMap().__ag` に合流するので genreSet/genreSim も同じデータを使う。
候補行の下 `subLine()`: 1行目 長さ・年・POP・レーベル、2行目 AF（E/D/V＝energy/danceability/valence×100）。レーベルは通信せず、集めた曲情報（`S.ex`）→ 同じアルバムの曲の情報（`labelMap`）→ Exportify → Discogs の順で分かるものだけ。

アーティストの国（ユーザー指定「見えるところに」）: `acFill()` が MusicBrainz に Spotify のアーティストURLで100組ずつ照会（`/ws/2/url?resource=…&inc=artist-rels` の artist.country）、登録が無ければ名前で検索（同名で国の違う候補があれば不明のまま）。1回/秒。`S.ac[artistId]={c,at}`（IndexedDB "ac"、分かったものは180日・不明は30日で聞き直す、曲データ同期にも入る）。起動5秒後と `autoMeta` で自動。表示は旗＋日本語名 `ccText`（`Intl.DisplayNames`、長い名前は `CC_SHORT`）を候補とデッキのアーティスト名の横（`ccSpan`）・曲情報のアーティスト欄に。点数は重み「国」wCc（スコアリング参照）。候補欄の「国」で絞り込み（`#fCc`、LS `fCc`: すべて／今の曲と同じ国 `=`／日本以外 `!JP`／ライブラリにある国（曲数順）。`ccMatch`、絞り込み中は国不明の曲を出さない。ユーザー指定）。

## スコアリング（`suggest()`）
重み: wFlow（自分のプレイリスト内で直前／直後に並べた曲）、wCo（同じプレイリストに共起、1/log2(len+2)で重み付け）、wBpm（±2/4/6/8%、倍／半分テンポ可）、wKey（Camelot相性 `keyCompat`）、wYear（リリース年の近さ `yearOf`＝MusicBrainzの初リリース→アルバム年。±2年=1／±5年=.6／±10年=.25。チップは出さず候補2行目の年を緑/黄に色付け `c.yv`）、wGen（ジャンル: `genreSet`（meta.genre＋アーティストのSpotifyジャンル）同士を `genreSim` で比較。完全一致1（ただし j-rock・j-pop・歌謡曲など国でまとめただけの広いジャンル `G_BROAD` の一致は0.4＝近い止まり。ユーザー指摘「パンクと j-rock が同じジャンル」）・単語一致0.5（地域・雰囲気だけの語 `G_STOP` は数えない）・大きな括り `GENRE_FAM`（metal系・house系…）一致0.4・さらに大きな括り `GENRE_SUPER`（guitar＝metal/punk/rock、club＝house/techno/trance/edm/hardstyle 等）一致0.2。ジャンル名は比べる前に `normGenre()` で表記ゆれをそろえる（`G_ALIAS`: カタカナ・日本語・ローマ字・全角・ハイフン → 英語。メロコア／メロディックハードコア／merokoa → melodic hardcore 等、ユーザー指定）。表示の `genreList` も同じ表記の重複を1つにする。名前で重ならなくても、ジャンル地図の距離 `gmDist()`（縦・横・色RGBの5つを散らばり `GM_SD` で割り重み `GM_W` を掛けた距離、両方の集まりのいちばん近い組み合わせ）が `GM_NEAR`=0.6 未満なら 0.3（近いジャンル）。ジャンル越えの加点は地図で遠いほど大きい（`(md-0.6)/0.9` を 0.3〜1、地図に無ければ 0.6、0.9以上で「ジャンル越え（遠い）」）。両方分かっていて全く重ならなければ −wGen×2 と「ジャンル違い」チップ）。wCc（国: 今の曲とアーティストの国 `countriesOf` が1つでも同じなら +wCc、不明は加点なし。チップは出さず候補のアーティスト名の横の国を緑に `c.ccv`。今の曲の国が分からなければ ideal に入れない。ユーザー指定）。候補の点数は1位=100ではなく、全条件満点の合計 `ideal` を100とした `pct`（BPMとキーだけ合う曲が100に見えないように）。
フィルタ: BPM幅、キー一致のみ、同アーティスト回避、倍／半分可、POPの範囲（つまみ2つのスライダー `#popMin`/`#popMax`、5刻み、LS `popMin`/`popMax`、ダブルクリックで0〜100に戻す。絞り込み中は人気度不明の曲を出さない。ユーザー指定）。今の曲の手がかりが少なく1曲も残らないときは、点の低い曲も「候補 N曲（参考）」として注記付きで出す（`weak`）。
選び方 `MODES`（LS `mode`、候補欄上部のボタン／Mキー）: 各モードの倍率 `m` をスライダーの重みに掛ける。
- flow いつもの流れ（従来どおり）／similar 似た曲（`vibe()`: 音 `afSim` 0.6＋ジャンル `genreSim` 0.25（同じPLは含めない。ユーザー指定）。`afSim` は7特徴量 `AF_W` をライブラリ内の標準偏差 `afStats()` で割った重み付き距離 → 散らばり1つ分で50%。ジャンルはmeta.genre＋集めたアーティストのSpotifyジャンル、完全一致1・単語一致0.5。チップに理由（音・ジャンル））／surprise ジャンル越え（キーは LS 互換のため "surprise" のまま。ユーザー指定で「自分にとっての意外性（初めての組み合わせ・隠れた曲）」はやめた。今の曲のジャンルが分かっていれば、同じ・近いジャンル（`genreSim`>0＝完全一致・単語一致・大きな括り一致）は候補から外す（ユーザー指定「同じようなのしか選ばれない」）。全く重ならない曲だけ +cross、ジャンル不明の曲は −cross×0.6。音の近さ `afSim` で +snd（倍率1、チップ「音の感じ NN%」）。flow/co は0。ゆらぎ `rnd01(now:seed)` 少し、🎲／Rで `S.seed` を変えて入れ替え）／up 上げる・down 落とす（energy 差 +0.03〜0.25 を加点）
- af（energy等）は ReccoBeats／Exportify 由来。無い曲は雰囲気・エネルギーの加点なし

## タグ（自分で付ける）
`S.tags[id]={t:[...],at}`（IndexedDB "tags"、Gist同期は `at` が新しい方が勝つ）。デッキの「＋タグ」欄（Tキー、Enterで追加、日本語変換中のEnterは無視、×で外す、よく使うタグを「＋」で1クリック）。定番タグ `TAG_PRESET`（時間帯 Opener〜After Hours／役割 Banger・Tool等／要素 Vocal等／ムード／版 Edit・Remix等、ユーザー指定「プロDJのフォルダ分けのようなタグをデフォルトで」）をデッキの「定番タグから選ぶ」（`#tagPre`、開閉は LS `tagPre`）で1クリック付け外し、入力候補にも入る。候補の曲にも付けられる（ユーザー指定）: 候補行の「＃」かタグのチップを押すと小窓 `#tagPop`（`openTagPop`/`renderTagPop`、候補欄の外に fixed で置くので描き直しでも閉じない。入力欄・自分のタグ・定番タグ、Esc／外側クリックで閉じる）。候補行にタグのチップ（今の曲と同じタグは緑）、同じタグ1つにつき +1.5（2つまで）。候補欄の「タグ」で絞り込み（LS `fTag`）。タグを付けた曲の一覧（ユーザー指定）: 左ペインの「タグの曲」（`#dTagList`、開閉は LS `dTagList`、`renderTagList`）。タグのチップで絞る（「すべて」はタグ付き全曲＋各曲のタグ、LS `tagListTag`）、並び順 付けた順／BPM順／曲名順（LS `tagListSort`）、曲を押すとNowへ。タグが変わると `renderTagFilter` から描き直す。デッキの入力欄に入力中は `renderDeck` を止め、離れたら描き直す（`renderDeck(true)` で強制）。

## 星の評価（自分で付ける。ユーザー指定）
`S.rate[id]={r:1〜5（0＝外した）,at}`（IndexedDB "rate"、Gist同期は tags と同じく `at` が新しい方が勝つ）。`setRate`（同じ星をもう一度押すと外す）。デッキの「評価」行（`#deckRate`、`starsEdit`）・1〜5キー（Now の曲）・候補の「＃」小窓（`data-tprate`）で付ける。候補行はアーティスト名の横に ★ だけ表示（`starsView`）。点数・絞り込みにはまだ使っていない。

## 曲情報の自動収集（`gatherInfo(id)` → `S.ex[id]`, IndexedDB "ex", 14日キャッシュ）
Spotify（人気度・レーベル・リリース・アーティストのジャンル／フォロワー・トップ曲・別バージョン検索）／Deezer（BPM・ゲイン・ランク・アルバム）／MusicBrainz（ISRC→recording、タグ・初リリース、1req/秒。`mbLinks()` でサンプリング元／この曲をサンプリングした曲／リミックス元／カバー。関係は録音ごとに登録されるので、DJミックス内の録音を除き収録リリースの多い順に最大4録音を見て合算）／Wikipedia REST summary（ja→en、音楽系記事のみ、かつ返ってきた記事名がアーティスト名と一致するときだけ採用＝別ページへの転送を弾く）／Discogs。キャッシュは `EX_VER` が変わると取り直す。WhoSampled は公開APIがないので使わない。
いずれも **APIキー不要** のものだけ。鍵が要るサービス（Last.fm等）はコードに鍵を埋め込まない方針。
表示は `renderInfo()`（#infoBody）。チェックボックス `#autoInfo` でON/OFF。

## 同期・保存
- IndexedDB "yotsuji-next" store "kv"（`DB.get/set`）: tracks, meta, dz, dg, rb, ex, plIndex。localStorage（`LS`）: cid, tok, now, hist, weights, 各設定
- GitHub Gist 同期（`syncPush/syncPull/mergeMeta`）: ファイル `yotsuji-next-sync.json`、トークンは LS `ghTok`（UIで入力、コードに書かない）。変更（`autoSync`）は LS `syncDirty` に印を付けて1.5秒後に送る。送るときは小さい同期データを先に、曲データ（libPush）は後（iPhoneで途中で止められてもタグ等は届くように）。タブが隠れるとき未送信があればすぐ送る。開いたままでも受け取る（ユーザー指摘「何もしなくても同期されない」）: `syncCheck()` が画面復帰時と表示中60秒おき（20秒スロットル）に `/gists/{id}/commits?per_page=1` の版を LS `syncVer` と比べ、違えば `syncPull(false)`（未送信があれば push＝受信も兼ねる）。同期欄 `#syncInfo` に最終送信・受信時刻・未送信の有無・Gist ID 先頭7文字（端末間で同じか比べる用）。画面復帰時は追従の `poll()` もすぐ1回。GitHub API の GET は `max-age=60` でブラウザにキャッシュされるので、`gh()` と raw_url の取得は `cache:"no-store"`（古い Gist と合成して送ると他の端末のタグが消え、端末ごとにタグが食い違った。ユーザー指摘）。meta は SRC_RANK の高い方を採用してマージ。Client ID（PKCEなので秘密ではない）も載せ、空の端末に入れる
- 設定の受け渡し（ユーザー指定「iPhoneで設定を入れるのがだるい」）: Mac のライブラリ画面 5 の「iPhoneへ設定を渡す」(`setupCopy`) が `yotsuji-setup:`+base64(JSON{cid,gh}) をクリップボードへ（ユニバーサルクリップボードで iPhone に届く）。曲もトークンも無い端末は起動時に `#dlgSetup`「はじめに」を出し、「設定を貼り付ける」で `navigator.clipboard.readText` → `setupApply`（cid・ghTok を入れて `syncPull(true)`、曲データも受け取る）。読めなければ貼り付け欄。「自分で設定する」で従来のライブラリ画面。トークンはコードやURLに載せない
- 曲データ同期（ユーザー指定「Macと同じデータをiPhoneで」）: 別の非公開Gist `yotsuji-next-library.json`（`findLibGist`/`libPush`/`libPull`）。tracks（配列に詰め、画像URLの共通部分は `~`）・playlists・saved・plIndex・ag・af・rb。大きいので LS `libStamp`（ライブラリが変わった時刻: scan完了・agFillで取得・ReccoBeatsで20曲以上）が `libSent` より新しいときだけ送る。同期データの `libAt` が自分の `libStamp` より新しいときだけ受け取る（受け取ったら trackVer も揃え、全PL読み直しを起こさない）。同期導入前の端末は起動時に libStamp=libAt（最後に読み込んだ時刻）

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
- 候補は上位60曲ずつ（`candLimit`）。一番下の「もっと見る」で+60。Now・選び方・絞り込みが変わったときだけ60に戻す（`candCtx`）
- 候補の先頭へ: 下へスクロールすると右下（ユーザー指定）に「↑ 先頭へ」が浮かぶ（`#toTop`、`toTopCheck`）。Homeキーでも。選択も先頭に戻す
- 押している最中は描き直さない: `pressing`/`later(fn)`。renderCands・renderDeck・renderInfo は押下中なら離した後に回す（押した要素が差し替わるとクリックが消え「2回押さないと効かない」になるため）。renderCands は HTML が同じなら書き換えない
- 再生／キュー（`play`/`queue` → `withDevice`）: 404（動いているデバイスなし）なら `/me/player/devices` から開いているSpotify（アクティブ→Computer→Smartphone）を選んで `device_id` 付きで再送。403＝Premiumのみ等は `playErr` で日本語の理由を出す。NOW PLAYING（デッキ）にも ▶ 再生。再生ボタン自体は Now を変えない（ユーザー指定）。追従ONなら、Spotifyで流れ始めた曲は通常どおり追従が拾う（特別扱いはしない＝ユーザー指定「余計なことしなくていい」）。指示が通っても Mac の Spotify アプリが曲を読み込まず「無」になることがあるので、`confirmPlay` で `/me/player` の曲を確認 → 違えばアルバム文脈（`context_uri`+`offset`）で再送 → それでもだめなら `spotify:track:` リンクでアプリに曲を開く。`toast()` は画面下にも浮かせて出す（#status だけだと押しても反応がないように見えた）
- ライブラリ画面: 「選択したプレイリストを読み込む」(`#scan`) はプレイリスト一覧のすぐ下（最下部だと分かりにくい、とユーザー指摘）。横に選択数（`selCount`）、0本なら押せない。下部は「閉じる」だけ
- iPhone・iPad で ▶ 再生（ユーザー指摘「iPhone で押すと Mac の Spotify で鳴る」）: `IS_PHONE`/`IS_TABLET` なら `ownDevice()` が `/me/player/devices` から同じ種類（Smartphone/Tablet）を選び `device_id` 付きで送る（Mac に切り替えない）。一覧に無い（アプリが起動していない）か 404 なら `spotify:track:` でアプリに曲を開く
- DJモード（`setDj`）: 再生／キューボタンを隠し追従を止める
- モバイル（@media max-width:760px、iPhone 15 Pro 393×852 基準。ユーザー指定）: 1カラム。`aside{display:contents}` と `order` で 「Now Playing → 検索 → 候補 → 曲情報・重み付け・タグの曲・履歴」の順に並べ替え（候補が最初の画面に入る）。`#mobileNow` 固定バー、`<details class="side">` で重み付け／履歴を折りたたみ。`viewport-fit=cover` と `env(safe-area-inset-*)` でノッチ／ホームバーを避ける（status-bar-style black）

## Playlist Forge（`forge/`）
- 条件（ジャンル・年代・国・BPM・似せたい曲／アーティストなど）から Spotify 全体を探してプレイリストを作る別ページ。公開URL: https://atuyijust.github.io/yotsuji-next/forge/
- ES モジュール構成（`forge/index.html`, `forge/css/style.css`, `forge/js/*.js`）。ビルド不要。詳しくは `forge/README.md`
- もとは `~/Documents/spotify-playlist-maker` で作ったもの。今後は `forge/` を正とする
- Redirect URI は置いたフォルダの URL（`https://atuyijust.github.io/yotsuji-next/forge/`）。Spotify Dashboard に登録が必要
- 同じサイトなので localStorage を共有する: Client ID は Forge の `spm.clientId` が空なら四辻 NEXT の `cid` を使う。トークンは別々（スコープが違うため）
- 連携: 四辻 NEXT のヘッダー「プレイリスト作成 ↗」（デッキの「似た曲でプレイリスト ↗」はうまく動かずユーザー指定で削除）
- Forge の右上「四辻 NEXT」で戻る（パスが `/forge/` のときだけ表示）
- 設定の共有: Forge の Last.fm / Claude の API キーは、四辻 NEXT の同期 Gist（`yotsuji-next-sync.json` がある Gist）に別ファイル `playlist-forge-settings.json` として置く（`forge/js/sync.js`、ユーザー指定）。四辻 NEXT の `ghTok` / `gistId` をそのまま使う。開いたとき、この端末に無いキーだけ受け取り、この端末のキーが変わっていれば送る
- Forge は Client ID が分かっていて未ログインなら、開いたときに自動で Spotify ログインへ（タブごとに 1 回、sessionStorage `spm.autoLogin`）
- Forge のアイコンは `forge/` の中に専用のもの（`icon.svg` が元。PNG は headless Chrome で書き出し、`icon-maskable-512.png`・`apple-touch-icon.png` は全面塗り）。四辻 NEXT のアイコンと見分けられるように（ユーザー指定）
- Forge の「新しい版に更新」（`forge/js/update.js`、四辻 NEXT の checkUpdate と同じ考え方）: 開いたときのファイル群のハッシュと、公開中（`cache:'no-store'`）のハッシュを20秒後・表示中10分おき・画面復帰時に比べ、違えば `#btn-update` を出す。押すかタブが隠れたとき（曲を探している最中以外）に、条件と一覧を sessionStorage に保存し、キャッシュを `cache:'reload'` で入れ替えてから読み直す。新しい JS ファイルを足したら `FILES` にも足す
- テーマの定番曲: `data.js` の THEMES に `classics`（ハロウィン・クリスマス）。Claude が使えない（クレジット切れなど）ときも定番曲が入る。Last.fm・Claude・定番曲のうち2つ以上で見つかった曲は +0.25

## やらないこと
- 第三者APIキーのコード埋め込み
- 歌詞の取得・表示（デッキの「歌詞 ↗」は曲名＋アーティスト名＋「歌詞」で Google 検索を別タブで開くだけ `openLyrics`。ユーザー指定）
