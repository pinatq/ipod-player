// Logika bez zaleznosci od Electrona -> daje sie odpalic w czystym node (test.js).
const HOSTS = ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];

function validateYoutubeUrl(raw, T = {}) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: T.errBadLink || 'That is not a valid link.' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, error: T.errProtocol || 'Only http/https.' };
  if (!HOSTS.includes(u.hostname.replace(/^www\./, ''))) return { ok: false, error: T.errOnlyYt || 'YouTube links only.' };
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

// entity z embeda Spotify -> utwory. Pojedynczy utwor ma artists[], album
// i playlista maja trackList[] z subtitle.
// Granica zaufania: to odpowiedz z sieci, wiec tniemy biale znaki i dlugosc.
function spotifyEmbedTracks(entity) {
  if (!entity) return [];
  const list = entity.trackList && entity.trackList.length ? entity.trackList : [entity];
  const str = v => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, 200);
  // Embed ma jedna okladke na calosc - pojedyncze utwory swoich nie maja.
  // Dla linku do utworu jest to jego wlasna okladka, dla playlisty - jej.
  const src = entity.coverArt && Array.isArray(entity.coverArt.sources) ? entity.coverArt.sources : [];
  const raw = src.length && typeof src[src.length - 1].url === 'string' ? src[src.length - 1].url : '';
  const art = /^https:\/\/i\.scdn\.co\//.test(raw) ? raw : null;
  return list.map(t => {
    if (!t || typeof t !== 'object') return null;
    const title = str(t.title);
    if (!title) return null;
    const artist = str(t.subtitle) ||
      str((Array.isArray(t.artists) ? t.artists : []).map(a => a && a.name).filter(Boolean).join(', '));
    // embed nie podaje ISRC - zostaje dopasowanie po tekscie
    // Przy playliscie ta okladka jest wspolna dla wszystkich utworow, wiec
    // sluzy tylko za zastepnik - przy odtwarzaniu podmienia ja miniatura z YouTube.
    return { title, artist, isrc: '', art, artPlaceholder: !!(entity.trackList || []).length };
  }).filter(Boolean);
}

// Ta sama lista, ale jako gotowe frazy do wyszukania (uzywa tego pobieranie).
function spotifyEntityQueries(entity) {
  return spotifyEmbedTracks(entity)
    .map(t => `${t.artist} ${t.title}`.replace(/\s+/g, ' ').trim().slice(0, 120))
    .filter(Boolean);
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


// ---------- YouTube Music / Spotify ----------

// Wpis z `yt-dlp --flat-playlist -J`. Granica zaufania: to odpowiedz z sieci,
// wiec tniemy typy i dlugosci, zanim cokolwiek trafi do interfejsu.
function mapYtmEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const id = typeof e.id === 'string' ? e.id.trim() : '';
  // ID filmu YouTube to 11 znakow base64url - wszystko inne to nie utwor
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const str = v => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    id,
    title: str(e.title) || id,
    artist: str(e.channel || e.uploader),
    dur: Number.isFinite(e.duration) ? e.duration : 0,
  };
}

