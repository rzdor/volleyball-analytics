import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import { detectMotionSegments, MotionDetectorOptions } from '../services/motionDetector';
import { trimVideoToSegments } from '../services/videoTrimmer';
import {
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_REMOTE_VIDEO_BYTES,
  VideoDownloadError,
  downloadVideoFromUrl,
} from '../services/remoteVideoDownloader';
import { videoStorage } from '../services/storageProvider';

const router = Router();

const uploadsInputDir = videoStorage.getLocalInputDir();
const uploadsOutputDir = videoStorage.getLocalOutputDir();
const MAX_FILE_SIZE_BYTES = MAX_REMOTE_VIDEO_BYTES;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsInputDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = randomUUID();
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_VIDEO_MIME_TYPES.includes(file.mimetype as typeof ALLOWED_VIDEO_MIME_TYPES[number])) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only video files are allowed.'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES } // 100MB limit
});

router.post('/trim', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), upload.single('video'), async (req: Request, res: Response): Promise<void> => {
  let outputPath: string | undefined;
  let inputVideoPath: string | undefined = req.file?.path;
  let downloadedPath: string | undefined;
  let storedInput: { url?: string } | undefined;

  try {
    const videoUrl = typeof req.body.videoUrl === 'string' ? req.body.videoUrl.trim() : '';

    if (!inputVideoPath && videoUrl) {
       downloadedPath = await downloadVideoFromUrl(videoUrl, uploadsInputDir, MAX_FILE_SIZE_BYTES);
       inputVideoPath = downloadedPath;
    }

    if (!inputVideoPath) {
      res.status(400).json({ error: 'No video provided. Upload a file or provide a public link.' });
      return;
    }

    storedInput = await videoStorage.saveInput(inputVideoPath, path.basename(inputVideoPath));

    const options: MotionDetectorOptions = {
      sampleFps: parseFloat(req.body.sampleFps) || 2,
      threshold: parseFloat(req.body.threshold) || 0.02,
      minSegmentLength: parseFloat(req.body.minSegmentLength) || 3,
      preRoll: parseFloat(req.body.preRoll) || 1,
      postRoll: parseFloat(req.body.postRoll) || 1,
      smoothingWindow: parseInt(req.body.smoothingWindow, 10) || 3,
    };

    const segments = await detectMotionSegments(inputVideoPath, options);

    if (segments.length === 0) {
      res.status(422).json({
        error: 'No motion segments detected. Try lowering the threshold.',
        segments,
      });
      return;
    }

    const outputFilename = `trimmed-${randomUUID()}.mp4`;
    outputPath = path.join(uploadsOutputDir, outputFilename);

    await trimVideoToSegments(inputVideoPath, segments, outputPath);

    const storedOutput = await videoStorage.saveOutput(outputPath, outputFilename);

    res.json({
      success: true,
      segments,
      totalSegments: segments.length,
      previewUrl: storedOutput.url,
      downloadUrl: storedOutput.downloadUrl || storedOutput.url,
      inputUrl: storedInput?.url,
    });
  } catch (error) {
    console.error('Trim error:', error);
    if (outputPath && fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
    if (downloadedPath && fs.existsSync(downloadedPath)) {
      try { fs.unlinkSync(downloadedPath); } catch { /* ignore */ }
    }
    if (error instanceof VideoDownloadError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Failed to trim video' });
  }
});

const TRIMMED_FILE_PATTERN = /^trimmed-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.mp4$/i;
const downloadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.get('/download/:filename', downloadLimiter, async (req: Request, res: Response): Promise<void> => {
  const requested = req.params.filename as string;
  if (!requested) {
    res.status(400).json({ error: 'Invalid file' });
    return;
  }
  if (!TRIMMED_FILE_PATTERN.test(requested)) {
    res.status(400).json({ error: 'Invalid file' });
    return;
  }

  const exists = await videoStorage.outputExists(requested);
  if (!exists) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const remoteUrl = await videoStorage.getOutputUrl(requested, true);
  if (remoteUrl && !remoteUrl.startsWith('/uploads/')) {
    res.redirect(remoteUrl);
    return;
  }

  const uploadsRoot = path.resolve(uploadsOutputDir);
  const filePath = path.resolve(uploadsRoot, requested);
  if (!filePath.startsWith(uploadsRoot) || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  res.download(filePath);
});

router.get('/list', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [uploads, processed] = await Promise.all([
      videoStorage.listInputs(),
      videoStorage.listOutputs(),
    ]);
    res.json({ uploads, processed });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

export default router;
