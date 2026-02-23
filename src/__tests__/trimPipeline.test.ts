import fs from 'fs';
import os from 'os';
import path from 'path';
import { runTrimPipeline, NoSegmentsDetectedError } from '../services/trimPipeline';
import { VideoDownloadError } from '../services/remoteVideoDownloader';
import { detectMotionSegments } from '../services/motionDetector';
import { trimVideoToSegments } from '../services/videoTrimmer';

jest.mock('../services/motionDetector', () => ({
  detectMotionSegments: jest.fn(),
}));

jest.mock('../services/videoTrimmer', () => ({
  trimVideoToSegments: jest.fn().mockResolvedValue(undefined),
}));

const detectMotionSegmentsMock = detectMotionSegments as unknown as jest.Mock;
const trimVideoToSegmentsMock = trimVideoToSegments as unknown as jest.Mock;

describe('runTrimPipeline', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-pipeline-'));
  const storageMock = {
    getLocalInputDir: () => tempDir,
    getLocalOutputDir: () => tempDir,
    saveInput: jest.fn(async (_path: string, preferred?: string) => ({
      name: preferred ?? 'input.mp4',
      url: `/uploads/inputs/${preferred ?? 'input.mp4'}`,
      downloadUrl: `/uploads/inputs/${preferred ?? 'input.mp4'}`,
    })),
    saveOutput: jest.fn(async (_path: string, filename?: string) => ({
      name: filename ?? 'output.mp4',
      url: `/uploads/processed/${filename ?? 'output.mp4'}`,
      downloadUrl: `/uploads/processed/${filename ?? 'output.mp4'}`,
    })),
  };

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws a VideoDownloadError when no video is provided', async () => {
    await expect(runTrimPipeline({ storage: storageMock as any }))
      .rejects.toBeInstanceOf(VideoDownloadError);
  });

  it('throws NoSegmentsDetectedError when no motion is found', async () => {
    const inputFile = path.join(tempDir, 'input.mp4');
    fs.writeFileSync(inputFile, 'bytes');
    detectMotionSegmentsMock.mockResolvedValueOnce([]);

    await expect(runTrimPipeline({ videoPath: inputFile, storage: storageMock as any }))
      .rejects.toBeInstanceOf(NoSegmentsDetectedError);
  });

  it('returns stored output metadata when trimming succeeds', async () => {
    const inputFile = path.join(tempDir, 'input-success.mp4');
    fs.writeFileSync(inputFile, 'bytes');
    detectMotionSegmentsMock.mockResolvedValueOnce([{ start: 0, end: 1 }]);
    trimVideoToSegmentsMock.mockResolvedValueOnce(undefined);

    const result = await runTrimPipeline({
      videoPath: inputFile,
      storage: storageMock as any,
      outputFilename: 'trimmed-test.mp4',
    });

    expect(result.segments).toHaveLength(1);
    expect(result.storedOutput.name).toBe('trimmed-test.mp4');
    expect(storageMock.saveInput).toHaveBeenCalled();
    expect(storageMock.saveOutput).toHaveBeenCalledWith(expect.any(String), 'trimmed-test.mp4');
  });
});
