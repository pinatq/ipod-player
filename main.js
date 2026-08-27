const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const { validateYoutubeUrl, parseSpotifyUrl, spotifyEntityQueries, safeTrackPath } = require('./lib');
const { remux, embedArt, extractArt, dropSidecarArt, FFMPEG } = require('./remux');

const MUSIC_DIR = path.join(os.homedir(), 'Music', 'iPod');
// okladki trzymamy poza folderem muzyki, zeby ten zostal czysty - same utwory
const COVER_DIR = path.join(app.getPath('userData'), 'covers');
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
const SHIM_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'ytshim')
  : path.join(__dirname, 'ytshim');

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
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('quit', () => app.quit());
ipcMain.handle('minimize', (e) => BrowserWindow.fromWebContents(e.sender).minimize());
ipcMain.handle('reveal-music', () => shell.openPath(MUSIC_DIR));
ipcMain.handle('downloader-status', () => ({ path: findYtdlp(), dir: MUSIC_DIR }));

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
      artist: dash > 0 ? base.slice(0, dash).trim() : 'Nieznany artysta',
      title: dash > 0 ? base.slice(dash + 3).trim() : base,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'pl'));
});

ipcMain.handle('delete-track', (e, fileUrl) => {
  // Granica zaufania: kasujemy pliki z dysku - walidacja siedzi w lib.js (z testem).
  const p = safeTrackPath({ fileURLToPath, path }, MUSIC_DIR, fileUrl, AUDIO_EXT);
  if (!p) return { ok: false, error: 'Plik spoza folderu Muzyka.' };

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
    if (fs.existsSync(SHIM_DIR)) env.PYTHONPATH = SHIM_DIR;
    const opts = { timeout: 10 * 60 * 1000, env };
    const child = execFile(bin, args, opts, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).split('\n').slice(-3).join(' ').slice(0, 200);
        // 403 na strumieniu = YouTube zmienil klienta i stary yt-dlp odpada.
        // Bez tej podpowiedzi wyglada to jak awaria aplikacji.
        return resolve({ ok: false, error: /403|Forbidden/.test(msg)
          ? 'YouTube odrzucil pobieranie (403). Zaktualizuj: brew upgrade yt-dlp'
          : msg });
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
async function spotifyQueries(sp) {
  const r = await fetch(`https://open.spotify.com/embed/${sp.type}/${sp.id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return [];
  const m = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s.exec(await r.text());
  if (!m) return [];
  let entity;
  try { entity = JSON.parse(m[1]).props.pageProps.state.data.entity; } catch { return []; }
  return spotifyEntityQueries(entity);
}

ipcMain.handle('download', async (e, url, video) => {
  const bin = findYtdlp();
  if (!bin) return { ok: false, error: 'NO_YTDLP' };

  let targets;
  const sp = parseSpotifyUrl(url);
  if (sp && video) return { ok: false, error: 'Filmik pobierzesz tylko z linku YouTube.' };
  if (sp) {
    let qs;
    try { qs = await spotifyQueries(sp); }
    catch { return { ok: false, error: 'Nie udalo sie odczytac listy ze Spotify.' }; }
    if (!qs.length) return { ok: false, error: 'Spotify nie zwrocil zadnych utworow (prywatna playlista?).' };
    targets = qs.map(q => `ytsearch1:${q}`);
  } else {
    const v = validateYoutubeUrl(url);
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
