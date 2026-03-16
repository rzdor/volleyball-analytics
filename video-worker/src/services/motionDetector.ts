import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getVideoMetadata } from './frameExtractor';

export interface MotionDetectorOptions {
  sampleFps?: number;          // Frames to sample per second (default: 2)
  threshold?: number;          // Motion score threshold 0–1 (default: 0.02)
  minSegmentLength?: number;   // Minimum play segment in seconds (default: 3)
  preRoll?: number;            // Seconds of padding before play (default: 1)
  postRoll?: number;           // Seconds of padding after play (default: 1)
  smoothingWindow?: number;    // Rolling-average window size (default: 3)
}

export interface TimeRange {
  start: number;
  end: number;
}

// Downscaled resolution used for motion comparison (faster, less memory)
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 90;
const FRAME_SIZE = FRAME_WIDTH * FRAME_HEIGHT; // bytes per grayscale frame

/**
 * Extracts all video frames at the given fps as raw 8-bit grayscale bytes
 * written sequentially into a single binary file (no image headers).
 */
function extractRawGrayFrames(
  videoPath: string,
  sampleFps: number,
  outputFile: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions([
        '-vf', `fps=${sampleFps},scale=${FRAME_WIDTH}:${FRAME_HEIGHT},format=gray`,
        '-f', 'rawvideo',
        '-pix_fmt', 'gray',
      ])
      .output(outputFile)
      .on('end', () => resolve())
      .on('error', reject)
      .run();
  });
}

/**
 * Computes per-frame motion scores as the mean absolute pixel difference
 * between consecutive frames, normalised to [0, 1].
 * The first frame always gets score 0 (no previous frame to compare).
 */
export function computeMotionScores(rawData: Buffer, frameSize: number = FRAME_SIZE): number[] {
  const numFrames = Math.floor(rawData.length / frameSize);
  const scores: number[] = new Array(numFrames).fill(0);

  for (let i = 1; i < numFrames; i++) {
    const off1 = (i - 1) * frameSize;
    const off2 = i * frameSize;
    let diff = 0;
    for (let j = 0; j < frameSize; j++) {
      diff += Math.abs(rawData[off2 + j] - rawData[off1 + j]);
    }
    scores[i] = diff / frameSize / 255;
  }

  return scores;
}

/**
 * Applies a symmetric rolling-average window to smooth out noise.
 */
export function smoothScores(scores: number[], windowSize: number): number[] {
  if (windowSize <= 1) return scores.slice();
  const half = Math.floor(windowSize / 2);
  return scores.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(scores.length, i + half + 1);
    let sum = 0;
    for (let k = start; k < end; k++) sum += scores[k];
    return sum / (end - start);
  });
}

/**
 * Converts a boolean-active array (after threshold) into time ranges,
 * applies minimum segment length filtering, and adds pre/post-roll padding.
 * Adjacent padded segments are merged into a single range.
 */
export function scoresToSegments(
  smoothed: number[],
  sampleFps: number,
  threshold: number,
  minSegmentLength: number,
  preRoll: number,
  postRoll: number,
  duration: number
): TimeRange[] {
  const active = smoothed.map(s => s >= threshold);

  // Collect raw active segments
  const raw: TimeRange[] = [];
  let segStart: number | null = null;
  for (let i = 0; i < active.length; i++) {
    const t = i / sampleFps;
    if (active[i] && segStart === null) {
      segStart = t;
    } else if (!active[i] && segStart !== null) {
      raw.push({ start: segStart, end: t });
      segStart = null;
    }
  }
  if (segStart !== null) {
    raw.push({ start: segStart, end: duration });
  }

  // Filter short segments
  const filtered = raw.filter(s => s.end - s.start >= minSegmentLength);

  // Apply pre/post-roll padding
  const padded = filtered.map(s => ({
    start: Math.max(0, s.start - preRoll),
    end: Math.min(duration, s.end + postRoll),
  }));

  // Merge overlapping / adjacent segments
  const merged: TimeRange[] = [];
  for (const seg of padded) {
    if (merged.length > 0 && seg.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, seg.end);
    } else {
      merged.push({ start: seg.start, end: seg.end });
    }
  }

  return merged;
}

/**
 * Full pipeline: extracts frames, computes motion scores, smooths them,
 * then returns the list of play-segment time ranges.
 * Temporary files are cleaned up before returning.
 */
export async function detectMotionSegments(
  videoPath: string,
  options: MotionDetectorOptions = {}
): Promise<TimeRange[]> {
  const {
    sampleFps = 2,
    threshold = 0.02,
    minSegmentLength = 3,
    preRoll = 1,
    postRoll = 1,
    smoothingWindow = 3,
  } = options;

  const metadata = await getVideoMetadata(videoPath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-motion-'));
  const rawFile = path.join(tmpDir, 'frames.raw');

  try {
    await extractRawGrayFrames(videoPath, sampleFps, rawFile);
    const rawData = fs.readFileSync(rawFile);
    const scores = computeMotionScores(rawData);
    const smoothed = smoothScores(scores, smoothingWindow);
    return scoresToSegments(
      smoothed, sampleFps, threshold, minSegmentLength, preRoll, postRoll, metadata.duration
    );
  } finally {
    try { fs.unlinkSync(rawFile); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}
