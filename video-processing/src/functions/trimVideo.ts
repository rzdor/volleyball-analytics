import { app, InvocationContext } from "@azure/functions";

export async function trimVideo(blob: Buffer, context: InvocationContext): Promise<void> {
    context.log(`Storage blob function processed blob "${context.triggerMetadata.name}" with size ${blob.length} bytes`);
}

app.storageBlob('trimVideo', {
    path: 'video/input',
    connection: 'volleyballproject_STORAGE',
    handler: trimVideo
});
