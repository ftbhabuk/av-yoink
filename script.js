// YouTube elements
const urlInput = document.getElementById('urlInput');
const downloadBtn = document.getElementById('downloadBtn');
const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const status = document.getElementById('status');
const videoPreview = document.getElementById('videoPreview');
const videoThumbnail = document.getElementById('videoThumbnail');
const videoTitle = document.getElementById('videoTitle');
const videoUploader = document.getElementById('videoUploader');
const videoDuration = document.getElementById('videoDuration');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const qualitySelector = document.getElementById('qualitySelector');
const qualitySelect = document.getElementById('qualitySelect');

// Spotify elements
const youtubeMode = document.getElementById('youtubeMode');
const spotifyMode = document.getElementById('spotifyMode');
const youtubeSection = document.getElementById('youtubeSection');
const spotifySection = document.getElementById('spotifySection');
const csvFile = document.getElementById('csvFile');
const uploadBtn = document.getElementById('uploadBtn');
const fileName = document.getElementById('fileName');
const playlistSection = document.getElementById('playlistSection');
const songList = document.getElementById('songList');
const selectAllBtn = document.getElementById('selectAllBtn');
const deselectAllBtn = document.getElementById('deselectAllBtn');
const selectedCount = document.getElementById('selectedCount');
const downloadSpotifyBtn = document.getElementById('downloadSpotifyBtn');

// Global variables
let currentMode = 'youtube';
let spotifySongs = [];

// Drag selection
let isDragging = false;
let dragStartIndex = -1;
let initialSelectionState = false;

const API_URL = window.location.origin;

// Mode switching
youtubeMode.addEventListener('click', () => switchMode('youtube'));
spotifyMode.addEventListener('click', () => switchMode('spotify'));

function switchMode(mode) {
currentMode = mode;
youtubeMode.classList.toggle('active', mode === 'youtube');
spotifyMode.classList.toggle('active', mode === 'spotify');
youtubeSection.style.display = mode === 'youtube' ? 'block' : 'none';
spotifySection.style.display = mode === 'spotify' ? 'block' : 'none';
downloadBtn.style.display = mode === 'youtube' ? 'block' : 'none';
downloadVideoBtn.style.display = mode === 'youtube' ? 'block' : 'none';
downloadSpotifyBtn.style.display = mode === 'spotify' ? 'block' : 'none';

videoPreview.style.display = 'none';
qualitySelector.classList.remove('show');
playlistSection.style.display = 'none';
progressContainer.style.display = 'none';
status.className = 'status';
status.textContent = '';

urlInput.value = '';
csvFile.value = '';
fileName.textContent = '';
spotifySongs = [];
}

// CSV Upload
uploadBtn.addEventListener('click', () => csvFile.click());
csvFile.addEventListener('change', handleFileUpload);

function handleFileUpload(e) {
const file = e.target.files[0];
if (!file || !file.name.endsWith('.csv')) {
showStatus('Please select a valid CSV file', 'error');
return;
}
fileName.textContent = file.name;
showStatus('Parsing CSV...', '');

const formData = new FormData();
formData.append('csvFile', file);

fetch(`${API_URL}/parse-csv`, { method: 'POST', body: formData })
.then(r => r.ok ? r.json() : r.json().then(err => Promise.reject(err.error)))
.then(data => {
spotifySongs = data.songs;
displaySongList();
showStatus(`Loaded ${spotifySongs.length} songs`, 'success');
})
.catch(err => {
showStatus(`Error: ${err}`, 'error');
fileName.textContent = '';
});
}

function displaySongList() {
songList.innerHTML = '';
spotifySongs.forEach((song, i) => {
const div = document.createElement('div');
div.className = 'song-item';
div.dataset.index = i;
div.innerHTML = `
<input type="checkbox" class="song-checkbox" ${song.selected ? 'checked' : ''} data-index="${i}">
<div class="song-info">
<div class="song-title">${escapeHtml(song.track_name)}</div>
<div class="song-artist">${escapeHtml(song.artist_name)}</div>
${song.album_name ? `<div class="song-album">${escapeHtml(song.album_name)}</div>` : ''}
</div>
`;
songList.appendChild(div);
});

document.querySelectorAll('.song-checkbox').forEach(cb => cb.addEventListener('change', updateSongSelection));
setupDragSelection();
playlistSection.style.display = 'block';
updateSelectedCount();
}

