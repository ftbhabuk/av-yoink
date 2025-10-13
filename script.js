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

// Backend URL - change this to your server URL
const API_URL = 'http://localhost:5000';

// Mode switching functionality
youtubeMode.addEventListener('click', () => switchMode('youtube'));
spotifyMode.addEventListener('click', () => switchMode('spotify'));

function switchMode(mode) {
    currentMode = mode;
    
    // Update button states
    youtubeMode.classList.toggle('active', mode === 'youtube');
    spotifyMode.classList.toggle('active', mode === 'spotify');
    
    // Show/hide sections
    youtubeSection.style.display = mode === 'youtube' ? 'block' : 'none';
    spotifySection.style.display = mode === 'spotify' ? 'block' : 'none';
    
    // Show/hide download buttons
    downloadBtn.style.display = mode === 'youtube' ? 'block' : 'none';
    downloadVideoBtn.style.display = mode === 'youtube' ? 'block' : 'none';
    downloadSpotifyBtn.style.display = mode === 'spotify' ? 'block' : 'none';
    
    // Hide other sections
    videoPreview.style.display = 'none';
    qualitySelector.classList.remove('show');
    playlistSection.style.display = 'none';
    progressContainer.style.display = 'none';
    status.className = 'status';
    status.textContent = '';
    
    // Clear inputs
    urlInput.value = '';
    csvFile.value = '';
    fileName.textContent = '';
    spotifySongs = [];
}

// File upload functionality
uploadBtn.addEventListener('click', () => csvFile.click());
csvFile.addEventListener('change', handleFileUpload);

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.name.endsWith('.csv')) {
        showStatus('Please select a CSV file', 'error');
        return;
    }
    
    fileName.textContent = file.name;
    showStatus('Uploading and parsing CSV file...', '');
    
    const formData = new FormData();
    formData.append('csvFile', file);
    
    fetch(`${API_URL}/parse-csv`, {
        method: 'POST',
        body: formData
    })
    .then(response => {
        if (!response.ok) {
            return response.json().then(err => {
                throw new Error(err.error || 'Failed to parse CSV');
            });
        }
        return response.json();
    })
    .then(data => {
        if (data.error) {
            throw new Error(data.error);
        }
        
        spotifySongs = data.songs;
        displaySongList();
        showStatus(`Found ${spotifySongs.length} songs in playlist`, 'success');
    })
    .catch(error => {
        console.error('CSV parsing error:', error);
        showStatus(`Error: ${error.message}`, 'error');
        fileName.textContent = '';
        csvFile.value = '';
    });
}

function displaySongList() {
    songList.innerHTML = '';
    
    spotifySongs.forEach((song, index) => {
        const songItem = document.createElement('div');
        songItem.className = 'song-item';
        songItem.innerHTML = `
            <input type="checkbox" class="song-checkbox" ${song.selected ? 'checked' : ''} data-index="${index}">
            <div class="song-info">
                <div class="song-title">${escapeHtml(song.track_name)}</div>
                <div class="song-artist">${escapeHtml(song.artist_name)}</div>
                ${song.album_name ? `<div class="song-album">${escapeHtml(song.album_name)}</div>` : ''}
            </div>
        `;
        songList.appendChild(songItem);
    });
    
    // Add event listeners to checkboxes
    const checkboxes = songList.querySelectorAll('.song-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', updateSongSelection);
    });
    
    playlistSection.style.display = 'block';
    updateSelectedCount();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateSongSelection(event) {
    const index = parseInt(event.target.dataset.index);
    spotifySongs[index].selected = event.target.checked;
    updateSelectedCount();
}

function updateSelectedCount() {
    const selected = spotifySongs.filter(song => song.selected).length;
    selectedCount.textContent = `${selected} selected`;
}

// Playlist control buttons
selectAllBtn.addEventListener('click', () => {
    spotifySongs.forEach(song => song.selected = true);
    const checkboxes = songList.querySelectorAll('.song-checkbox');
    checkboxes.forEach(checkbox => checkbox.checked = true);
    updateSelectedCount();
});

deselectAllBtn.addEventListener('click', () => {
    spotifySongs.forEach(song => song.selected = false);
    const checkboxes = songList.querySelectorAll('.song-checkbox');
    checkboxes.forEach(checkbox => checkbox.checked = false);
    updateSelectedCount();
});

