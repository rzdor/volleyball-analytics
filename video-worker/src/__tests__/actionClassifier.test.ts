import { classifyPlayContacts } from '../services/actionClassifier';

describe('actionClassifier', () => {
  it('classifies a simple serve-pass-set-attack rally', () => {
    const contacts = classifyPlayContacts({
      trimmedStartSeconds: 0,
      contacts: [
        {
          playerTrackId: 1,
          teamId: 0,
          teamSide: 'main',
          frameIndex: 0,
          timestamp: 0.2,
          distanceToBallPx: 4,
          ballConfidence: 0.9,
        },
        {
          playerTrackId: 9,
          teamId: 1,
          teamSide: 'opponent',
          frameIndex: 12,
          timestamp: 1.1,
          distanceToBallPx: 6,
          ballConfidence: 0.88,
        },
        {
          playerTrackId: 10,
          teamId: 1,
          teamSide: 'opponent',
          frameIndex: 20,
          timestamp: 1.8,
          distanceToBallPx: 5,
          ballConfidence: 0.86,
        },
        {
          playerTrackId: 11,
          teamId: 1,
          teamSide: 'opponent',
          frameIndex: 28,
          timestamp: 2.4,
          distanceToBallPx: 4,
          ballConfidence: 0.87,
        },
      ],
    });

    expect(contacts.map(contact => contact.actionType)).toEqual(['serve', 'pass', 'set', 'attack']);
    expect(contacts[2].actionReason).toContain('Same-team follow-up');
  });
});
