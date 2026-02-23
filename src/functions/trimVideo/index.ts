import os from 'os';
import path from 'path';
import { MotionDetectorOptions } from '../../services/motionDetector';
import { MAX_REMOTE_VIDEO_BYTES, VideoDownloadError } from '../../services/remoteVideoDownloader';
import { createVideoStorage } from '../../services/storageProvider';
import { NoSegmentsDetectedError, runTrimPipeline } from '../../services/trimPipeline';

type HttpRequest = { body?: any; query?: Record<string, unknown> };
type FunctionContext = { res?: any; log?: (...args: any[]) => void };

const storage = createVideoStorage({ baseDir: path.join(os.tmpdir(), 'va-function-uploads') });

export default async function (context: FunctionContext, req: HttpRequest): Promise<void> {
  const blobUrl =
    typeof req.body?.blobUrl === 'string'
      ? req.body.blobUrl.trim()
      : typeof req.query?.blobUrl === 'string'
        ? req.query.blobUrl.trim()
        : '';

  if (!blobUrl) {
    context.res = { status: 400, body: { error: 'blobUrl is required' } };
    return;
  }

  const options: MotionDetectorOptions = {
    sampleFps: parseFloat(req.body?.sampleFps) || 2,
    threshold: parseFloat(req.body?.threshold) || 0.02,
    minSegmentLength: parseFloat(req.body?.minSegmentLength) || 3,
    preRoll: parseFloat(req.body?.preRoll) || 1,
    postRoll: parseFloat(req.body?.postRoll) || 1,
    smoothingWindow: parseInt(req.body?.smoothingWindow, 10) || 3,
  };

  try {
    const result = await runTrimPipeline({
      videoUrl: blobUrl,
      storage,
      motionOptions: options,
      maxBytes: MAX_REMOTE_VIDEO_BYTES,
    });

    context.res = {
      status: 200,
      body: {
        success: true,
        segments: result.segments,
        totalSegments: result.segments.length,
        previewUrl: result.storedOutput.url,
        downloadUrl: result.storedOutput.downloadUrl ?? result.storedOutput.url,
        inputUrl: result.storedInput?.url,
        outputName: result.storedOutput.name,
      },
    };
  } catch (error) {
    if (error instanceof NoSegmentsDetectedError) {
      context.res = {
        status: 422,
        body: { error: 'No motion segments detected. Try lowering the threshold.', segments: [] },
      };
      return;
    }
    if (error instanceof VideoDownloadError) {
      const statusCode = error.statusCode ?? 400;
      context.res = { status: statusCode, body: { error: error.message } };
      return;
    }
    context.log?.('trimVideo function error', error);
    context.res = { status: 500, body: { error: 'Failed to trim video' } };
  }
}
