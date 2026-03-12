import { app, EventGridEvent, InvocationContext } from "@azure/functions";
import { BlobServiceClient } from '@azure/storage-blob';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { createVideoStorage } from '../services/storageProvider';
import { detectPlayers, PlayerDetectorOptions } from '../services/playerDetector';

const PROCESSED_PREFIX = 'processed/';

const storage = createVideoStorage({ baseDir: path.join(os.tmpdir(), 'va-function-detections') });

export async function detectPlayersHandler(event: EventGridEvent, context: InvocationContext): Promise<void> {
    const data = event.data as { url: string };
    const blobUrl = data.url;
    const urlPath = new URL(blobUrl).pathname;

    // Only process blobs from the processed/ folder (trimmed videos)
    if (!urlPath.includes(`/${PROCESSED_PREFIX}`)) {
        context.log('detectPlayers skipping non-processed blob', { blobUrl });
        return;
    }

    const blobName = path.basename(urlPath);
    context.log('detectPlayers triggered by EventGrid', { blobName, eventType: event.eventType, blobUrl });

    const connectionString = process.env.AzureWebJobsStorage;
    if (!connectionString) {
        throw new Error('AzureWebJobsStorage connection string not configured');
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const segments = urlPath.split('/').filter(Boolean);
    const containerName = segments[0];
    const blobPath = segments.slice(1).join('/');
    const blob = await blobServiceClient
        .getContainerClient(containerName)
        .getBlobClient(blobPath)
        .downloadToBuffer();

    context.log('detectPlayers downloaded blob', { blobName, size: blob.length });

    const tmpDir = path.join(os.tmpdir(), 'va-function-detections', 'inputs');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpInputPath = path.join(tmpDir, `${randomUUID()}-${blobName}`);

    try {
        fs.writeFileSync(tmpInputPath, blob);
        context.log('detectPlayers wrote blob to temp file', { tmpInputPath });

        const options: PlayerDetectorOptions = {
            sampleFps: 2,
            confidence: 0.5,
            numTeams: 2,
        };

        context.log('detectPlayers starting detection', { blobName, options });

        const detectionDir = storage.getLocalDetectionDir();
        const result = await detectPlayers(
            tmpInputPath,
            detectionDir,
            options,
            (msg, ...args) => context.log(msg, ...args),
        );

        // Save detection JSON to blob storage
        const detectionFilename = blobName.replace(/\.[^.]+$/, '') + '-detection.json';
        const detectionJsonPath = path.join(detectionDir, detectionFilename);
        fs.writeFileSync(detectionJsonPath, JSON.stringify(result, null, 2));

        const stored = await storage.saveDetection(detectionJsonPath, detectionFilename);

        context.log('detectPlayers succeeded', {
            teams: result.teams.length,
            tracks: result.tracks.length,
            sampledFrames: result.sampledFrames,
            detectionUrl: stored.url,
        });

        // Clean up the intermediate JSON file if it differs from stored location
        if (fs.existsSync(detectionJsonPath) && path.resolve(detectionJsonPath) !== path.resolve(stored.url)) {
            try { fs.unlinkSync(detectionJsonPath); } catch { /* ignore */ }
        }
    } catch (error) {
        context.log('detectPlayers function error', error);
        throw error;
    } finally {
        if (fs.existsSync(tmpInputPath)) {
            try {
                fs.unlinkSync(tmpInputPath);
            } catch (cleanupErr) {
                context.log('detectPlayers failed to clean up temp file', cleanupErr);
            }
        }
    }
}

app.eventGrid('detectPlayersBlob', {
    handler: detectPlayersHandler,
});
