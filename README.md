# 🏐 Volleyball Play Analyzer

AI-powered web application for analyzing volleyball plays using video frame extraction and GPT-4 Vision.

## Features

- **Video Upload**: Upload volleyball game footage for AI analysis
- **Frame Extraction**: Uses ffmpeg to extract frames at configurable rates
- **GPT-4 Vision Analysis**: AI analyzes actual video frames to see player movements
- **Configurable Cost Control**: Adjust frame rate and max frames to control API costs
- **Text-Based Analysis**: Describe plays to get instant coaching feedback
- **Motion-Based Trimming**: Automatically remove non-play time from single-camera static recordings using frame-difference detection (no AI required)
- **Detailed Coaching Insights**:
  - Play type identification
  - Player positioning analysis
  - Technical execution feedback
  - Tactical suggestions
  - Recommended drills

## Prerequisites

- **Node.js** 18+
- **ffmpeg** installed and in PATH
  - Windows: `choco install ffmpeg` or download from https://ffmpeg.org
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env and add your OpenAI API key
   ```

3. **Build the project**
   ```bash
   npm run build
   ```

4. **Start the server**
   ```bash
   npm start
   ```

5. Open http://localhost:3000 in your browser

## Configuration Options

| Option | Default | Range | Description |
|--------|---------|-------|-------------|
| Frames per Second | 1 | 0.1-5 | How many frames to extract per second |
| Max Frames | 15 | 1-50 | Maximum frames to send to AI |

### Cost Estimation (GPT-4o with low detail images)

| Video Length | 1 fps | 2 fps | 
|--------------|-------|-------|
| 10 seconds | ~$0.03 | ~$0.05 |
| 15 seconds | ~$0.04 | ~$0.07 |
| 30 seconds | ~$0.07 | ~$0.12 |

*Costs are approximate and may vary*

## Development

Run in development mode with hot reload:
```bash
npm run dev
```

## API Endpoints

### POST /api/videos/upload
Upload a video file for analysis.
- **Body**: `multipart/form-data` with `video` file and optional `description`
- **Response**: Analysis results with coaching suggestions

### POST /api/videos/analyze-url
Analyze a video by URL (YouTube or direct file link).
- **Body**: `{ "url": "https://...", "description": "..." }`
- **Response**: Analysis results with coaching suggestions

### POST /api/videos/analyze
Analyze a play based on text description.
- **Body**: `{ "description": "Your play description" }`
- **Response**: Analysis results with coaching suggestions

## Tech Stack

- **Backend**: Node.js, Express, TypeScript
- **AI**: OpenAI GPT-4o Vision API
- **Video Processing**: ffmpeg via fluent-ffmpeg
- **Frontend**: Vanilla JavaScript, CSS3
- **File Upload**: Multer

## Project Structure

```
volleyball/
├── src/
│   ├── index.ts                  # Express server
│   ├── routes/
│   │   └── videoRoutes.ts        # API routes
│   └── services/
│       ├── videoAnalyzer.ts      # AI analysis service
│       ├── frameExtractor.ts     # ffmpeg frame extraction
│       ├── motionDetector.ts     # Motion-based play segment detection
│       └── videoTrimmer.ts       # ffmpeg segment concatenation
├── public/
│   ├── index.html                # Frontend UI
│   ├── styles.css                # Styles
│   └── app.js                    # Frontend logic
├── uploads/                      # Uploaded videos & extracted frames
└── dist/                         # Compiled JavaScript
```

## API Endpoints

### POST /api/videos/upload
Upload a video file for frame-by-frame AI analysis.

**Body** (`multipart/form-data`):
- `video` - Video file (required)
- `description` - Play context (optional)
- `framesPerSecond` - Frame extraction rate (default: 1)
- `maxFrames` - Maximum frames to analyze (default: 15)

### POST /api/videos/analyze-url
Analyze a video provided as a URL.

**Body** (`application/json`):
- `url` - URL of the video (required). Supports:
  - **YouTube** links (`youtube.com/watch?v=…`, `youtu.be/…`)
  - **Direct video file** URLs pointing to MP4, WebM, MOV, or AVI files
- `description` - Play context (optional)
- `framesPerSecond` - Frame extraction rate (default: 1)
- `maxFrames` - Maximum frames to analyze (default: 20)

> **Note**: Videos are streamed server-side; the client only needs to supply the URL. YouTube videos are downloaded using the highest-quality combined (video + audio) MP4 stream at ≤720p, or the best available video-only MP4 if no combined stream is offered. The file size limit is 100 MB.

```bash
curl -X POST http://localhost:3000/api/videos/analyze-url \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=EXAMPLE","description":"spike attempt from position 4"}'
```

**Body** (`application/json`):
```json
{ "description": "Your play description" }
```

---

## Motion-Based Video Trimming

`POST /api/videos/trim` removes non-play periods from a static-camera recording using motion detection.  
No AI or third-party services are required — only ffmpeg.

### How It Works

1. Frames are sampled from the video at a configurable rate (default 2 fps) and scaled down to 160×90 grayscale pixels.
2. The mean absolute pixel difference between consecutive frames is computed as the **motion score**.
3. Scores are smoothed with a rolling-average window to reduce noise.
4. Frames above a configurable threshold are marked as "active".
5. Active runs are grouped into segments, short segments are dropped, and configurable pre/post-roll padding is added.
6. Overlapping padded segments are merged; the final list is fed to ffmpeg `trim + concat` to produce a clean MP4.

### Endpoint

`POST /api/videos/trim` — `multipart/form-data`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `video` | File | **required** | Video file (MP4, WebM, MOV, AVI) |
| `sampleFps` | number | `2` | Frames to sample per second for motion analysis |
| `threshold` | number | `0.02` | Motion score threshold (0–1); lower = more sensitive |
| `minSegmentLength` | number | `3` | Minimum play-segment length in seconds |
| `preRoll` | number | `1` | Seconds of context to keep before each segment |
| `postRoll` | number | `1` | Seconds of context to keep after each segment |
| `smoothingWindow` | number | `3` | Rolling-average window size for score smoothing |

**Success response** (`200`):
```json
{
  "success": true,
  "totalSegments": 4,
  "segments": [
    { "start": 12.5, "end": 38.0 },
    { "start": 55.0, "end": 92.5 }
  ],
  "downloadUrl": "/uploads/trimmed-1234567890-123456789.mp4"
}
```

**Error response** (`422`) when no motion is detected:
```json
{
  "error": "No motion segments detected. Try lowering the threshold.",
  "segments": []
}
```

### Example (curl)

```bash
curl -X POST http://localhost:3000/api/videos/trim \
  -F "video=@game.mp4" \
  -F "threshold=0.015" \
  -F "preRoll=2" \
  -F "postRoll=2"
```

Download the result:

```bash
curl -O http://localhost:3000/uploads/trimmed-<id>.mp4
```

ISC
