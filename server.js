const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const multer = require('multer');
const csv = require('csv-parser');
const archiver = require('archiver');
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

// Increase timeout for long downloads
app.use((req, res, next) => {
    res.setTimeout(600000); // 10 minutes for playlist downloads
    next();
});

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}
//deployment n local cookies files directory 
const COOKIES_FILE = fs.existsSync('/etc/secrets/cookies.txt')
    ? '/etc/secrets/cookies.txt'  // Render
    : path.join(__dirname, 'cookies.txt'); // Local

// Helper function to get yt-dlp base arguments with cookies for spawn
function getYtDlpSpawnArgs() {
    const args = [];
    
    // Add cookies if file exists
    if (fs.existsSync(COOKIES_FILE)) {
        args.push('--cookies', COOKIES_FILE);
    }
    
    // Add additional arguments to avoid bot detection
    args.push(
        '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--extractor-retries', '3'
    );
    
    return args;
}

// Helper function to get yt-dlp base arguments with cookies for exec (string format)
function getYtDlpExecArgs() {
    let args = '';
    
    // Add cookies if file exists
    if (fs.existsSync(COOKIES_FILE)) {
        args += `--cookies "${COOKIES_FILE}" `;
    }
    
    // Add additional arguments to avoid bot detection
    args += '--no-check-certificates ';
    args += '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ';
    args += '--extractor-retries 3 ';
    
    return args;
}

// Helper function to embed metadata and thumbnail using ffmpeg
async function embedMetadataAndThumbnail(audioPath, metadata, thumbnailUrl) {
    const outputPath = audioPath.replace('.mp3', '_final.mp3');
    const thumbnailPath = path.join(TEMP_DIR, `${uuidv4()}_thumb.jpg`); // Unique temp thumbnail path
    
    try {
        // Download thumbnail
        await new Promise((resolve, reject) => {
            const protocol = thumbnailUrl.startsWith('https') ? https : http;
            const file = fs.createWriteStream(thumbnailPath);
            
            protocol.get(thumbnailUrl, (response) => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlink(thumbnailPath, () => {});
                reject(err);
            });
        });
        
        // Embed metadata and thumbnail using ffmpeg
        await new Promise((resolve, reject) => {
            const ffmpegArgs = [
                '-i', audioPath,
                '-i', thumbnailPath,
                '-map', '0:a',
                '-map', '1:0',
                '-c', 'copy',
                '-id3v2_version', '3',
                '-metadata:s:v', 'title="Album cover"',
                '-metadata:s:v', 'comment="Cover (front)"',
                '-metadata', `title=${metadata.title || 'Unknown'}`,
                '-metadata', `artist=${metadata.artist || 'Unknown'}`,
                '-metadata', `album=${metadata.album || 'YouTube'}`,
                '-y',
                outputPath
            ];
            
            const ffmpeg = spawn('ffmpeg', ffmpegArgs);
            
            let errorOutput = '';
            
            ffmpeg.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            
            ffmpeg.on('close', (code) => {
                // Clean up thumbnail
                if (fs.existsSync(thumbnailPath)) {
                    fs.unlinkSync(thumbnailPath);
                }
                
                if (code !== 0) {
                    console.error('FFmpeg error:', errorOutput);
                    reject(new Error('Failed to embed metadata'));
                } else {
                    // Remove original file and rename final file
                    if (fs.existsSync(audioPath)) {
                        fs.unlinkSync(audioPath);
                    }
                    fs.renameSync(outputPath, audioPath);
                    resolve();
                }
            });
        });
        
        console.log('✓ Metadata and thumbnail embedded successfully');
        return true;
        
    } catch (error) {
        console.error('Error embedding metadata:', error);
        // Clean up temp files
        if (fs.existsSync(thumbnailPath)) {
            fs.unlinkSync(thumbnailPath);
        }
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        return false;
    }
}


// Configure multer for file uploads
const upload = multer({
    dest: TEMP_DIR,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Only CSV files are allowed'), false);
        }
    }
});

