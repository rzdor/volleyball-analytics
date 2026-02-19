import { computeMotionScores, smoothScores, scoresToSegments } from '../services/motionDetector';

describe('Volleyball Play Analyzer', () => {
  it('should pass a basic sanity test', () => {
    expect(true).toBe(true);
  });
});

describe('computeMotionScores', () => {
  const FRAME_SIZE = 4; // tiny frame for testing

  it('assigns 0 to the first frame', () => {
    const raw = Buffer.from([10, 20, 30, 40, 10, 20, 30, 40]); // 2 identical frames
    const scores = computeMotionScores(raw, FRAME_SIZE);
    expect(scores[0]).toBe(0);
  });

  it('returns 0 score for identical consecutive frames', () => {
    const raw = Buffer.from([100, 100, 100, 100, 100, 100, 100, 100]);
    const scores = computeMotionScores(raw, FRAME_SIZE);
    expect(scores[1]).toBe(0);
  });

  it('returns maximum score (1.0) when frames are fully inverted', () => {
    const raw = Buffer.from([0, 0, 0, 0, 255, 255, 255, 255]);
    const scores = computeMotionScores(raw, FRAME_SIZE);
    expect(scores[1]).toBeCloseTo(1.0);
  });

  it('returns a partial score for partially changed frames', () => {
    // Half the pixels change by 255 → expected score = 0.5
    const raw = Buffer.from([0, 0, 0, 0, 255, 255, 0, 0]);
    const scores = computeMotionScores(raw, FRAME_SIZE);
    expect(scores[1]).toBeCloseTo(0.5);
  });

  it('handles a single frame without throwing', () => {
    const raw = Buffer.from([1, 2, 3, 4]);
    const scores = computeMotionScores(raw, FRAME_SIZE);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toBe(0);
  });
});

describe('smoothScores', () => {
  it('returns identical array when windowSize is 1', () => {
    const scores = [0.1, 0.5, 0.9, 0.3];
    expect(smoothScores(scores, 1)).toEqual(scores);
  });

  it('averages correctly with a window of 3', () => {
    const scores = [0, 0.6, 0, 0, 0];
    const smoothed = smoothScores(scores, 3);
    // Index 1: average of [0, 0.6, 0] = 0.2
    expect(smoothed[1]).toBeCloseTo(0.2);
  });

  it('does not mutate the original array', () => {
    const scores = [0.1, 0.2, 0.3];
    const copy = scores.slice();
    smoothScores(scores, 3);
    expect(scores).toEqual(copy);
  });
});

describe('scoresToSegments', () => {
  const FPS = 2;
  const DURATION = 20;

  it('returns empty array when all scores are below threshold', () => {
    const scores = new Array(40).fill(0);
    const result = scoresToSegments(scores, FPS, 0.02, 3, 1, 1, DURATION);
    expect(result).toHaveLength(0);
  });

  it('detects a single active region', () => {
    // Frames 4-11 are above threshold (2s–5.5s at 2fps)
    const scores = new Array(40).fill(0);
    for (let i = 4; i <= 11; i++) scores[i] = 0.1;
    const result = scoresToSegments(scores, FPS, 0.02, 3, 0, 0, DURATION);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBeCloseTo(2.0);
    expect(result[0].end).toBeCloseTo(6.0);  // first inactive frame at index 12 = 12/2 = 6.0s
  });

  it('discards segments shorter than minSegmentLength', () => {
    // Only 2 frames above threshold → 1 second of activity < minSegmentLength=3
    const scores = new Array(40).fill(0);
    scores[4] = 0.1;
    scores[5] = 0.1;
    const result = scoresToSegments(scores, FPS, 0.02, 3, 0, 0, DURATION);
    expect(result).toHaveLength(0);
  });

  it('applies pre-roll and post-roll padding', () => {
    const scores = new Array(40).fill(0);
    for (let i = 10; i <= 19; i++) scores[i] = 0.1; // 5s–9.5s
    const result = scoresToSegments(scores, FPS, 0.02, 3, 1, 2, DURATION);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBeCloseTo(4.0); // 5s - 1s preRoll
    expect(result[0].end).toBeCloseTo(12.0);  // first inactive frame at index 20 = 10.0s, + 2s postRoll
  });

  it('merges overlapping padded segments', () => {
    const scores = new Array(40).fill(0);
    // Two separate bursts, close enough that padding causes overlap
    for (let i = 4; i <= 10; i++) scores[i] = 0.1;  // 2s–5s
    for (let i = 12; i <= 18; i++) scores[i] = 0.1; // 6s–9s
    const result = scoresToSegments(scores, FPS, 0.02, 3, 1, 1, DURATION);
    expect(result).toHaveLength(1);
  });

  it('clamps padding to video boundaries', () => {
    const scores = new Array(40).fill(0);
    for (let i = 0; i <= 8; i++) scores[i] = 0.1; // starts at 0s
    const result = scoresToSegments(scores, FPS, 0.02, 3, 5, 5, DURATION);
    expect(result[0].start).toBe(0); // cannot go negative
    expect(result[0].end).toBeLessThanOrEqual(DURATION);
  });
});

