const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Increase timeout for long downloads
app.use((req, res, next) => {
    res.setTimeout(300000); // 5 minutes
    next();
});

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

// Get video info endpoint
app.post('/video-info', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const cmd = `yt-dlp --dump-json --no-download "${url}"`;
    
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

// Get available video formats endpoint
app.post('/video-formats', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const cmd = `yt-dlp -F "${url}"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        if (error) {
            console.error('Video formats error:', stderr);
            return res.status(500).json({ error: 'Failed to get video formats' });
        }

        try {
            // Parse yt-dlp format list output
            const lines = stdout.split('\n');
            const formats = [];
            
            
            for (const line of lines) {
                // Look for lines with video formats (contain resolution and quality)
                if (line.includes('x') && (line.includes('p,') || line.includes('p '))) {
                    const parts = line.trim().split(/\s+/);
                    
                    if (parts.length >= 3) {
                        const id = parts[0];
                        const ext = parts[1];
                        const resolution = parts[2];
                        
                        // Find quality in the line (look for pattern like "144p," or "1080p,")
                        const qualityMatch = line.match(/(\d+p),?/);
                        if (qualityMatch) {
                            const quality = qualityMatch[1];
                            
                            // Check if it's a video format
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

app.post('/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'No URL provided' });
    }

    const id = uuidv4();
    const outputTemplate = path.join(TEMP_DIR, `${id}.%(ext)s`);

    console.log('Starting download...');
    
    const ytdlp = spawn('yt-dlp', [
        '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '-o', outputTemplate, '--no-playlist', url
    ]);

    let progressData = '';

    ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        progressData += output;
        
        // Extract progress percentage from yt-dlp output
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

        // Find the downloaded file
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
        
        if (files.length === 0) {
            console.error('No files found in temp directory');
            return res.status(500).json({ error: 'File not found after download' });
        }

        const filePath = path.join(TEMP_DIR, files[0]);
        console.log('Sending file:', filePath);
        
        // Get a clean filename (remove the uuid prefix)
        const cleanName = files[0].replace(`${id}.`, '');

        res.download(filePath, cleanName, (err) => {
            if (err) {
                console.error('Download error:', err);
            } else {
                console.log('File sent successfully');
            }
            // Cleanup
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
    
    // Use provided quality or default to 720p
    const formatSelector = quality ? `best[height<=${quality}]` : 'best[height<=720]';
    
    const ytdlp = spawn('yt-dlp', [
        '-f', formatSelector,
        '-o', outputTemplate, '--no-playlist', url
    ]);

    let progressData = '';

    ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        progressData += output;
        
        // Extract progress percentage from yt-dlp output
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

        // Find the downloaded file
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(id));
        
        if (files.length === 0) {
            console.error('No video files found in temp directory');
            return res.status(500).json({ error: 'Video file not found after download' });
        }

        const filePath = path.join(TEMP_DIR, files[0]);
        console.log('Sending video file:', filePath);
        
        // Get a clean filename (remove the uuid prefix)
        const cleanName = files[0].replace(`${id}.`, '');

        res.download(filePath, cleanName, (err) => {
            if (err) {
                console.error('Video download error:', err);
            } else {
                console.log('Video file sent successfully');
            }
            // Cleanup
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
});