// Get video info endpoint (fast)
app.post('/video-info', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const baseArgs = getYtDlpExecArgs();
    const cmd = `yt-dlp ${baseArgs}--dump-json --no-download "${url}"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error) {
            console.error('Video info error:', stderr);
            return res.status(500).json({ error: 'Failed to get video info' });
        }

        try {
            const videoData = JSON.parse(stdout);
            const info = {
                title: videoData.title,
                duration: videoData.duration,
                thumbnail: videoData.thumbnail,
                uploader: videoData.uploader,
                view_count: videoData.view_count,
                upload_date: videoData.upload_date
            };
            res.json(info);
        } catch (parseError) {
            console.error('Parse error:', parseError);
            res.status(500).json({ error: 'Failed to parse video info' });
        }
    });
});

// Get video formats endpoint (fast)
app.post('/video-formats', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const baseArgs = getYtDlpExecArgs();
    const cmd = `yt-dlp ${baseArgs}-F "${url}"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error) {
            console.error('Video formats error:', stderr);
            return res.status(500).json({ error: 'Failed to get video formats' });
        }

        try {
            const lines = stdout.split('\n');
            const formats = [];
            
            for (const line of lines) {
                if (line.includes('x') && (line.includes('p,') || line.includes('p '))) {
                    const parts = line.trim().split(/\s+/);
                    
                    if (parts.length >= 3) {
                        const id = parts[0];
                        const ext = parts[1];
                        const resolution = parts[2];
                        
                        const qualityMatch = line.match(/(\d+p),?/);
                        if (qualityMatch) {
                            const quality = qualityMatch[1];
                            
                            if (resolution.includes('x') && quality.includes('p')) {
                                formats.push({
                                    id: id,
                                    extension: ext,
                                    resolution: resolution,
                                    quality: quality,
                                    size: parts[4] || 'unknown'
                                });
                            }
                        }
                    }
                }
            }
            
            // Sort by quality (highest first)
            formats.sort((a, b) => {
                const aP = parseInt(a.quality);
                const bP = parseInt(b.quality);
                return bP - aP;
            });
            
            res.json({ formats: formats });
        } catch (parseError) {
            console.error('Parse error:', parseError);
            res.status(500).json({ error: 'Failed to parse video formats' });
        }
    });
});

// Parse Spotify CSV file - improved column detection
app.post('/parse-csv', upload.single('csvFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No CSV file uploaded' });
    }

    const songs = [];
    const filePath = req.file.path;
    let headers = [];

    fs.createReadStream(filePath)
        .pipe(csv())
        .on('headers', (headerList) => {
            headers = headerList;
            console.log('CSV Headers:', headers);
        })
        .on('data', (row) => {
            // Try multiple possible column name variations
            const trackName = row['Track Name'] || row['track_name'] || row['TrackName'] || 
                            row['Track'] || row['track'] || row['Song'] || row['song'] ||
                            row['Title'] || row['title'];
            
            const artistName = row['Artist Name(s)'] || row['Artist Name'] || row['artist_name'] || 
                             row['ArtistName'] || row['Artist'] || row['artist'] || 
                             row['Artists'] || row['artists'];
            
            const albumName = row['Album Name'] || row['album_name'] || row['AlbumName'] || 
                            row['Album'] || row['album'];
            
            const duration = row['Duration (ms)'] || row['duration_ms'] || row['DurationMs'] ||
                           row['Duration'] || row['duration'];

            const song = {
                track_name: trackName,
                artist_name: artistName,
                album_name: albumName,
                duration_ms: duration,
                selected: true
            };
            
            // Only add if we have at least track name and artist
            if (song.track_name && song.artist_name) {
                songs.push(song);
                console.log(`✓ Parsed: ${song.track_name} by ${song.artist_name}`);
            } else {
                console.log(`✗ Skipped row - missing data:`, { trackName, artistName });
            }
        })
        .on('end', () => {
            // Clean up the uploaded file
            fs.unlinkSync(filePath);
            
            if (songs.length === 0) {
                return res.status(400).json({ 
                    error: 'No valid songs found in CSV file. Please check column names.',
                    headers: headers 
                });
            }
            
            console.log(`Parsed ${songs.length} songs from CSV`);
            res.json({ songs: songs });
        })
        .on('error', (error) => {
            // Clean up the uploaded file
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            console.error('CSV parsing error:', error);
            res.status(500).json({ error: 'Failed to parse CSV file' });
        });
});

