FROM node:18-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --break-system-packages yt-dlp

WORKDIR /app

# Install node dependencies
COPY package*.json ./
RUN npm install

# Copy application
COPY . .

# Use Render's PORT environment variable
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]