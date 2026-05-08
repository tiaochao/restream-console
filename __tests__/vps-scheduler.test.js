'use strict';

// Mock db 模块，在 require vps-scheduler 之前
jest.mock('../db', () => {
  const mockGet = jest.fn();
  const mockPrepare = jest.fn(() => ({ get: mockGet }));
  return {
    prepare: mockPrepare,
    getSetting: jest.fn(),
    __mockGet: mockGet,
    __mockPrepare: mockPrepare,
  };
});

const db = require('../db');
const { selectBestVps } = require('../services/vps-scheduler');

beforeEach(() => {
  jest.clearAllMocks();
  // 默认 max_tasks_per_vps = 5
  db.getSetting.mockReturnValue('5');
});

describe('selectBestVps', () => {
  test('有一个在线 VPS 且无运行任务时，返回该 VPS', () => {
    db.__mockGet.mockReturnValue({ id: 1, name: 'VPS-A', running_count: 0 });
    const result = selectBestVps(1);
    expect(result).toEqual({ id: 1, name: 'VPS-A' });
  });

  test('有两个在线 VPS，返回任务数更少的那个', () => {
    // SQL 层已排序，mock 直接返回胜者
    db.__mockGet.mockReturnValue({ id: 2, name: 'VPS-B', running_count: 1 });
    const result = selectBestVps(1);
    expect(result).toEqual({ id: 2, name: 'VPS-B' });
  });

  test('无在线 VPS 时返回 null', () => {
    db.__mockGet.mockReturnValue(undefined);
    const result = selectBestVps(1);
    expect(result).toBeNull();
  });

  test('VPS 已达上限时返回 null', () => {
    db.getSetting.mockReturnValue('2');
    db.__mockGet.mockReturnValue(undefined); // HAVING 过滤后无结果
    const result = selectBestVps(1);
    expect(result).toBeNull();
  });

  test('两个 VPS 任务数相同时返回 id 较小的', () => {
    // SQL ORDER BY v.id ASC，mock 返回 id=1 的 VPS
    db.__mockGet.mockReturnValue({ id: 1, name: 'VPS-A', running_count: 0 });
    const result = selectBestVps(1);
    expect(result).toEqual({ id: 1, name: 'VPS-A' });
  });

  test('db 查询抛出异常时返回 null 不崩溃', () => {
    db.__mockPrepare.mockImplementation(() => {
      throw new Error('DB error');
    });
    const result = selectBestVps(1);
    expect(result).toBeNull();
  });

  test('调用 getSetting 时传入正确的 userId', () => {
    db.__mockGet.mockReturnValue(null);
    selectBestVps(42);
    // getSetting 第二个参数应为 userId
    expect(db.getSetting).toHaveBeenCalledWith('max_tasks_per_vps', 42);
  });
});
