// Logika bez zaleznosci od Electrona -> daje sie odpalic w czystym node (test.js).
const HOSTS = ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];

function validateYoutubeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'To nie jest poprawny link.' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, error: 'Tylko http/https.' };
  if (!HOSTS.includes(u.hostname.replace(/^www\./, ''))) return { ok: false, error: 'Tylko linki z YouTube.' };
  return { ok: true, href: u.href };
}

// Spotify szyfruje audio (Widevine) - nie da sie go stamtad pobrac i nie probujemy.
// Z linku czytamy WYLACZNIE publiczne metadane (artysta + tytul), a dzwiek leci
// z YouTube tym samym torem co reszta. Tak samo dziala spotdl.
function parseSpotifyUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (u.hostname.replace(/^www\./, '') !== 'open.spotify.com') return null;
  // /track/ID albo /intl-pl/track/ID; ID to 22 znaki base62
  const m = /^(?:\/intl-[a-z]{2})?\/(track|album|playlist)\/([A-Za-z0-9]{22})$/.exec(u.pathname);
  return m ? { type: m[1], id: m[2] } : null;
}

// entity z embeda Spotify -> jedna fraza "artysta tytul" na utwor.
// Pojedynczy utwor ma artists[], album i playlista maja trackList[] z subtitle.
// Granica zaufania: to odpowiedz z sieci, wiec tniemy biale znaki i dlugosc.
function spotifyEntityQueries(entity) {
  if (!entity) return [];
  const list = entity.trackList && entity.trackList.length ? entity.trackList : [entity];
  return list.map(t => {
    const artist = t.subtitle || (t.artists || []).map(a => a && a.name).filter(Boolean).join(', ');
    return `${artist || ''} ${t.title || ''}`.replace(/\s+/g, ' ').trim().slice(0, 120);
  }).filter(Boolean);
}

// Roznica katow znormalizowana do (-π, π]. Bez tego przejscie przez ±π
// daje skok o pelny obrot i kolo szarpie w druga strone.
function wheelDelta(angle, last) {
  let d = angle - last;
  if (d >  Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Granica zaufania dla kasowania: zwraca sciezke tylko jesli file:// URL
// wskazuje na plik audio lezacy BEZPOSREDNIO w folderze muzyki.
// Odrzuca podkatalogi, "..", symlinki-po-nazwie i obce rozszerzenia.
function safeTrackPath({ fileURLToPath, path }, musicDir, fileUrl, audioExts) {
  let p;
  try { p = fileURLToPath(fileUrl); } catch { return null; }
  const rel = path.relative(musicDir, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.includes('/') || rel.includes('\\')) return null;      // zaden podkatalog
  if (!audioExts.includes(path.extname(p).toLowerCase())) return null;
  return p;
}

module.exports = { validateYoutubeUrl, parseSpotifyUrl, spotifyEntityQueries, wheelDelta, safeTrackPath };
