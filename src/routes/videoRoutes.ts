import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { analyzeVolleyballVideo, AnalysisOptions } from '../services/videoAnalyzer';

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

export default router;
