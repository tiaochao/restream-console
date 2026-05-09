const { parseHealthResult, evaluateHealth } = require('../services/task-state');

const BASE_TASK = {
  id: 78,
  name: '[Auto] Test Host',
  status: 'running',
  source_url: 'https://live.douyin.com/123456',
  rtmp_url: 'rtmp://a.rtmp.youtube.com/live2',
  platform: 'youtube',
  auto_restart: 1,
  stall_count: 0,
};

describe('task-state fallback health', () => {
  test('does not restart when background fallback process is alive', () => {
    const now = 1000;
    const parsed = parseHealthResult(BASE_TASK, [
      'alive',
      '990',
      '{"state":"idle","source":"unknown","target":"unknown","fallback":false,"bg_pid":456}',
      'bg_fallback_alive',
      'no_rtmp',
    ], now, 120);

    expect(parsed.isFallbackActive).toBe(true);
    expect(parsed.hasHealthyFrameAfterErrors).toBe(true);

    const effect = evaluateHealth(BASE_TASK, parsed, { blockLimit: 8 });
    expect(effect.requiresRestart).toBe(false);
    expect(effect.requiresStop).toBe(false);
  });

  test('keeps stale fallback task running instead of marking error', () => {
    const now = 1000;
    const parsed = parseHealthResult(BASE_TASK, [
      'alive',
      '700',
      '{"state":"fallback","source":"live","target":"unknown","fallback":true,"bg_pid":456}',
      'bg_fallback_alive',
      'no_rtmp',
    ], now, 120);

    const effect = evaluateHealth(BASE_TASK, parsed, { blockLimit: 8 });
    expect(effect.action).toBe('setRunning');
    expect(effect.requiresRestart).toBe(false);
    expect(effect.requiresStop).toBe(false);
  });

  test('keeps running when wrapper died but background fallback is alive', () => {
    const now = 1000;
    const parsed = parseHealthResult(BASE_TASK, [
      'dead',
      '700',
      '{"state":"idle","source":"unknown","target":"unknown","fallback":false,"bg_pid":456}',
      'bg_fallback_alive',
      'no_rtmp',
    ], now, 120);

    expect(parsed.isFallbackActive).toBe(true);

    const effect = evaluateHealth(BASE_TASK, parsed, { blockLimit: 8 });
    expect(effect.action).toBe('setRunning');
    expect(effect.requiresRestart).toBe(false);
    expect(effect.requiresStop).toBe(false);
  });

  test('cleans stale sessions before restarting a dead process', () => {
    const now = 1000;
    const parsed = parseHealthResult(BASE_TASK, [
      'dead',
      '990',
      '{"state":"streaming","source":"live","target":"ok","fallback":false}',
      'bg_fallback_dead',
      'no_rtmp',
    ], now, 120);

    const effect = evaluateHealth(BASE_TASK, parsed, { blockLimit: 8 });
    expect(effect.requiresRestart).toBe(true);
    expect(effect.requiresStop).toBe(true);
  });
});
