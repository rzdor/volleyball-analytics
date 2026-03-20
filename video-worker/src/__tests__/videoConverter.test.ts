import { shouldConvertTo720p, TARGET_CONVERT_HEIGHT } from '../services/videoConverter';

describe('videoConverter conversion threshold', () => {
  it('triggers conversion only when the source height is above 720p', () => {
    expect(shouldConvertTo720p(TARGET_CONVERT_HEIGHT - 1)).toBe(false);
    expect(shouldConvertTo720p(TARGET_CONVERT_HEIGHT)).toBe(false);
    expect(shouldConvertTo720p(TARGET_CONVERT_HEIGHT + 1)).toBe(true);
  });
});
