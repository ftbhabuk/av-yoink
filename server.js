const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const multer = require('multer');
const csv = require('csv-parser');
const https = require('https');
const http = require('http');
const pLimit = require('p-limit').default;

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Serve the main HTML file
app.get('/', (req, res) => {
res.sendFile(path.join(__dirname, 'index.html'));
});

// Allow yt-dlp/ffmpeg enough time to finish before Express closes the socket.
app.use((req, res, next) => {
const requestTimeoutMs = 10 * 60 * 1000;
req.setTimeout(requestTimeoutMs);
res.setTimeout(requestTimeoutMs);
next();
});

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
fs.mkdirSync(TEMP_DIR);
}

// Cookies file (local or deployed)
const COOKIES_FILE = fs.existsSync('/etc/secrets/cookies.txt')
? '/etc/secrets/cookies.txt'
: path.join(__dirname, 'cookies.txt');

// yt-dlp base args (spawn version)
function getYtDlpSpawnArgs() {
const args = [];
if (fs.existsSync(COOKIES_FILE)) {
args.push('--cookies', COOKIES_FILE);
}
args.push(
'--no-check-certificates',
'--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
'--extractor-retries', '3'
);
return args;
}

// yt-dlp base args (exec string version)
function getYtDlpExecArgs() {
let args = '';
if (fs.existsSync(COOKIES_FILE)) {
args += `--cookies "${COOKIES_FILE}" `;
}
args += '--no-check-certificates ';
args += '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ';
args += '--extractor-retries 3 ';
return args;
}

function getBestThumbnailUrl(videoInfo) {
if (Array.isArray(videoInfo?.thumbnails) && videoInfo.thumbnails.length > 0) {
return [...videoInfo.thumbnails]
.filter((thumb) => thumb?.url)
.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0]?.url || null;
}
return videoInfo?.thumbnail || null;
}

async function downloadThumbnail(thumbnailUrl, destinationPath) {
if (!thumbnailUrl) return null;

return new Promise((resolve, reject) => {
const protocol = thumbnailUrl.startsWith('https') ? https : http;
const file = fs.createWriteStream(destinationPath);

const request = protocol.get(thumbnailUrl, (response) => {
if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
file.close(() => fs.unlink(destinationPath, () => {}));
downloadThumbnail(response.headers.location, destinationPath).then(resolve).catch(reject);
return;
}

if (response.statusCode !== 200) {
file.close(() => fs.unlink(destinationPath, () => {}));
reject(new Error(`Thumbnail request failed with status ${response.statusCode}`));
return;
}

response.pipe(file);
file.on('finish', () => file.close(() => resolve(destinationPath)));
});

request.on('error', (err) => {
file.close(() => fs.unlink(destinationPath, () => {}));
reject(err);
});
});
}

async function runFfmpegTagging(audioPath, outputPath, metadata, thumbnailPath = null) {
return new Promise((resolve, reject) => {
const ffmpegArgs = ['-i', audioPath];

if (thumbnailPath) {
ffmpegArgs.push('-i', thumbnailPath);
}

ffmpegArgs.push(
'-map', '0:a',
'-c:a', 'copy',
'-id3v2_version', '3',
'-metadata', `title=${metadata.title || 'Unknown'}`,
'-metadata', `artist=${metadata.artist || 'Unknown'}`,
'-metadata', `album=${metadata.album || 'YouTube'}`
);

if (thumbnailPath) {
ffmpegArgs.push(
'-map', '1:0',
'-c:v', 'mjpeg',
'-disposition:v', 'attached_pic',
'-metadata:s:v', 'title=Album cover',
'-metadata:s:v', 'comment=Cover (front)'
);
}

ffmpegArgs.push('-y', outputPath);

const ffmpeg = spawn('ffmpeg', ffmpegArgs);
let errorOutput = '';
ffmpeg.stderr.on('data', (data) => { errorOutput += data.toString(); });
ffmpeg.on('close', (code) => {
if (code !== 0) {
console.error('FFmpeg error:', errorOutput);
reject(new Error('Failed to write metadata'));
} else {
resolve();
}
});
});
}

// Embed metadata and attach artwork when available.
async function embedMetadata(audioPath, metadata, thumbnailUrl = null) {
const outputPath = audioPath.replace('.mp3', '_final.mp3');
const thumbnailPath = thumbnailUrl ? path.join(TEMP_DIR, `${uuidv4()}_thumb`) : null;

try {
if (thumbnailPath) {
try {
await downloadThumbnail(thumbnailUrl, thumbnailPath);
await runFfmpegTagging(audioPath, outputPath, metadata, thumbnailPath);
console.log('✓ Metadata and thumbnail embedded');
} catch (artworkError) {
console.warn('Thumbnail embedding failed, retrying metadata only:', artworkError.message);
await runFfmpegTagging(audioPath, outputPath, metadata);
console.log('✓ Metadata embedded without thumbnail');
}
} else {
await runFfmpegTagging(audioPath, outputPath, metadata);
console.log('✓ Metadata embedded without thumbnail');
}

if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
fs.renameSync(outputPath, audioPath);
return true;
} catch (error) {
console.error('Error embedding metadata:', error);
return false;
} finally {
[thumbnailPath, outputPath].forEach((filePath) => {
if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
});
}
}

