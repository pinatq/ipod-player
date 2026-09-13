const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { validateYoutubeUrl, parseSpotifyUrl, spotifyEntityQueries, spotifyEmbedTracks, safeTrackPath,
        mapYtmEntry, mapYtmPlaylist, ytmRadioUrl, ytmPlaylistUrl,
        spotifyTracks, spotifyPlaylists, safeStreamUrl, cookieLines } = require('./lib');
const { remux, embedArt, extractArt, dropSidecarArt, FFMPEG } = require('./remux');
const { dict, catalogue, resolve } = require('./i18n');

const MUSIC_DIR = path.join(os.homedir(), 'Music', 'iPod');
// okladki trzymamy poza folderem muzyki, zeby ten zostal czysty - same utwory
const COVER_DIR = path.join(app.getPath('userData'), 'covers');
const LANG_FILE = path.join(app.getPath('userData'), 'language.json');

// Jezyk bierze sie z systemu, chyba ze uzytkownik wybral inny w Ustawieniach.
function savedLocale() {
  try { return JSON.parse(fs.readFileSync(LANG_FILE, 'utf8')).locale; } catch { return null; }
}
let LOCALE = resolve(savedLocale() || app.getLocale());
let T = dict(LOCALE);
const AUDIO_EXT = ['.m4a', '.mp3', '.aac', '.wav', '.flac', '.ogg', '.opus'];
// webp/jpg leca prosto z YouTube - Chromium wyswietli oba bez konwersji
const ART_EXT = ['.jpg', '.webp', '.png'];

// ponytail: PATH w spakowanej .app jest okrojony i nie widzi homebrew,
// wiec sondujemy jawne sciezki zamiast polegac na `which`.
const YTDLP_PATHS = [
  '/opt/homebrew/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  path.join(os.homedir(), '.local/bin/yt-dlp'),
];

// /etc/hosts celowo blokuje www.youtube.com i ma tak zostac. Ten katalog daje
// wyjatek WYLACZNIE procesowi yt-dlp odpalonemu stad - szczegoly w
// ytshim/sitecustomize.py. Reszta systemu blokady nie omija.
// Opcjonalny katalog z dodatkiem do PYTHONPATH dla yt-dlp. Publiczna paczka
// go nie zawiera; jesli ktos go sobie polozy, zostanie uzyty.
const SHIM_DIR = [
  path.join(app.getPath('userData'), 'ytshim'),
  path.join(__dirname, 'ytshim'),
].find(p => { try { return fs.existsSync(p); } catch { return false; } }) || '';

function findYtdlp() {
  return YTDLP_PATHS.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 460, height: 780,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    // sandbox:false bo preload wymaga ./lib. Bezpieczne: okno laduje tylko
    // lokalny plik, zadnej zdalnej tresci.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  win.loadFile('index.html');
  return win;
}

