const db = require('../db');
const { getSetting } = require('../db');
const sshService = require('./ssh');
const { resolveDouyinStreamUrl } = require('./platform-api');
const fs = require('fs');
const path = require('path');
const { decrypt } = require('./crypto');
const notifier = require('./notifier');
const { writeEvent } = require('../db');
const { logError } = require('../utils/log-error');

const PLATFORM_RTMP = {
  youtube: 'rtmp://a.rtmp.youtube.com/live2',
  tiktok:  'rtmp://push.tiktokv.com/live',
};

const MEDIA_LIBRARY_DIR = '/root/restream_uploads';
const LEGACY_RECORD_DIR = '/root/restream_recordings';
const AUTO_RECORDING_PREFIX = '录播';

const START_TASK_TIMEOUT_MS = 30 * 1000; // SSH 无响应时的最大等待时间

// 返回一个在 signal 触发 abort 时 reject 的 Promise
// 用于与业务 Promise 竞争，实现强制超时
function raceAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(`[队列启动] 操作已超时`));
      return;
    }
    const onAbort = () => reject(new Error(`[队列启动] 操作超时（30s），SSH 无响应`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => { signal.removeEventListener('abort', onAbort); resolve(val); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); }
    );
  });
}

let startQueue = Promise.resolve();

// Escape a string for use inside a double-quoted shell argument.
// Prevents injection via $, backticks, \, or " in user-controlled values.
function dqEsc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"');
}

function shSingleQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function normalizeRecordLabel(value, fallback = '直播间') {
  return String(value || fallback)
    .replace(/^\[Auto\]\s*/i, '')
    .replace(/[\\/:*?"<>|`$;{}()[\]\r\n\t]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || fallback;
}

function sourceRecordLabel(sourceUrl, fallback = '直播间') {
  try {
    const u = new URL(sourceUrl || '');
    const host = u.hostname.toLowerCase();
    const id = u.pathname.split('/').filter(Boolean).pop();
    if (/douyin\.com$/i.test(host) && id) return `抖音直播间_${id.slice(-12)}`;
    if (/bilibili\.com$/i.test(host) && id) return `B站直播间_${id}`;
    if (id) return `直播间_${id.slice(-12)}`;
  } catch (err) { logError('sourceRecordLabel', err); }
  return fallback;
}

function channelRecordLabel(task) {
  if (!task?.user_id || !task?.source_url || String(task.source_url).startsWith('/')) return '';
  try {
    const channel = db.prepare(`
      SELECT name FROM source_channels
      WHERE user_id=? AND url=? AND name IS NOT NULL AND trim(name) != ''
      ORDER BY id DESC LIMIT 1
    `).get(task.user_id, task.source_url);
    return channel?.name || '';
  } catch (err) {
    logError('channelRecordLabel', err);
    return '';
  }
}

function recordLabelForTask(task) {
  const channelLabel = normalizeRecordLabel(channelRecordLabel(task), '');
  const taskLabel = normalizeRecordLabel(task?.name, '');
  const genericTaskName = !taskLabel || /^task_?\d+$/i.test(taskLabel) || /^\d+\s*号$/.test(taskLabel);

  if (channelLabel && (genericTaskName || taskLabel === channelLabel)) return channelLabel;
  if (channelLabel && taskLabel) return normalizeRecordLabel(`${channelLabel}_${taskLabel}`);
  if (taskLabel && !genericTaskName) return taskLabel;
  return normalizeRecordLabel(sourceRecordLabel(task?.source_url, `task_${task?.id || 'unknown'}`));
}

function autoRecordingCompatName(taskId) {
  return `task_${taskId}_latest.ts`;
}

function autoRecordingCompatPath(taskId) {
  return `${MEDIA_LIBRARY_DIR}/${autoRecordingCompatName(taskId)}`;
}

async function syncAutoRecordingMediaFile(task) {
  if (!task?.id || !task?.vps_id || !task?.user_id) return;
  if (String(task.source_url || '').startsWith('/')) return;

  const compatName = autoRecordingCompatName(task.id);
  const compatPath = autoRecordingCompatPath(task.id);
  const legacyPath = `${LEGACY_RECORD_DIR}/${compatName}`;
  const namedPattern = `${AUTO_RECORDING_PREFIX}_*_task${task.id}.ts`;
  const cmd = [
    `mkdir -p ${shSingleQuote(MEDIA_LIBRARY_DIR)}`,
    `if [ ! -s ${shSingleQuote(compatPath)} ] && [ -s ${shSingleQuote(legacyPath)} ]; then cp -f ${shSingleQuote(legacyPath)} ${shSingleQuote(compatPath)}; fi`,
    `find ${shSingleQuote(MEDIA_LIBRARY_DIR)} -maxdepth 1 -type f \\( -name ${shSingleQuote(namedPattern)} -o -name ${shSingleQuote(compatName)} \\) -size +0c -printf '%f\\t%p\\t%s\\n' 2>/dev/null`,
  ].join(' && ');

  const result = await sshService.exec(task.vps_id, cmd, task.user_id);
  const records = (result.stdout || '').trim().split('\n').filter(Boolean).map(line => {
    const [fileName, remotePath, sizeStr] = line.split('\t');
    return { fileName, remotePath, size: parseInt(sizeStr, 10) || 0 };
  }).filter(row => row.fileName && row.remotePath && row.size > 0);
  const hasNamedRecording = records.some(row => row.fileName !== compatName);

  if (hasNamedRecording) {
    db.prepare('DELETE FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
      .run(task.user_id, task.vps_id, compatPath);
  }

  for (const { fileName, remotePath, size } of records) {
    if (hasNamedRecording && remotePath === compatPath) continue;
    const existing = db.prepare('SELECT id FROM media_files WHERE user_id=? AND vps_id=? AND remote_path=?')
      .get(task.user_id, task.vps_id, remotePath);
    if (existing) {
      db.prepare('UPDATE media_files SET name=?, size=? WHERE id=?').run(fileName, size, existing.id);
    } else {
      db.prepare('INSERT INTO media_files (user_id, vps_id, name, remote_path, size) VALUES (?,?,?,?,?)')
        .run(task.user_id, task.vps_id, fileName, remotePath, size);
    }
  }

  const currentPaths = new Set(records.map(r => r.remotePath));
  const allEntries = db.prepare(
    'SELECT id, remote_path, name FROM media_files WHERE user_id=? AND vps_id=?'
  ).all(task.user_id, task.vps_id);
  const stalePattern = new RegExp(`^${AUTO_RECORDING_PREFIX}_.*_task${task.id}(_\\d+)?\\.ts$`);
  for (const entry of allEntries) {
    if (stalePattern.test(entry.name || '') && !currentPaths.has(entry.remote_path)) {
      db.prepare('DELETE FROM media_files WHERE id=?').run(entry.id);
    }
  }
}

function isYoutubeTarget(task) {
  return task.platform === 'youtube' || /(?:^|\.)(?:youtube\.com|rtmp\.youtube\.com)$/i.test(String(task.rtmp_url || '').replace(/^rtmps?:\/\//i, '').split('/')[0]);
}

function ffmpegOutputArgs(task) {
  return '-map 0:v:0 -map 0:a:0? -dn -sn -c:v copy -c:a copy -avoid_negative_ts make_zero -flvflags no_duration_filesize';
}

function ffmpegRecordArgs() {
  return '-map 0:v:0 -map 0:a:0? -dn -sn -c:v copy -c:a copy';
}

function ffmpegHttpInputArgs(headers = '') {
  return `-fflags +genpts -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 3 ${headers} -rw_timeout 12000000`;
}

function remoteDependencyInstallCommand() {
  return [
    'if ! command -v wget >/dev/null 2>&1; then apt-get update -y && apt-get install -y wget ca-certificates; fi',
    'if ! command -v ffmpeg >/dev/null 2>&1; then apt-get update -y && apt-get install -y ffmpeg; fi',
    'if ! command -v python3 >/dev/null 2>&1; then apt-get update -y && apt-get install -y python3; fi',
    'if ! command -v streamlink >/dev/null 2>&1; then apt-get update -y && apt-get install -y python3-pip ca-certificates && (pip3 install -q --break-system-packages --upgrade streamlink || pip3 install -q --upgrade streamlink); fi',
    'if ! command -v yt-dlp >/dev/null 2>&1; then ARCH=$(uname -m); if [ "$ARCH" = "aarch64" ]; then YT_BIN=yt-dlp_linux_aarch64; elif [ "$ARCH" = "armv7l" ]; then YT_BIN=yt-dlp_linux_armv7l; else YT_BIN=yt-dlp_linux; fi; wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT_BIN" && chmod +x /usr/local/bin/yt-dlp; fi',
  ].join(' && ');
}

async function syncDouyinHelper(vpsId, userId) {
  const scriptPath = path.join(__dirname, '..', 'check_douyin.py');
  const script = fs.readFileSync(scriptPath, 'utf8');
  const scriptB64 = Buffer.from(script).toString('base64');
  await sshService.exec(vpsId, [
    'mkdir -p /opt/restream-console',
    `printf %s ${shSingleQuote(scriptB64)} | base64 -d > /opt/restream-console/check_douyin.py`,
    'chmod +x /opt/restream-console/check_douyin.py',
  ].join(' && '), userId);
}

async function ensureRemoteRuntime(vpsId, userId, options = {}) {
  await sshService.exec(vpsId, remoteDependencyInstallCommand(), userId);
  if (options.douyinHelper) await syncDouyinHelper(vpsId, userId);
}

function getDouyinCookies(userId) {
  return decrypt(getSetting('douyin_cookies', userId) || '') || '';
}

function buildCommand(task) {
  const dest = `${dqEsc(task.rtmp_url)}/${dqEsc(task.stream_key)}`;
  const logFile = `/tmp/restream_${task.id}.log`;
  const outArgs = ffmpegOutputArgs(task);
  const recordArgs = ffmpegRecordArgs();
  const recordDir = MEDIA_LIBRARY_DIR;
  const autoRecordLabel = recordLabelForTask(task);
  const autoRecordCompatFile = autoRecordingCompatPath(task.id);
  const autoRecordTmp = `${recordDir}/task_${task.id}_recording.tmp`;
  const autoRecordFallback = `${recordDir}/task_${task.id}_fallback.tmp`;
  const autoRecordDone = `${recordDir}/task_${task.id}_recorded.flag`;
  const encodeNotice = isYoutubeTarget(task)
    ? `echo "[编码] YouTube 目标启用无转码模式：音视频直通"`
    : `true`;

  let inner;
  if (task.source_url.startsWith('/')) {
    // 媒体库文件：循环推送，不需要重新解析
    inner = `${encodeNotice}\nffmpeg -stream_loop -1 -re -fflags +genpts -i "${dqEsc(task.source_url)}" ${outArgs} -f flv "${dest}"`;
  } else {
    // 网络直播：循环解析直链 + 推流（直链过期或 ffmpeg 退出后自动重新获取）
    const isDouyin = /douyin\.com/i.test(task.source_url);
    const isBilibili = /live\.bilibili\.com/i.test(task.source_url);
    const ckArg   = task._douyinCookieFile ? `--add-header "Cookie:$_DOUYIN_COOKIE"` : '';
    const ckRawArg = task._douyinCookieFile ? `"$_DOUYIN_COOKIE"` : `""`;
    const ytHdrs  = isDouyin
      ? `--add-header "Referer: https://live.douyin.com/" --add-header "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`
      : '';
    const ffmpegHdrs = isDouyin
      ? `-headers "Referer: https://live.douyin.com/\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\\r\\n"`
      : '';
    const httpInputArgs = ffmpegHttpInputArgs(ffmpegHdrs);
    const ytFormatArgs = isBilibili
      ? `-S "vcodec:h264,res,br" -f "best[vcodec^=avc1]/best[vcodec*=h264]/best[vcodec!*=hevc][vcodec!*=h265]"`
      : `-f "best"`;

    const allUrls = [task.source_url];
    if (task.backup_urls) {
      task.backup_urls.split('\n').forEach(u => { u = u.trim(); if (u) allUrls.push(u); });
    }
    const urlsArr = allUrls.map(shSingleQuote).join(' ');

    // 如果 API 已解析出直链，第一次优先使用它（更快），之后循环用 yt-dlp 续期
    const firstUrl = task._resolvedStreamUrl ? dqEsc(task._resolvedStreamUrl) : '';
    const dyHelper = isDouyin ? '/opt/restream-console/check_douyin.py' : '';

    inner = [
      `export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=en_US.UTF-8 2>/dev/null || true`,
      `_STATUS_FILE="/tmp/restream_${task.id}.status"`,
      `_write_status() {`,
      `  printf '{"state":"%s","source":"%s","target":"%s","fallback":%s,"fallback_round":%d,"ts":%d,"pid":%d}\\n' "$1" "$2" "$3" "$4" "$5" "$(date +%s)" "$$" > "$_STATUS_FILE" 2>/dev/null || true`,
      `}`,
      `_write_status idle unknown unknown false 0`,
      `_FIRST=1`,
      `_MISS=0`,
      `_FALLBACK_ROUND=0`,
      `_DOUYIN_COOKIE=""`,
      `_AUTO_REC_FILE=""`,
      `_AUTO_REC_LABEL="${dqEsc(autoRecordLabel)}"`,
      `_AUTO_REC_COMPAT_FILE="${autoRecordCompatFile}"`,
      `_AUTO_REC_TMP="${autoRecordTmp}"`,
      `_AUTO_REC_FALLBACK="${autoRecordFallback}"`,
      `_AUTO_REC_DONE="${autoRecordDone}"`,
      `_AUTO_REC_MIN_BYTES=1048576`,
      `_AUTO_REC_MIN_FALLBACK_BYTES=65536`,
      `_AUTO_REC_MAX_SECONDS=3600`,
      `_AUTO_REC_MAX_BYTES=2147483648`,
      `mkdir -p "${recordDir}"`,
      `rm -f "$_AUTO_REC_DONE" "$_AUTO_REC_FALLBACK"`,
      `_prepare_auto_record_file() {`,
      `  if [ -n "$_AUTO_REC_FILE" ]; then return; fi`,
      `  _REC_TS=$(TZ=Asia/Shanghai date +%Y%m%d_%H%M%S 2>/dev/null || date -u -d '+8 hours' +%Y%m%d_%H%M%S 2>/dev/null || date +%Y%m%d_%H%M%S)`,
      `  _AUTO_REC_FILE="${recordDir}/${AUTO_RECORDING_PREFIX}_${'${_REC_TS}'}_${'${_AUTO_REC_LABEL}'}_task${task.id}.ts"`,
      `  if [ -e "$_AUTO_REC_FILE" ]; then _AUTO_REC_FILE="${recordDir}/${AUTO_RECORDING_PREFIX}_${'${_REC_TS}'}_${'${_AUTO_REC_LABEL}'}_task${task.id}_$$.ts"; fi`,
      `  echo "[录播] 本场录播文件 $_AUTO_REC_FILE"`,
      `}`,
      `_finalize_auto_record_tmp() {`,
      `  if [ ! -e "$_AUTO_REC_TMP" ]; then return; fi`,
      `  _prepare_auto_record_file`,
      `  _REC_SIZE=$(stat -c%s "$_AUTO_REC_TMP" 2>/dev/null || echo 0)`,
      `  if [ "$_REC_SIZE" -gt "$_AUTO_REC_MIN_BYTES" ]; then`,
      `    mv -f "$_AUTO_REC_TMP" "$_AUTO_REC_FILE"`,
      `    ln -sfn "$_AUTO_REC_FILE" "$_AUTO_REC_COMPAT_FILE" 2>/dev/null || cp -f "$_AUTO_REC_FILE" "$_AUTO_REC_COMPAT_FILE" 2>/dev/null || true`,
      `    rm -f "$_AUTO_REC_FALLBACK"`,
      `    touch "$_AUTO_REC_DONE"`,
      `    echo "[录播] 已留存备用录播 $_AUTO_REC_FILE ($_REC_SIZE bytes)"`,
      `    _cleanup_old_recordings`,
      `  elif [ "$_REC_SIZE" -gt "$_AUTO_REC_MIN_FALLBACK_BYTES" ]; then`,
      `    cp -f "$_AUTO_REC_TMP" "$_AUTO_REC_FALLBACK" 2>/dev/null || true`,
      `    rm -f "$_AUTO_REC_TMP"`,
      `    echo "[录播] 本轮录播较短，已保留本场兜底快照 $_AUTO_REC_FALLBACK ($_REC_SIZE bytes)"`,
      `  else`,
      `    rm -f "$_AUTO_REC_TMP"`,
      `    echo "[录播] 本轮录播过短，保留上一份可用录播"`,
      `  fi`,
      `}`,
      `_cleanup_on_term() {`,
      `  _finalize_auto_record_tmp`,
      `  exit 0`,
      `}`,
      `trap _cleanup_on_term INT TERM`,
      `_reset_auto_record_for_next_live() {`,
      `  rm -f "$_AUTO_REC_DONE"`,
      `  rm -f "$_AUTO_REC_FALLBACK"`,
      `  _AUTO_REC_FILE=""`,
      `}`,
      `_pick_auto_record_for_fallback() {`,
      `  _PLAY_REC=""`,
      `  if [ -s "$_AUTO_REC_TMP" ]; then`,
      `    _TMP_SIZE=$(stat -c%s "$_AUTO_REC_TMP" 2>/dev/null || echo 0)`,
      `    if [ "$_TMP_SIZE" -gt "$_AUTO_REC_MIN_FALLBACK_BYTES" ]; then`,
      `      cp -f "$_AUTO_REC_TMP" "$_AUTO_REC_FALLBACK" 2>/dev/null || true`,
      `      if [ -s "$_AUTO_REC_FALLBACK" ]; then`,
      `        _PLAY_REC="$_AUTO_REC_FALLBACK"`,
      `        echo "[兜底-录播] 使用本场正在录制的片段快照 $_AUTO_REC_FALLBACK ($_TMP_SIZE bytes)"`,
      `        return`,
      `      fi`,
      `    fi`,
      `  fi`,
      `  if [ -s "$_AUTO_REC_FALLBACK" ]; then`,
      `    _PLAY_REC="$_AUTO_REC_FALLBACK"`,
      `    echo "[兜底-录播] 继续使用本场录播快照 $_AUTO_REC_FALLBACK"`,
      `    return`,
      `  fi`,
      `  if [ -n "$_AUTO_REC_FILE" ] && [ -s "$_AUTO_REC_FILE" ]; then`,
      `    _PLAY_REC="$_AUTO_REC_FILE"`,
      `    echo "[兜底-录播] 使用最近留存录播 $_AUTO_REC_FILE"`,
      `    return`,
      `  fi`,
      `  if [ -s "$_AUTO_REC_COMPAT_FILE" ]; then`,
      `    _PLAY_REC="$_AUTO_REC_COMPAT_FILE"`,
      `    echo "[兜底-录播] 使用兼容录播 $_AUTO_REC_COMPAT_FILE"`,
      `  fi`,
      `}`,
      `_push_auto_record_fallback() {`,
      `  _FALLBACK_SECONDS="${'${1:-120}'}"`,
      `  _pick_auto_record_for_fallback`,
      `  if [ -z "$_PLAY_REC" ]; then return 1; fi`,
      `  _FALLBACK_ROUND=$((_FALLBACK_ROUND + 1))`,
      `  _write_status fallback live unknown true "$_FALLBACK_ROUND"`,
      `  echo "[兜底-录播] 直播链路中断，循环播放录播 $_PLAY_REC（第 $_FALLBACK_ROUND 轮，${'$_FALLBACK_SECONDS'} 秒）"`,
      `  ${encodeNotice}`,
      `  timeout "$_FALLBACK_SECONDS" ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_PLAY_REC" ${outArgs} -f flv "${dest}"`,
      `  _FB_RC=$?`,
      `  if [ "$_FB_RC" -ne 0 ] && [ "$_FB_RC" -ne 124 ]; then`,
      `    _write_status target_lost live lost false 0`,
      `    echo "[TARGET_LOST] fallback push failed rc=$_FB_RC; target RTMP/live event may have ended"`,
      `    return 2`,
      `  fi`,
      `  echo "[兜底-录播] 录播兜底结束，重新探测直播源..."`,
      `  return 0`,
      `}`,
      `_cleanup_old_recordings() {`,
      `  find ${shSingleQuote(recordDir)} -maxdepth 1 -type f \\( -name ${shSingleQuote(`${AUTO_RECORDING_PREFIX}_*_task${task.id}.ts`)} -o -name ${shSingleQuote(`${AUTO_RECORDING_PREFIX}_*_task${task.id}_*.ts`)} \\) -printf '%T@\\t%p\\n' 2>/dev/null | sort -rn | tail -n +3 | cut -f2- | while IFS= read -r _OLD_REC; do`,
      `    rm -f "$_OLD_REC"`,
      `    echo "[录播清理] 已删除旧录播: $_OLD_REC"`,
      `  done`,
      `}`,
      `_BG_COVER_PID=""`,
      `_ensure_bg_cover() {`,
      `  if [ -n "$_BG_COVER_PID" ]; then kill -0 "$_BG_COVER_PID" 2>/dev/null && return 0; _BG_COVER_PID=""; fi`,
      `  _pick_auto_record_for_fallback`,
      `  [ -z "$_PLAY_REC" ] && return 1`,
      `  ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_PLAY_REC" ${outArgs} -f flv "${dest}" >/dev/null 2>&1 &`,
      `  _BG_COVER_PID=$!`,
      `  echo "[兜底-后台] 录播持续覆盖启动 (pid=$_BG_COVER_PID): $_PLAY_REC"`,
      `  return 0`,
      `}`,
      `_drop_bg_cover_nowait() {`,
      `  [ -z "$_BG_COVER_PID" ] && return`,
      `  kill "$_BG_COVER_PID" 2>/dev/null || true`,
      `  _BG_COVER_PID=""`,
      `}`,
      task._douyinCookieFile
        ? `if [ -f "${task._douyinCookieFile}" ]; then _DOUYIN_COOKIE=$(tr -d '\\n' < "${task._douyinCookieFile}"); fi`
        : `true`,
      `while true; do`,
      `  if [ "$_FIRST" = "1" ] && [ -n "${firstUrl}" ]; then`,
      `    STREAM_URL="${firstUrl}"`,
      `    echo "[直链-API] ${firstUrl.substring(0, 80)}..."`,
      `    _FIRST=0`,
      `  else`,
      `    STREAM_URL=""`,
      `    _ensure_bg_cover`,
      `    for _SRC in ${urlsArr}; do`,
      `      echo "[解析] 尝试源: $_SRC"`,
      isDouyin
        ? `      if [ -x "${dyHelper}" ]; then STREAM_URL=$(python3 "${dyHelper}" --stream-url "$_SRC" ${ckRawArg} 2>/tmp/restream_douyin_${task.id}.err | grep -m1 '^https\\?://'); if [ -n "$STREAM_URL" ]; then echo "[抖音解析] 使用源: $_SRC"; _MISS=0; break; fi; fi`
        : `      true`,
      `      STREAM_URL=$(yt-dlp --no-warnings --socket-timeout 15 --retries 2 --fragment-retries 2 ${ckArg} ${ytHdrs} ${ytFormatArgs} -g "$_SRC" 2>/tmp/restream_ytdlp_${task.id}.err | grep -m1 '^https\\?://')`,
      `      if [ -n "$STREAM_URL" ]; then echo "[yt-dlp] 使用源: $_SRC"; _MISS=0; break; fi`,
      `    done`,
      `  fi`,
      `  if [ -z "$STREAM_URL" ]; then`,
      `    _MISS=$((_MISS + 1))`,
      `    _SLEEP=$((15 * _MISS))`,
      `    if [ "$_SLEEP" -gt 300 ]; then _SLEEP=300; fi`,
      isDouyin
        ? `    if [ -s /tmp/restream_douyin_${task.id}.err ]; then echo "[解析失败-抖音] $(tail -1 /tmp/restream_douyin_${task.id}.err | tr -d '\\r' | cut -c1-180)"; fi`
        : `    true`,
      `    if [ -s /tmp/restream_ytdlp_${task.id}.err ]; then echo "[解析失败-yt-dlp] $(tail -1 /tmp/restream_ytdlp_${task.id}.err | tr -d '\\r' | cut -c1-180)"; fi`,
      `    _ensure_bg_cover`,
      `    if [ -n "$_BG_COVER_PID" ]; then`,
      `      echo "[兜底-后台] 录播持续覆盖 YouTube，$_SLEEP 秒后重新探测..."`,
      `      sleep "$_SLEEP"`,
      `      continue`,
      `    fi`,
      `    if _push_auto_record_fallback 300; then`,
      `      sleep 3`,
      `      continue`,
      `    fi`,
      `    _write_status source_retry retry unknown false 0`,
      `    echo "[错误] 无法获取直链，$_SLEEP 秒后重试..."`,
      `    sleep "$_SLEEP"`,
      `    continue`,
      `  fi`,
      `  _write_status streaming live connected false 0`,
      `  echo "[推流] $STREAM_URL"`,
      `  if [ "$_FALLBACK_ROUND" -gt 0 ]; then`,
      `    echo "[直播恢复] 已重新获取直播源，切回直播并准备下一场录播留存"`,
      `    _reset_auto_record_for_next_live`,
      `    _FALLBACK_ROUND=0`,
      `  fi`,
      `  _EXPIRE_TS=$(echo "$STREAM_URL" | grep -oP '(?<=expire=)\\d+' 2>/dev/null || echo 0)`,
      `  _NOW=$(date +%s)`,
      `  _FFMPEG_MAX_TIME=86400`,
      `  if [ "$_EXPIRE_TS" -gt "$_NOW" ]; then`,
      `    _TTL=$(( _EXPIRE_TS - _NOW ))`,
      `    _FFMPEG_MAX_TIME=$(( _TTL - 90 ))`,
      `    [ "$_FFMPEG_MAX_TIME" -lt 30 ] && _FFMPEG_MAX_TIME=30`,
      `    echo "[TTL] 直链约 ${'${_TTL}'}s 后过期，将在 ${'${_FFMPEG_MAX_TIME}'}s 后主动刷新"`,
      `  fi`,
      `  _drop_bg_cover_nowait`,
      `  ${encodeNotice}`,
      `  if [ -f "$_AUTO_REC_DONE" ]; then`,
      `    echo "[录播] 本场已留存录播文件，本轮只推直播源"`,
      `    timeout "$_FFMPEG_MAX_TIME" ffmpeg -re ${httpInputArgs} -i "$STREAM_URL" ${outArgs} -f flv "${dest}"`,
      `  else`,
      `    _prepare_auto_record_file`,
      `    rm -f "$_AUTO_REC_TMP" "$_AUTO_REC_FALLBACK"`,
      `    echo "[录播] 与主推流共用同一条输入录制，最多 ${'$_AUTO_REC_MAX_SECONDS'} 秒或 2GB：$_AUTO_REC_FILE"`,
      `    timeout "$_FFMPEG_MAX_TIME" ffmpeg -re ${httpInputArgs} -i "$STREAM_URL" ${outArgs} -f flv "${dest}" ${recordArgs} -t "$_AUTO_REC_MAX_SECONDS" -fs "$_AUTO_REC_MAX_BYTES" -flush_packets 1 -muxdelay 0 -muxpreload 0 -f mpegts "$_AUTO_REC_TMP"`,
      `  fi`,
      `  _FFMPEG_RC=$?`,
      `  _ensure_bg_cover`,
      `  _finalize_auto_record_tmp`,
      `  if [ "$_FFMPEG_RC" -eq 124 ]; then echo "[TTL] 直链到期主动刷新，重新获取直链..."; elif [ "$_FFMPEG_RC" -ne 0 ]; then echo "[FFMPEG_EXIT] main ffmpeg exited rc=$_FFMPEG_RC; will inspect source/target and retry"; fi`,
      `  echo "[退出] ffmpeg 退出(code=$_FFMPEG_RC)，准备快速兜底/重连..."`,
      `  if [ -n "$_BG_COVER_PID" ]; then`,
      `    _MISS=0`,
      `    echo "[兜底-后台] 录播持续覆盖中，立即重新解析直播源..."`,
      `    continue`,
      `  fi`,
      `  if _push_auto_record_fallback 90; then`,
      `    _MISS=0`,
      `    sleep 1`,
      `    continue`,
      `  fi`,
      `  _MISS=$((_MISS + 1))`,
      `  _SLEEP=$((5 * _MISS))`,
      `  if [ "$_SLEEP" -gt 120 ]; then _SLEEP=120; fi`,
      `  echo "[重连] $_SLEEP 秒后重新获取直链..."`,
      `  sleep "$_SLEEP"`,
      `done`,
    ].join('\n');
  }

  const scriptB64 = Buffer.from(inner).toString('base64');
  return { cmd: `nohup bash -c "$(echo '${scriptB64}' | base64 -d)" > ${logFile} 2>&1 & echo $!`, logFile };
}

async function startTask(taskId, userId = null) {
  const task = db.prepare(`
    SELECT t.*, v.id as vid FROM tasks t
    LEFT JOIN vps v ON t.vps_id = v.id WHERE t.id = ?
    ${userId ? 'AND t.user_id = ?' : ''}
  `).get(...(userId ? [taskId, userId] : [taskId]));

  if (!task)          throw new Error('任务不存在');
  if (!task.vps_id)   throw new Error('任务未绑定 VPS');
  if (task.status === 'running') throw new Error('任务已在运行');

  // 检查 VPS 任务上限
  const ownerId = task.user_id;
  const maxPerVps = parseInt(getSetting('max_tasks_per_vps', ownerId) || '5');
  const running = db.prepare(
    "SELECT COUNT(*) as n FROM tasks WHERE user_id=? AND vps_id=? AND status='running'"
  ).get(ownerId, task.vps_id).n;
  if (running >= maxPerVps) {
    throw new Error(`该 VPS 已有 ${running} 个任务运行，上限 ${maxPerVps} 个`);
  }

  // 需要本地检测开播状态的平台：抖音 / B站 / 快手
  const isMediaFile = task.source_url.startsWith('/');
  const isDouyin   = !isMediaFile && /douyin\.com/i.test(task.source_url);
  const isBilibili = !isMediaFile && /live\.bilibili\.com/i.test(task.source_url);
  const isKuaishou = !isMediaFile && /live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(task.source_url);

  if (isDouyin || isBilibili || isKuaishou) {
    const { checkDouyin, checkBilibili, checkKuaishou } = require('./platform-api');
    const cookies = getDouyinCookies(ownerId);

    // 1) 检测是否正在直播
    let isLive = true; // 默认乐观，检测失败时直接尝试推流
    try {
      let liveResult = null;
      if (isDouyin)   liveResult = await checkDouyin(task.source_url, cookies);
      if (isBilibili) liveResult = await checkBilibili(task.source_url);
      if (isKuaishou) liveResult = await checkKuaishou(task.source_url);
      if (liveResult && liveResult.isLive === false) isLive = false;
    } catch (err) { logError('startTaskQueued/liveCheck', err); }

    if (!isLive) {
      console.log(`[任务${taskId}] 主播未开播，进入等待直播状态`);
      db.prepare("UPDATE tasks SET status='waiting_live', remote_pid=NULL WHERE id=?").run(taskId);
      return null;
    }

    await ensureRemoteRuntime(task.vps_id, ownerId, { douyinHelper: isDouyin });

    // 2) 抖音额外处理：API 解析直链 / streamlink 兜底
    if (isDouyin) {
      try {
        const resolved = await resolveDouyinStreamUrl(task.source_url, cookies);
        if (resolved && resolved.url) {
          task._resolvedStreamUrl = resolved.url;
          console.log(`[任务${taskId}] 抖音流地址(${resolved.protocol}): ${resolved.url.substring(0, 60)}...`);
        }
      } catch (err) { logError('startTaskQueued/douyinResolve', err); }

      // 3) API 失败：用 streamlink + cookies
      if (cookies) {
        const ckFile = `/tmp/dy_ck_${taskId}.txt`;
        const cookiesB64 = Buffer.from(cookies).toString('base64');
        await sshService.exec(task.vps_id,
          `printf %s ${shSingleQuote(cookiesB64)} | base64 -d > ${ckFile}`,
          ownerId
        );
        task._douyinCookieFile = ckFile;
      }

      if (!task._resolvedStreamUrl) {
        if (cookies) {
          console.log(`[任务${taskId}] API 无直链，将用远端抖音解析 + yt-dlp 兜底: ${task._douyinCookieFile}`);
        } else {
          console.warn(`[任务${taskId}] ${task.name || ''} 未配置抖音 Cookie，将先尝试无 Cookie 远端解析；如持续失败请在设置页或系统设置补充 Cookie`);
        }
      }
    }
  }

  const { cmd, logFile } = buildCommand(task);
  const result = await sshService.exec(task.vps_id, cmd, ownerId);
  const pid = parseInt(result.stdout.trim());
  if (!pid || isNaN(pid)) {
    throw new Error('启动失败: ' + (result.stderr || '无法获取 PID'));
  }

  db.prepare(`
    UPDATE tasks
    SET status='running', remote_pid=?, log_file=?,
        started_at=datetime('now'), last_active_at=datetime('now'), stall_count=0, block_count=0
    WHERE id=?
  `).run(pid, logFile, taskId);

  return pid;
}

// 带错开延迟的启动（多任务连续启动时调用此方法）
function startTaskQueued(taskId, userId = null) {
  startQueue = startQueue.then(async () => {
    const signal = AbortSignal.timeout(START_TASK_TIMEOUT_MS);
    try {
      await raceAbort(startTask(taskId, userId), signal);
    } catch (e) {
      console.error(`[队列启动] 任务 ${taskId} 失败:`, e.message);
      // 启动失败时标记为 error，避免永远卡在 restarting
      db.prepare(`UPDATE tasks SET status='error', remote_pid=NULL WHERE id=? ${userId ? 'AND user_id=?' : ''}`)
        .run(...(userId ? [taskId, userId] : [taskId]));
      notifier.send(userId, {
        type: 'task_start_failed',
        taskId,
        taskName: String(taskId),
        message: `任务 ${taskId} 启动失败：${e.message}`,
      }).catch(() => {});
      writeEvent(taskId, userId, null, 'error', `start_failed: ${e.message}`);
    }
    const delay = parseInt(getSetting('start_delay', userId || undefined) || '5') * 1000;
    await new Promise(r => setTimeout(r, delay));
  });
  return startQueue;
}

function _notify(task, type, message) {
  notifier.send(task.user_id, {
    type,
    taskId: task.id,
    taskName: task.name || String(task.id),
    message,
  }).catch(() => {});
}

function _record(task, fromStatus, toStatus, reason) {
  writeEvent(task.id, task.user_id, fromStatus, toStatus, reason);
}

async function stopTask(taskId, userId = null) {
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? ${userId ? 'AND user_id=?' : ''}`)
    .get(...(userId ? [taskId, userId] : [taskId]));
  if (!task) throw new Error('任务不存在');

  if (task.remote_pid && task.vps_id) {
    await sshService.exec(
      task.vps_id,
      `pkill -P ${task.remote_pid} 2>/dev/null; kill ${task.remote_pid} 2>/dev/null; rm -f /tmp/dy_ck_${taskId}.txt 2>/dev/null; true`,
      task.user_id
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    await syncAutoRecordingMediaFile(task).catch(() => {});
  }
  db.prepare(`UPDATE tasks SET status='stopped', remote_pid=NULL WHERE id=? ${userId ? 'AND user_id=?' : ''}`)
    .run(...(userId ? [taskId, userId] : [taskId]));
}

// 健康检测：进程存活 + 日志文件活跃度 + 状态文件 + 目标端连接检测
async function checkHealth(task) {
  if (!task.remote_pid || !task.vps_id) return;

  const stallTimeout = parseInt(getSetting('stall_timeout', task.user_id) || '120');
  const blockLimit   = parseInt(getSetting('block_limit', task.user_id)   || '8');

  try {
    await syncAutoRecordingMediaFile(task).catch(() => {});

    // 一次 SSH 同时检查进程存活 + 日志 mtime + 状态文件 + RTMP 连接
    const cmd = [
      `kill -0 ${task.remote_pid} 2>/dev/null && echo alive || echo dead`,
      `stat -c %Y ${task.log_file} 2>/dev/null || echo 0`,
      `cat /tmp/restream_${task.id}.status 2>/dev/null || echo '{}'`,
      `if ! command -v ss >/dev/null 2>&1; then echo rtmp_unknown; else _RTMP_HIT=0; _PIDS="${task.remote_pid}"; _SID=$(ps -o sid= -p ${task.remote_pid} 2>/dev/null | tr -d ' '); if [ -n "$_SID" ]; then _PIDS="$(ps -o pid= -g "$_SID" 2>/dev/null | tr '\\n' ' ')"; elif command -v pgrep >/dev/null 2>&1; then _SCAN="${task.remote_pid}"; while [ -n "$_SCAN" ]; do _NEXT=""; for _PP in $_SCAN; do for _CP in $(pgrep -P "$_PP" 2>/dev/null); do _PIDS="$_PIDS $_CP"; _NEXT="$_NEXT $_CP"; done; done; _SCAN="$_NEXT"; done; fi; for _P in $_PIDS; do ss -tnp 2>/dev/null | grep -E ':(1935|443) ' | grep -q "pid=$_P," && _RTMP_HIT=1; done; [ "$_RTMP_HIT" = "1" ] && echo rtmp_connected || echo no_rtmp; fi`,
    ].join('; ');

    const result = await sshService.exec(task.vps_id, cmd, task.user_id);
    const lines = result.stdout.trim().split('\n');
    const procStatus = lines[0]?.trim();
    const mtime = parseInt(lines[1]?.trim() || '0');
    const rtmpStatus = lines[3]?.trim() || 'rtmp_unknown';
    const now = Math.floor(Date.now() / 1000);
    const stale = mtime > 0 && (now - mtime) > stallTimeout;

    // 解析 JSON 状态文件（由 bash 脚本的 _write_status 函数写出）
    let statusJson = {};
    try {
      const raw = (lines[2] || '{}').trim();
      statusJson = JSON.parse(raw);
    } catch (_) {
      // 状态文件不存在或格式错误，降级为空对象，后续判断使用默认值
    }
    const jsState       = statusJson.state     || 'unknown';   // streaming|source_retry|source_offline|fallback|target_lost|idle|expired
    const jsSource      = statusJson.source    || 'unknown';   // live|retry|offline|unknown
    const jsTarget      = statusJson.target    || 'unknown';   // connected|lost|unknown
    const jsFallback    = statusJson.fallback  === true;       // boolean

    // === 基于 JSON 状态文件的健康判断（替代正则文本解析）===

    // 兜底录播：脚本报告 fallback 状态
    const isFallbackActive = jsFallback === true || jsState === 'fallback';

    // 直播源重试：无法获取直链
    const isRetryLoop      = jsState === 'source_retry' || jsSource === 'retry';

    // 直播源明确离线（404/not live 类）
    const isSourceOffline  = jsSource === 'offline' || jsState === 'source_offline';
    const isSourceUnavailable = isSourceOffline;

    // 目标 RTMP 断开
    const isTargetLost     = jsState === 'target_lost' || jsTarget === 'lost';

    // 直链过期（URL expire 时间戳临近）
    const isExpiredDirectUrl = jsState === 'expired';

    // ffmpeg 无流输出（状态文件首次创建前或脚本未能写出）
    const isFfmpegNoStreamError = jsState === 'idle' && procStatus !== 'dead' && mtime > 0 && (now - mtime) < 30;

    // 是否为直播类源
    const isLiveSource = !task.source_url.startsWith('/') &&
      /douyin\.com|live\.bilibili\.com|live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(task.source_url);

    // RTMP 连接状态（来自 ss 命令，与之前相同）
    const expectsRtmp1935   = /^rtmp:\/\//i.test(String(task.rtmp_url || ''));
    const isYoutubeRtmpMissing = isYoutubeTarget(task) && expectsRtmp1935 && procStatus !== 'dead' && rtmpStatus === 'no_rtmp';
    const isTargetStatus    = task.status === 'target_lost';

    // 验证码/封锁检测：JSON 状态文件中无法检测，降级为保守值（不触发 block 逻辑）
    // TODO(Phase 5): 可在状态文件中添加 blocked 字段
    const isBlocked = false;

    // RTMP 推流错误：从 JSON target 字段判断
    const isRtmpError = jsTarget === 'lost' && procStatus !== 'dead' && !jsFallback;

    // 空流输出（无音视频流）：从状态文件无法直接检测，保留为 false
    // 此场景在 streaming 状态下 mtime 会停止更新，stale 逻辑会捕获
    const hasHealthyFrameAfterErrors = jsState === 'streaming';

    if (procStatus !== 'dead' && isFfmpegNoStreamError && !hasHealthyFrameAfterErrors) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[health] task ${task.id} ffmpeg output has no streams, restarting to rebuild command, stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (newStallCount >= 1) {
        await stopTask(task.id, task.user_id).catch(() => {});
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
        _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
        _record(task, task.status, 'restarting', 'auto_restart');
      } else if (task.status !== 'stalled') {
        db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
        _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
        _record(task, task.status, 'stalled', 'stream_stalled');
      }
      return;
    }

    if (procStatus !== 'dead' && isExpiredDirectUrl && isLiveSource) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[health] task ${task.id} source direct url expired, stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (isFallbackActive) {
        db.prepare("UPDATE tasks SET status='running', last_active_at=datetime('now') WHERE id=?").run(task.id);
        return;
      }

      db.prepare("UPDATE tasks SET status='source_retrying' WHERE id=?").run(task.id);
      return;
    }

    if (procStatus !== 'dead' && isRetryLoop && isLiveSource) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[健康监控] 任务 ${task.id} 正在重试解析直播源，stall=${newStallCount}`);
      db.prepare("UPDATE tasks SET status='source_retrying', stall_count=? WHERE id=?").run(newStallCount, task.id);
      return;
    }

    if (isTargetLost || isTargetStatus) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[health] task ${task.id} target RTMP disconnected, stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET status=?, stall_count=? WHERE id=?').run('target_lost', newStallCount, task.id);

      if (newStallCount >= 2 || isTargetStatus) {
        if (task.auto_restart) {
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
          startTaskQueued(task.id, task.user_id).catch(() => {});
          _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
          _record(task, task.status, 'restarting', 'auto_restart');
        } else {
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='target_lost', remote_pid=NULL WHERE id=?").run(task.id);
        }
      }
      return;
    }

    if (isYoutubeRtmpMissing && !isRetryLoop && !isExpiredDirectUrl && !isSourceUnavailable) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[健康监控] 任务 ${task.id} 未检测到 YouTube RTMP 连接，stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (newStallCount >= 2) {
        if (task.auto_restart) {
          console.log(`[健康监控] 任务 ${task.id} YouTube RTMP 连接丢失，自动重启`);
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
          startTaskQueued(task.id, task.user_id).catch(() => {});
          _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
          _record(task, task.status, 'restarting', 'auto_restart');
        } else {
          db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
          _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
          _record(task, task.status, 'stalled', 'stream_stalled');
        }
      } else if (task.status !== 'stalled') {
        db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
        _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
        _record(task, task.status, 'stalled', 'stream_stalled');
      }
      return;
    }

    // 直播源已不可用时，优先按“源结束/未开播”处理，避免把脚本重试误显示为推流中。
    if (procStatus !== 'dead' && isSourceUnavailable && isLiveSource) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[健康监控] 任务 ${task.id} 直播源不可用，stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      if (isFallbackActive) {
        db.prepare("UPDATE tasks SET status='running', last_active_at=datetime('now') WHERE id=?").run(task.id);
        return;
      }

      if (!isSourceOffline || newStallCount < 2) {
        if (task.status !== 'stalled') {
          db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
          _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
          _record(task, task.status, 'stalled', 'stream_stalled');
        }
        return;
      }

      console.log(`[健康监控] 任务 ${task.id} 直播源持续不可用，进入等待开播`);
      await stopTask(task.id, task.user_id).catch(() => {});
      db.prepare("UPDATE tasks SET status='waiting_live', remote_pid=NULL, stall_count=0 WHERE id=?").run(task.id);
      return;
    }

    // 检测抖音验证码特征词（streamlink 报错时会出现）
    // 验证码/封锁检测：JSON 状态文件中无法检测，降级为保守值（不触发 block 逻辑）
    // TODO(Phase 5): 可在状态文件中添加 blocked 字段
    if (isBlocked) {
      const newBlockCount = (task.block_count || 0) + 1;
      console.warn(`[健康监控] 任务 ${task.id} 检测到验证码/封锁，block_count=${newBlockCount}`);
      db.prepare('UPDATE tasks SET block_count=? WHERE id=?').run(newBlockCount, task.id);

      if (newBlockCount >= blockLimit) {
        console.error(`[健康监控] 任务 ${task.id} 连续 ${newBlockCount} 次被封，自动停止（IP 可能被封）`);
        await stopTask(task.id, task.user_id).catch(() => {});
        db.prepare("UPDATE tasks SET status='blocked', remote_pid=NULL WHERE id=?").run(task.id);
        return;
      }
    }

    // 检测 RTMP 推流目标断开（YouTube/TikTok 主动断流、推流码失效等）
    // isRtmpError 已在 JSON 状态判断块中通过 jsTarget 字段计算
    if (isRtmpError) {
      const newStallCount = (task.stall_count || 0) + 1;
      console.warn(`[健康监控] 任务 ${task.id} 检测到 RTMP 推流错误（可能目标端断流），stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);
      // 允许短暂断流重试（最多 3 次 ≈ 90s），超过则停止
      if (newStallCount >= 3) {
        if (task.auto_restart) {
          console.error(`[健康监控] 任务 ${task.id} RTMP 持续报错，自动重启`);
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
          startTaskQueued(task.id, task.user_id).catch(() => {});
          _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
          _record(task, task.status, 'restarting', 'auto_restart');
        } else {
          console.error(`[健康监控] 任务 ${task.id} RTMP 持续报错，自动停止`);
          await stopTask(task.id, task.user_id).catch(() => {});
          db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
          _notify(task, 'task_error', `任务 ${task.name || task.id} 已停止（进程死亡，无自动重启）`);
          _record(task, task.status, 'error', 'process_died');
        }
        return;
      }
      if (task.status !== 'stalled') {
        db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
        _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
        _record(task, task.status, 'stalled', 'stream_stalled');
      }
      return;
    }

    if (procStatus === 'dead') {
      // 进程已死
      if (task.auto_restart) {
        console.log(`[健康监控] 任务 ${task.id} 进程已死，自动重启`);
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
        _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
        _record(task, task.status, 'restarting', 'auto_restart');
      } else {
        db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
        _notify(task, 'task_error', `任务 ${task.name || task.id} 已停止（进程死亡，无自动重启）`);
        _record(task, task.status, 'error', 'process_died');
      }
      return;
    }

    if (stale || isRetryLoop) {
      const reason = stale ? `日志 ${now - mtime}s 无更新` : '无法获取直链';
      const newStallCount = (task.stall_count || 0) + 1;
      console.log(`[健康监控] 任务 ${task.id} ${reason}，stall=${newStallCount}`);
      db.prepare('UPDATE tasks SET stall_count=? WHERE id=?').run(newStallCount, task.id);

      // 重试循环：允许最多 10 次（≈5分钟）再处理，为短暂断播留余地
      const retryThreshold = isRetryLoop && !stale ? 10 : 1;
      if (newStallCount < retryThreshold) {
        // 更新显示状态为 stalled，但暂不杀进程
        if (task.status !== 'stalled') {
          db.prepare("UPDATE tasks SET status='stalled' WHERE id=?").run(task.id);
          _notify(task, 'task_stalled', `任务 ${task.name || task.id} 已掉线，请检查推流状态`);
          _record(task, task.status, 'stalled', 'stream_stalled');
        }
        return;
      }

      if (task.auto_restart) {
        console.log(`[健康监控] 任务 ${task.id} 自动重启（${reason}）`);
        await stopTask(task.id, task.user_id).catch(() => {});
        db.prepare("UPDATE tasks SET status='restarting' WHERE id=?").run(task.id);
        startTaskQueued(task.id, task.user_id).catch(() => {});
        _notify(task, 'task_restarting', `任务 ${task.name || task.id} 自动重启中`);
        _record(task, task.status, 'restarting', 'auto_restart');
      } else {
        await stopTask(task.id, task.user_id).catch(() => {});
        db.prepare("UPDATE tasks SET status='error', remote_pid=NULL WHERE id=?").run(task.id);
        _notify(task, 'task_error', `任务 ${task.name || task.id} 已停止（持续无日志更新，无自动重启）`);
        _record(task, task.status, 'error', 'no_log_update');
      }
    } else if (mtime > 0) {
      // 正常运行，更新活跃时间，清零计数；若之前卡过，恢复为 running
      const statusPatch = ['stalled', 'source_retrying'].includes(task.status) ? ", status='running'" : '';
      db.prepare(`UPDATE tasks SET last_active_at=datetime('now'), stall_count=0, block_count=0${statusPatch} WHERE id=?`).run(task.id);
      if ((task.stall_count || 0) > 0 || ['stalled', 'restarting', 'source_retrying'].includes(task.status)) {
        _notify(task, 'task_recovered', `任务 ${task.name || task.id} 已恢复正常`);
        _record(task, task.status, 'running', 'recovered');
      }
    }
  } catch (err) {
    logError('checkHealth', err);
    // SSH 暂时失败，不改状态
  }
}

// 定期 ping 所有 VPS，自动更新在线状态
async function checkAllVpsStatus() {
  const vpsList = db.prepare('SELECT * FROM vps').all();
  await processInBatches(vpsList, 3, async (vps) => {
    try {
      const ok = await sshService.testConnection(vps);
      if (ok) {
        db.prepare("UPDATE vps SET status='online', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      } else {
        db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
      }
    } catch (_) {
      db.prepare("UPDATE vps SET status='offline', last_check=CURRENT_TIMESTAMP WHERE id=?").run(vps.id);
    }
  });
}

async function processInBatches(items, limit, handler) {
  const queue = Array.isArray(items) ? [...items] : [];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length || 1)) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await handler(item);
    }
  });
  await Promise.all(workers);
}

function startMonitor() {
  // 任务健康检测：每 30s（运行中 + 异常/重试中的活动任务）
  setInterval(async () => {
    const active = db.prepare(
      "SELECT * FROM tasks WHERE status IN ('running','stalled','source_retrying','target_lost')"
    ).all();
    await processInBatches(active, 3, task => checkHealth(task).catch(err => logError('checkHealth', err)));
  }, 30 * 1000);

  // 等待直播监控：每 60s 检查 waiting_live 任务，开播则自动启动
  setInterval(async () => {
    const waiting = db.prepare(
      "SELECT * FROM tasks WHERE status='waiting_live'"
    ).all();
    await processInBatches(waiting, 2, task => checkAndStartIfLive(task).catch(() => {}));
  }, 60 * 1000);

  // VPS 在线状态检测：每 2 分钟
  setInterval(() => {
    checkAllVpsStatus().catch(e => console.error('[VPS心跳]', e.message));
  }, 2 * 60 * 1000);

  // 启动时立刻检测一次
  setTimeout(() => {
    checkAllVpsStatus().catch(() => {});
  }, 3000);
}

// 检查来源是否开播，若是则自动启动任务
async function checkAndStartIfLive(task) {
  const { checkDouyin, checkBilibili, checkKuaishou } = require('./platform-api');
  const url = task.source_url;

  const isDouyin   = /douyin\.com/i.test(url);
  const isBilibili = /live\.bilibili\.com/i.test(url);
  const isKuaishou = /live\.kuaishou\.com|kuaishou\.com\/short-video/i.test(url);
  if (!isDouyin && !isBilibili && !isKuaishou) return;

  try {
    let result = null;
    if (isDouyin)   result = await checkDouyin(url, getDouyinCookies(task.user_id));
    if (isBilibili) result = await checkBilibili(url);
    if (isKuaishou) result = await checkKuaishou(url);

    if (result && result.isLive) {
      console.log(`[等待直播] 任务 ${task.id} 检测到开播，自动启动`);
      startTaskQueued(task.id, task.user_id);
    }
  } catch (err) { logError('checkAndStartIfLive', err); }
}

module.exports = { startTask, startTaskQueued, stopTask, checkHealth, startMonitor, PLATFORM_RTMP, checkAndStartIfLive, recordLabelForTask, _buildCommand: buildCommand };
