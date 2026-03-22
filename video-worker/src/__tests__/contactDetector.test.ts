import { inferPlayerBallContacts } from '../services/contactDetector';
import { DetectionResult } from '../services/playerDetector';

describe('contactDetector', () => {
  it('finds ordered player-ball contacts and de-duplicates repeated same-player frames', () => {
    const result: DetectionResult = {
      videoName: 'sample.mp4',
      processedAt: '2026-03-22T00:00:00Z',
      sampleFps: 2,
      videoFps: 30,
      totalVideoFrames: 120,
      sampledFrames: 3,
      teams: [],
      frames: [
        {
          frameIndex: 0,
          timestamp: 0,
          balls: [{ bbox: { x: 102, y: 96, w: 20, h: 20 }, confidence: 0.9 }],
          players: [
            { trackId: 10, teamId: 0, teamSide: 'main', bbox: { x: 90, y: 100, w: 60, h: 120 }, confidence: 0.95 },
          ],
        },
        {
          frameIndex: 15,
          timestamp: 0.3,
          balls: [{ bbox: { x: 105, y: 94, w: 20, h: 20 }, confidence: 0.91 }],
          players: [
            { trackId: 10, teamId: 0, teamSide: 'main', bbox: { x: 90, y: 100, w: 60, h: 120 }, confidence: 0.96 },
          ],
        },
        {
          frameIndex: 30,
          timestamp: 0.8,
          balls: [{ bbox: { x: 305, y: 85, w: 20, h: 20 }, confidence: 0.88 }],
          players: [
            { trackId: 10, teamId: 0, teamSide: 'main', bbox: { x: 90, y: 100, w: 60, h: 120 }, confidence: 0.9 },
            { trackId: 11, teamId: 1, teamSide: 'opponent', bbox: { x: 280, y: 90, w: 70, h: 110 }, confidence: 0.94 },
          ],
        },
      ],
      tracks: [],
    };

    const contacts = inferPlayerBallContacts(result);

    expect(contacts).toHaveLength(2);
    expect(contacts[0].playerTrackId).toBe(10);
    expect(contacts[1].playerTrackId).toBe(11);
    expect(contacts[1].teamSide).toBe('opponent');
  });
});
