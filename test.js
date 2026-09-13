const assert = require('assert');
const { validateYoutubeUrl, parseSpotifyUrl, spotifyEntityQueries, wheelDelta, safeTrackPath,
        mapYtmEntry, mapYtmPlaylist, spotifyTracks, spotifyPlaylists, matchQuery,
        safeStreamUrl, cookieLines, spotifyEmbedTracks, homeMenuLayout } = require('./lib');
const { fileURLToPath, pathToFileURL } = require('url');
const path = require('path');

// --- walidacja linku (granica zaufania: leci do procesu potomnego) ---
assert.ok(validateYoutubeUrl('https://www.youtube.com/watch?v=abc').ok);
assert.ok(validateYoutubeUrl('https://youtu.be/abc').ok);
assert.ok(validateYoutubeUrl('https://music.youtube.com/watch?v=abc').ok);

assert.ok(!validateYoutubeUrl('https://evil.com/x').ok);          // obcy host
assert.ok(!validateYoutubeUrl('file:///etc/passwd').ok);          // zly protokol
assert.ok(!validateYoutubeUrl('nie-link').ok);                    // smiec
assert.ok(!validateYoutubeUrl('https://youtube.com.evil.com/x').ok); // podszywanie sie pod host
assert.ok(!validateYoutubeUrl('https://notyoutube.com/x').ok);    // sufiks nie wystarcza

// --- link Spotify (tylko metadane; audio i tak leci z YouTube) ---
assert.deepStrictEqual(parseSpotifyUrl('https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8'),
  { type: 'track', id: '4PTG3Z6ehGkBFwjybzWkR8' });
assert.deepStrictEqual(parseSpotifyUrl('https://open.spotify.com/intl-pl/album/1ATL5GLyefJaxhQzSPVrLX'),
  { type: 'album', id: '1ATL5GLyefJaxhQzSPVrLX' });
