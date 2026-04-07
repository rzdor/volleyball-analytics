import { buildServeTimeline, createServeReviewOverride, ServeReviewManifest } from '../services/serveReview';

describe('serveReview', () => {
  const playerManifest = {
    recordId: 'record-1',
    generatedAt: '2026-04-07T00:00:00.000Z',
    sourceVideoBlobName: 'input/video.mp4',
    processedBlobName: 'processed/record-1/video-trimmed.mp4',
    players: [
      {
        trackId: 7,
        teamId: 0,
        teamSide: 'main' as const,
        frameCount: 40,
        avgConfidence: 0.88,
        displayName: 'Alex',
        imageBlobName: 'processed/record-1/players/track-0007.jpg',
      },
      {
        trackId: 9,
        teamId: 1,
        teamSide: 'opponent' as const,
        frameCount: 32,
        avgConfidence: 0.82,
        displayName: 'Blake',
      },
    ],
  };

  const playDescriptions = {
    recordId: 'record-1',
    generatedAt: '2026-04-07T00:00:00.000Z',
    sourceVideoBlobName: 'input/video.mp4',
    processedBlobName: 'processed/record-1/video-trimmed.mp4',
    playCount: 2,
    plays: [
      {
        playIndex: 1,
        sourceStartSeconds: 12,
        sourceEndSeconds: 18,
        trimmedStartSeconds: 0,
        trimmedEndSeconds: 6,
        sceneBlobName: 'processed/record-1/scene-001.mp4',
        contactedPlayers: [],
        contacts: [
          {
            playerTrackId: 7,
            teamId: 0,
            teamSide: 'main' as const,
            frameIndex: 10,
            timestamp: 0.4,
            distanceToBallPx: 6,
            ballConfidence: 0.91,
            actionType: 'serve' as const,
            actionConfidence: 0.9,
            actionReason: 'Detected serve',
          },
          {
            playerTrackId: 9,
            teamId: 1,
            teamSide: 'opponent' as const,
            frameIndex: 25,
            timestamp: 1.2,
            distanceToBallPx: 5,
            ballConfidence: 0.88,
            actionType: 'pass' as const,
          },
        ],
      },
      {
        playIndex: 2,
        sourceStartSeconds: 20,
        sourceEndSeconds: 28,
        trimmedStartSeconds: 6,
        trimmedEndSeconds: 14,
        sceneBlobName: 'processed/record-1/scene-002.mp4',
        contactedPlayers: [],
        contacts: [
          {
            playerTrackId: 9,
            teamId: 1,
            teamSide: 'opponent' as const,
            frameIndex: 55,
            timestamp: 6.6,
            distanceToBallPx: 7,
            ballConfidence: 0.84,
            actionType: 'pass' as const,
            actionConfidence: 0.45,
            actionReason: 'First contact without serve signal',
          },
        ],
      },
    ],
  };

  it('derives detected serves and maps them to source timestamps', () => {
    const timeline = buildServeTimeline({
      playerManifest,
      playDescriptions,
    });

    expect(timeline.summary.activeServeCount).toBe(1);
    expect(timeline.summary.detectedServeCount).toBe(1);
    expect(timeline.summary.missingServeCount).toBe(1);
    expect(timeline.serves).toHaveLength(1);
    expect(timeline.serves[0]).toMatchObject({
      playIndex: 1,
      playerTrackId: 7,
      displayName: 'Alex',
      trimmedTimestamp: 0.4,
      sourceTimestamp: 12.4,
      reviewStatus: 'detected',
    });
  });

  it('applies corrected reviews and dismissals on top of detected serves', () => {
    const correctedReview = createServeReviewOverride(playDescriptions.plays[1], 0, '2026-04-07T01:00:00.000Z');
    const reviewManifest: ServeReviewManifest = {
      recordId: 'record-1',
      updatedAt: '2026-04-07T01:00:00.000Z',
      plays: [
        {
          playIndex: 1,
          dismissed: true,
          updatedAt: '2026-04-07T01:00:00.000Z',
        },
        correctedReview!,
      ],
    };

    const timeline = buildServeTimeline({
      playerManifest,
      playDescriptions,
      reviewManifest,
    });

    expect(timeline.summary.activeServeCount).toBe(1);
    expect(timeline.summary.correctedServeCount).toBe(1);
    expect(timeline.summary.dismissedServeCount).toBe(1);
    expect(timeline.summary.reviewedPlayCount).toBe(2);
    expect(timeline.plays[0].reviewStatus).toBe('dismissed');
    expect(timeline.plays[0].serve).toBeUndefined();
    expect(timeline.plays[1].serve).toMatchObject({
      playIndex: 2,
      playerTrackId: 9,
      trimmedTimestamp: 6.6,
      sourceTimestamp: 20.6,
      reviewStatus: 'corrected',
    });
  });

  it('keeps a corrected serve even if the saved contact no longer matches a contact option', () => {
    const reviewManifest: ServeReviewManifest = {
      recordId: 'record-1',
      updatedAt: '2026-04-07T01:00:00.000Z',
      plays: [
        {
          playIndex: 2,
          updatedAt: '2026-04-07T01:00:00.000Z',
          serve: {
            playerTrackId: 7,
            teamId: 0,
            teamSide: 'main',
            frameIndex: 999,
            trimmedTimestamp: 6.25,
            sourceTimestamp: 20.25,
          },
        },
      ],
    };

    const timeline = buildServeTimeline({
      playerManifest,
      playDescriptions,
      reviewManifest,
    });

    expect(timeline.plays[1].reviewStatus).toBe('corrected');
    expect(timeline.plays[1].selectedContactIndex).toBeUndefined();
    expect(timeline.plays[1].serve).toMatchObject({
      playerTrackId: 7,
      displayName: 'Alex',
      trimmedTimestamp: 6.25,
      sourceTimestamp: 20.25,
      reviewStatus: 'corrected',
    });
  });
});