// Download multiple songs from Spotify playlist
app.post('/download-spotify', async (req, res) => {
    const { songs } = req.body;

    if (!songs || !Array.isArray(songs) || songs.length === 0) {
        return res.status(400).json({ error: 'No songs provided' });
    }

    // Filter only selected songs
    const selectedSongs = songs.filter(song => song.selected);
    
    if (selectedSongs.length === 0) {
        return res.status(400).json({ error: 'No songs selected for download' });
    }

    console.log(`Starting download of ${selectedSongs.length} songs`);

    const downloadedFiles = [];
    const zipId = uuidv4();
    const zipPath = path.join(TEMP_DIR, `${zipId}.zip`);
    
    const baseArgs = getYtDlpSpawnArgs();
    const infoBaseArgs = getYtDlpExecArgs(); // For fetching info via exec

    // Use p-limit to control concurrency (e.g., 3 concurrent downloads)
    const limit = pLimit(3); // Adjust concurrency as needed
    const MAX_RETRIES = 3; // Max retries per song
    let currentSongIndex = 0;

    const downloadSong = async (song, retryCount = 0) => {
        currentSongIndex++;
        const displayIndex = currentSongIndex;
        
        console.log(`[${displayIndex}/${selectedSongs.length}] Downloading: ${song.track_name} by ${song.artist_name} (Attempt: ${retryCount + 1})`);
        
        const searchQuery = `${song.track_name} ${song.artist_name}`;
        const id = uuidv4();
        const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);
        
        try {
            await new Promise((resolve, reject) => {
                const ytdlpArgs = [
                    ...baseArgs,
                    '-x', 
                    '--audio-format', 'mp3', 
                    '--audio-quality', '0',
                    '-o', outputTemplate,
                    '--no-playlist',
                    '--no-warnings',
                    '--quiet',
                    `ytsearch1:${searchQuery}`
                ];

                const ytdlp = spawn('yt-dlp', ytdlpArgs);

                let errorOutput = '';

                ytdlp.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });

                ytdlp.on('close', async (code) => {
                    if (code !== 0) {
                        console.error(`[${displayIndex}/${selectedSongs.length}] Failed to download: ${song.track_name} - ${errorOutput.trim().split('\n').pop()}`);
                        reject(new Error('Download failed')); // Reject to trigger retry
                        return;
                    }

                    // Find the downloaded file
                    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
                    
                    if (files.length > 0) {
                        const filePath = path.join(TEMP_DIR, files[0]);
                        
                        // Try to get video info for thumbnail
                        try {
                            const infoCmd = `yt-dlp ${infoBaseArgs}--dump-json --no-download "ytsearch1:${searchQuery}"`;
                            
                            const videoInfo = await new Promise((resolveInfo, rejectInfo) => {
                                exec(infoCmd, { maxBuffer: 1024 * 1024 * 5, timeout: 10000 }, (errorInfo, stdoutInfo, stderrInfo) => {
                                    if (errorInfo) {
                                        resolveInfo(null);
                                        return;
                                    }
                                    try {
                                        resolveInfo(JSON.parse(stdoutInfo));
                                    } catch (e) {
                                        resolveInfo(null);
                                    }
                                });
                            });
                            
                            // Embed metadata if we got video info
                            if (videoInfo && videoInfo.thumbnail) {
                                const metadata = {
                                    title: song.track_name,
                                    artist: song.artist_name,
                                    album: song.album_name || 'Spotify Playlist'
                                };
                                await embedMetadataAndThumbnail(filePath, metadata, videoInfo.thumbnail);
                            }
                        } catch (error) {
                            console.log(`[${displayIndex}/${selectedSongs.length}] Could not add metadata for: ${song.track_name}`);
                        }
                        
                        const cleanName = `${song.artist_name} - ${song.track_name}.mp3`
                            .replace(/[<>:"/\\|?*]/g, '_')
                            .substring(0, 200); // Limit filename length
                        
                        downloadedFiles.push({
                            path: filePath,
                            name: cleanName
                        });
                        console.log(`[${displayIndex}/${selectedSongs.length}] ✓ Downloaded: ${cleanName}`);
                        resolve();
                    } else {
                        console.error(`[${displayIndex}/${selectedSongs.length}] No file found after download for ${song.track_name}`);
                        reject(new Error('File not found'));
                    }
                });

                // Timeout for each song (3 minutes)
                setTimeout(() => {
                    if (ytdlp.pid && !ytdlp.killed) { // Check if process is still active
                        ytdlp.kill();
                        reject(new Error('Download timed out'));
                    }
                }, 180000); // 3 minutes
            });
            return true; // Indicate success
            
        } catch (error) {
            console.error(`[${displayIndex}/${selectedSongs.length}] Error processing ${song.track_name}:`, error.message);
            if (retryCount < MAX_RETRIES) {
                console.log(`[${displayIndex}/${selectedSongs.length}] Retrying ${song.track_name}... (Retry ${retryCount + 1}/${MAX_RETRIES})`);
                await new Promise(resolve => setTimeout(resolve, 5000 * (retryCount + 1))); // Exponential backoff
                return downloadSong(song, retryCount + 1); // Retry
            } else {
                console.error(`[${displayIndex}/${selectedSongs.length}] Max retries reached for ${song.track_name}. Skipping.`);
                return false; // Indicate failure after max retries
            }
        }
    };

    const downloadPromises = selectedSongs.map(song => limit(() => downloadSong(song)));
    await Promise.allSettled(downloadPromises); // Wait for all downloads to finish or fail

    if (downloadedFiles.length === 0) {
        return res.status(500).json({ error: 'Failed to download any songs. YouTube may be blocking requests or max retries reached. Make sure cookies.txt is properly configured.' });
    }

    console.log(`Successfully downloaded ${downloadedFiles.length}/${selectedSongs.length} songs`);

    // Create ZIP file
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    output.on('close', () => {
        console.log(`ZIP created: ${archive.pointer()} bytes`);
        
        // Send the ZIP file
        res.download(zipPath, 'spotify_playlist.zip', (err) => {
            if (err) {
                console.error('Download error:', err);
            }
            
            // Cleanup all files
            downloadedFiles.forEach(file => {
                if (fs.existsSync(file.path)) {
                    fs.unlinkSync(file.path);
                }
            });
            
            if (fs.existsSync(zipPath)) {
                fs.unlinkSync(zipPath);
            }
        });
    });

    archive.on('error', (err) => {
        console.error('Archive error:', err);
        res.status(500).json({ error: 'Failed to create ZIP file' });
    });

    archive.pipe(output);

    // Add files to archive
    downloadedFiles.forEach(file => {
        archive.file(file.path, { name: file.name });
    });

    await archive.finalize();
});

