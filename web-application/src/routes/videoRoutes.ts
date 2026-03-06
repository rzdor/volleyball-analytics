import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import { BlobServiceClient } from '@azure/storage-blob';

const router = Router();

const uploadsInputDir = path.resolve(process.cwd(), 'uploads/inputs');
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB
const BLOB_CONTAINER = process.env.VIDEO_BLOB_CONTAINER || 'volleyball-videos';
const BLOB_FOLDER = 'input';

function getBlobServiceClient(): BlobServiceClient {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
  }
  return BlobServiceClient.fromConnectionString(connectionString);
}

async function uploadToBlob(filePath: string, blobName: string): Promise<string> {
  const blobService = getBlobServiceClient();
  const containerClient = blobService.getContainerClient(BLOB_CONTAINER);
  await containerClient.createIfNotExists();
  const blockBlobClient = containerClient.getBlockBlobClient(`${BLOB_FOLDER}/${blobName}`);
  await blockBlobClient.uploadFile(filePath);
  return blockBlobClient.url;
}

const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
] as const;

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
  limits: { fileSize: MAX_VIDEO_BYTES }
});

// TODO: Update to call the Function App video-processing endpoint
router.post('/trim', rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), upload.single('video'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No video file provided.' });
      return;
    }

    const blobName = req.file.filename;
    const blobUrl = await uploadToBlob(req.file.path, blobName);

    // Clean up local temp file
    fs.unlink(req.file.path, () => {});

    res.json({
      success: true,
      blobUrl,
      blobName: `${BLOB_FOLDER}/${blobName}`,
      container: BLOB_CONTAINER,
    });
  } catch (error) {
    console.error('Upload error:', error);
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: 'Failed to upload video' });
  }
});

router.get('/list', async (_req: Request, res: Response): Promise<void> => {
  try {
    const blobService = getBlobServiceClient();
    const containerClient = blobService.getContainerClient(BLOB_CONTAINER);
    const videos: { name: string; url: string; createdOn?: Date }[] = [];

    for await (const blob of containerClient.listBlobsFlat({ prefix: `${BLOB_FOLDER}/` })) {
      const blobClient = containerClient.getBlobClient(blob.name);
      videos.push({
        name: blob.name.replace(`${BLOB_FOLDER}/`, ''),
        url: blobClient.url,
        createdOn: blob.properties.createdOn,
      });
    }

    res.json({ videos });
  } catch (error) {
    console.error('List error:', error);
    res.status(500).json({ error: 'Failed to list videos' });
  }
});

export default router;