app.whenReady().then(() => {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  startProxy().then(p => { proxyPort = p; });
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('quit', () => app.quit());
ipcMain.handle('minimize', (e) => BrowserWindow.fromWebContents(e.sender).minimize());
ipcMain.handle('reveal-music', () => shell.openPath(MUSIC_DIR));
ipcMain.handle('downloader-status', () => ({ path: findYtdlp(), dir: MUSIC_DIR }));
ipcMain.handle('language', () => ({ locale: LOCALE, dict: T, list: catalogue() }));
ipcMain.handle('set-language', (e, locale) => {
  LOCALE = resolve(locale);
  T = dict(LOCALE);
  try { fs.writeFileSync(LANG_FILE, JSON.stringify({ locale: LOCALE })); } catch {}
  return { locale: LOCALE, dict: T };
});

ipcMain.handle('list-tracks', async () => {
  let files;
  try { files = fs.readdirSync(MUSIC_DIR); } catch { return []; }

  const out = [];
  for (const f of files) {
    if (!AUDIO_EXT.includes(path.extname(f).toLowerCase())) continue;
    const full = path.join(MUSIC_DIR, f);
    const base = path.basename(f, path.extname(f));
    // "Artysta - Tytul" jesli sie da, inaczej cala nazwa jako tytul
    const dash = base.indexOf(' - ');
    // okladka wyjeta z metadanych do cache - w folderze muzyki maja byc same utwory
    const cover = await extractArt(full, COVER_DIR);
    out.push({
      file: pathToFileURL(full).href,
      art: cover ? pathToFileURL(cover).href : null,
      artist: dash > 0 ? base.slice(0, dash).trim() : T.unknownArtist,
      title: dash > 0 ? base.slice(dash + 3).trim() : base,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'pl'));
});

ipcMain.handle('delete-track', (e, fileUrl) => {
  // Granica zaufania: kasujemy pliki z dysku - walidacja siedzi w lib.js (z testem).
  const p = safeTrackPath({ fileURLToPath, path }, MUSIC_DIR, fileUrl, AUDIO_EXT);
  if (!p) return { ok: false, error: T.errOutside };

  try {
    fs.unlinkSync(p);
    const base = path.basename(p, path.extname(p));
    // sprzatamy tez okladke obok (jesli jeszcze jest) i te z cache
    for (const art of [...ART_EXT.map(e => path.join(MUSIC_DIR, base + e)),
                       path.join(COVER_DIR, base + '.jpg')]) {
      try { if (fs.existsSync(art)) fs.unlinkSync(art); } catch {}
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.message || '').slice(0, 120) };
  }
});

// Jeden target = jeden utwor. Link YouTube albo "ytsearch1:artysta tytul".
// Granica zaufania: nigdy przez shell, zawsze tablica argumentow.
function runYtdlp(bin, target, video, onProgress) {
  return new Promise(resolve => {
    // ponytail: bierzemy gotowe m4a zamiast konwertowac -> zero zaleznosci od ffmpeg.
    // Film: bestvideo+bestaudio wymaga sklejenia, wiec podajemy ffmpeg jawnie
    // (PATH w spakowanej .app go nie widzi).
    // "Najwyzsza jakosc" = najlepsze avc1+aac, bo AV1/VP9/Opus nie graja
    // w QuickTime/Finder - schodzil sam dzwiek bez obrazu.
    const args = video ? [
      '-f', 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      ...(FFMPEG ? ['--ffmpeg-location', FFMPEG] : []),
      '-o', path.join(MUSIC_DIR, '%(title)s.%(ext)s'),
      '--no-overwrites',
      '--no-playlist', '--restrict-filenames', '--newline',
      target,
    ] : [
      '-f', 'bestaudio[ext=m4a]/bestaudio',
      '-o', path.join(MUSIC_DIR, '%(artist,uploader)s - %(title)s.%(ext)s'),
      '--write-thumbnail', '--no-overwrites',
      '--no-playlist', '--restrict-filenames', '--newline',
      target,
    ];
    // Shim jest opcjonalny: bez niego yt-dlp dziala normalnie, tylko nie omija
    // lokalnej blokady w /etc/hosts. Publiczna wersja go nie zawiera.
    const env = { ...process.env };
    if (SHIM_DIR) env.PYTHONPATH = SHIM_DIR;
    const opts = { timeout: 10 * 60 * 1000, env };
    const child = execFile(bin, args, opts, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).split('\n').slice(-3).join(' ').slice(0, 200);
        // 403 na strumieniu = YouTube zmienil klienta i stary yt-dlp odpada.
        // Bez tej podpowiedzi wyglada to jak awaria aplikacji.
        return resolve({ ok: false, error: /403|Forbidden/.test(msg) ? T.err403 : msg });
      }
      resolve({ ok: true });
    });
    child.stdout.on('data', d => {
      const m = /\[download\]\s+(\d{1,3}(?:\.\d)?)%/.exec(d.toString());
      if (m) onProgress(parseFloat(m[1]));
    });
  });
}

// Dwie naprawy po pobraniu, obie bezstratne dla dzwieku:
//  1. yt-dlp czasem zostawia surowy strumien DASH - stary sprzet go nie otworzy
//  2. okladka musi byc WBUDOWANA w plik, bo Finder nie widzi osobnego .webp
// ponytail: leci raz po calej playliscie, nie po kazdym utworze (bylo O(n²)).
async function fixupAll() {
  try {
    for (const f of fs.readdirSync(MUSIC_DIR)) {
      if (!/\.(m4a|mp4|aac)$/i.test(f)) continue;
      const full = path.join(MUSIC_DIR, f);
      await remux(full);
      await embedArt(full);
      await dropSidecarArt(full);   // okladka jest juz w srodku - sprzatamy .webp
    }
  } catch {}
}