function setupDragSelection() {
songList.querySelectorAll('.song-item').forEach(item => {
item.addEventListener('mousedown', e => {
if (e.target.classList.contains('song-checkbox')) return;
e.preventDefault();
isDragging = true;
dragStartIndex = +item.dataset.index;
initialSelectionState = !spotifySongs[dragStartIndex].selected;
toggleSongSelection(dragStartIndex, initialSelectionState);
});
item.addEventListener('mouseenter', () => {
if (isDragging) toggleSongSelection(+item.dataset.index, initialSelectionState);
});
});
document.addEventListener('mouseup', () => { isDragging = false; });
}

function toggleSongSelection(i, state) {
spotifySongs[i].selected = state;
const cb = songList.querySelector(`input[data-index="${i}"]`);
if (cb) cb.checked = state;
updateSelectedCount();
}

function updateSongSelection(e) {
const i = +e.target.dataset.index;
spotifySongs[i].selected = e.target.checked;
updateSelectedCount();
}

function updateSelectedCount() {
const count = spotifySongs.filter(s => s.selected).length;
selectedCount.textContent = `${count} selected`;
}

selectAllBtn.onclick = () => {
spotifySongs.forEach(s => s.selected = true);
songList.querySelectorAll('.song-checkbox').forEach(cb => cb.checked = true);
updateSelectedCount();
};
deselectAllBtn.onclick = () => {
spotifySongs.forEach(s => s.selected = false);
songList.querySelectorAll('.song-checkbox').forEach(cb => cb.checked = false);
updateSelectedCount();
};

// FIXED Spotify bulk download - properly sends one song at a time
downloadSpotifyBtn.onclick = async () => {
const selected = spotifySongs.filter(s => s.selected);
if (selected.length === 0) return showStatus('Select at least one song', 'error');

downloadSpotifyBtn.disabled = true;
showStatus(`Starting download of ${selected.length} songs...`, '');
progressContainer.style.display = 'block';
progressBar.style.width = '0%';

let completed = 0;
let failed = 0;

// Process songs with controlled concurrency (2 at a time max)
const downloadQueue = [...selected];
const activeDownloads = [];
const maxConcurrent = 5;

const downloadOne = async (song) => {
try {
const response = await fetch(`${API_URL}/download-spotify`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ song }) // ← Send single song object, not array
});

if (!response.ok) {
const err = await response.json().catch(() => ({}));
throw new Error(err.error || 'Download failed');
}

const blob = await response.blob();
const filename = `${song.artist_name} - ${song.track_name}.mp3`
.replace(/[<>:"/\\|?*]/g, '_');

// Trigger download
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = filename;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
// Clean up after small delay
setTimeout(() => URL.revokeObjectURL(url), 1000);

completed++;
console.log(`✓ Downloaded: ${song.track_name}`);
} catch (err) {
console.error(`✗ Failed: ${song.track_name}`, err);
failed++;
}

// Update progress
const total = completed + failed;
const percent = Math.round((total / selected.length) * 100);
progressBar.style.width = percent + '%';
progressText.textContent = `${total} / ${selected.length} songs (${failed} failed)`;
};

// Process queue with concurrency limit
while (downloadQueue.length > 0 || activeDownloads.length > 0) {
// Start new downloads up to limit
while (activeDownloads.length < maxConcurrent && downloadQueue.length > 0) {
const song = downloadQueue.shift();
const promise = downloadOne(song);
activeDownloads.push(promise);
// Remove from active when done
promise.finally(() => {
const idx = activeDownloads.indexOf(promise);
if (idx > -1) activeDownloads.splice(idx, 1);
});
}

// Wait for at least one to finish before continuing
if (activeDownloads.length > 0) {
await Promise.race(activeDownloads);
}
// Small delay to prevent browser blocking downloads
await new Promise(r => setTimeout(r, 300));
}

