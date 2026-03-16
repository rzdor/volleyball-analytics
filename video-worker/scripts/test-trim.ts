#!/usr/bin/env ts-node

/**
 * Local test script for the video trim pipeline — batch comparison mode.
 *
 * Runs all combinations of sample-fps and threshold values against a single
 * input video, then prints a comparison table so you can pick the best config.
 *
 * Usage:
 *   npx ts-node scripts/test-trim.ts <input-video-path> [options]
 *
 * Options:
 *   --min-segment <n>   Minimum segment length in seconds (default: 3)
 *   --pre-roll <n>      Seconds before detected motion (default: 1)
 *   --post-roll <n>     Seconds after detected motion (default: 1)
 *   --smoothing <n>     Smoothing window size (default: 3)
 *   --output-dir <path> Directory to write trimmed files (default: <input-dir>/trim-comparison/)
 *   --skip-trim         Only detect segments, skip the actual video trimming
 *
 * Requires ffmpeg installed locally.
 *
 * Example:
 *   npx ts-node scripts/test-trim.ts ~/videos/game.mp4
 *   npx ts-node scripts/test-trim.ts ~/videos/game.mp4 --min-segment 5 --skip-trim
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { detectMotionSegments, MotionDetectorOptions, TimeRange } from '../src/services/motionDetector';
import { trimVideoToSegments } from '../src/services/videoTrimmer';
import { getVideoMetadata, VideoMetadata } from '../src/services/frameExtractor';

const SAMPLE_FPS_VALUES = [2, 5, 10];
const THRESHOLD_VALUES = [0.02, 0.01, 0.005];

interface SharedOptions {
  minSegmentLength: number;
  preRoll: number;
  postRoll: number;
  smoothingWindow: number;
}

interface RunResult {
  sampleFps: number;
  threshold: number;
  segments: TimeRange[];
  segmentCount: number;
  totalMotionDuration: number;
  reductionPct: number;
  detectTimeMs: number;
  outputPath?: string;
  outputSize?: number;
  outputDuration?: number;
  trimTimeMs?: number;
  error?: string;
}

interface TestConfig {
  inputPath: string;
  outputDir: string;
  skipTrim: boolean;
  shared: SharedOptions;
}

function parseArgs(): TestConfig {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: npx ts-node scripts/test-trim.ts <input-video> [options]');
    console.log('');
    console.log(`Runs ${SAMPLE_FPS_VALUES.length * THRESHOLD_VALUES.length} combinations:`);
    console.log(`  sample-fps: ${SAMPLE_FPS_VALUES.join(', ')}`);
    console.log(`  threshold:  ${THRESHOLD_VALUES.join(', ')}`);
    console.log('');
    console.log('Options:');
    console.log('  --min-segment <n>   Minimum segment seconds (default: 3)');
    console.log('  --pre-roll <n>      Pre-roll seconds (default: 1)');
    console.log('  --post-roll <n>     Post-roll seconds (default: 1)');
    console.log('  --smoothing <n>     Smoothing window (default: 3)');
    console.log('  --output-dir <path> Output directory (default: <input-dir>/trim-comparison/)');
    console.log('  --skip-trim         Only detect segments, skip video trimming');
    process.exit(0);
  }

  const inputPath = path.resolve(args[0]);
  let outputDir = '';
  let skipTrim = false;
  const shared: SharedOptions = {
    minSegmentLength: 3,
    preRoll: 1,
    postRoll: 1,
    smoothingWindow: 3,
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--min-segment': shared.minSegmentLength = parseFloat(args[++i]); break;
      case '--pre-roll': shared.preRoll = parseFloat(args[++i]); break;
      case '--post-roll': shared.postRoll = parseFloat(args[++i]); break;
      case '--smoothing': shared.smoothingWindow = parseFloat(args[++i]); break;
      case '--output-dir': outputDir = args[++i]; break;
      case '--skip-trim': skipTrim = true; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!outputDir) {
    outputDir = path.join(path.dirname(inputPath), 'trim-comparison');
  }

  return { inputPath, outputDir, skipTrim, shared };
}

function checkFfmpeg(): void {
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
  } catch {
    console.error('ERROR: ffmpeg is not installed or not in PATH.');
    process.exit(1);
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileSize(filePath: string): number {
  return fs.statSync(filePath).size;
}

function buildConfigLabel(sampleFps: number, threshold: number): string {
  return `fps${sampleFps}_th${threshold}`;
}

async function runSingleConfig(
  inputPath: string,
  sampleFps: number,
  threshold: number,
  shared: SharedOptions,
  videoDuration: number,
  outputDir: string,
  skipTrim: boolean,
  baseName: string,
  ext: string,
): Promise<RunResult> {
  const label = buildConfigLabel(sampleFps, threshold);
  const options: MotionDetectorOptions = {
    sampleFps,
    threshold,
    ...shared,
  };

  const result: RunResult = {
    sampleFps,
    threshold,
    segments: [],
    segmentCount: 0,
    totalMotionDuration: 0,
    reductionPct: 0,
    detectTimeMs: 0,
  };

  try {
    // Detect motion
    const detectStart = Date.now();
    const segments = await detectMotionSegments(inputPath, options);
    result.detectTimeMs = Date.now() - detectStart;
    result.segments = segments;
    result.segmentCount = segments.length;

    const totalMotion = segments.reduce((sum, s) => sum + (s.end - s.start), 0);
    result.totalMotionDuration = totalMotion;
    result.reductionPct = videoDuration > 0
      ? (1 - totalMotion / videoDuration) * 100
      : 0;

    console.log(`  ✓ [${label}] ${segments.length} segments, ${totalMotion.toFixed(1)}s motion, ${result.reductionPct.toFixed(0)}% reduction (detect: ${(result.detectTimeMs / 1000).toFixed(1)}s)`);

    // Trim
    if (!skipTrim && segments.length > 0) {
      const outputPath = path.join(outputDir, `${baseName}-${label}${ext}`);
      const trimStart = Date.now();
      await trimVideoToSegments(inputPath, segments, outputPath);
      result.trimTimeMs = Date.now() - trimStart;
      result.outputPath = outputPath;

      if (fs.existsSync(outputPath)) {
        result.outputSize = getFileSize(outputPath);
        const outputMeta = await getVideoMetadata(outputPath);
        result.outputDuration = outputMeta.duration;
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ [${label}] ERROR: ${result.error}`);
  }

  return result;
}

function printComparisonTable(results: RunResult[], inputDuration: number, inputSize: number): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  COMPARISON TABLE');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`  Input: ${formatTime(inputDuration)} (${inputDuration.toFixed(1)}s), ${formatSize(inputSize)}`);
  console.log('');

  // Table header
  const header = [
    'fps'.padEnd(5),
    'threshold'.padEnd(10),
    'segments'.padEnd(9),
    'motion'.padEnd(10),
    'reduction'.padEnd(10),
    'detect'.padEnd(9),
    'trim'.padEnd(9),
    'out size'.padEnd(10),
    'out dur'.padEnd(10),
  ].join('│');
  const separator = [5, 10, 9, 10, 10, 9, 9, 10, 10].map(n => '─'.repeat(n)).join('┼');

  console.log(`  ${header}`);
  console.log(`  ${separator}`);

  for (const r of results) {
    if (r.error) {
      console.log(`  ${String(r.sampleFps).padEnd(5)}│${String(r.threshold).padEnd(10)}│ ERROR: ${r.error}`);
      continue;
    }

    const row = [
      String(r.sampleFps).padEnd(5),
      String(r.threshold).padEnd(10),
      String(r.segmentCount).padEnd(9),
      `${r.totalMotionDuration.toFixed(1)}s`.padEnd(10),
      `${r.reductionPct.toFixed(0)}%`.padEnd(10),
      `${(r.detectTimeMs / 1000).toFixed(1)}s`.padEnd(9),
      r.trimTimeMs != null ? `${(r.trimTimeMs / 1000).toFixed(1)}s`.padEnd(9) : '—'.padEnd(9),
      r.outputSize != null ? formatSize(r.outputSize).padEnd(10) : '—'.padEnd(10),
      r.outputDuration != null ? `${r.outputDuration.toFixed(1)}s`.padEnd(10) : '—'.padEnd(10),
    ].join('│');

    console.log(`  ${row}`);
  }

  console.log(`  ${separator}`);
  console.log('');

  // Print segment details per config
  console.log('  SEGMENT DETAILS');
  console.log('  ───────────────');
  for (const r of results) {
    if (r.error || r.segments.length === 0) continue;
    const label = buildConfigLabel(r.sampleFps, r.threshold);
    console.log(`  [${label}]`);
    r.segments.forEach((seg, i) => {
      const dur = seg.end - seg.start;
      console.log(`    ${String(i + 1).padStart(3)}. ${formatTime(seg.start)} → ${formatTime(seg.end)}  (${dur.toFixed(1)}s)`);
    });
    console.log('');
  }
}

async function run(): Promise<void> {
  const config = parseArgs();

  if (!fs.existsSync(config.inputPath)) {
    console.error(`ERROR: Input file not found: ${config.inputPath}`);
    process.exit(1);
  }

  checkFfmpeg();

  const totalCombinations = SAMPLE_FPS_VALUES.length * THRESHOLD_VALUES.length;

  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  Video Trim Pipeline — Batch Comparison');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log(`  Combinations: ${totalCombinations}  (sample-fps: [${SAMPLE_FPS_VALUES}] × threshold: [${THRESHOLD_VALUES}])`);
  console.log(`  Skip trim:    ${config.skipTrim}`);
  console.log('');

  // Read video metadata
  console.log('▶ Reading video metadata...');
  const meta: VideoMetadata = await getVideoMetadata(config.inputPath);
  const inputSize = getFileSize(config.inputPath);
  console.log(`  File:       ${path.basename(config.inputPath)}`);
  console.log(`  Size:       ${formatSize(inputSize)}`);
  console.log(`  Duration:   ${formatTime(meta.duration)} (${meta.duration.toFixed(1)}s)`);
  console.log(`  Resolution: ${meta.width}x${meta.height}`);
  console.log(`  FPS:        ${meta.fps}`);
  console.log('');

  // Prepare output directory
  if (!config.skipTrim) {
    fs.mkdirSync(config.outputDir, { recursive: true });
    console.log(`  Output dir: ${config.outputDir}`);
    console.log('');
  }

  const ext = path.extname(config.inputPath);
  const baseName = path.basename(config.inputPath, ext);

  // Run all combinations
  console.log(`▶ Running ${totalCombinations} configurations...`);
  const results: RunResult[] = [];
  let index = 0;

  for (const sampleFps of SAMPLE_FPS_VALUES) {
    for (const threshold of THRESHOLD_VALUES) {
      index++;
      console.log(`  [${index}/${totalCombinations}]`);
      const result = await runSingleConfig(
        config.inputPath,
        sampleFps,
        threshold,
        config.shared,
        meta.duration,
        config.outputDir,
        config.skipTrim,
        baseName,
        ext,
      );
      results.push(result);
    }
  }

  // Print comparison
  printComparisonTable(results, meta.duration, inputSize);

  // Summary
  const successful = results.filter(r => !r.error);
  const bestReduction = successful.reduce((best, r) =>
    r.reductionPct > best.reductionPct ? r : best, successful[0]);
  const fastest = successful.reduce((best, r) =>
    r.detectTimeMs < best.detectTimeMs ? r : best, successful[0]);
  const mostSegments = successful.reduce((best, r) =>
    r.segmentCount > best.segmentCount ? r : best, successful[0]);

  if (successful.length > 0) {
    console.log('  HIGHLIGHTS');
    console.log('  ──────────');
    console.log(`  Most reduction:  fps=${bestReduction.sampleFps}, th=${bestReduction.threshold} → ${bestReduction.reductionPct.toFixed(0)}% removed`);
    console.log(`  Fastest detect:  fps=${fastest.sampleFps}, th=${fastest.threshold} → ${(fastest.detectTimeMs / 1000).toFixed(1)}s`);
    console.log(`  Most segments:   fps=${mostSegments.sampleFps}, th=${mostSegments.threshold} → ${mostSegments.segmentCount} segments`);
  }

  if (!config.skipTrim) {
    console.log('');
    console.log(`  Output files in: ${config.outputDir}`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');

  const hasErrors = results.some(r => r.error);
  process.exit(hasErrors ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
