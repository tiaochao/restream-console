const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const jsFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    if (entry.isFile() && entry.name.endsWith('.js')) jsFiles.push(full);
  }
}

walk(root);

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

require('../db');

[
  'middleware/auth',
  'middleware/csrf',
  'routes/auth',
  'routes/admin',
  'routes/channels',
  'routes/dashboard',
  'routes/logs',
  'routes/media',
  'routes/settings',
  'routes/stream-keys',
  'routes/tasks',
  'routes/vps',
  'services/ssh',
  'services/platform-api',
  'services/task-manager',
  'services/live-monitor',
  'services/youtube-monitor',
].forEach(mod => require(path.join(root, mod)));

function assertContains(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`录播兜底脚本检查失败：缺少 ${label}`);
  }
}

function assertNotContains(text, needle, label) {
  if (text.includes(needle)) {
    throw new Error(`录播兜底脚本检查失败：不应包含 ${label}`);
  }
}

function decodeTaskScript(cmd) {
  const match = cmd.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/);
  if (!match) throw new Error('录播兜底脚本检查失败：无法提取任务脚本');
  return Buffer.from(match[1], 'base64').toString('utf8');
}

const taskManager = require(path.join(root, 'services/task-manager'));
const generated = taskManager._buildCommand({
  id: 900001,
  user_id: 1,
  name: '[Auto] 测试主播',
  platform: 'youtube',
  source_url: 'https://live.douyin.com/test-room',
  backup_urls: 'https://live.douyin.com/test-backup',
  rtmp_url: 'rtmp://example.invalid/live',
  stream_key: 'test-key',
});
const generatedScript = decodeTaskScript(generated.cmd);
assertContains(generatedScript, '_finalize_auto_record_tmp() {', '录播临时文件收尾函数');
assertContains(generatedScript, '_prepare_auto_record_file() {', '按场次生成录播文件名函数');
assertContains(generatedScript, '_pick_auto_record_for_fallback() {', '录播兜底选择函数');
assertContains(generatedScript, '_AUTO_REC_FILE=""', '录播文件路径按场次延迟生成');
assertContains(generatedScript, '_AUTO_REC_LABEL="测试主播"', '录播文件名包含主播/任务名称');
assertContains(generatedScript, '_AUTO_REC_COMPAT_FILE="/root/restream_uploads/task_900001_latest.ts"', '内部兼容录播路径');
assertContains(generatedScript, '_AUTO_REC_FILE="/root/restream_uploads/录播_${_REC_TS}_${_AUTO_REC_LABEL}_task900001.ts"', '媒体库录播留存可读路径');
assertContains(generatedScript, 'ln -sfn "$_AUTO_REC_FILE" "$_AUTO_REC_COMPAT_FILE"', '用软链接保留旧兜底兼容文件');
assertContains(generatedScript, '_AUTO_REC_FALLBACK="/root/restream_uploads/task_900001_fallback.tmp"', '本场录播快照路径');
assertContains(generatedScript, 'cp -f "$_AUTO_REC_TMP" "$_AUTO_REC_FALLBACK"', '从正在录制的临时文件生成兜底快照');
assertContains(generatedScript, 'if [ -s "$_AUTO_REC_FALLBACK" ]; then', '重复兜底时继续使用本场快照');
assertContains(generatedScript, '本轮录播较短，已保留本场兜底快照', '短直播录播留存快照');
assertContains(generatedScript, '_push_auto_record_fallback() {', '统一录播兜底推送函数');
assertContains(generatedScript, 'ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_PLAY_REC"', '循环播放选中的录播文件');
assertContains(generatedScript, '与主推流共用同一条输入录制', '单次拉流同时推送和录播');
assertContains(generatedScript, '-t "$_AUTO_REC_MAX_SECONDS"', '录播时长上限');
assertContains(generatedScript, '-fs "$_AUTO_REC_MAX_BYTES"', '录播大小上限');
assertContains(generatedScript, '-flush_packets 1 -muxdelay 0 -muxpreload 0', '录播文件实时刷新');
assertContains(generatedScript, '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 3', '直播输入短线自动重连');
assertNotContains(generatedScript, '-reconnect_attempts', '旧版 FFmpeg 不兼容的重连次数参数');
assertNotContains(generatedScript, '-reconnect_at_eof 1', '直播 HLS EOF 不死守旧直链，交给外层重新解析');
assertContains(generatedScript, '-map 0:v:0 -map 0:a:0?', '只推送一路视频和一路音频');
assertContains(generatedScript, 'if _push_auto_record_fallback 90; then', '主推流退出后快速切录播兜底');
assertNotContains(generatedScript, '_start_auto_record() {', '单独二次拉流录播函数');
assertNotContains(generatedScript, '_AUTO_REC_PID_FILE', '单独录播进程 PID 文件');
assertNotContains(generatedScript, '/tmp/restream_record_900001.log', '单独录播进程日志');

