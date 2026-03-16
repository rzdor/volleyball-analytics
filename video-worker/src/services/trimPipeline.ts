import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { MotionDetectorOptions, TimeRange, detectMotionSegments } from './motionDetector';
import { trimVideoToScene, trimVideoToSegments } from './videoTrimmer';
import { StoredVideo, VideoStorage, getDefaultStorage } from './storageProvider';
import { MAX_REMOTE_VIDEO_BYTES, VideoDownloadError, downloadVideoFromUrl } from './remoteVideoDownloader';

export function normalizeVideoUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export class NoSegmentsDetectedError extends Error {
  constructor() {
    super('No motion segments detected');
  }
}

export interface TrimPipelineParams {
  videoPath?: string;
  videoUrl?: string;
  storage?: VideoStorage;
  motionOptions?: MotionDetectorOptions;
  maxBytes?: number;
  outputFilename?: string;
  sceneOutputPrefix?: string;
  persistInput?: boolean;
}

export interface TrimPipelineResult {
  segments: TimeRange[];
  storedOutput: StoredVideo;
  storedScenes: StoredVideo[];
  storedInput?: StoredVideo;
  outputPath: string;
  sceneOutputPaths: string[];
  downloadedPath?: string;
}

function cleanupLocalFile(filePath: string | undefined): void {
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch (cleanupErr) {
    console.error(`Failed to clean up local file: ${filePath}`, cleanupErr);
  }
}

export async function runTrimPipeline(params: TrimPipelineParams): Promise<TrimPipelineResult> {
  const storage = params.storage ?? getDefaultStorage();
  const maxBytesLimit = params.maxBytes ?? MAX_REMOTE_VIDEO_BYTES;
  const motionOptions = params.motionOptions;
  const persistInput = params.persistInput ?? true;

  let inputPath = params.videoPath;
  let downloadedPath: string | undefined;
  let outputPath: string | undefined;
  const sceneOutputPaths: string[] = [];

  if (!inputPath) {
    if (params.videoUrl) {
      inputPath = await downloadVideoFromUrl(params.videoUrl, storage.getLocalInputDir(), maxBytesLimit);
      downloadedPath = inputPath;
    } else {
      throw new VideoDownloadError('No video source provided in params. Supply either params.videoPath or params.videoUrl.');
    }
  }

  try {
    const storedInput = persistInput
      ? await storage.saveInput(inputPath, path.basename(inputPath))
      : undefined;
    const segments = await detectMotionSegments(inputPath, motionOptions);

    if (segments.length === 0) {
      throw new NoSegmentsDetectedError();
    }

    const filename = params.outputFilename ?? `trimmed-${randomUUID()}.mp4`;
    outputPath = path.join(storage.getLocalOutputDir(), filename);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await trimVideoToSegments(inputPath, segments, outputPath);
    const storedOutput = await storage.saveOutput(outputPath, filename);
    const scenePrefix = params.sceneOutputPrefix ?? path.posix.dirname(filename);
    const sceneBaseName = path.basename(filename, path.extname(filename));
    const storedScenes: StoredVideo[] = [];

    for (const [index, segment] of segments.entries()) {
      const sceneFilename = path.posix.join(scenePrefix, `${sceneBaseName}-scene-${String(index + 1).padStart(3, '0')}.mp4`);
      const sceneOutputPath = path.join(storage.getLocalOutputDir(), sceneFilename);
      fs.mkdirSync(path.dirname(sceneOutputPath), { recursive: true });
      await trimVideoToScene(inputPath, segment, sceneOutputPath);
      sceneOutputPaths.push(sceneOutputPath);
      storedScenes.push(await storage.saveOutput(sceneOutputPath, sceneFilename));
    }

    if (storage.isRemoteStorage()) {
      cleanupLocalFile(outputPath);
      for (const sceneOutputPath of sceneOutputPaths) {
        cleanupLocalFile(sceneOutputPath);
      }
    }

    return { segments, storedOutput, storedScenes, storedInput, outputPath, sceneOutputPaths, downloadedPath };
  } catch (err) {
    cleanupLocalFile(outputPath);
    for (const sceneOutputPath of sceneOutputPaths) {
      cleanupLocalFile(sceneOutputPath);
    }
    cleanupLocalFile(downloadedPath);
    throw err;
  }
}