// To samo dla wpisu z listy playlist (tam _type === 'url', a id to ID playlisty).
function mapYtmPlaylist(e) {
  if (!e || typeof e !== 'object') return null;
  const id = typeof e.id === 'string' ? e.id.trim() : '';
  if (!/^[A-Za-z0-9_-]{2,60}$/.test(id)) return null;
  const title = (typeof e.title === 'string' ? e.title : '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { id, title: title || id };
}

// Radio ("miks") YouTube Music startujace od danego utworu.
const ytmRadioUrl = id => `https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`;
const ytmPlaylistUrl = id => `https://music.youtube.com/playlist?list=${id}`;

// Odpowiedz Spotify: /me/tracks ma {items:[{track}]}, /playlists/x/tracks tak samo.
// Wyciagamy ISRC, bo szukanie po nim trafia w nagranie, a nie w cover czy teledysk.
function spotifyTracks(json) {
  const items = json && Array.isArray(json.items) ? json.items : [];
  return items.map(it => {
    const t = it && (it.track || it);
    if (!t || typeof t !== 'object' || t.is_local) return null;
    const str = v => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const title = str(t.name);
    if (!title) return null;
    const artist = (Array.isArray(t.artists) ? t.artists : [])
      .map(a => a && typeof a.name === 'string' ? a.name : '').filter(Boolean).join(', ').slice(0, 200);
    const isrc = t.external_ids && typeof t.external_ids.isrc === 'string'
      ? t.external_ids.isrc.trim().toUpperCase() : '';
    const imgs = t.album && Array.isArray(t.album.images) ? t.album.images : [];
    const art = imgs.length && typeof imgs[imgs.length - 1].url === 'string' ? imgs[imgs.length - 1].url : null;
    return {
      title, artist,
      isrc: /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : '',
      art: art && /^https:\/\/i\.scdn\.co\//.test(art) ? art : null,
    };
  }).filter(Boolean);
}

function spotifyPlaylists(json) {
  const items = json && Array.isArray(json.items) ? json.items : [];
  return items.map(p => {
    if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9]{22}$/.test(p.id)) return null;
    const title = (typeof p.name === 'string' ? p.name : '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return { id: p.id, title: title || p.id };
  }).filter(Boolean);
}

// Czego szukac na YouTube. ISRC identyfikuje konkretne nagranie, wiec ma
// pierwszenstwo; bez niego zostaje zwykly tekst. Tak samo robi spotDL.
function matchQuery(t) {
  if (!t) return '';
  if (t.isrc) return t.isrc;
  return `${t.artist || ''} ${t.title || ''}`.replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Granica zaufania dla lokalnego proxy: przepuszczamy WYLACZNIE strumienie
// Google. Bez tego byl to otwarty proxy dla kazdego, kto trafi w port.
function safeStreamUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (h !== 'googlevideo.com' && !h.endsWith('.googlevideo.com')) return null;
  return u.href;
}

// Ciasteczka z sesji Electrona -> format Netscape, ktory rozumie yt-dlp.
function cookieLines(cookies) {
  const out = ['# Netscape HTTP Cookie File'];
  for (const c of cookies || []) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
    const dom = typeof c.domain === 'string' ? c.domain : '';
    if (!dom) continue;
    out.push([
      dom,
      dom.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || 0),
      c.name,
      c.value,
    ].join('\t'));
  }
  return out.join('\n') + '\n';
}


// Uklad menu glownego zapisany przez uzytkownika. Granica zaufania jest tu
// slabsza (wlasny localStorage), ale zapis przezywa aktualizacje aplikacji,
// wiec musi zniesc identyfikatory, ktorych juz nie ma, i sam dobrac te nowe.
// `fixed` nie da sie ukryc - inaczej nie byloby jak wrocic do ustawien.
function homeMenuLayout(saved, defaults, fixed) {
  const known = id => defaults.includes(id);
  const s = saved && typeof saved === 'object' ? saved : {};
  const order = (Array.isArray(s.order) ? s.order : []).filter((id, i, a) =>
    known(id) && a.indexOf(id) === i);
  for (const id of defaults) if (!order.includes(id)) order.push(id);
  const hidden = (Array.isArray(s.hidden) ? s.hidden : []).filter((id, i, a) =>
    known(id) && id !== fixed && a.indexOf(id) === i);
  return { order, hidden };
}

module.exports = { validateYoutubeUrl, parseSpotifyUrl, spotifyEntityQueries, wheelDelta, safeTrackPath,
                   mapYtmEntry, mapYtmPlaylist, ytmRadioUrl, ytmPlaylistUrl,
                   spotifyTracks, spotifyPlaylists, matchQuery, safeStreamUrl, cookieLines,
                   spotifyEmbedTracks, homeMenuLayout };
