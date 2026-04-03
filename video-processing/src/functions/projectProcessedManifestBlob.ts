import { app, EventGridEvent, InvocationContext } from '@azure/functions';
import { downloadBlobAsString, parseBlobUrl } from '../services/blobUtils';
import {
  CosmosReadModelStore,
  getCosmosReadModelStore,
  PlayerManifestProjection,
  PlayDescriptionsProjection,
} from '../services/cosmosReadModelStore';

type BlobCreatedEventData = {
  url?: string;
};

type BlobRenamedEventData = {
  destinationUrl?: string;
};

function getBlobUrl(event: EventGridEvent): string {
  if (event.eventType === 'Microsoft.Storage.BlobRenamed') {
    const data = event.data as BlobRenamedEventData;
    if (!data.destinationUrl) {
      throw new Error('EventGrid blob-renamed event is missing data.destinationUrl');
    }

    return data.destinationUrl;
  }

  const data = event.data as BlobCreatedEventData;
  if (!data.url) {
    throw new Error('EventGrid blob-created event is missing data.url');
  }

  return data.url;
}

function isPlayerManifest(blobName: string): boolean {
  return blobName.startsWith('processed/') && blobName.endsWith('/players/manifest.json');
}

function isPlayManifest(blobName: string): boolean {
  return blobName.startsWith('processed/') && blobName.endsWith('/plays/manifest.json');
}

function getRecordIdFromManifestPath(blobName: string): string {
  const parts = blobName.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'processed') {
    throw new Error(`Unexpected manifest blob path: ${blobName}`);
  }

  return parts[1];
}

async function projectPlayerManifest(
  store: CosmosReadModelStore,
  blobUrl: string,
  context: InvocationContext,
): Promise<void> {
  const blob = parseBlobUrl(blobUrl);
  const manifest = JSON.parse(await downloadBlobAsString(blob)) as PlayerManifestProjection;
  const recordId = getRecordIdFromManifestPath(blob.blobName);

  if (manifest.recordId && manifest.recordId !== recordId) {
    throw new Error(`Player manifest recordId mismatch for ${blob.blobName}`);
  }

  await store.replacePlayerManifest({
    ...manifest,
    recordId,
  });

  context.log('projectProcessedManifestBlob projected player manifest', {
    recordId,
    playerCount: manifest.players.length,
    blobName: blob.blobName,
  });
}

async function projectPlayManifest(
  store: CosmosReadModelStore,
  blobUrl: string,
  context: InvocationContext,
): Promise<void> {
  const blob = parseBlobUrl(blobUrl);
  const manifest = JSON.parse(await downloadBlobAsString(blob)) as PlayDescriptionsProjection;
  const recordId = getRecordIdFromManifestPath(blob.blobName);

  if (manifest.recordId && manifest.recordId !== recordId) {
    throw new Error(`Play manifest recordId mismatch for ${blob.blobName}`);
  }

  await store.replacePlayDescriptions({
    ...manifest,
    recordId,
  });

  context.log('projectProcessedManifestBlob projected play manifest', {
    recordId,
    playCount: manifest.playCount,
    blobName: blob.blobName,
  });
}

export async function projectProcessedManifestBlobHandler(event: EventGridEvent, context: InvocationContext): Promise<void> {
  const store = getCosmosReadModelStore(context.log);
  if (!store) {
    context.log('projectProcessedManifestBlob skipped because Cosmos DB is not configured.');
    return;
  }

  const blobUrl = getBlobUrl(event);
  const blob = parseBlobUrl(blobUrl);

  if (isPlayerManifest(blob.blobName)) {
    await projectPlayerManifest(store, blobUrl, context);
    return;
  }

  if (isPlayManifest(blob.blobName)) {
    await projectPlayManifest(store, blobUrl, context);
    return;
  }

  context.log('projectProcessedManifestBlob skipping non-manifest blob', {
    blobName: blob.blobName,
    eventType: event.eventType,
  });
}

app.eventGrid('projectProcessedManifestBlob', {
  handler: projectProcessedManifestBlobHandler,
});
