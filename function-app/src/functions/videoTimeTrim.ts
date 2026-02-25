import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import os from 'os';
import path from 'path';
import { MotionDetectorOptions } from '../services/motionDetector';
import { MAX_REMOTE_VIDEO_BYTES, VideoDownloadError } from '../services/remoteVideoDownloader';
import { createVideoStorage } from '../services/storageProvider';
import { NoSegmentsDetectedError, normalizeVideoUrl, runTrimPipeline } from '../services/trimPipeline';

const storage = createVideoStorage({ baseDir: path.join(os.tmpdir(), 'va-function-uploads') });

export async function videoTimeTrim(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const body: any = await request.json().catch(() => ({}));
    const blobUrl = normalizeVideoUrl(body?.blobUrl ?? request.query.get('blobUrl'));

    context.log('trimVideo request received', { blobUrl });

    if (!blobUrl) {
        return { status: 400, jsonBody: { error: 'blobUrl is required' } };
    }

    const options: MotionDetectorOptions = {
        sampleFps: parseFloat(body?.sampleFps) || 2,
        threshold: parseFloat(body?.threshold) || 0.02,
        minSegmentLength: parseFloat(body?.minSegmentLength) || 3,
        preRoll: parseFloat(body?.preRoll) || 1,
        postRoll: parseFloat(body?.postRoll) || 1,
        smoothingWindow: parseInt(body?.smoothingWindow, 10) || 3,
    };

    context.log('trimVideo starting pipeline', { blobUrl, options });

    try {
        const result = await runTrimPipeline({
            videoUrl: blobUrl,
            storage,
            motionOptions: options,
            maxBytes: MAX_REMOTE_VIDEO_BYTES,
        });

        context.log('trimVideo pipeline succeeded', {
            totalSegments: result.segments.length,
            outputName: result.storedOutput.name,
        });

        return {
            status: 200,
            jsonBody: {
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
            context.log('trimVideo no segments detected', { blobUrl, options });
            return { status: 422, jsonBody: { error: 'No motion segments detected. Try lowering the threshold.', segments: [] } };
        }
        if (error instanceof VideoDownloadError) {
            const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
            context.log('trimVideo video download error', { blobUrl, statusCode, message: error.message });
            return { status: statusCode, jsonBody: { error: error.message } };
        }
        context.log('trimVideo function error', error);
        return { status: 500, jsonBody: { error: 'Failed to trim video' } };
    }
}

app.http('videoTimeTrim', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'trim-video',
    handler: videoTimeTrim,
});