// Multer for CSV upload
const upload = multer({
dest: TEMP_DIR,
limits: { fileSize: 10 * 1024 * 1024 },
fileFilter: (req, file, cb) => {
if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) cb(null, true);
else cb(new Error('Only CSV files are allowed'), false);
}
});

// === Endpoints ===

// Video info
app.post('/video-info', async (req, res) => {
const { url } = req.body;
if (!url) return res.status(400).json({ error: 'No URL provided' });

const cmd = `yt-dlp ${getYtDlpExecArgs()}--dump-json --no-download "${url}"`;
exec(cmd, { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
if (error) return res.status(500).json({ error: 'Failed to get video info' });
try {
const data = JSON.parse(stdout);
res.json({
title: data.title,
duration: data.duration,
thumbnail: data.thumbnail,
uploader: data.uploader,
view_count: data.view_count,
upload_date: data.upload_date
});
} catch (e) {
res.status(500).json({ error: 'Failed to parse video info' });
}
});
});

// Video formats
app.post('/video-formats', async (req, res) => {
const { url } = req.body;
if (!url) return res.status(400).json({ error: 'No URL provided' });

const cmd = `yt-dlp ${getYtDlpExecArgs()}-F "${url}"`;
exec(cmd, { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
if (error) return res.status(500).json({ error: 'Failed to get formats' });

const formats = [];
for (const line of stdout.split('\n')) {
if (line.includes('x') && (line.includes('p,') || line.includes('p '))) {
const parts = line.trim().split(/\s+/);
if (parts.length >= 3) {
const qualityMatch = line.match(/(\d+)p/);
if (qualityMatch) {
formats.push({
id: parts[0],
extension: parts[1],
resolution: parts[2],
quality: qualityMatch[1] + 'p',
size: parts[4] || 'unknown'
});
}
}
}
}
formats.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
res.json({ formats });
});
});

// Parse Spotify CSV
app.post('/parse-csv', upload.single('csvFile'), (req, res) => {
if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

const songs = [];
const filePath = req.file.path;

fs.createReadStream(filePath)
.pipe(csv())
.on('data', (row) => {
const trackName = row['Track Name'] || row['track_name'] || row['TrackName'] || row['Track'] || row['track'] || row['Song'] || row['song'] || row['Title'] || row['title'];
const artistName = row['Artist Name(s)'] || row['Artist Name'] || row['artist_name'] || row['ArtistName'] || row['Artist'] || row['artist'] || row['Artists'] || row['artists'];
const albumName = row['Album Name'] || row['album_name'] || row['AlbumName'] || row['Album'] || row['album'];
const duration = row['Duration (ms)'] || row['duration_ms'] || row['DurationMs'] || row['Duration'] || row['duration'];

if (trackName && artistName) {
songs.push({
track_name: trackName,
artist_name: artistName,
album_name: albumName,
duration_ms: duration,
selected: true
});
}
})
.on('end', () => {
fs.unlinkSync(filePath);
if (songs.length === 0) return res.status(400).json({ error: 'No valid songs found in CSV' });
res.json({ songs });
})
.on('error', (err) => {
if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
res.status(500).json({ error: 'Failed to parse CSV' });
});
});

