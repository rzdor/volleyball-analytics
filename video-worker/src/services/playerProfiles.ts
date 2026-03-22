import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { DetectionResult, FramePlayer, TeamSide } from './playerDetector';
import { VideoStorage } from './storageProvider';

export interface PlayerProfileEntry {
  trackId: number;
  teamId: number;
  teamSide?: TeamSide;
  frameCount: number;
  avgConfidence: number;
  bestConfidence?: number;
  sampleTimestamp?: number;
  imageBlobName?: string;
  imageUrl?: string;
  displayName?: string;
  notes?: string;
}

export interface PlayerManifest {
  recordId: string;
  generatedAt: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  players: PlayerProfileEntry[];
}

interface CropCandidate {
  player: FramePlayer;
  timestamp: number;
}

interface VideoDimensions {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function getVideoDimensions(videoPath: string): Promise<VideoDimensions> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (error, metadata) => {
      if (error) {
        reject(error);
        return;
      }

      const stream = metadata.streams.find(item => item.codec_type === 'video');
      const width = typeof stream?.width === 'number' ? stream.width : 0;
      const height = typeof stream?.height === 'number' ? stream.height : 0;

      if (width <= 0 || height <= 0) {
        reject(new Error(`Unable to determine video dimensions for ${videoPath}`));
        return;
      }

      resolve({ width, height });
    });
  });
}

async function extractPlayerCrop(
  videoPath: string,
  timestamp: number,
  player: FramePlayer,
  dimensions: VideoDimensions,
  outputPath: string
): Promise<void> {
  const paddingX = player.bbox.w * 0.35;
  const paddingY = player.bbox.h * 0.35;
  const x = clamp(Math.floor(player.bbox.x - paddingX), 0, dimensions.width - 1);
  const y = clamp(Math.floor(player.bbox.y - paddingY), 0, dimensions.height - 1);
  const width = clamp(Math.ceil(player.bbox.w + paddingX * 2), 1, dimensions.width - x);
  const height = clamp(Math.ceil(player.bbox.h + paddingY * 2), 1, dimensions.height - y);
  const safeTimestamp = Math.max(0, timestamp);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(safeTimestamp)
      .frames(1)
      .outputOptions([
        '-vf',
        `crop=${width}:${height}:${x}:${y},scale=256:-2`,
        '-q:v',
        '2',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

function getBestCropCandidates(result: DetectionResult): Map<number, CropCandidate> {
  const candidates = new Map<number, CropCandidate>();

  for (const frame of result.frames) {
    for (const player of frame.players) {
      if (player.trackId < 0) {
        continue;
      }

      const existing = candidates.get(player.trackId);
      if (!existing || player.confidence > existing.player.confidence) {
        candidates.set(player.trackId, {
          player,
          timestamp: frame.timestamp,
        });
      }
    }
  }

  return candidates;
}

export async function buildPlayerManifest(params: {
  recordId: string;
  videoPath: string;
  sourceVideoBlobName: string;
  processedBlobName: string;
  detectionResult: DetectionResult;
  storage: VideoStorage;
}): Promise<{ manifest: PlayerManifest; manifestBlobName: string; manifestUrl: string }> {
  const dimensions = await getVideoDimensions(params.videoPath);
  const bestCandidates = getBestCropCandidates(params.detectionResult);
  const players: PlayerProfileEntry[] = [];

  for (const track of [...params.detectionResult.tracks].sort((left, right) => left.trackId - right.trackId)) {
    const candidate = bestCandidates.get(track.trackId);
    let imageBlobName: string | undefined;

    if (candidate) {
      const imageRelativePath = path.posix.join(
        params.recordId,
        'players',
        `track-${String(track.trackId).padStart(4, '0')}.jpg`
      );
      const imageOutputPath = path.join(params.storage.getLocalOutputDir(), imageRelativePath);
      fs.mkdirSync(path.dirname(imageOutputPath), { recursive: true });

      await extractPlayerCrop(params.videoPath, candidate.timestamp, candidate.player, dimensions, imageOutputPath);
      const storedImage = await params.storage.saveOutput(imageOutputPath, imageRelativePath);
      imageBlobName = `processed/${storedImage.name}`;

      if (params.storage.isRemoteStorage() && fs.existsSync(imageOutputPath)) {
        fs.unlinkSync(imageOutputPath);
      }
    }

    players.push({
      trackId: track.trackId,
      teamId: track.teamId,
      teamSide: track.teamSide,
      frameCount: track.frameCount,
      avgConfidence: track.avgConfidence,
      bestConfidence: candidate?.player.confidence,
      sampleTimestamp: candidate?.timestamp,
      imageBlobName,
      displayName: '',
      notes: '',
    });
  }

  const manifest: PlayerManifest = {
    recordId: params.recordId,
    generatedAt: new Date().toISOString(),
    sourceVideoBlobName: params.sourceVideoBlobName,
    processedBlobName: params.processedBlobName,
    players,
  };

  const manifestRelativePath = path.posix.join(params.recordId, 'players', 'manifest.json');
  const manifestOutputPath = path.join(params.storage.getLocalOutputDir(), manifestRelativePath);
  fs.mkdirSync(path.dirname(manifestOutputPath), { recursive: true });
  fs.writeFileSync(manifestOutputPath, JSON.stringify(manifest, null, 2));
  const storedManifest = await params.storage.saveOutput(manifestOutputPath, manifestRelativePath);

  if (params.storage.isRemoteStorage() && fs.existsSync(manifestOutputPath)) {
    fs.unlinkSync(manifestOutputPath);
  }

  return {
    manifest,
    manifestBlobName: `processed/${storedManifest.name}`,
    manifestUrl: storedManifest.url,
  };
}
