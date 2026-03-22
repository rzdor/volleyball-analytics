import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

// Mock child_process
jest.mock('child_process');
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

// Deterministic UUID for test output paths
jest.mock('crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}));

import { detectPlayers, DetectionResult } from '../services/playerDetector';

function createMockProcess(exitCode: number, stdout: string, stderr: string): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).stdin = null;

  // Emit data + close asynchronously
  setImmediate(() => {
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
    if (stdout) stdoutEmitter.emit('data', Buffer.from(stdout));
    proc.emit('close', exitCode);
  });

  return proc;
}

const SAMPLE_RESULT: DetectionResult = {
  videoName: 'test-video.mp4',
  processedAt: '2026-03-12T15:00:00Z',
  sampleFps: 2,
  videoFps: 30,
  totalVideoFrames: 900,
  sampledFrames: 60,
  teams: [
    { id: 0, dominantColor: [255, 50, 50], playerCount: 6, side: 'main' },
    { id: 1, dominantColor: [50, 50, 255], playerCount: 6, side: 'opponent' },
  ],
  frames: [
    {
      frameIndex: 0,
      timestamp: 0,
      balls: [
        { bbox: { x: 130, y: 190, w: 24, h: 24 }, confidence: 0.89 },
      ],
      players: [
        { trackId: 1, teamId: 0, teamSide: 'main', bbox: { x: 100, y: 200, w: 50, h: 100 }, confidence: 0.95 },
      ],
    },
  ],
  tracks: [
    { trackId: 1, teamId: 0, teamSide: 'main', firstFrame: 0, lastFrame: 60, frameCount: 55, avgConfidence: 0.92 },
  ],
};

describe('playerDetector', () => {
  const videoPath = '/tmp/test-video.mp4';
  const outputDir = '/tmp/test-output';

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock fs.readFileSync to return sample result
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(SAMPLE_RESULT));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should spawn python3 with correct arguments', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, '/tmp/output.json', ''));

    await detectPlayers(videoPath, outputDir);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('python3');
    expect(args).toContain(videoPath);
    expect(args).toContain('--sample-fps');
    expect(args).toContain('2');
    expect(args).toContain('--confidence');
    expect(args).toContain('0.5');
    expect(args).toContain('--num-teams');
    expect(args).toContain('2');
    expect(args).toContain('--model');
    expect(args).toContain('yolov8n.pt');
  });

  it('should pass custom options to python script', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, '', ''));

    await detectPlayers(videoPath, outputDir, {
      sampleFps: 5,
      confidence: 0.7,
      numTeams: 3,
      modelName: 'yolov8s.pt',
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('5');
    expect(args).toContain('0.7');
    expect(args).toContain('3');
    expect(args).toContain('yolov8s.pt');
  });

  it('should parse and return detection result JSON', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, '', ''));

    const result = await detectPlayers(videoPath, outputDir);

    expect(result.videoName).toBe('test-video.mp4');
    expect(result.teams).toHaveLength(2);
    expect(result.tracks).toHaveLength(1);
    expect(result.frames).toHaveLength(1);
    expect(result.teams[0].dominantColor).toEqual([255, 50, 50]);
    expect(result.teams[0].side).toBe('main');
    expect(result.frames[0].balls[0].confidence).toBe(0.89);
    expect(result.frames[0].players[0].teamSide).toBe('main');
    expect(result.tracks[0].teamSide).toBe('main');
  });

  it('should reject when python process exits with non-zero code', async () => {
    mockSpawn.mockReturnValue(createMockProcess(1, '', 'Error: model not found'));

    await expect(detectPlayers(videoPath, outputDir))
      .rejects
      .toThrow('Python detection script exited with code 1');
  });

  it('should reject when python process fails to start', async () => {
    const proc = new EventEmitter() as ChildProcess;
    (proc as any).stdout = new EventEmitter();
    (proc as any).stderr = new EventEmitter();
    (proc as any).stdin = null;
    mockSpawn.mockReturnValue(proc);

    const promise = detectPlayers(videoPath, outputDir);

    setImmediate(() => {
      proc.emit('error', new Error('spawn ENOENT'));
    });

    await expect(promise).rejects.toThrow('Failed to start Python process');
  });

  it('should reject when output JSON is invalid', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, '', ''));
    jest.spyOn(fs, 'readFileSync').mockReturnValue('not valid json{{{');

    await expect(detectPlayers(videoPath, outputDir))
      .rejects
      .toThrow('Failed to parse detection output');
  });

  it('should forward stderr to the log function', async () => {
    mockSpawn.mockReturnValue(createMockProcess(0, '', '[detect] Loading model'));

    const logs: string[] = [];
    await detectPlayers(videoPath, outputDir, {}, (msg) => logs.push(msg));

    expect(logs.some(l => l.includes('playerDetector:py'))).toBe(true);
  });
});