// Spotify daje nam TYLKO liste "artysta - tytul" z publicznego embeda.
// Zadnego audio stamtad nie ruszamy - jest zaszyfrowane i tak ma zostac.
async function spotifyEntity(sp) {
  const r = await fetch(`https://open.spotify.com/embed/${sp.type}/${sp.id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return null;
  const m = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s.exec(await r.text());
  if (!m) return null;
  try { return JSON.parse(m[1]).props.pageProps.state.data.entity; } catch { return null; }
}

async function spotifyQueries(sp) {
  return spotifyEntityQueries(await spotifyEntity(sp));
}

ipcMain.handle('download', async (e, url, video) => {
  const bin = findYtdlp();
  if (!bin) return { ok: false, error: 'NO_YTDLP' };

  let targets;
  const sp = parseSpotifyUrl(url);
  if (sp && video) return { ok: false, error: T.errVideoOnlyYt };
  if (sp) {
    let qs;
    try { qs = await spotifyQueries(sp); }
    catch { return { ok: false, error: T.errSpotifyRead }; }
    if (!qs.length) return { ok: false, error: T.errSpotifyEmpty };
    targets = qs.map(q => `ytsearch1:${q}`);
  } else {
    const v = validateYoutubeUrl(url, T);
    if (!v.ok) return v;
    targets = [v.href];
  }

  const fails = [];
  for (let i = 0; i < targets.length; i++) {
    const r = await runYtdlp(bin, targets[i], video, pct =>
      e.sender.send('download-progress', Math.round(((i + pct / 100) / targets.length) * 100)));
    if (!r.ok) fails.push(r.error);
  }
  await fixupAll();

  if (fails.length === targets.length) return { ok: false, error: fails[0] };
  return { ok: true, total: targets.length, failed: fails.length };
});

// ================= strumieniowanie: YouTube Music i Spotify =================
//
// Zadne audio nie leci ze Spotify - stamtad bierzemy wylacznie liste utworow.
// Dzwiek zawsze pochodzi z YouTube, tak samo jak przy pobieraniu.

const YTM_FILE     = path.join(app.getPath('userData'), 'ytm.json');
const COOKIE_FILE  = path.join(app.getPath('userData'), 'ytm-cookies.txt');
const SPOTIFY_FILE = path.join(app.getPath('userData'), 'spotify.json');
const SPOTIFY_PORT = 8888;
// Spotify od 27.11.2025 nie przyjmuje juz aliasu "localhost" - tylko 127.0.0.1.
const SPOTIFY_REDIRECT = `http://127.0.0.1:${SPOTIFY_PORT}/cb`;
const SPOTIFY_SCOPE = 'playlist-read-private playlist-read-collaborative user-library-read';

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v), { mode: 0o600 }); } catch {} };

// ---------- lokalne proxy strumienia ----------
// Serwery googlevideo nie odsylaja naglowka CORS, wiec podlaczony do <audio>
// analizator Web Audio dostaje same zera i wizualizacje przestaja chodzic za
// muzyka. Przepuszczenie strumienia przez wlasny port to naprawia i przy okazji
// daje obsluge Range, czyli dziala przewijanie.
let proxyPort = 0;

function startProxy() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const url = safeStreamUrl(new URL(req.url, 'http://127.0.0.1').searchParams.get('u') || '');
      if (!url) { res.writeHead(403); return res.end(); }
      const headers = { 'user-agent': 'Mozilla/5.0' };
      if (req.headers.range) headers.range = req.headers.range;
      const up = https.get(url, { headers }, r => {
        const h = { 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
        for (const k of ['content-type', 'content-length', 'content-range'])
          if (r.headers[k]) h[k.replace(/(^|-)(\w)/g, (m, a, b) => a + b.toUpperCase())] = r.headers[k];
        res.writeHead(r.statusCode || 200, h);
        r.pipe(res);
      });
      up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
      req.on('close', () => up.destroy());
    });
    srv.on('error', () => resolve(0));
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