// Download endpoint with metadata embedding and dynamic filename
app.post('/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const id = uuidv4();
    // Using a temporary name that can be identified later, yt-dlp will rename it.
    // We'll get the final name from videoInfo or regex.
    const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`); 

    console.log('Starting download with metadata and dynamic filename...');
    
    // First, get video info for metadata and original title
    const baseArgs = getYtDlpExecArgs();
    const infoCmd = `yt-dlp ${baseArgs}--dump-json --no-download "${url}"`;
    
    let videoInfo = null;
    
    try {
        videoInfo = await new Promise((resolve, reject) => {
            exec(infoCmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
                if (error) {
                    console.error('Failed to get video info for title:', stderr);
                    reject(error);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(e);
                }
            });
        });
    } catch (error) {
        console.error('Warning: Could not fetch video info for title/metadata, proceeding with generic filename.', error.message);
    }
    
    const spawnArgs = getYtDlpSpawnArgs();
    const ytdlpArgs = [
        ...spawnArgs,
        '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '-o', outputTemplate, '--no-playlist', url
    ];
    
    const ytdlp = spawn('yt-dlp', ytdlpArgs);

    let progressData = '';

    ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        progressData += output;
        
        const progressMatch = output.match(/(\d+\.?\d*)%/);
        if (progressMatch) {
            console.log(`Progress: ${progressMatch[1]}%`);
        }
    });

    ytdlp.stderr.on('data', (data) => {
        console.log(`yt-dlp: ${data}`);
    });

    ytdlp.on('close', async (code) => {
        if (code !== 0) {
            console.error('Download failed with code:', code);
            return res.status(500).json({ error: 'Download failed' });
        }

        console.log('Download complete, finding file...');

        // yt-dlp renames the file, so we look for any file starting with our id prefix
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
        
        if (files.length === 0) {
            console.error('No files found in temp directory after download completion');
            return res.status(500).json({ error: 'File not found after download' });
        }

        const filePath = path.join(TEMP_DIR, files[0]);
        console.log('Audio file downloaded:', filePath);
        
        // Embed metadata and thumbnail if we have video info
        if (videoInfo && videoInfo.thumbnail) {
            console.log('Embedding metadata and thumbnail...');
            const metadata = {
                title: videoInfo.title,
                artist: videoInfo.uploader || videoInfo.channel,
                album: 'YouTube'
            };
            
            await embedMetadataAndThumbnail(filePath, metadata, videoInfo.thumbnail);
        }
        
        // Construct a clean filename using the video title
        let cleanName = `download.mp3`; // Default
        if (videoInfo && videoInfo.title) {
            // Sanitize title for filename
            cleanName = `${videoInfo.title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200)}.mp3`;
        } else {
            // Fallback: use the filename generated by yt-dlp, if it's not just the ID.
            // Or use a more generic unique name.
            cleanName = files[0].replace(`${id}.`, ''); // Remove the UUID prefix, keep yt-dlp's generated name
            if (!cleanName.endsWith('.mp3')) {
                cleanName = `${cleanName}.mp3`;
            }
            if (cleanName.length < 5) { // If it's too short (e.g. just .mp3), make it more descriptive
                 cleanName = `${id.substring(0, 8)}_download.mp3`;
            }
        }

        res.download(filePath, cleanName, (err) => {
            if (err) {
                console.error('Download error:', err);
            } else {
                console.log('File sent successfully with metadata');
            }
            // Cleanup temp file after a short delay
            setTimeout(() => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log('Cleaned up temp file:', filePath);
                }
            }, 5000);
        });
    });
});

// Download video endpoint with dynamic filename
app.post('/download-video', async (req, res) => {
    const { url, quality } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const id = uuidv4();
    const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

    console.log('Starting video download with quality:', quality || 'best[height<=720]');
    
    // First, get video info for original title
    const baseExecArgs = getYtDlpExecArgs();
    const infoCmd = `yt-dlp ${baseExecArgs}--dump-json --no-download "${url}"`;
    
    let videoInfo = null;
    
    try {
        videoInfo = await new Promise((resolve, reject) => {
            exec(infoCmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
                if (error) {
                    console.error('Failed to get video info for title:', stderr);
                    reject(error);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    reject(e);
                }
            });
        });
    } catch (error) {
        console.error('Warning: Could not fetch video info for title, proceeding with generic filename.', error.message);
    }

    const formatSelector = quality ? `best[height<=${quality}]` : 'best[height<=720]';
    
    const spawnArgs = getYtDlpSpawnArgs();
    const ytdlpArgs = [
        ...spawnArgs,
        '-f', formatSelector,
        '-o', outputTemplate, '--no-playlist', url
    ];
    
    const ytdlp = spawn('yt-dlp', ytdlpArgs);

    let progressData = '';

    ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        progressData += output;
        
        const progressMatch = output.match(/(\d+\.?\d*)%/);
        if (progressMatch) {
            console.log(`Video Progress: ${progressMatch[1]}%`);
        }
    });

    ytdlp.stderr.on('data', (data) => {
        console.log(`yt-dlp video: ${data}`);
    });

    ytdlp.on('close', (code) => {
        if (code !== 0) {
            console.error('Video download failed with code:', code);
            return res.status(500).json({ error: 'Video download failed' });
        }

        console.log('Video download complete, finding file...');

        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
        
        if (files.length === 0) {
            console.error('No video files found in temp directory');
            return res.status(500).json({ error: 'Video file not found after download' });
        }

        const filePath = path.join(TEMP_DIR, files[0]);
        console.log('Sending video file:', filePath);
        
        let cleanName = `download.mp4`; // Default
        if (videoInfo && videoInfo.title) {
            const ext = path.extname(files[0]);
            cleanName = `${videoInfo.title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200)}${ext}`;
        } else {
             cleanName = files[0].replace(`${id}.`, '');
             if (!path.extname(cleanName)) { // Ensure it has an extension
                 cleanName = `${cleanName}.mp4`;
             }
             if (cleanName.length < 5) { // If it's too short (e.g. just .mp4), make it more descriptive
                 cleanName = `${id.substring(0, 8)}_video_download.mp4`;
            }
        }

        res.download(filePath, cleanName, (err) => {
            if (err) {
                console.error('Video download error:', err);
            } else {
                console.log('Video file sent successfully');
            }
            setTimeout(() => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log('Cleaned up temp video file');
                }
            }, 5000);
        });
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Make sure yt-dlp and ffmpeg are installed!');
    console.log('For Spotify playlist downloads, archiver package and p-limit are required.');
    console.log('Install p-limit: npm install p-limit');
    
    // Check if cookies file exists
    if (fs.existsSync(COOKIES_FILE)) {
        console.log('✓ Cookies file found - bot detection bypass enabled');
    } else {
        console.log('⚠ Warning: cookies.txt not found - you may encounter bot detection');
        console.log('  Export cookies using: https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/');
        console.log('  Place cookies.txt in the project root directory');
    }
});