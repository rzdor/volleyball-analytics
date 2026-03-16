import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { trimVideoToSegments } from '../services/videoTrimmer';
import { getVideoMetadata } from '../services/frameExtractor';

/**
 * Quality test: trims a locally saved synthetic video and verifies that the
 * output duration matches the manually calculated expected value.
 *
 * Source video: 20 s, generated with ffmpeg testsrc (moving pattern, no audio).
 * Segments trimmed: [2 s – 7 s] and [12 s – 17 s] → expected duration = 10 s.
 */
describe('trimVideoToSegments – quality test', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-trim-quality-'));
  const inputVideo = path.join(tmpDir, 'source.mp4');
  const outputVideo = path.join(tmpDir, 'trimmed.mp4');

  // Manually calculated expected output duration based on the segments below.
  const segments = [
    { start: 2, end: 7 },   // 5 s
    { start: 12, end: 17 }, // 5 s
  ];
  const expectedDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0); // 10 s

  // Tolerance in seconds for duration comparison (codec frame-boundary rounding).
  const TOLERANCE_S = 0.5;

  beforeAll(() => {
    // Generate a 20-second synthetic test video with a moving test-pattern.
    execSync(
      `ffmpeg -y -f lavfi -i testsrc=duration=20:size=320x240:rate=25 ` +
      `-c:v libx264 -preset ultrafast -crf 28 "${inputVideo}"`,
      { stdio: 'pipe' }
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces an output file whose duration matches the manually calculated value', async () => {
    await trimVideoToSegments(inputVideo, segments, outputVideo);

    expect(fs.existsSync(outputVideo)).toBe(true);

    const metadata = await getVideoMetadata(outputVideo);
    expect(metadata.duration).toBeGreaterThan(expectedDuration - TOLERANCE_S);
    expect(metadata.duration).toBeLessThan(expectedDuration + TOLERANCE_S);
  }, 60_000);
});
