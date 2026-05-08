'use strict';
const db = require('../db');
const { getSetting } = require('../db');
const { logError } = require('../utils/log-error');

/**
 * 选出当前用户负载最低的在线 VPS。
 * 负载指标：tasks 表中 status IN ('running','source_retrying','target_lost','stalled','restarting') 的任务数。
 * 不考虑 CPU/内存（未持久化到 DB）。
 *
 * @param {number} userId
 * @returns {{ id: number, name: string } | null}
 *   成功返回 { id, name }；无可用 VPS 时返回 null（调用方负责抛出友好错误）
 */
function selectBestVps(userId) {
  try {
    const maxPerVps = parseInt(getSetting('max_tasks_per_vps', userId) || '5');

    const row = db.prepare(`
      SELECT v.id, v.name,
        COUNT(t.id) AS running_count
      FROM vps v
      LEFT JOIN tasks t
        ON t.vps_id = v.id
       AND t.user_id = v.user_id
       AND t.status IN ('running', 'source_retrying', 'target_lost', 'stalled', 'restarting')
      WHERE v.user_id = ?
        AND v.status = 'online'
      GROUP BY v.id
      HAVING COUNT(t.id) < ?
      ORDER BY running_count ASC, v.id ASC
      LIMIT 1
    `).get(userId, maxPerVps);

    return row ? { id: row.id, name: row.name } : null;
  } catch (err) {
    logError('selectBestVps', err);
    return null;
  }
}

module.exports = { selectBestVps };
