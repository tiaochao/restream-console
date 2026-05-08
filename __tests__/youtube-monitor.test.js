const {
  classifyApiError,
  extractYouTubeVideoId,
  extractYouTubeChannelRef,
  keyFingerprint,
} = require('../services/youtube-monitor');

describe('classifyApiError', () => {
  test('quota exceeded by reason', () => {
    expect(classifyApiError({ reason: 'quotaExceeded' })).toBe('quota');
    expect(classifyApiError({ reason: 'dailyLimitExceeded' })).toBe('quota');
  });
  test('quota exceeded by message', () => {
    expect(classifyApiError({ message: 'quota exceeded' })).toBe('quota');
    expect(classifyApiError({ message: 'daily limit exceeded' })).toBe('quota');
  });
  test('rate limited', () => {
    expect(classifyApiError({ reason: 'rateLimitExceeded' })).toBe('rate_limited');
    expect(classifyApiError({ message: 'rate limit reached' })).toBe('rate_limited');
  });
  test('invalid key', () => {
    expect(classifyApiError({ reason: 'keyInvalid' })).toBe('invalid');
    expect(classifyApiError({ reason: 'API_KEY_INVALID' })).toBe('invalid');
    expect(classifyApiError({ message: 'API key not valid' })).toBe('invalid');
  });
  test('forbidden', () => {
    expect(classifyApiError({ reason: 'PERMISSION_DENIED' })).toBe('forbidden');
    expect(classifyApiError({ message: 'forbidden access' })).toBe('forbidden');
  });
  test('unknown error returns error', () => {
    expect(classifyApiError({ message: 'some unknown error' })).toBe('error');
    expect(classifyApiError({})).toBe('error');
    expect(classifyApiError(null)).toBe('error');
  });
});

describe('extractYouTubeVideoId', () => {
  test('standard watch URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractYouTubeVideoId('https://youtube.com/watch?v=abc123xyz')).toBe('abc123xyz');
  });
  test('short youtu.be URL', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  test('live URL', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  test('invalid URL returns empty string', () => {
    expect(extractYouTubeVideoId('not-a-url')).toBe('');
    expect(extractYouTubeVideoId('')).toBe('');
    expect(extractYouTubeVideoId('https://example.com')).toBe('');
  });
});

describe('extractYouTubeChannelRef', () => {
  test('channel ID URL', () => {
    const result = extractYouTubeChannelRef('https://www.youtube.com/channel/UCxxxxxx');
    expect(result).toHaveProperty('channelId', 'UCxxxxxx');
  });
  test('handle URL with @', () => {
    const result = extractYouTubeChannelRef('https://www.youtube.com/@TestChannel');
    expect(result).toHaveProperty('handle', 'TestChannel');
  });
  test('non-YouTube URL returns empty object', () => {
    expect(extractYouTubeChannelRef('https://example.com')).toEqual({});
    expect(extractYouTubeChannelRef('')).toEqual({});
  });
});

describe('keyFingerprint', () => {
  test('returns consistent string for same key', () => {
    const key = 'AIzaSyAbcdefghijklmnopqrstuvwxyz1234567';
    expect(keyFingerprint(key)).toBe(keyFingerprint(key));
    expect(typeof keyFingerprint(key)).toBe('string');
    expect(keyFingerprint(key).length).toBeGreaterThan(0);
  });
  test('different keys produce different fingerprints', () => {
    expect(keyFingerprint('key-one')).not.toBe(keyFingerprint('key-two'));
  });
});
