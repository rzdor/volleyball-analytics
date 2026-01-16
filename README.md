# 🏐 Volleyball Play Analyzer

AI-powered web application for analyzing volleyball plays using video frame extraction and GPT-4 Vision.

## Features

- **Video Upload**: Upload volleyball game footage for AI analysis
- **Frame Extraction**: Uses ffmpeg to extract frames at configurable rates
- **GPT-4 Vision Analysis**: AI analyzes actual video frames to see player movements
- **Configurable Cost Control**: Adjust frame rate and max frames to control API costs
- **Text-Based Analysis**: Describe plays to get instant coaching feedback
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
│       └── frameExtractor.ts     # ffmpeg frame extraction
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

### POST /api/videos/analyze
Analyze a play based on text description only.

**Body** (`application/json`):
```json
{ "description": "Your play description" }
```

## License

ISC
