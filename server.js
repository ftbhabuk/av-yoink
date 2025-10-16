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

    // Download songs one by one with delay between requests
    for (let i = 0; i < selectedSongs.length; i++) {
        const song = selectedSongs[i];
        
        try {
            console.log(`[${i + 1}/${selectedSongs.length}] Downloading: ${song.track_name} by ${song.artist_name}`);
            
            const searchQuery = `${song.track_name} ${song.artist_name}`;
            const id = uuidv4();
            const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);
            
            // Add delay between downloads to avoid rate limiting (after first song)
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
            }
            
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

                ytdlp.on('close', (code) => {
                    if (code !== 0) {
                        console.error(`Failed to download: ${song.track_name} - ${errorOutput}`);
                        resolve(); // Continue with next song
                        return;
                    }

                    // Find the downloaded file
                    const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
                    
                    if (files.length > 0) {
                        const filePath = path.join(TEMP_DIR, files[0]);
                        const cleanName = `${song.artist_name} - ${song.track_name}.mp3`
                            .replace(/[<>:"/\\|?*]/g, '_')
                            .substring(0, 200); // Limit filename length
                        
                        downloadedFiles.push({
                            path: filePath,
                            name: cleanName
                        });
                        console.log(`✓ Downloaded: ${cleanName}`);
                    }
                    
                    resolve();
                });

                // Timeout for each song (3 minutes)
                setTimeout(() => {
                    ytdlp.kill();
                    resolve();
                }, 180000);
            });
            
        } catch (error) {
            console.error(`Error downloading ${song.track_name}:`, error);
            // Continue with next song
        }
    }

    if (downloadedFiles.length === 0) {
        return res.status(500).json({ error: 'Failed to download any songs. YouTube may be blocking requests. Make sure cookies.txt is properly configured.' });
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

app.post('/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const id = uuidv4();
    const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

    console.log('Starting download...');
    
    const baseArgs = getYtDlpSpawnArgs();
    const ytdlpArgs = [
        ...baseArgs,
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

    ytdlp.on('close', (code) => {
        if (code !== 0) {
            console.error('Download failed with code:', code);
            return res.status(500).json({ error: 'Download failed' });
        }

        console.log('Download complete, finding file...');

        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
        
        if (files.length === 0) {
            console.error('No files found in temp directory');
            return res.status(500).json({ error: 'File not found after download' });
        }

        const filePath = path.join(TEMP_DIR, files[0]);
        console.log('Sending file:', filePath);
        
        const cleanName = files[0].replace(`${id}.`, '');

        res.download(filePath, cleanName, (err) => {
            if (err) {
                console.error('Download error:', err);
            } else {
                console.log('File sent successfully');
            }
            setTimeout(() => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log('Cleaned up temp file');
                }
            }, 5000);
        });
    });
});

// Download video endpoint
app.post('/download-video', async (req, res) => {
    const { url, quality } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const id = uuidv4();
    const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

    console.log('Starting video download with quality:', quality || 'best[height<=720]');
    
    const formatSelector = quality ? `best[height<=${quality}]` : 'best[height<=720]';
    
    const baseArgs = getYtDlpSpawnArgs();
    const ytdlpArgs = [
        ...baseArgs,
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
        
        const cleanName = files[0].replace(`${id}.`, '');

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
    console.log('For Spotify playlist downloads, archiver package is required');
    
    // Check if cookies file exists
    if (fs.existsSync(COOKIES_FILE)) {
        console.log('✓ Cookies file found - bot detection bypass enabled');
    } else {
        console.log('⚠ Warning: cookies.txt not found - you may encounter bot detection');
        console.log('  Export cookies using: https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/');
        console.log('  Place cookies.txt in the project root directory');
    }
});