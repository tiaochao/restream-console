const taskManager = require('../services/task-manager');

const BASE_TASK = {
  id: 99999,
  user_id: 1,
  name: 'Jest 测试任务',
  platform: 'youtube',
  source_url: 'https://live.douyin.com/test-room-jest',
  backup_urls: '',
  rtmp_url: 'rtmp://test.invalid/live',
  stream_key: 'jest-test-key',
};

describe('_buildCommand', () => {
  test('returns object with cmd and logFile', () => {
    const result = taskManager._buildCommand(BASE_TASK);
    expect(result).toHaveProperty('cmd');
    expect(result).toHaveProperty('logFile');
    expect(typeof result.cmd).toBe('string');
    expect(typeof result.logFile).toBe('string');
  });

  test('cmd is non-empty string', () => {
    const { cmd } = taskManager._buildCommand(BASE_TASK);
    expect(cmd.length).toBeGreaterThan(0);
  });

  test('logFile references task id', () => {
    const { logFile } = taskManager._buildCommand(BASE_TASK);
    expect(logFile).toContain(String(BASE_TASK.id));
  });

  test('cmd references task id', () => {
    const { cmd } = taskManager._buildCommand(BASE_TASK);
    expect(cmd).toContain(String(BASE_TASK.id));
  });

  test('different tasks produce different logFiles', () => {
    const task2 = { ...BASE_TASK, id: 88888 };
    const r1 = taskManager._buildCommand(BASE_TASK);
    const r2 = taskManager._buildCommand(task2);
    expect(r1.logFile).not.toBe(r2.logFile);
  });
});

describe('exported functions', () => {
  test('startTaskQueued is exported and is a function', () => {
    expect(typeof taskManager.startTaskQueued).toBe('function');
  });
  test('stopTask is exported and is a function', () => {
    expect(typeof taskManager.stopTask).toBe('function');
  });
  test('checkHealth is exported and is a function', () => {
    expect(typeof taskManager.checkHealth).toBe('function');
  });
  test('startMonitor is exported and is a function', () => {
    expect(typeof taskManager.startMonitor).toBe('function');
  });
});

describe('checkHealth early return', () => {
  test('returns undefined for task without remote_pid', async () => {
    const result = await taskManager.checkHealth({ id: 1, remote_pid: null, vps_id: 1 });
    expect(result).toBeUndefined();
  });
  test('returns undefined for task without vps_id', async () => {
    const result = await taskManager.checkHealth({ id: 1, remote_pid: 12345, vps_id: null });
    expect(result).toBeUndefined();
  });
});
