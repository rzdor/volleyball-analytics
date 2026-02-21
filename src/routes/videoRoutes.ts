import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
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
      previewUrl: `/uploads/${outputFilename}`,
      downloadUrl: `/api/videos/download/${outputFilename}`,
    });
  } catch (error) {
    console.error('Trim error:', error);
    if (outputPath && fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
    res.status(500).json({ error: 'Failed to trim video' });
  }
});

const TRIMMED_FILE_PATTERN = /^trimmed-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.mp4$/i;
const downloadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.get('/download/:filename', downloadLimiter, (req: Request, res: Response): void => {
  const param = req.params.filename;
  const requested = Array.isArray(param) ? (param[0] ?? '') : param;
  if (!requested) {
    res.status(400).json({ error: 'Invalid file' });
    return;
  }
  if (!TRIMMED_FILE_PATTERN.test(requested)) {
    res.status(400).json({ error: 'Invalid file' });
    return;
  }

  const uploadsDir = path.resolve(__dirname, '../../uploads');
  const filePath = path.resolve(uploadsDir, requested);
  if (!filePath.startsWith(uploadsDir)) {
    res.status(400).json({ error: 'Invalid file' });
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  res.download(filePath);
});

export default router;
