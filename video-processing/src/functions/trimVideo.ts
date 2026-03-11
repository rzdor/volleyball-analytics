import { app, EventGridEvent, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { BlobServiceClient } from '@azure/storage-blob';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { MotionDetectorOptions } from '../services/motionDetector';
import { createVideoStorage } from '../services/storageProvider';
import { NoSegmentsDetectedError, runTrimPipeline } from '../services/trimPipeline';


const storage = createVideoStorage({ baseDir: path.join(os.tmpdir(), 'va-function-uploads') });

export async function testrequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`Http function processed request for url "${request.url}"`);

    const name = request.query.get('name') || await request.text() || 'world';

    return { body: `Hello, ${name}!` };
};

export async function trimVideo(event: EventGridEvent, context: InvocationContext): Promise<void> {
    const data = event.data as { url: string };
    const blobUrl = data.url;
    const blobName = path.basename(new URL(blobUrl).pathname);

    context.log('trimVideo triggered by EventGrid', { blobName, eventType: event.eventType, blobUrl });

    const connectionString = process.env.AzureWebJobsStorage;
    if (!connectionString) {
        throw new Error('AzureWebJobsStorage connection string not configured');
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const urlPath = new URL(blobUrl).pathname;
    const segments = urlPath.split('/').filter(Boolean);
    const containerName = segments[0];
    const blobPath = segments.slice(1).join('/');
    const blob = await blobServiceClient
        .getContainerClient(containerName)
        .getBlobClient(blobPath)
        .downloadToBuffer();

    context.log('trimVideo downloaded blob', { blobName, size: blob.length });

    const tmpDir = path.join(os.tmpdir(), 'va-function-uploads', 'inputs');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpInputPath = path.join(tmpDir, `${randomUUID()}-${blobName}`);

    try {
        fs.writeFileSync(tmpInputPath, blob);
        context.log('trimVideo wrote blob to temp file', { tmpInputPath });

        const options: MotionDetectorOptions = {
            sampleFps: 2,
            threshold: 0.01,
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

app.eventGrid('trimVideoBlob', {
    handler: trimVideo
});