// Spotify download functionality
downloadSpotifyBtn.addEventListener('click', async () => {
    const selectedSongs = spotifySongs.filter(song => song.selected);
    
    if (selectedSongs.length === 0) {
        showStatus('Please select at least one song to download', 'error');
        return;
    }
    
    // Disable button during download
    downloadSpotifyBtn.disabled = true;
    
    showStatus(`Starting download of ${selectedSongs.length} songs... this may take a while`, '');
    progressContainer.style.display = 'block';
    progressText.textContent = 'Downloading songs...';
    progressBar.style.width = '50%';
    
    try {
        const response = await fetch(`${API_URL}/download-spotify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ songs: spotifySongs })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Download failed');
        }
        
        // Get filename from Content-Disposition header
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'spotify_playlist.zip';
        if (contentDisposition) {
            const matches = /filename="([^"]+)"/.exec(contentDisposition);
            if (matches) filename = matches[1];
        }
        
        // Download the file
        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(downloadUrl);
        
        showStatus(`Downloaded ${selectedSongs.length} songs as ZIP file!`, 'success');
        progressContainer.style.display = 'none';
        
    } catch (error) {
        console.error('Spotify download error:', error);
        showStatus(`Error: ${error.message}`, 'error');
        progressContainer.style.display = 'none';
    } finally {
        downloadSpotifyBtn.disabled = false;
    }
});

// Get video info and formats in parallel (much faster!)
async function getVideoInfo(url, showLoading = false) {
    try {
        if (showLoading) {
            showStatus('loading video info and quality options...', '');
        }
        
        // Make both API calls in parallel for better performance
        const [infoResponse, formatsResponse] = await Promise.all([
            fetch(`${API_URL}/video-info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url })
            }),
            fetch(`${API_URL}/video-formats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
            })
        ]);
        
        if (!infoResponse.ok) {
            throw new Error('Failed to get video info');
        }
        if (!formatsResponse.ok) {
            throw new Error('Failed to get video formats');
        }
        
        const [videoInfo, formatsData] = await Promise.all([
            infoResponse.json(),
            formatsResponse.json()
        ]);
        
        // Show video preview
        videoThumbnail.src = videoInfo.thumbnail;
        videoTitle.textContent = videoInfo.title;
        videoUploader.textContent = `by ${videoInfo.uploader}`;
        videoDuration.textContent = formatDuration(videoInfo.duration);
        
        videoPreview.style.display = 'block';
        
        // Show quality options immediately
        if (formatsData.formats && formatsData.formats.length > 0) {
            populateQualitySelector(formatsData.formats);
        } else {
            qualitySelector.classList.remove('show');
        }
        
        if (showLoading) {
            showStatus('', '');
        }
        
    } catch (error) {
        console.error('Error getting video info:', error);
        videoPreview.style.display = 'none';
        qualitySelector.classList.remove('show');
        if (showLoading) {
            showStatus('', '');
        }
    }
}

// Populate quality selector with available formats
function populateQualitySelector(formats) {
    qualitySelect.innerHTML = '';
    
    if (formats.length === 0) {
        qualitySelect.innerHTML = '<option value="">no formats available</option>';
        qualitySelector.classList.add('show');
        return;
    }
    
    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'auto (720p max)';
    qualitySelect.appendChild(defaultOption);
    
    // Add format options
    formats.forEach(format => {
        const option = document.createElement('option');
        option.value = format.quality.replace('p', '');
        option.textContent = `${format.quality} (${format.resolution})`;
        qualitySelect.appendChild(option);
    });
    
    // Show quality selector
    qualitySelector.classList.add('show');
}

function formatDuration(seconds) {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Audio download function
downloadBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    
    if (!url) {
        showStatus('please enter a youtube url', 'error');
        return;
    }
    
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
        showStatus('invalid youtube url', 'error');
        return;
    }
    
    await downloadContent(url, 'audio');
});

// Video download function
downloadVideoBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();

    if (!url) {
        showStatus('please enter a youtube url', 'error');
        return;
    }
    
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
        showStatus('invalid youtube url', 'error');
        return;
    }
    
    // If quality selector is not shown, load video info first
    if (!qualitySelector.classList.contains('show')) {
        showStatus('loading video info and quality options...', '');
        await getVideoInfo(url);
        showStatus('select a quality and click download video again', '');
        return;
    }
    
    // If quality selector is shown, proceed with download
    await downloadContent(url, 'video');
});

async function downloadContent(url, type) {
    // Disable both buttons
    downloadBtn.disabled = true;
    downloadVideoBtn.disabled = true;
    progressContainer.style.display = 'none';
    
    // Show progress bar and start download
    progressContainer.style.display = 'block';
    showStatus(`downloading ${type}...`, '');
    progressBar.style.width = '50%';
    progressText.textContent = 'Downloading...';
    
    try {
        // Create abort controller with longer timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 min timeout
        
        const endpoint = type === 'audio' ? '/download' : '/download-video';
        
        // Prepare request body
        const requestBody = { url: url };
        if (type === 'video') {
            const selectedQuality = qualitySelect.value;
            if (selectedQuality) {
                requestBody.quality = selectedQuality;
            }
        }
        
        const response = await fetch(`${API_URL}${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `${type} download failed`);
        }
        
        // Get filename from Content-Disposition header
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = type === 'audio' ? 'audio.mp3' : 'video.mp4';
        if (contentDisposition) {
            const matches = /filename="([^"]+)"/.exec(contentDisposition);
            if (matches) filename = matches[1];
        }
        
        // Download the file
        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(downloadUrl);
        
        showStatus(`${type} download complete!`, 'success');
        progressContainer.style.display = 'none';
        urlInput.value = '';
        
    } catch (error) {
        showStatus(`error: ${error.message}`, 'error');
        progressContainer.style.display = 'none';
    } finally {
        // Re-enable both buttons
        downloadBtn.disabled = false;
        downloadVideoBtn.disabled = false;
    }
}

function showStatus(message, type) {
    status.textContent = message;
    status.className = 'status show';
    if (type) status.classList.add(type);
}

// Auto-fetch video info when URL is pasted or typed
let debounceTimer;
urlInput.addEventListener('input', async (e) => {
    const url = e.target.value.trim();
    
    // Clear previous timer
    clearTimeout(debounceTimer);
    
    // Hide preview if URL is empty
    if (!url) {
        videoPreview.style.display = 'none';
        qualitySelector.classList.remove('show');
        return;
    }
    
    // Validate URL format
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
        videoPreview.style.display = 'none';
        qualitySelector.classList.remove('show');
        return;
    }
    
    // Debounce the API call (wait 500ms after user stops typing)
    debounceTimer = setTimeout(async () => {
        showStatus('loading video info...', '');
        await getVideoInfo(url);
        showStatus('', '');
    }, 500);
});

// Allow Enter key to submit (defaults to audio)
urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        downloadBtn.click();
    }
});