// query string (?si=...) nie przeszkadza, bo patrzymy tylko na pathname
assert.ok(parseSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'));

assert.strictEqual(parseSpotifyUrl('https://open.spotify.com/user/milosz'), null);   // nieobslugiwany typ
assert.strictEqual(parseSpotifyUrl('https://open.spotify.com/track/za-krotkie'), null); // zle ID
assert.strictEqual(parseSpotifyUrl('https://evil.com/track/4PTG3Z6ehGkBFwjybzWkR8'), null);
assert.strictEqual(parseSpotifyUrl('https://open.spotify.com.evil.com/track/4PTG3Z6ehGkBFwjybzWkR8'), null);
assert.strictEqual(parseSpotifyUrl('https://youtube.com/watch?v=abc'), null);        // to nie Spotify
assert.strictEqual(parseSpotifyUrl('smiec'), null);

// pojedynczy utwor: artysci siedza w artists[]
assert.deepStrictEqual(
  spotifyEntityQueries({ type: 'track', title: 'Tytul', artists: [{ name: 'A' }, { name: 'B' }] }),
  ['A, B Tytul']);
// album/playlista: kazdy wpis ma subtitle (artysta) + title
assert.deepStrictEqual(
  spotifyEntityQueries({ type: 'album', title: 'Plyta', subtitle: 'X',
    trackList: [{ subtitle: 'X', title: 'Raz' }, { subtitle: 'X', title: 'Dwa' }] }),
  ['X Raz', 'X Dwa']);
// smieci z sieci nie moga przeciec do argumentow yt-dlp
assert.deepStrictEqual(spotifyEntityQueries(null), []);
assert.deepStrictEqual(spotifyEntityQueries({ trackList: [{ title: '' }, { subtitle: '' }] }), []);
assert.deepStrictEqual(spotifyEntityQueries({ title: 'a\n--exec\trm', artists: [] }), ['a --exec rm']);
assert.ok(spotifyEntityQueries({ title: 'x'.repeat(500), artists: [] })[0].length <= 120);

// --- kat kola ---
const near = (a, b) => Math.abs(a - b) < 1e-9;
assert.ok(near(wheelDelta(0.2, 0.1), 0.1));                       // zwykly ruch w przod
assert.ok(near(wheelDelta(0.1, 0.2), -0.1));                      // zwykly ruch w tyl
// przejscie przez ±π: z 179° na -179° to +2°, nie -358°
assert.ok(near(wheelDelta(-Math.PI + 0.02, Math.PI - 0.02), 0.04));
assert.ok(near(wheelDelta(Math.PI - 0.02, -Math.PI + 0.02), -0.04));
// pelny obrot skladany z krokow sumuje sie do 2π mimo przejscia przez szew
let sum = 0;
for (let i = 1; i <= 360; i++) sum += wheelDelta((i * Math.PI) / 180 - Math.PI, ((i - 1) * Math.PI) / 180 - Math.PI);
assert.ok(near(sum, 2 * Math.PI), `suma pelnego obrotu = ${sum}`);

// --- kasowanie plikow: sciezka musi zostac w folderze muzyki ---
const DEPS = { fileURLToPath, path };
const DIR  = '/Users/x/Music/iPod';
const EXT  = ['.m4a', '.mp3'];
const check = (p) => safeTrackPath(DEPS, DIR, pathToFileURL(p).href, EXT);

assert.strictEqual(check(`${DIR}/Artysta - Tytul.m4a`), `${DIR}/Artysta - Tytul.m4a`);
assert.strictEqual(check(`${DIR}/spacja i znaki #!.mp3`), `${DIR}/spacja i znaki #!.mp3`);

assert.strictEqual(check('/etc/passwd'), null);                    // zupelnie obcy plik
assert.strictEqual(check(`${DIR}/../../.ssh/id_rsa`), null);       // wyjscie w gore
assert.strictEqual(check(`${DIR}/podkatalog/utwor.m4a`), null);    // podkatalog
assert.strictEqual(check(`${DIR}/notatka.txt`), null);             // nie audio
assert.strictEqual(check(`${DIR}`), null);                         // sam folder
assert.strictEqual(safeTrackPath(DEPS, DIR, 'nie-url', EXT), null);
assert.strictEqual(safeTrackPath(DEPS, DIR, 'https://evil.com/x.m4a', EXT), null);


// --- strumieniowanie: granica zaufania dla lokalnego proxy ---
// Bez tej walidacji port proxy bylby otwartym proxy dla calego internetu.
assert.ok(safeStreamUrl('https://rr1---sn-pj2.googlevideo.com/videoplayback?x=1'));
assert.ok(safeStreamUrl('https://googlevideo.com/a'));
assert.strictEqual(safeStreamUrl('http://rr1.googlevideo.com/a'), null);      // bez https
assert.strictEqual(safeStreamUrl('https://googlevideo.com.evil.com/a'), null); // podszycie
assert.strictEqual(safeStreamUrl('https://evil.com/a'), null);
assert.strictEqual(safeStreamUrl('file:///etc/passwd'), null);
assert.strictEqual(safeStreamUrl('smiec'), null);

// --- wpisy z yt-dlp (dane z sieci) ---
assert.deepStrictEqual(
  mapYtmEntry({ id: 'IFwBbKBn-6Q', title: ' Regular   Degular ', channel: 'RedTips', duration: 137 }),
  { id: 'IFwBbKBn-6Q', title: 'Regular Degular', artist: 'RedTips', dur: 137 });
assert.strictEqual(mapYtmEntry({ id: 'za-krotkie', title: 'x' }), null);   // nie ID filmu
assert.strictEqual(mapYtmEntry({ id: '../../etc/pas', title: 'x' }), null);
assert.strictEqual(mapYtmEntry(null), null);
assert.strictEqual(mapYtmEntry({ id: 'IFwBbKBn-6Q' }).title, 'IFwBbKBn-6Q');  // brak tytulu
assert.strictEqual(mapYtmEntry({ id: 'IFwBbKBn-6Q', title: 'a'.repeat(500) }).title.length, 200);
assert.strictEqual(mapYtmEntry({ id: 'IFwBbKBn-6Q', title: 'x', duration: 'du≈ºo' }).dur, 0);

assert.deepStrictEqual(mapYtmPlaylist({ id: 'LM', title: 'Liked Music' }), { id: 'LM', title: 'Liked Music' });
assert.strictEqual(mapYtmPlaylist({ id: '../tajne', title: 'x' }), null);

// --- Spotify: tylko lista utworow, ISRC ma pierwszenstwo przy szukaniu ---
const SP = spotifyTracks({ items: [
  { track: { name: 'Hometown Glory', artists: [{ name: 'Adele' }],
             external_ids: { isrc: 'gbbks0700588' },
             album: { images: [{ url: 'https://i.scdn.co/image/big' }, { url: 'https://i.scdn.co/image/small' }] } } },
  { track: { name: 'Bez ISRC', artists: [{ name: 'A' }, { name: 'B' }], external_ids: {} } },
  { track: { name: 'Lokalny', is_local: true } },
  { track: { name: '', artists: [] } },
  null,
] });
assert.strictEqual(SP.length, 2);
assert.strictEqual(SP[0].isrc, 'GBBKS0700588');
assert.strictEqual(SP[0].art, 'https://i.scdn.co/image/small');   // najmniejsza, ostatnia w liscie
assert.strictEqual(SP[1].artist, 'A, B');
assert.strictEqual(SP[1].isrc, '');
// okladka spoza CDN Spotify nie przechodzi
assert.strictEqual(spotifyTracks({ items: [{ track: { name: 'x', external_ids: {},
  album: { images: [{ url: 'https://evil.com/x.png' }] } } }] })[0].art, null);
// ISRC o zlym ksztalcie jest odrzucany, zeby nie trafil do zapytania
assert.strictEqual(spotifyTracks({ items: [{ track: { name: 'x',
  external_ids: { isrc: 'NIE ISRC' } } }] })[0].isrc, '');

assert.deepStrictEqual(spotifyPlaylists({ items: [
  { id: '37i9dQZF1DXcBWIGoYBM5M', name: 'Top 50' },
  { id: 'za-krotkie', name: 'x' },
] }), [{ id: '37i9dQZF1DXcBWIGoYBM5M', title: 'Top 50' }]);

// ISRC trafia w nagranie, tekst w cokolwiek - stad ta kolejnosc (tak samo spotDL)
assert.strictEqual(matchQuery({ isrc: 'GBBKS0700588', artist: 'Adele', title: 'Hometown Glory' }),
                   'GBBKS0700588');
assert.strictEqual(matchQuery({ isrc: '', artist: 'Adele', title: 'Hometown Glory' }),
                   'Adele Hometown Glory');
assert.strictEqual(matchQuery(null), '');

// --- ciasteczka dla yt-dlp ---
const CK = cookieLines([
  { domain: '.youtube.com', path: '/', secure: true, expirationDate: 1789295314.7, name: 'SID', value: 'abc' },
  { domain: 'music.youtube.com', name: 'X', value: 'y' },
  { domain: '.youtube.com', name: 'bez-wartosci' },
]);
const rows = CK.trim().split('\n');
assert.strictEqual(rows[0], '# Netscape HTTP Cookie File');
assert.strictEqual(rows[1], '.youtube.com\tTRUE\t/\tTRUE\t1789295314\tSID\tabc');
assert.strictEqual(rows[2], 'music.youtube.com\tFALSE\t/\tFALSE\t0\tX\ty');
assert.strictEqual(rows.length, 3);      // wpis bez wartosci wypada


// --- Spotify z wklejonego linku (embed, bez logowania) ---
// Playlista: trackList z subtitle. Pojedynczy utwor: artists[].
assert.deepStrictEqual(spotifyEmbedTracks({ trackList: [
  { title: '  Hometown   Glory ', subtitle: 'Adele' },
  { title: 'Bez wykonawcy' },
  { title: '' },
  null,
], coverArt: { sources: [{ url: 'https://i.scdn.co/image/okladka' }] } }), [
  { title: 'Hometown Glory', artist: 'Adele', isrc: '',
    art: 'https://i.scdn.co/image/okladka', artPlaceholder: true },
  { title: 'Bez wykonawcy', artist: '', isrc: '',
    art: 'https://i.scdn.co/image/okladka', artPlaceholder: true },
]);
// Link do POJEDYNCZEGO utworu: okladka jest jego wlasna, wiec nie jest zastepcza
// i odtwarzanie jej nie podmieni.
assert.deepStrictEqual(spotifyEmbedTracks({ title: 'Solo', artists: [{ name: 'A' }],
  coverArt: { sources: [{ url: 'https://i.scdn.co/image/jego' }] } }),
  [{ title: 'Solo', artist: 'A', isrc: '', art: 'https://i.scdn.co/image/jego', artPlaceholder: false }]);
assert.deepStrictEqual(spotifyEmbedTracks({ title: 'Solo', artists: [{ name: 'A' }, { name: 'B' }] }),
  [{ title: 'Solo', artist: 'A, B', isrc: '', art: null, artPlaceholder: false }]);
// okladka spoza CDN Spotify nie przechodzi
assert.strictEqual(spotifyEmbedTracks({ title: 'x',
  coverArt: { sources: [{ url: 'https://evil.com/x.png' }] } })[0].art, null);
assert.deepStrictEqual(spotifyEmbedTracks(null), []);
// embed nigdy nie daje ISRC, wiec szukamy po tekscie
assert.strictEqual(matchQuery(spotifyEmbedTracks({ title: 'Solo', artists: [{ name: 'A' }] })[0]),
                   'A Solo');


// --- uklad menu glownego (zapis przezywa aktualizacje aplikacji) ---
const DEF = ['music', 'download', 'ytm', 'spotify', 'shuffle', 'settings', 'nowPlaying'];
const home = (saved) => homeMenuLayout(saved, DEF, 'settings');

assert.deepStrictEqual(home(null), { order: DEF, hidden: [] });          // brak zapisu = domyslnie
assert.deepStrictEqual(home('smiec'), { order: DEF, hidden: [] });
assert.deepStrictEqual(home({ order: 'nie-tablica' }), { order: DEF, hidden: [] });

// wlasna kolejnosc i ukryte pozycje przechodza
assert.deepStrictEqual(home({ order: ['shuffle', 'music'], hidden: ['spotify'] }).order,
  ['shuffle', 'music', 'download', 'ytm', 'spotify', 'settings', 'nowPlaying']);
assert.deepStrictEqual(home({ hidden: ['spotify', 'download'] }).hidden, ['spotify', 'download']);

// identyfikator z wycofanej wersji wypada, nowa pozycja sama dochodzi na koniec
assert.ok(!home({ order: ['juz-nie-istnieje', 'music'] }).order.includes('juz-nie-istnieje'));
assert.deepStrictEqual(home({ order: ['music'] }).order, DEF);
assert.deepStrictEqual(home({ hidden: ['juz-nie-istnieje'] }).hidden, []);

// duplikaty w zapisie nie powielaja pozycji w menu
assert.deepStrictEqual(home({ order: ['music', 'music', 'shuffle'] }).order.filter(x => x === 'music').length, 1);
assert.deepStrictEqual(home({ hidden: ['spotify', 'spotify'] }).hidden, ['spotify']);

// Ustawien ukryc sie nie da - bez nich nie ma powrotu do tego ekranu
assert.deepStrictEqual(home({ hidden: ['settings'] }).hidden, []);
assert.ok(home({ hidden: ['settings', 'spotify'] }).order.includes('settings'));

console.log('ok — wszystkie testy przeszly');
