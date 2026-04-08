import {
  DEFAULT_MOTION_SAMPLE_FPS,
  DEFAULT_MOTION_THRESHOLD,
} from '../services/motionDetector';

describe('motionDetector defaults', () => {
  it('uses the tuned trim worker defaults', () => {
    expect(DEFAULT_MOTION_SAMPLE_FPS).toBe(5);
    expect(DEFAULT_MOTION_THRESHOLD).toBe(0.005);
  });
});
