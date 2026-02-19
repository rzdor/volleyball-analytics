import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
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
    if (options.framesPerSecond! < 0.1) options.framesPerSecond = 0.1;
    if (options.framesPerSecond! > 5) options.framesPerSecond = 5;
    if (options.maxFrames! < 1) options.maxFrames = 1;
    if (options.maxFrames! > 50) options.maxFrames = 50;

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

export default router;
