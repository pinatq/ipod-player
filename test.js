const assert = require('assert');
const { validateYoutubeUrl, parseSpotifyUrl, spotifyEntityQueries, wheelDelta, safeTrackPath } = require('./lib');
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

console.log('ok — wszystkie testy przeszly');