// Fixed /download-spotify endpoint - handles SINGLE song only
app.post('/download-spotify', async (req, res) => {
const { song } = req.body; // ← Expects ONE song object, not array
if (!song || !song.track_name || !song.artist_name) {
return res.status(400).json({ error: 'Invalid song data' });
}

const searchQuery = `${song.track_name} ${song.artist_name}`;
const id = uuidv4();
const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);
const baseArgs = getYtDlpSpawnArgs();

try {
// Download with timeout
await new Promise((resolve, reject) => {
const ytdlpArgs = [
...baseArgs,
'-x', '--audio-format', 'mp3', 
'--audio-quality', '0',
'-o', outputTemplate,
'--no-playlist', 
'--no-warnings',
'--quiet',
`ytsearch1:${searchQuery}`
];
const ytdlp = spawn('yt-dlp', ytdlpArgs);
const timeout = setTimeout(() => {
ytdlp.kill();
reject(new Error('Download timeout'));
}, 60 * 1000);

let stderrOutput = '';
ytdlp.stderr.on('data', (data) => {
stderrOutput += data.toString();
});

ytdlp.on('close', (code) => {
clearTimeout(timeout);
if (code !== 0) {
const errorMsg = stderrOutput.includes('No video') ? 'Song not found' :
stderrOutput.includes('blocked') ? 'Video blocked/restricted' :
stderrOutput.includes('timeout') ? 'Connection timeout' :
'Download failed';
reject(new Error(errorMsg));
} else {
resolve();
}
});
});

// Find the downloaded file
const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
if (files.length === 0) {
return res.status(500).json({ error: 'File not found after download' });
}

const filePath = path.join(TEMP_DIR, files[0]);

// Fetch the matched video's thumbnail when possible, but always write the text metadata.
try {
const infoCmd = `yt-dlp ${getYtDlpExecArgs()}--dump-json --no-download "ytsearch1:${searchQuery}"`;
const infoJson = await Promise.race([
new Promise((resolve) => {
exec(infoCmd, { maxBuffer: 5 * 1024 * 1024 }, (e, out) => {
try { resolve(JSON.parse(out)); } catch { resolve(null); }
});
}),
new Promise((resolve) => setTimeout(() => resolve(null), 20 * 1000))
]);

await embedMetadata(filePath, {
title: song.track_name,
artist: song.artist_name,
album: song.album_name || 'Spotify Playlist'
}, getBestThumbnailUrl(infoJson));
} catch (e) {
console.log('Metadata embedding skipped:', e.message);
}

// Send file directly
const cleanName = `${song.artist_name} - ${song.track_name}.mp3`
.replace(/[<>:"/\\|?*]/g, '_')
.substring(0, 200);

res.download(filePath, cleanName, (err) => {
// Clean up after download
setTimeout(() => {
if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}, 5000);
});

} catch (error) {
console.error(`✗ Failed to download: ${song.artist_name} - ${song.track_name}`);
console.error(` Reason: ${error.message}`);
// Clean up any partial files
const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
files.forEach(f => {
try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch {}
});
res.status(500).json({ error: error.message || 'Download failed' });
}
});

// Serve temp files directly
app.get('/temp/:filename', (req, res) => {
const filePath = path.join(TEMP_DIR, req.params.filename);
if (fs.existsSync(filePath)) {
res.download(filePath, () => {
setTimeout(() => fs.existsSync(filePath) && fs.unlinkSync(filePath), 10000);
});
} else {
res.status(404).send('File not found');
}
});

// Single audio download
app.post('/download', async (req, res) => {
const { url } = req.body;
if (!url) return res.status(400).json({ error: 'No URL provided' });

const id = uuidv4();
const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

let videoInfo = null;
try {
const infoCmd = `yt-dlp ${getYtDlpExecArgs()}--dump-json --no-download "${url}"`;
videoInfo = await new Promise((resolve, reject) => {
exec(infoCmd, { maxBuffer: 5 * 1024 * 1024 }, (e, out) => {
try { resolve(JSON.parse(out)); } catch { resolve(null); }
});
});
} catch (e) { /* ignore */ }

const ytdlpArgs = [
...getYtDlpSpawnArgs(),
'-x', '--audio-format', 'mp3', '--audio-quality', '0',
'-o', outputTemplate, '--no-playlist', url
];
const ytdlp = spawn('yt-dlp', ytdlpArgs);

ytdlp.on('close', async (code) => {
if (code !== 0) return res.status(500).json({ error: 'Download failed' });

const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
if (files.length === 0) return res.status(500).json({ error: 'File not found' });

const filePath = path.join(TEMP_DIR, files[0]);

await embedMetadata(filePath, {
title: videoInfo?.title,
artist: videoInfo?.uploader || videoInfo?.channel,
album: 'YouTube'
}, getBestThumbnailUrl(videoInfo));

let cleanName = videoInfo?.title
? `${videoInfo.title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200)}.mp3`
: `${id.substring(0, 8)}_download.mp3`;

res.download(filePath, cleanName, () => {
setTimeout(() => fs.existsSync(filePath) && fs.unlinkSync(filePath), 5000);
});
});
});

// Video download
app.post('/download-video', async (req, res) => {
const { url, quality } = req.body;
if (!url) return res.status(400).json({ error: 'No URL provided' });

const id = uuidv4();
const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

let videoInfo = null;
try {
const infoCmd = `yt-dlp ${getYtDlpExecArgs()}--dump-json --no-download "${url}"`;
videoInfo = await new Promise((resolve) => {
exec(infoCmd, { maxBuffer: 5 * 1024 * 1024 }, (e, out) => {
try { resolve(JSON.parse(out)); } catch { resolve(null); }
});
});
} catch (e) { /* ignore */ }

const format = quality ? `best[height<=${quality}]` : 'best[height<=720]';
const ytdlpArgs = [...getYtDlpSpawnArgs(), '-f', format, '-o', outputTemplate, '--no-playlist', url];
const ytdlp = spawn('yt-dlp', ytdlpArgs);

ytdlp.on('close', (code) => {
if (code !== 0) return res.status(500).json({ error: 'Video download failed' });

const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
if (files.length === 0) return res.status(500).json({ error: 'Video not found' });

const filePath = path.join(TEMP_DIR, files[0]);
const ext = path.extname(filePath);
const cleanName = videoInfo?.title
? `${videoInfo.title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200)}${ext}`
: `${id.substring(0, 8)}_video${ext || '.mp4'}`;

res.download(filePath, cleanName, () => {
setTimeout(() => fs.existsSync(filePath) && fs.unlinkSync(filePath), 5000);
});
});
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
console.log(`Server running on http://localhost:${PORT}`);
console.log('Make sure yt-dlp and ffmpeg are installed!');
if (fs.existsSync(COOKIES_FILE)) {
console.log('✓ Cookies file found');
} else {
console.log('⚠ No cookies.txt – may hit bot detection');
}
});