// ---------- yt-dlp jako zrodlo danych ----------
// Tryb 'window' = ciasteczka z okna logowania w aplikacji, 'safari' = z Safari.
const ytmMode = () => readJson(YTM_FILE, {}).mode || null;

function cookieArgs() {
  const m = ytmMode();
  if (m === 'window' && fs.existsSync(COOKIE_FILE)) return ['--cookies', COOKIE_FILE];
  if (m === 'safari') return ['--cookies-from-browser', 'safari'];
  return [];
}

function ytdlpJson(args) {
  const bin = findYtdlp();
  if (!bin) return Promise.resolve(null);
  const env = { ...process.env };
  if (SHIM_DIR) env.PYTHONPATH = SHIM_DIR;
  return new Promise(resolve => {
    // playlisty potrafia miec setki pozycji - domyslny bufor 1 MB tu nie wystarcza
    execFile(bin, args, { timeout: 90_000, env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}

const flatArgs = (url, end) => [
  ...cookieArgs(), '--flat-playlist', '-J', '--no-warnings',
  ...(end ? ['--playlist-end', String(end)] : []), url,
];

ipcMain.handle('ytm-status', () => ({ mode: ytmMode(), ready: !!findYtdlp() }));

ipcMain.handle('ytm-disconnect', () => {
  try { fs.unlinkSync(COOKIE_FILE); } catch {}
  try { fs.unlinkSync(YTM_FILE); } catch {}
  return { ok: true };
});

ipcMain.handle('ytm-use-safari', async () => {
  writeJson(YTM_FILE, { mode: 'safari' });
  const d = await ytdlpJson(flatArgs(ytmPlaylistUrl('LM'), 1));
  if (!d) { try { fs.unlinkSync(YTM_FILE); } catch {}; return { ok: false, error: T.errYtmCookies }; }
  return { ok: true, mode: 'safari' };
});

// Logowanie: zwykle okno przegladarki na music.youtube.com. Po zamknieciu
// zrzucamy ciasteczka sesji do pliku, ktory rozumie yt-dlp.
// ponytail: wlasna partycja, zeby ta sesja nie mieszala sie z niczym innym.
ipcMain.handle('ytm-login', async () => {
  const { session } = require('electron');
  const ses = session.fromPartition('persist:ytm');
  // Google odrzuca logowanie, gdy widzi w User-Agencie "Electron"
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
           + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  ses.setUserAgent(UA);
  const win = new BrowserWindow({
    width: 520, height: 720, title: 'YouTube Music',
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
  });
  win.loadURL('https://music.youtube.com/', { userAgent: UA });

  await new Promise(r => win.on('closed', r));

  const cs = [...await ses.cookies.get({ domain: '.youtube.com' }),
              ...await ses.cookies.get({ domain: '.google.com' })];
  if (!cs.some(c => c.name === 'SID' || c.name === '__Secure-1PSID'))
    return { ok: false, error: T.errYtmLogin };
  try { fs.writeFileSync(COOKIE_FILE, cookieLines(cs), { mode: 0o600 }); } catch {}
  writeJson(YTM_FILE, { mode: 'window' });
  return { ok: true, mode: 'window' };
});

ipcMain.handle('ytm-playlists', async () => {
  const d = await ytdlpJson(flatArgs('https://www.youtube.com/feed/playlists'));
  const out = (d && Array.isArray(d.entries) ? d.entries : []).map(mapYtmPlaylist).filter(Boolean);
  return out;
});

ipcMain.handle('ytm-tracks', async (e, id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{2,60}$/.test(id)) return [];
  const d = await ytdlpJson(flatArgs(ytmPlaylistUrl(id), 200));
  return (d && Array.isArray(d.entries) ? d.entries : []).map(mapYtmEntry).filter(Boolean);
});

ipcMain.handle('ytm-radio', async (e, id) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) return [];
  const d = await ytdlpJson(flatArgs(ytmRadioUrl(id), 50));
  return (d && Array.isArray(d.entries) ? d.entries : []).map(mapYtmEntry).filter(Boolean);
});

// Rozwiazujemy adres strumienia dopiero przy starcie utworu - wygasa po kilku
// godzinach, wiec trzymanie go dla calej playlisty nie mialoby sensu.
ipcMain.handle('stream-url', async (e, target) => {
  const bin = findYtdlp();
  if (!bin) return { ok: false, error: 'NO_YTDLP' };
  if (typeof target !== 'string' || !target) return { ok: false, error: T.errBadLink };

  const url = /^[A-Za-z0-9_-]{11}$/.test(target)
    ? `https://music.youtube.com/watch?v=${target}`
    : `ytsearch1:${target.slice(0, 120)}`;

  const env = { ...process.env };
  if (SHIM_DIR) env.PYTHONPATH = SHIM_DIR;
  // Jedno wywolanie daje adres strumienia i ID filmu - ID sluzy potem za
  // okladke tam, gdzie zrodlo zadnej nie podalo (embed Spotify).
  //
  // ponytail: najpierw BEZ ciasteczek. YouTube obsluguje zalogowane zadania
  // wyraznie wolniej - zmierzone 1,6 s anonimowo wobec 5 s z sesja, a do
  // samego adresu strumienia logowanie jest niepotrzebne. Ciasteczka wchodza
  // dopiero, gdy anonimowo sie nie udalo (utwor z ograniczeniem wieku, prywatny).
  const run = extra => new Promise(resolve => {
    const args = [...extra, '-f', 'bestaudio[ext=m4a]/bestaudio',
                  '--no-playlist', '--no-warnings', '--print', '%(id)s|%(urls)s', url];
    execFile(bin, args, { timeout: 60_000, env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err && !stdout ? '' : String(stdout).trim().split('\n')[0]));
  });

  let raw = await run([]);
  if (!raw) raw = await run(cookieArgs());
  const cut = raw.indexOf('|');
  const id = cut > 0 ? raw.slice(0, cut) : '';
  const safe = safeStreamUrl(cut > 0 ? raw.slice(cut + 1) : '');
  if (!safe) return { ok: false, error: T.errStream };
  return {
    ok: true,
    url: `http://127.0.0.1:${proxyPort}/?u=${encodeURIComponent(safe)}`,
    id: /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '',
  };
});

// ---------- Spotify: wylacznie metadane ----------
// Wlasny Client ID uzytkownika. Spotify od 6.02.2026 daje jednej aplikacji
// deweloperskiej piec kont i wymaga Premium, wiec wspolnego klucza w aplikacji
// byc nie moze - kazdy rejestruje swoj.
const spotifyCfg = () => readJson(SPOTIFY_FILE, {});

ipcMain.handle('spotify-status', () => {
  const c = spotifyCfg();
  return { clientId: c.clientId || '', linked: !!c.refresh, redirect: SPOTIFY_REDIRECT };
});

ipcMain.handle('spotify-set-id', (e, id) => {
  const clean = String(id || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(clean)) return { ok: false, error: T.errSpotifyId };
  writeJson(SPOTIFY_FILE, { ...spotifyCfg(), clientId: clean });
  return { ok: true };
});

ipcMain.handle('spotify-disconnect', () => {
  try { fs.unlinkSync(SPOTIFY_FILE); } catch {}
  return { ok: true };
});

const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Authorization Code + PKCE. Bez sekretu klienta, bo aplikacja desktopowa i tak
// nie ma gdzie go bezpiecznie trzymac - po to jest PKCE.
ipcMain.handle('spotify-login', async () => {
  const cfg = spotifyCfg();
  if (!cfg.clientId) return { ok: false, error: T.errSpotifyId };

  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  const code = await new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const q = new URL(req.url, SPOTIFY_REDIRECT).searchParams;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(q.get('code') ? 'OK' : 'ERR');
      srv.close();
      resolve(q.get('state') === state ? q.get('code') : null);
    });
    srv.on('error', () => resolve(null));
    srv.listen(SPOTIFY_PORT, '127.0.0.1', () => {
      shell.openExternal('https://accounts.spotify.com/authorize?' + new URLSearchParams({
        client_id: cfg.clientId, response_type: 'code', redirect_uri: SPOTIFY_REDIRECT,
        scope: SPOTIFY_SCOPE, code_challenge_method: 'S256', code_challenge: challenge, state,
      }));
    });
    setTimeout(() => { try { srv.close(); } catch {}; resolve(null); }, 180_000);
  });
  if (!code) return { ok: false, error: T.errSpotifyAuth };

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: SPOTIFY_REDIRECT, client_id: cfg.clientId, code_verifier: verifier }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  if (!j || !j.refresh_token) return { ok: false, error: T.errSpotifyAuth };

  writeJson(SPOTIFY_FILE, { ...cfg, refresh: j.refresh_token });
  return { ok: true };
});

