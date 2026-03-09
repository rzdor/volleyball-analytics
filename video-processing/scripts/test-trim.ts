#!/usr/bin/env ts-node

/**
 * Local test script for the video trim pipeline.
 *
 * Usage:
 *   npx ts-node scripts/test-trim.ts <input-video-path> [options]
 *
 * Options:
 *   --threshold <n>        Motion detection threshold (default: 0.02)
 *   --min-segment <n>      Minimum segment length in seconds (default: 3)
 *   --sample-fps <n>       Frames to sample per second (default: 2)
 *   --pre-roll <n>         Seconds before detected motion (default: 1)
 *   --post-roll <n>        Seconds after detected motion (default: 1)
 *   --smoothing <n>        Smoothing window size (default: 3)
 *   --output <path>        Custom output path (default: auto-generated in tmp/)
 *
 * Requires ffmpeg installed locally.
 *
 * Example:
 *   npx ts-node scripts/test-trim.ts ~/videos/game.mp4
 *   npx ts-node scripts/test-trim.ts ~/videos/game.mp4 --threshold 0.05 --min-segment 5
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { detectMotionSegments, MotionDetectorOptions, TimeRange } from '../src/services/motionDetector';
import { trimVideoToSegments } from '../src/services/videoTrimmer';
import { getVideoMetadata } from '../src/services/frameExtractor';

interface TestOptions {
  inputPath: string;
  outputPath?: string;
  motionOptions: MotionDetectorOptions;
}

function parseArgs(): TestOptions {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: npx ts-node scripts/test-trim.ts <input-video> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --threshold <n>     Motion threshold 0-1 (default: 0.02)');
    console.log('  --min-segment <n>   Minimum segment seconds (default: 3)');
    console.log('  --sample-fps <n>    Sample frames per second (default: 2)');
    console.log('  --pre-roll <n>      Pre-roll seconds (default: 1)');
    console.log('  --post-roll <n>     Post-roll seconds (default: 1)');
    console.log('  --smoothing <n>     Smoothing window (default: 3)');
    console.log('  --output <path>     Output file path');
    process.exit(0);
  }

  const inputPath = path.resolve(args[0]);
  const motionOptions: MotionDetectorOptions = {};
  let outputPath: string | undefined;

  for (let i = 1; i < args.length; i += 2) {
    const value = parseFloat(args[i + 1]);
    switch (args[i]) {
      case '--threshold': motionOptions.threshold = value; break;
      case '--min-segment': motionOptions.minSegmentLength = value; break;
      case '--sample-fps': motionOptions.sampleFps = value; break;
      case '--pre-roll': motionOptions.preRoll = value; break;
      case '--post-roll': motionOptions.postRoll = value; break;
      case '--smoothing': motionOptions.smoothingWindow = value; break;
      case '--output': outputPath = args[i + 1]; break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  return { inputPath, outputPath, motionOptions };
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

function getFileSize(filePath: string): string {
  const bytes = fs.statSync(filePath).size;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function run(): Promise<void> {
  const opts = parseArgs();

  // Validate input
  if (!fs.existsSync(opts.inputPath)) {
    console.error(`ERROR: Input file not found: ${opts.inputPath}`);
    process.exit(1);
  }

  checkFfmpeg();

  console.log('═══════════════════════════════════════════');
  console.log('  Video Trim Pipeline - Local Test');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // Step 1: Get video metadata
  console.log('▶ Step 1: Reading video metadata...');
  const meta = await getVideoMetadata(opts.inputPath);
  console.log(`  File:       ${path.basename(opts.inputPath)}`);
  console.log(`  Size:       ${getFileSize(opts.inputPath)}`);
  console.log(`  Duration:   ${formatTime(meta.duration)} (${meta.duration.toFixed(1)}s)`);
  console.log(`  Resolution: ${meta.width}x${meta.height}`);
  console.log(`  FPS:        ${meta.fps}`);
  console.log('');

  // Step 2: Detect motion segments
  console.log('▶ Step 2: Detecting motion segments...');
  const effectiveOptions: MotionDetectorOptions = {
    sampleFps: opts.motionOptions.sampleFps ?? 2,
    threshold: opts.motionOptions.threshold ?? 0.02,
    minSegmentLength: opts.motionOptions.minSegmentLength ?? 3,
    preRoll: opts.motionOptions.preRoll ?? 1,
    postRoll: opts.motionOptions.postRoll ?? 1,
    smoothingWindow: opts.motionOptions.smoothingWindow ?? 3,
  };
  console.log(`  Options:    ${JSON.stringify(effectiveOptions)}`);

  const startDetect = Date.now();
  const segments: TimeRange[] = await detectMotionSegments(opts.inputPath, effectiveOptions);
  const detectTime = ((Date.now() - startDetect) / 1000).toFixed(1);
  console.log(`  Completed in ${detectTime}s`);
  console.log('');

  if (segments.length === 0) {
    console.log('⚠ No motion segments detected!');
    console.log('  Try lowering --threshold (current:', effectiveOptions.threshold, ')');
    process.exit(0);
  }

  // Step 3: Print segments
  console.log(`▶ Found ${segments.length} segment(s):`);
  let totalSegmentDuration = 0;
  segments.forEach((seg, i) => {
    const duration = seg.end - seg.start;
    totalSegmentDuration += duration;
    console.log(`  [${i + 1}] ${formatTime(seg.start)} → ${formatTime(seg.end)}  (${duration.toFixed(1)}s)`);
  });
  const reductionPct = ((1 - totalSegmentDuration / meta.duration) * 100).toFixed(0);
  console.log(`  Total:    ${totalSegmentDuration.toFixed(1)}s of ${meta.duration.toFixed(1)}s (${reductionPct}% reduction)`);
  console.log('');

  // Step 4: Trim video
  const outputPath = opts.outputPath ?? path.join(
    os.tmpdir(),
    `trimmed-${Date.now()}.mp4`
  );
  console.log(`▶ Step 3: Trimming video → ${outputPath}`);

  const startTrim = Date.now();
  await trimVideoToSegments(opts.inputPath, segments, outputPath);
  const trimTime = ((Date.now() - startTrim) / 1000).toFixed(1);
  console.log(`  Completed in ${trimTime}s`);
  console.log('');

  // Step 5: Verify output
  console.log('▶ Step 4: Verifying output...');
  if (!fs.existsSync(outputPath)) {
    console.error('  ✗ Output file was not created!');
    process.exit(1);
  }

  const outputMeta = await getVideoMetadata(outputPath);
  const outputSize = getFileSize(outputPath);
  const durationDiff = Math.abs(outputMeta.duration - totalSegmentDuration);

  console.log(`  Size:       ${outputSize} (was ${getFileSize(opts.inputPath)})`);
  console.log(`  Duration:   ${formatTime(outputMeta.duration)} (${outputMeta.duration.toFixed(1)}s)`);
  console.log(`  Resolution: ${outputMeta.width}x${outputMeta.height}`);
  console.log('');

  // Validation checks
  console.log('▶ Validation:');

  const checks = [
    { name: 'Output file exists', pass: true },
    { name: 'Output file > 0 bytes', pass: fs.statSync(outputPath).size > 0 },
    { name: 'Output has video stream', pass: outputMeta.width > 0 && outputMeta.height > 0 },
    { name: 'Output duration > 0', pass: outputMeta.duration > 0 },
    { name: `Duration within 2s of expected (${totalSegmentDuration.toFixed(1)}s)`, pass: durationDiff < 2 },
    { name: 'Output shorter than input', pass: outputMeta.duration < meta.duration || segments.length === 0 },
    { name: 'Resolution preserved', pass: outputMeta.width === meta.width && outputMeta.height === meta.height },
  ];

  let allPassed = true;
  for (const check of checks) {
    const icon = check.pass ? '✓' : '✗';
    console.log(`  ${icon} ${check.name}`);
    if (!check.pass) allPassed = false;
  }

  console.log('');
  console.log('═══════════════════════════════════════════');
  if (allPassed) {
    console.log('  ✓ ALL CHECKS PASSED');
  } else {
    console.log('  ✗ SOME CHECKS FAILED');
  }
  // Copy output to same directory as input file
  const ext = path.extname(opts.inputPath);
  const baseName = path.basename(opts.inputPath, ext);
  const inputDir = path.dirname(opts.inputPath);
  const finalPath = path.join(inputDir, `${baseName}-trimmed${ext}`);
  fs.copyFileSync(outputPath, finalPath);
  console.log(`  Output copied to: ${finalPath}`);
  console.log('═══════════════════════════════════════════');

  process.exit(allPassed ? 0 : 1);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
