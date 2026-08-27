// Naprawia pliki, ktore yt-dlp zostawil jako surowy strumien DASH.
// Stary sprzet (iPod, samochodowe radia) nie umie otworzyc kontenera 'dash' -
// przepakowujemy do zwyklego MP4. Bez rekompresji, wiec bezstratnie i szybko.
//
// Jako modul:  const { remux } = require('./remux')
// Z konsoli:   node remux.js          (naprawia cala biblioteke)

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const run = promisify(execFile);
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
  .find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

// marki, ktore stary sprzet otwiera bez problemu
const OK_BRANDS = new Set(['isom', 'M4A ', 'mp42', 'mp41', 'M4V ', 'qt  ']);

/** Odczytuje marke kontenera z naglowka ftyp. Zwraca null dla nie-MP4. */
function brandOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    if (fs.readSync(fd, b, 0, 12, 0) < 12) return null;
    if (b.toString('latin1', 4, 8) !== 'ftyp') return null;
    return b.toString('latin1', 8, 12);
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Przepakowuje plik, jesli trzeba. Zwraca:
 *   {changed:false, reason}  - nie bylo potrzeby albo nie da sie
 *   {changed:true, from}     - naprawiony
 */
async function remux(file) {
  if (!FFMPEG) return { changed: false, reason: 'brak ffmpeg' };
  const brand = brandOf(file);
  if (brand === null) return { changed: false, reason: 'nie MP4' };
  if (OK_BRANDS.has(brand)) return { changed: false, reason: `marka ${brand} jest ok` };

  const tmp = path.join(path.dirname(file), '.remux-' + path.basename(file));
  try {
    // -c copy = bez rekompresji; +faststart przenosi indeks na poczatek
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', file,
                       '-c', 'copy', '-movflags', '+faststart', tmp],
              { timeout: 120000 });
    if (!fs.statSync(tmp).size) throw new Error('pusty wynik');
    fs.renameSync(tmp, file);
    return { changed: true, from: brand };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { changed: false, reason: (err.stderr || err.message || '').slice(0, 120) };
  }
}

const FFPROBE = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']
  .find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });

const ART_EXT = ['.jpg', '.webp', '.png'];

async function hasEmbeddedArt(file) {
  if (!FFPROBE) return false;
  try {
    const { stdout } = await run(FFPROBE,
      ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_name',
       '-of', 'csv=p=0', file], { timeout: 20000 });
    return stdout.trim().length > 0;
  } catch { return false; }
}

/**
 * Wszywa okladke do pliku audio. Finder/Music czytaja TYLKO grafike wbudowana
 * w metadane - osobny plik .webp obok utworu jest dla nich niewidoczny,
 * wiec bez tego iPod pokazuje szara nutke.
 * Miniatury z YouTube sa 16:9, a okladka albumu jest kwadratowa - przycinamy
 * do srodka i skalujemy do 600x600. Dzwiek kopiowany bez rekompresji.
 */
async function embedArt(file) {
  if (!FFMPEG) return { changed: false, reason: 'brak ffmpeg' };
  if (await hasEmbeddedArt(file)) return { changed: false, reason: 'ma juz okladke' };

  const dir = path.dirname(file), base = path.basename(file, path.extname(file));
  const art = ART_EXT.map(e => path.join(dir, base + e)).find(p => fs.existsSync(p));
  if (!art) return { changed: false, reason: 'brak pliku okladki' };

  const tmp = path.join(dir, '.art-' + path.basename(file));
  try {
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', file, '-i', art,
      '-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'mjpeg',
      '-filter:v', "crop='min(iw,ih)':'min(iw,ih)',scale=600:600",
      '-disposition:v', 'attached_pic', '-movflags', '+faststart', tmp],
      { timeout: 120000 });
    if (!fs.statSync(tmp).size) throw new Error('pusty wynik');
    fs.renameSync(tmp, file);
    return { changed: true };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { changed: false, reason: (err.stderr || err.message || '').slice(0, 120) };
  }
}

/**
 * Wyciaga wbudowana okladke do katalogu cache (poza folderem muzyki, zeby
 * ten zostal czysty). Zwraca sciezke do jpg albo null.
 * Ekstrakcja tylko gdy cache jest starszy niz plik audio.
 */
async function extractArt(file, cacheDir) {
  if (!FFMPEG) return null;
  const key = path.basename(file, path.extname(file)) + '.jpg';
  const out = path.join(cacheDir, key);
  try {
    const src = fs.statSync(file);
    const dst = fs.existsSync(out) ? fs.statSync(out) : null;
    if (dst && dst.mtimeMs >= src.mtimeMs && dst.size > 0) return out;   // cache aktualny
  } catch { return null; }

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    // wbudowana grafika jest juz mjpeg, wiec -c copy wystarczy
    await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', file,
                       '-an', '-c:v', 'copy', out], { timeout: 30000 });
    return fs.statSync(out).size ? out : null;
  } catch {
    try { fs.unlinkSync(out); } catch {}
    return null;
  }
}

/** Kasuje plik okladki lezacy obok utworu - tylko gdy grafika jest juz w srodku. */
async function dropSidecarArt(file) {
  if (!(await hasEmbeddedArt(file))) return false;
  const dir = path.dirname(file), base = path.basename(file, path.extname(file));
  let removed = false;
  for (const ext of ART_EXT) {
    const p = path.join(dir, base + ext);
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; } } catch {}
  }
  return removed;
}

module.exports = { remux, brandOf, embedArt, extractArt, dropSidecarArt, FFMPEG };

// ---- tryb konsolowy: napraw cala biblioteke ----
if (require.main === module) {
  const dir = process.argv[2] || path.join(os.homedir(), 'Music', 'iPod');
  (async () => {
    const files = fs.readdirSync(dir).filter(f => /\.(m4a|mp4|aac)$/i.test(f));
    let fixed = 0, arted = 0, dropped = 0;
    for (const f of files) {
      const full = path.join(dir, f);
      const r = await remux(full);
      if (r.changed) { fixed++; console.log(`  kontener (${r.from} -> isom): ${f}`); }
      else if (!/jest ok/.test(r.reason)) console.log(`  pominiety: ${f} - ${r.reason}`);

      const a = await embedArt(full);
      if (a.changed) { arted++; console.log(`  okładka wszyta:            ${f}`); }
      else if (!/ma juz/.test(a.reason)) console.log(`  bez okładki: ${f} - ${a.reason}`);

      if (await dropSidecarArt(full)) { dropped++; }
    }
    console.log(`\nsprawdzono ${files.length}: kontener ${fixed}, okładki ${arted}, sprzatnietych plikow obok ${dropped}`);
  })();
}
