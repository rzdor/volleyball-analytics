import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import { analyzeVolleyballVideo, AnalysisOptions } from '../services/videoAnalyzer';
import { detectMotionSegments, MotionDetectorOptions } from '../services/motionDetector';
import { trimVideoToSegments } from '../services/videoTrimmer';

const router = Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only video files are allowed.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

router.post('/upload', upload.single('video'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No video file uploaded' });
      return;
    }

    const videoPath = req.file.path;
    
    // Parse analysis options from request
    const options: AnalysisOptions = {
      framesPerSecond: parseFloat(req.body.framesPerSecond) || 1,
      maxFrames: parseInt(req.body.maxFrames) || 20
    };
    
    // Validate options
    if (options.framesPerSecond! < MIN_FPS) options.framesPerSecond = MIN_FPS;
    if (options.framesPerSecond! > MAX_FPS) options.framesPerSecond = MAX_FPS;
    if (options.maxFrames! < MIN_FRAMES) options.maxFrames = MIN_FRAMES;
    if (options.maxFrames! > MAX_FRAMES) options.maxFrames = MAX_FRAMES;

    const analysis = await analyzeVolleyballVideo(videoPath, req.body.description || '', options);

    res.json({
      success: true,
      filename: req.file.filename,
      options,
      analysis
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process video' });
  }
});

router.post('/analyze', async (req: Request, res: Response): Promise<void> => {
  try {
    const { description } = req.body;
    if (!description) {
      res.status(400).json({ error: 'Play description is required' });
      return;
    }

    const analysis = await analyzeVolleyballVideo(null, description);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Failed to analyze play' });
  }
});

router.post('/trim', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), upload.single('video'), async (req: Request, res: Response): Promise<void> => {
  const videoPath = req.file?.path;
  let outputPath: string | undefined;

  try {
    if (!req.file || !videoPath) {
      res.status(400).json({ error: 'No video file uploaded' });
      return;
    }

    const options: MotionDetectorOptions = {
      sampleFps: parseFloat(req.body.sampleFps) || 2,
      threshold: parseFloat(req.body.threshold) || 0.02,
      minSegmentLength: parseFloat(req.body.minSegmentLength) || 3,
      preRoll: parseFloat(req.body.preRoll) || 1,
      postRoll: parseFloat(req.body.postRoll) || 1,
      smoothingWindow: parseInt(req.body.smoothingWindow, 10) || 3,
    };

    const segments = await detectMotionSegments(videoPath, options);

    if (segments.length === 0) {
      res.status(422).json({
        error: 'No motion segments detected. Try lowering the threshold.',
        segments,
      });
      return;
    }

    const outputFilename = `trimmed-${randomUUID()}.mp4`;
    outputPath = path.join(__dirname, '../../uploads', outputFilename);

    await trimVideoToSegments(videoPath, segments, outputPath);

    res.json({
      success: true,
      segments,
      totalSegments: segments.length,
      downloadUrl: `/uploads/${outputFilename}`,
    });
  } catch (error) {
    console.error('Trim error:', error);
    if (outputPath && fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
    res.status(500).json({ error: 'Failed to trim video' });
  }
});

const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/x-matroska', 'video/mpeg', 'video/ogg',
]);
const URL_DOWNLOAD_SIZE_LIMIT = 100 * 1024 * 1024; // 100 MB
const MIN_FPS = 0.1;
const MAX_FPS = 5;
const MIN_FRAMES = 1;
const MAX_FRAMES = 50;

function downloadVideoFromUrl(url: string, destPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requester = parsedUrl.protocol === 'https:' ? https : http;

    const req = requester.get(url, (res) => {
      // Follow one redirect
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return downloadVideoFromUrl(res.headers.location, destPath).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Remote server returned status ${res.statusCode}`));
      }

      const contentType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_VIDEO_MIME_TYPES.has(contentType)) {
        res.resume();
        return reject(new Error(`Unsupported content type: ${contentType}. Only video files are allowed.`));
      }

      let received = 0;
      const file = fs.createWriteStream(destPath);

      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > URL_DOWNLOAD_SIZE_LIMIT) {
          req.destroy();
          file.destroy();
          fs.unlink(destPath, () => {});
          reject(new Error('Video file exceeds the 100 MB size limit'));
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    req.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });

    req.setTimeout(30_000, () => {
      req.destroy();
      fs.unlink(destPath, () => {});
      reject(new Error('Request timed out while downloading video'));
    });
  });
}

const urlAnalysisLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });

router.post('/analyze-url', urlAnalysisLimiter, async (req: Request, res: Response): Promise<void> => {
  const { url, description, framesPerSecond, maxFrames } = req.body;
  let videoPath: string | undefined;

  try {
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'A video URL is required' });
      return;
    }

    // Validate URL scheme
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      res.status(400).json({ error: 'Invalid URL format' });
      return;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      res.status(400).json({ error: 'Only http and https URLs are supported' });
      return;
    }

    const ext = path.extname(parsedUrl.pathname) || '.mp4';
    const filename = `url-${randomUUID()}${ext}`;
    videoPath = path.join(__dirname, '../../uploads', filename);

    await downloadVideoFromUrl(url, videoPath);

    const options: AnalysisOptions = {
      framesPerSecond: parseFloat(framesPerSecond) || 1,
      maxFrames: parseInt(maxFrames) || 20,
    };

    if (options.framesPerSecond! < MIN_FPS) options.framesPerSecond = MIN_FPS;
    if (options.framesPerSecond! > MAX_FPS) options.framesPerSecond = MAX_FPS;
    if (options.maxFrames! < MIN_FRAMES) options.maxFrames = MIN_FRAMES;
    if (options.maxFrames! > MAX_FRAMES) options.maxFrames = MAX_FRAMES;

    const analysis = await analyzeVolleyballVideo(videoPath, description || '', options);

    res.json({ success: true, filename, options, analysis });
  } catch (error) {
    console.error('URL analyze error:', error);
    const message = error instanceof Error ? error.message : 'Failed to process video from URL';
    res.status(500).json({ error: message });
  } finally {
    if (videoPath && fs.existsSync(videoPath)) {
      try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
    }
  }
});

export default router;
