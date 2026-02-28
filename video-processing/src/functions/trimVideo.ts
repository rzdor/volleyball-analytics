import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { MotionDetectorOptions } from '../services/motionDetector';
import { createVideoStorage } from '../services/storageProvider';
import { NoSegmentsDetectedError, runTrimPipeline } from '../services/trimPipeline';

const storage = createVideoStorage({ baseDir: path.join(os.tmpdir(), 'va-function-uploads') });

export async function trimVideo(blob: Buffer, context: InvocationContext): Promise<void> {
    const blobName = (context.triggerMetadata?.name as string) ?? `video-${randomUUID()}`;

    context.log('trimVideo triggered', { blobName, size: blob.length });

    const tmpDir = path.join(os.tmpdir(), 'va-function-uploads', 'inputs');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpInputPath = path.join(tmpDir, `${randomUUID()}-${blobName}`);

    try {
        fs.writeFileSync(tmpInputPath, blob);
        context.log('trimVideo wrote blob to temp file', { tmpInputPath });

        const options: MotionDetectorOptions = {
            sampleFps: 2,
            threshold: 0.02,
            minSegmentLength: 3,
            preRoll: 1,
            postRoll: 1,
            smoothingWindow: 3,
        };

        context.log('trimVideo starting pipeline', { blobName, options });

        const result = await runTrimPipeline({
            videoPath: tmpInputPath,
            storage,
            motionOptions: options,
        });

        context.log('trimVideo pipeline succeeded', {
            totalSegments: result.segments.length,
            outputName: result.storedOutput.name,
            outputUrl: result.storedOutput.url,
        });
    } catch (error) {
        if (error instanceof NoSegmentsDetectedError) {
            context.log('trimVideo no segments detected', { blobName });
            return;
        }
        context.log('trimVideo function error', error);
        throw error;
    } finally {
        if (fs.existsSync(tmpInputPath)) {
            try {
                fs.unlinkSync(tmpInputPath);
            } catch (cleanupErr) {
                context.log('trimVideo failed to clean up temp file', cleanupErr);
            }
        }
    }
}

export async function testrequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`Http function processed request for url "${request.url}"`);

    const name = request.query.get('name') || await request.text() || 'world';

    return { body: `Hello, ${name}!` };
};

app.http('testrequest1', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: testrequest
});