const healthSource = fs.readFileSync(path.join(root, 'services/task-manager.js'), 'utf8');
assertContains(healthSource, "cat /tmp/restream_${task.id}.status 2>/dev/null || echo '{}'", '健康检测读取任务状态文件');
assertContains(healthSource, 'statusJson = JSON.parse(raw)', '健康检测解析 JSON 状态文件');
assertContains(healthSource, 'expectsRtmp1935', '仅对 rtmp:// 检查 1935 连接变量');
assertContains(healthSource, "/^rtmp:\\/\\//i.test(String(task.rtmp_url || ''))", '仅对 rtmp:// 检查 1935 连接条件');
assertContains(healthSource, 'while [ -n "$_SCAN" ]; do _NEXT=""', '健康检测扫描整棵子进程');
assertContains(healthSource, 'ps -o pid= -g "$_SID"', '健康检测优先扫描进程组内的 ffmpeg 子进程');
assertContains(healthSource, "grep -E ':(1935|443) '", '健康检测识别 RTMP/RTMPS 推流连接');
assertContains(healthSource, 'target_lost', '目标 RTMP 断开时单独标记状态，避免误显示推流中');
assertContains(healthSource, 'source_retrying', '源直链解析失败时单独标记重试状态，避免误显示卡死');
assertContains(healthSource, 'const hasHealthyFrameAfterErrors', '健康检查用最新 frame 进度压制旧错误误判');
assertContains(healthSource, '!isRetryLoop && !isExpiredDirectUrl && !isSourceUnavailable', '源直链过期时不误判为 YouTube RTMP 丢失');
assertContains(healthSource, 'remoteDependencyInstallCommand()', '远端执行依赖自动补齐');
assertContains(healthSource, 'streamlink', '远端依赖自动补齐 streamlink，保障抖音解析兜底');
assertContains(healthSource, 'ensureRemoteRuntime(task.vps_id, ownerId, { douyinHelper: isDouyin })', '直播任务启动前同步执行环境');
assertContains(healthSource, 'const isBlocked = false', '验证码封锁状态不再通过日志关键字误判');

const dbSource = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
assertContains(dbSource, 'youtube_api_key', 'YouTube API Key 用户级配置');
assertContains(dbSource, 'youtube_api_keys', 'YouTube API Key 池用户级配置');
assertContains(dbSource, 'youtube_api_key_cursor', 'YouTube API Key 池轮询游标配置');
assertContains(dbSource, 'youtube_api_key_status', 'YouTube API Key 状态用户级配置');
assertContains(dbSource, 'youtube_live_status', '任务表保存 YouTube 目标端状态');
const youtubeSource = fs.readFileSync(path.join(root, 'services/youtube-monitor.js'), 'utf8');
assertContains(youtubeSource, 'liveStreamingDetails', 'YouTube Data API 回填直播详情');
assertContains(youtubeSource, 'concurrentViewers', 'YouTube Data API 回填实时观看人数');
assertContains(youtubeSource, 'getYouTubeApiKeys', 'YouTube API Key 池读取');
assertContains(youtubeSource, 'getUsableYouTubeApiKeys', 'YouTube API Key 状态跳过');
assertContains(youtubeSource, 'isQuotaOrKeyError', 'YouTube API 配额耗尽自动切换判断');
assertContains(youtubeSource, 'rotateApiCursor', 'YouTube API Key 池轮询切换');
assertContains(youtubeSource, 'testApiKeyPool', 'YouTube API Key 池有效性检测');

const settingsSource = fs.readFileSync(path.join(root, 'routes/settings.js'), 'utf8');
assertContains(settingsSource, "router.post('/test-youtube-api-keys'", 'YouTube API Key 池检测接口');

assertContains(healthSource, "require('../utils/log-error')", 'task-manager 导入 logError 工具');
assertContains(healthSource, "logError('checkHealth'", 'checkHealth 外层错误日志（CONCERNS #16）');
assertContains(youtubeSource, 'classifyApiError,', 'youtube-monitor 导出 classifyApiError');

console.log(`OK: checked ${jsFiles.length} JavaScript files, loaded key modules, bootstrapped database, and verified auto-record fallback script`);
