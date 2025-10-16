AV-Yoink
A lightweight web application for downloading audio and video from YouTube URLs and Spotify playlists. Built with a minimal Node.js/Express backend using yt-dlp and a clean, vanilla JavaScript frontend for a simple, efficient user experience. Designed for personal use.
Features

Download YouTube audio (MP3) or video (multiple resolutions).
Batch download Spotify playlist songs as MP3s from a CSV export.
Bypasses YouTube bot detection with cookies.txt.
Minimalistic UI with video previews, quality selection, and playlist management.
Lightweight and optimized for performance.

Prerequisites

Node.js: v18 or higher
Docker: For containerized deployment
Python 3 and pip: For yt-dlp
FFmpeg: For audio/video processing
Spotify CSV: Exportable via Exportify
YouTube Cookies: For bot detection bypass (see Managing Cookies)

Project Structure
av-yoink/
├── .dockerignore        # Docker ignore rules
├── .gitignore          # Git ignore rules
├── Dockerfile          # Docker configuration
├── cookies.txt.example # Example YouTube cookies file
├── index.html          # Main HTML file
├── package.json        # Node.js dependencies
├── package-lock.json   # Dependency lock file
├── render.yaml         # Render deployment configuration
├── script.js           # Frontend JavaScript logic
├── server.js           # Backend Express server
├── styles.css          # CSS styles
└── README.md           # This file

Installation
Option 1: Local Development with Node.js

Clone the Repository:
git clone <https://github.com/ftbhabuk/av-yoink.git>
cd av-yoink

Install Dependencies (Arch Linux):
sudo pacman -S nodejs npm python python-pip ffmpeg
pip install yt-dlp
npm install

Add YouTube Cookies (Optional):

Copy cookies.txt.example to cookies.txt and populate with valid cookies. See Managing Cookies.

Run the Application:
node server.js

Access at <http://localhost:5000>.

Option 2: Docker Deployment

Clone the Repository:
git clone <https://github.com/ftbhabuk/av-yoink.git>
cd av-yoink

Build the Docker Image:
docker build -t av-yoink .

Add YouTube Cookies (Optional):

Create a cookies.txt file with valid cookies. See Managing Cookies.

Run the Docker Container:

With cookies:docker run -p 10000:10000 -v $(pwd)/cookies.txt:/etc/secrets/cookies.txt av-yoink

Without cookies:docker run -p 10000:10000 av-yoink

Access at <http://localhost:10000>.

Managing Cookies
To bypass YouTube bot detection:

Log into YouTube in a browser and complete any bot verification.
Export cookies in Netscape format using:
Firefox: cookies.txt
Chrome: Use a similar extension or script.

Save as cookies.txt in the project root (local) or mount as /etc/secrets/cookies.txt (Docker).
Ensure cookies include youtube.com entries like __Secure-3PSID, SID, HSID.

Exporting Spotify Playlists

Export your Spotify playlist as a CSV using Exportify.
Upload the CSV via the app’s Spotify mode.
Select songs and download as a ZIP of MP3s.

Usage

YouTube Mode:

Enter a YouTube URL.
View video preview and select quality (for video downloads).
Click Download Audio or Download Video.

Spotify Mode:

Upload a Spotify playlist CSV.
Select songs to download.
Click Download Selected Songs for a ZIP of MP3s.

Notes

Regularly update cookies.txt as YouTube cookies expire frequently.
Intended for personal use only, respecting YouTube and Spotify terms of service.
Lightweight design prioritizes simplicity and performance.

Dependencies

Backend: express, cors, multer, csv-parser, archiver, uuid, yt-dlp, ffmpeg
Frontend: Vanilla JavaScript, HTML, CSS

License
MIT License. See LICENSE file for details.
