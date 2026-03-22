import { buildPlayDescriptionsManifest, buildPlaySceneManifest } from '../services/playDescriptions';

describe('playDescriptions', () => {
  it('builds play manifests with contacted players grouped by play boundaries', () => {
    const sceneManifest = buildPlaySceneManifest({
      recordId: 'record-1',
      sourceVideoBlobName: 'input/video.mp4',
      processedBlobName: 'processed/record-1/video-trimmed.mp4',
      segments: [
        { start: 2, end: 5 },
        { start: 10, end: 14 },
      ],
      storedScenes: [
        { name: 'record-1/video-trimmed-scene-001.mp4', url: 'https://example.test/1' },
        { name: 'record-1/video-trimmed-scene-002.mp4', url: 'https://example.test/2' },
      ],
    });

    const manifest = buildPlayDescriptionsManifest({
      recordId: 'record-1',
      sourceVideoBlobName: 'input/video.mp4',
      processedBlobName: 'processed/record-1/video-trimmed.mp4',
      sceneManifest,
      contactEvents: [
        { playerTrackId: 5, teamId: 0, teamSide: 'main', frameIndex: 10, timestamp: 1, distanceToBallPx: 4, ballConfidence: 0.8 },
        { playerTrackId: 12, teamId: 1, teamSide: 'opponent', frameIndex: 40, timestamp: 4.5, distanceToBallPx: 3, ballConfidence: 0.82 },
      ],
    });

    expect(manifest.playCount).toBe(2);
    expect(manifest.plays[0].contactedPlayers.map(player => player.trackId)).toEqual([5]);
    expect(manifest.plays[1].contactedPlayers.map(player => player.trackId)).toEqual([12]);
    expect(manifest.plays[0].trimmedStartSeconds).toBe(0);
    expect(manifest.plays[1].trimmedStartSeconds).toBe(3);
  });
});
