import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { MotionDetectorOptions, TimeRange, detectMotionSegments } from './motionDetector';
import { trimVideoToSegments } from './videoTrimmer';
import { StoredVideo, VideoStorage, videoStorage } from './storageProvider';
import { MAX_REMOTE_VIDEO_BYTES, VideoDownloadError, downloadVideoFromUrl } from './remoteVideoDownloader';

export class NoSegmentsDetectedError extends Error {
  segments: TimeRange[];

  constructor(segments: TimeRange[]) {
    super('No motion segments detected');
    this.segments = segments;
  }
}

export interface TrimPipelineParams {
  videoPath?: string;
  videoUrl?: string;
  storage?: VideoStorage;
  motionOptions?: MotionDetectorOptions;
  maxBytes?: number;
  outputFilename?: string;
}

export interface TrimPipelineResult {
  segments: TimeRange[];
  storedOutput: StoredVideo;
  storedInput?: StoredVideo;
  outputPath: string;
  downloadedPath?: string;
}

export async function runTrimPipeline(params: TrimPipelineParams): Promise<TrimPipelineResult> {
  const storage = params.storage ?? videoStorage;
  const maxBytes = params.maxBytes ?? MAX_REMOTE_VIDEO_BYTES;
  const motionOptions = params.motionOptions;

  let inputPath = params.videoPath;
  let downloadedPath: string | undefined;
  let outputPath: string | undefined;

  if (!inputPath) {
    if (params.videoUrl) {
      inputPath = await downloadVideoFromUrl(params.videoUrl, storage.getLocalInputDir(), maxBytes);
      downloadedPath = inputPath;
    } else {
      throw new VideoDownloadError('No video provided. Upload a file or provide a public link.');
    }
  }

  try {
    const storedInput = await storage.saveInput(inputPath, path.basename(inputPath));
    const segments = await detectMotionSegments(inputPath, motionOptions);

    if (segments.length === 0) {
      throw new NoSegmentsDetectedError(segments);
    }

    const filename = params.outputFilename ?? `trimmed-${randomUUID()}.mp4`;
    outputPath = path.join(storage.getLocalOutputDir(), filename);
    await trimVideoToSegments(inputPath, segments, outputPath);
    const storedOutput = await storage.saveOutput(outputPath, filename);

    return { segments, storedOutput, storedInput, outputPath, downloadedPath };
  } catch (err) {
    if (outputPath && fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    }
    if (downloadedPath && fs.existsSync(downloadedPath)) {
      try { fs.unlinkSync(downloadedPath); } catch { /* ignore */ }
    }
    throw err;
  }
}
