// 新しい版の通知（四辻 NEXT の checkUpdate と同じ考え方）。
// 開いたときに読み込んだファイルの中身と、公開中のファイルの中身を比べ、違っていれば「新しい版に更新」を出す。
const FILES = ['./', 'css/style.css', 'js/app.js', 'js/engine.js', 'js/spotify.js', 'js/sources.js', 'js/nl.js', 'js/data.js', 'js/util.js', 'js/sync.js', 'js/update.js'];

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};

async function sig(cache) {
  const texts = await Promise.all(
    FILES.map((f) => fetch(f === './' ? location.pathname : f, { cache }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(f))))),
  );
  return texts.map(hash).join('.');
}

let base = null;
let ready = false;

// 今動いている版の印（ブラウザのキャッシュ＝このページが読み込んだもの）
export async function initUpdate() {
  if (!/^https?:$/.test(location.protocol)) return;
  try {
    base = await sig('default');
  } catch {}
}

export async function checkUpdate() {
  if (ready || !base) return ready;
  try {
    if ((await sig('no-store')) !== base) ready = true;
  } catch {}
  return ready;
}

// ブラウザのキャッシュも新しい版に置き換えてから読み直す（古いファイルのまま開き直さないように）
export async function applyUpdate() {
  await Promise.all(FILES.map((f) => fetch(f === './' ? location.pathname : f, { cache: 'reload' }).catch(() => {})));
  location.reload();
}
