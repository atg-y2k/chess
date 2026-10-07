import { describe, expect, it } from 'vitest';
import { openingBannerOf, shortStatus } from '../../src/ui/OpeningBanner';

describe('OpeningBanner helpers', () => {
  it('reads the banner from the coach action label (name, status, tone)', () => {
    expect(openingBannerOf('Italian Game\tMove 3 of 5\ton')).toEqual({ name: 'Italian Game', status: 'Move 3 of 5', tone: 'on' });
    expect(openingBannerOf('Italian Game\tLine complete\tdone')?.tone).toBe('done');
    expect(openingBannerOf('Italian Game\tLeft at 2. Nc3\toff')?.tone).toBe('off');
    expect(openingBannerOf('Italian Game\tMove 1 of 3')?.tone).toBe('on');
    expect(openingBannerOf('Italian Game')).toBeNull();
  });

  it('shortens the status for a narrow column', () => {
    expect(shortStatus('Move 3 of 5')).toBe('3 of 5');
    expect(shortStatus('Line complete')).toBe('Complete');
    expect(shortStatus('Left at 2. Nc3')).toBe('Left at 2. Nc3');
  });
});