// Done
const successMsg = failed > 0 
? `Done! ${completed} downloaded, ${failed} failed` 
: `All ${completed} songs downloaded successfully!`;
showStatus(successMsg, failed > 0 ? 'warning' : 'success');
progressContainer.style.display = 'none';
downloadSpotifyBtn.disabled = false;
};
async function triggerDownload(url, filename) {
const a = document.createElement('a');
a.href = url;
a.download = filename;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
// Small delay so browser doesn't block as popup
await new Promise(r => setTimeout(r, 300));
}

// Video info + formats
async function getVideoInfo(url) {
try {
showStatus('Loading video info...', '');
const [infoRes, formatsRes] = await Promise.all([
fetch(`${API_URL}/video-info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }),
fetch(`${API_URL}/video-formats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
]);

const info = await infoRes.json();
const formats = await formatsRes.json();

videoThumbnail.src = info.thumbnail || '';
videoTitle.textContent = info.title || 'Unknown';
videoUploader.textContent = info.uploader ? `by ${info.uploader}` : '';
videoDuration.textContent = info.duration ? formatDuration(info.duration) : '';
videoPreview.style.display = 'block';

if (formats.formats?.length) {
populateQualitySelector(formats.formats);
} else {
qualitySelector.classList.remove('show');
}
showStatus('', '');
} catch (e) {
console.error(e);
showStatus('Failed to load video info', 'error');
}
}

function populateQualitySelector(formats) {
qualitySelect.innerHTML = '<option value="">auto (720p max)</option>';
formats.forEach(f => {
const opt = document.createElement('option');
opt.value = f.quality.replace('p', '');
opt.textContent = `${f.quality} (${f.resolution})`;
qualitySelect.appendChild(opt);
});
qualitySelector.classList.add('show');
}

function formatDuration(sec) {
if (!sec) return '';
const m = Math.floor(sec / 60);
const s = sec % 60;
return `${m}:${s.toString().padStart(2, '0')}`;
}

// Single audio/video download (works again!)
downloadBtn.onclick = () => downloadContent(urlInput.value.trim(), 'audio');
downloadVideoBtn.onclick = async () => {
const url = urlInput.value.trim();
if (!qualitySelector.classList.contains('show')) {
await getVideoInfo(url);
showStatus('Select quality then click Download Video again', '');
return;
}
downloadContent(url, 'video');
};

async function downloadContent(url, type) {
if (!url || !url.includes('youtube.com') && !url.includes('youtu.be')) {
return showStatus('Enter a valid YouTube URL', 'error');
}

downloadBtn.disabled = true;
downloadVideoBtn.disabled = true;
progressContainer.style.display = 'block';
progressBar.style.width = '30%';
showStatus(`Downloading ${type}...`, '');

try {
const endpoint = type === 'audio' ? '/download' : '/download-video';
const body = { url };
if (type === 'video' && qualitySelect.value) body.quality = qualitySelect.value;

const res = await fetch(`${API_URL}${endpoint}`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body)
});

if (!res.ok) throw new Error((await res.json()).error || 'Download failed');

let filename = type === 'audio' ? 'audio.mp3' : 'video.mp4';
const disposition = res.headers.get('Content-Disposition');
if (disposition) {
const match = disposition.match(/filename="?([^"]+)"?/);
if (match) filename = match[1];
}

const blob = await res.blob();
const objUrl = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = objUrl;
a.download = filename;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(objUrl);

showStatus(`${type} downloaded!`, 'success');
} catch (err) {
showStatus(`Error: ${err.message}`, 'error');
} finally {
progressContainer.style.display = 'none';
downloadBtn.disabled = false;
downloadVideoBtn.disabled = false;
}
}

function showStatus(msg, type = '') {
status.textContent = msg;
status.className = 'status show';
if (type) status.classList.add(type);
}

function escapeHtml(text) {
const div = document.createElement('div');
div.textContent = text;
return div.innerHTML;
}

// Auto load info on input
let debounce;
urlInput.addEventListener('input', () => {
clearTimeout(debounce);
const val = urlInput.value.trim();
if (!val) {
videoPreview.style.display = 'none';
qualitySelector.classList.remove('show');
return;
}
debounce = setTimeout(() => getVideoInfo(val), 600);
});

urlInput.addEventListener('keypress', e => e.key === 'Enter' && downloadBtn.click());
