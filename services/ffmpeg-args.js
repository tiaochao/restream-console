const db = require('../db');
const { getSetting } = require('../db');
const { decrypt } = require('./crypto');
const { logError } = require('../utils/log-error');
const { dqEsc, shSingleQuote } = require('../utils/shell-escape');

const MEDIA_LIBRARY_DIR = '/root/restream_uploads';
const LEGACY_RECORD_DIR = '/root/restream_recordings';
const AUTO_RECORDING_PREFIX = '录播';

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
      `  _STATUS_BG_PID="${'${6:-0}'}"`,
      `  printf '{"state":"%s","source":"%s","target":"%s","fallback":%s,"fallback_round":%d,"ts":%d,"pid":%d,"bg_pid":%d}\\n' "$1" "$2" "$3" "$4" "$5" "$(date +%s)" "$$" "$_STATUS_BG_PID" > "$_STATUS_FILE" 2>/dev/null || true`,
      `}`,
      `_write_status idle unknown unknown false 0 0`,
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
      `  _write_status fallback live unknown true "$_FALLBACK_ROUND" 0`,
      `  echo "[兜底-录播] 直播链路中断，循环播放录播 $_PLAY_REC（第 $_FALLBACK_ROUND 轮，${'$_FALLBACK_SECONDS'} 秒）"`,
      `  ${encodeNotice}`,
      `  timeout "$_FALLBACK_SECONDS" ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_PLAY_REC" ${outArgs} -f flv "${dest}"`,
      `  _FB_RC=$?`,
      `  if [ "$_FB_RC" -ne 0 ] && [ "$_FB_RC" -ne 124 ]; then`,
      `    _write_status target_lost live lost false 0 0`,
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
      `  _write_status fallback live unknown true "$_FALLBACK_ROUND" "$_BG_COVER_PID"`,
      `  echo "[兜底-后台] 录播持续覆盖启动 (pid=$_BG_COVER_PID): $_PLAY_REC"`,
      `  return 0`,
      `}`,
      `_drop_bg_cover_nowait() {`,
      `  [ -z "$_BG_COVER_PID" ] && return`,
      `  kill "$_BG_COVER_PID" 2>/dev/null || true`,
      `  sleep 0.2`,
      `  kill -KILL "$_BG_COVER_PID" 2>/dev/null || true`,
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
      `    _write_status source_retry retry unknown false 0 0`,
      `    echo "[错误] 无法获取直链，$_SLEEP 秒后重试..."`,
      `    sleep "$_SLEEP"`,
      `    continue`,
      `  fi`,
      `  _write_status streaming live connected false 0 0`,
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

module.exports = {
  buildCommand,
  recordLabelForTask,
  isYoutubeTarget,
  remoteDependencyInstallCommand,
  autoRecordingCompatPath,
  autoRecordingCompatName,
  MEDIA_LIBRARY_DIR,
  LEGACY_RECORD_DIR,
  AUTO_RECORDING_PREFIX,
};