let spToken = { value: '', exp: 0 };

async function spotifyToken() {
  if (spToken.value && Date.now() < spToken.exp) return spToken.value;
  const cfg = spotifyCfg();
  if (!cfg.clientId || !cfg.refresh) return null;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token',
      refresh_token: cfg.refresh, client_id: cfg.clientId }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  if (!j || !j.access_token) return null;
  // Spotify czasem rotuje refresh token przy odswiezeniu - stary przestaje dzialac
  if (j.refresh_token) writeJson(SPOTIFY_FILE, { ...cfg, refresh: j.refresh_token });
  spToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return spToken.value;
}

async function spotifyGet(pathname) {
  const tok = await spotifyToken();
  if (!tok) return null;
  const r = await fetch('https://api.spotify.com/v1' + pathname, {
    headers: { Authorization: 'Bearer ' + tok },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  return r && r.ok ? r.json().catch(() => null) : null;
}

ipcMain.handle('spotify-playlists', async () => {
  const j = await spotifyGet('/me/playlists?limit=50');
  return j ? spotifyPlaylists(j) : [];
});

ipcMain.handle('spotify-tracks', async (e, id) => {
  // 'liked' to pseudo-playlista: Polubione utwory siedza pod innym endpointem
  const first = id === 'liked' ? '/me/tracks?limit=50'
    : (/^[A-Za-z0-9]{22}$/.test(String(id)) ? `/playlists/${id}/tracks?limit=100` : null);
  if (!first) return [];

  const out = [];
  let page = first;
  // ponytail: maks 5 stron (500 utworow). Wiecej i tak nie zmiesci sie na kole.
  for (let i = 0; i < 5 && page; i++) {
    const j = await spotifyGet(page);
    if (!j) break;
    out.push(...spotifyTracks(j));
    page = typeof j.next === 'string' && j.next.startsWith('https://api.spotify.com/v1')
      ? j.next.slice('https://api.spotify.com/v1'.length) : null;
  }
  return out;
});

// Pobranie utworu, ktory wlasnie leci ze strumienia. Dla YouTube Music mamy
// dokladne ID, wiec trafienie jest pewne; dla Spotify szukamy po ISRC.
ipcMain.handle('download-track', async (e, target) => {
  const bin = findYtdlp();
  if (!bin) return { ok: false, error: 'NO_YTDLP' };
  if (typeof target !== 'string' || !target) return { ok: false, error: T.errBadLink };
  const t = /^[A-Za-z0-9_-]{11}$/.test(target)
    ? `https://music.youtube.com/watch?v=${target}` : `ytsearch1:${target.slice(0, 120)}`;
  const r = await runYtdlp(bin, t, false, pct => e.sender.send('download-progress', Math.round(pct)));
  if (!r.ok) return r;
  await fixupAll();
  return { ok: true, total: 1, failed: 0 };
});

// Playlista Spotify z wklejonego linku - bez logowania, bez klucza, bez Premium.
// Embed daje tylko wykonawce i tytul (zadnego ISRC), wiec dopasowanie na YouTube
// jest slabsze niz po zalogowaniu. Dzwiek i tak leci stamtad tak samo.
ipcMain.handle('spotify-link-tracks', async (e, url) => {
  const sp = parseSpotifyUrl(url);
  if (!sp) return { ok: false, error: T.errBadLink };
  let entity;
  try { entity = await spotifyEntity(sp); }
  catch { return { ok: false, error: T.errSpotifyRead }; }
  const tracks = spotifyEmbedTracks(entity);
  if (!tracks.length) return { ok: false, error: T.errSpotifyEmpty };
  return { ok: true, tracks };
});
