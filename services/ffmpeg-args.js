const db = require('../db');
const { getSetting } = require('../db');
const { decrypt } = require('./crypto');
const { logError } = require('../utils/log-error');
const { dqEsc, shSingleQuote } = require('../utils/shell-escape');

const MEDIA_LIBRARY_DIR = '/root/restream_uploads';
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

function youtubeBackupDest(task) {
  if (!isYoutubeTarget(task)) return null;
  const rawUrl = String(task.rtmp_url || '');
  const newUrl = rawUrl.replace(/^(rtmps?:\/\/)a\.(rtmp\.youtube\.com)/i, '$1b.$2');
  if (newUrl === rawUrl) return null;
  // YouTube 备用服务器需要 ?backup=1 参数，否则会被当作主流量
  const backupUrl = newUrl + (/\?/.test(newUrl) ? '&backup=1' : '?backup=1');
  return `${dqEsc(backupUrl)}/${dqEsc(task.stream_key)}`;
}

function ffmpegOutputArgs() {
  return '-map 0:v:0 -map 0:a:0? -dn -sn -c:v copy -c:a copy -avoid_negative_ts make_zero -flvflags no_duration_filesize';
}

function ffmpegRecordArgs() {
  return '-map 0:v:0 -map 0:a:0? -dn -sn -c:v copy -c:a copy';
}

function ffmpegHttpInputArgs(headers = '') {
  // -http_persistent 0: 禁用 keepalive，防止 HLS 片段切换时 404 导致 FFmpeg 异常退出
  // -reconnect_delay_max 10: 给更长的重连窗口容忍短暂网络抖动
  return `-fflags +genpts -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10 -http_persistent 0 ${headers} -rw_timeout 15000000`;
}

function remoteControlFile(taskId) {
  return `/tmp/restream_${parseInt(taskId, 10)}.control`;
}

function controlPreamble(task) {
  const controlFile = remoteControlFile(task.id);
  return [
    `_CONTROL_FILE="${controlFile}"`,
    `_CONTROL_WATCH_PID=""`,
    `_require_control() {`,
    `  if [ ! -s "$_CONTROL_FILE" ]; then echo "[CONTROL_STOP] missing $_CONTROL_FILE"; return 1; fi`,
    `  _CTRL_STATE=$(head -n 1 "$_CONTROL_FILE" 2>/dev/null | tr -d ' \\r\\n')`,
    `  if [ "$_CTRL_STATE" != "run" ]; then echo "[CONTROL_STOP] state=$_CTRL_STATE"; return 1; fi`,
    `  return 0`,
    `}`,
    `_stop_control_watch() {`,
    `  if [ -n "$_CONTROL_WATCH_PID" ]; then`,
    `    kill "$_CONTROL_WATCH_PID" 2>/dev/null || true`,
    `    wait "$_CONTROL_WATCH_PID" 2>/dev/null || true`,
    `    _CONTROL_WATCH_PID=""`,
    `  fi`,
    `}`,
    `_control_kill_descendants() {`,
    `  _ROOT="$1"`,
    `  _SELF="${'${BASHPID:-$$}'}"`,
    `  _SCAN="$_ROOT"`,
    `  _PIDS=""`,
    `  if command -v pgrep >/dev/null 2>&1; then`,
    `    while [ -n "$_SCAN" ]; do`,
    `      _NEXT=""`,
    `      for _PP in $_SCAN; do`,
    `        for _CP in $(pgrep -P "$_PP" 2>/dev/null); do`,
    `          [ "$_CP" = "$_SELF" ] && continue`,
    `          _PIDS="$_PIDS $_CP"`,
    `          _NEXT="$_NEXT $_CP"`,
    `        done`,
    `      done`,
    `      _SCAN="$_NEXT"`,
    `    done`,
    `  fi`,
    `  for _P in $_PIDS; do kill -TERM "$_P" 2>/dev/null || true; done`,
    `  sleep 0.5`,
    `  for _P in $_PIDS; do kill -KILL "$_P" 2>/dev/null || true; done`,
    `}`,
    `_start_control_watch() {`,
    `  _require_control || return 1`,
    `  (`,
    `    while true; do`,
    `      sleep 5`,
    `      if ! _require_control; then`,
    `        echo "[CONTROL_STOP] task control revoked, stopping process tree"`,
    `        _control_kill_descendants "$$"`,
    `        kill -TERM "$$" 2>/dev/null || true`,
    `        exit 0`,
    `      fi`,
    `    done`,
    `  ) &`,
    `  _CONTROL_WATCH_PID=$!`,
    `}`,
  ].join('\n');
}

function remoteDependencyInstallCommand() {
  return [
    'if ! command -v wget >/dev/null 2>&1; then apt-get update -y && apt-get install -y wget ca-certificates; fi',
    'if ! command -v ffmpeg >/dev/null 2>&1; then apt-get update -y && apt-get install -y ffmpeg; fi',
    'if ! command -v python3 >/dev/null 2>&1; then apt-get update -y && apt-get install -y python3; fi',
    'if ! command -v streamlink >/dev/null 2>&1; then apt-get update -y && apt-get install -y python3-pip ca-certificates && (pip3 install -q --break-system-packages --upgrade streamlink || pip3 install -q --upgrade streamlink); fi',
    'if ! command -v yt-dlp >/dev/null 2>&1; then ARCH=$(uname -m); if [ "$ARCH" = "aarch64" ]; then YT_BIN=yt-dlp_linux_aarch64; elif [ "$ARCH" = "armv7l" ]; then YT_BIN=yt-dlp_linux_armv7l; else YT_BIN=yt-dlp_linux; fi; wget -qO /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT_BIN" && chmod +x /usr/local/bin/yt-dlp; elif [ $(( $(date +%s) - $(stat -c %Y /usr/local/bin/yt-dlp 2>/dev/null || echo $(date +%s)) )) -gt 604800 ]; then yt-dlp -U 2>/dev/null || true; fi',
  ].join(' && ');
}

function buildCommand(task) {
  const dest = `${dqEsc(task.rtmp_url)}/${dqEsc(task.stream_key)}`;
  const fallbackDest = youtubeBackupDest(task) || dest;
  const logFile = `/tmp/restream_${task.id}.log`;
  const outArgs = ffmpegOutputArgs();
  const recordArgs = ffmpegRecordArgs();
  const hasBackup = fallbackDest !== dest;
  // tee muxer: 将完全相同的流同时推到 YouTube 主推地址和备用地址
  // flvflags=no_duration_filesize 在每个 tee 子输出内部指定（tee 容器本身不认识该选项）
  const teeSpec = hasBackup
    ? `[f=flv:flvflags=no_duration_filesize:onfail=ignore]${dest}|[f=flv:flvflags=no_duration_filesize:onfail=ignore]${fallbackDest}`
    : '';
  const teeOut = hasBackup ? `-f tee "${teeSpec}"` : `-f flv "${dest}"`;
  const outArgsTee = hasBackup ? outArgs.replace(' -flvflags no_duration_filesize', '') : outArgs;
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
    // 媒体库文件：循环推送；HEVC 源文件自动转码为 H.264（FLV 不支持 HEVC 直通）
    inner = `${controlPreamble(task)}
_require_control || exit 0
_start_control_watch || exit 0
trap '_stop_control_watch; exit 0' INT TERM
_SRC_FILE="${dqEsc(task.source_url)}"
_VID_CODEC=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$_SRC_FILE" 2>/dev/null | head -1 | tr -d '\\r\\n')
if [ "$_VID_CODEC" = "hevc" ] || [ "$_VID_CODEC" = "h265" ]; then
  echo "[转码] 检测到 HEVC 视频，自动转码为 H.264 以兼容 RTMP/FLV（CPU 占用会增加）"
  ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_SRC_FILE" -map 0:v:0 -map 0:a:0? -dn -sn -c:v libx264 -preset veryfast -crf 18 -g 48 -keyint_min 48 -c:a copy -avoid_negative_ts make_zero${hasBackup ? '' : ' -flvflags no_duration_filesize'} ${teeOut}
else
  echo "[推流] 视频直通模式（$_VID_CODEC）"
  ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_SRC_FILE" ${outArgsTee} ${teeOut}
fi
_RC=$?
_stop_control_watch
exit "$_RC"`;
  } else {
    // 网络直播：循环解析直链 + 推流（直链过期或 ffmpeg 退出后自动重新获取）
    const isDouyin   = /douyin\.com/i.test(task.source_url);
    const isBilibili = /live\.bilibili\.com/i.test(task.source_url);
    const isKuaishou = /live\.kuaishou\.com|v\.kuaishou\.com|kuaishou\.com\/short-video/i.test(task.source_url);
    const isTiktok   = !isDouyin && !isKuaishou && /tiktok\.com/i.test(task.source_url);
    const ckArg   = task._douyinCookieFile ? `--add-header "Cookie:$_DOUYIN_COOKIE"` : '';
    const ckRawArg = task._douyinCookieFile ? `"$_DOUYIN_COOKIE"` : `""`;
    const ytHdrs  = isDouyin
      ? `--add-header "Referer: https://live.douyin.com/" --add-header "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`
      : (isTiktok
        ? `--add-header "Referer: https://www.tiktok.com/" --add-header "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"`
        : '');
    const ffmpegHdrs = isDouyin
      ? `-headers "Referer: https://live.douyin.com/\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\\r\\n"`
      : (isTiktok
        ? `-headers "Referer: https://www.tiktok.com/\\r\\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\\r\\n"`
        : '');
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
    const ksHelper = isKuaishou ? '/opt/restream-console/check_kuaishou.py' : '';
    const tkHelper = isTiktok ? '/opt/restream-console/check_tiktok.py' : '';

    // 中继 URL：当 VPS IP 被抖音封锁时，通过主应用服务器解析直链
    const relaySecret = process.env.RELAY_SECRET || '';
    const relayHost = process.env.RELAY_HOST || '';
    const relayUrl = (isDouyin && relaySecret && relayHost && task.user_id)
      ? `http://${relayHost}/api/douyin-relay?secret=${relaySecret}&user_id=${task.user_id}&url=`
      : '';
    const relayEnv = relayUrl ? `DOUYIN_RELAY_URL=${shSingleQuote(relayUrl)} ` : '';

    inner = [
      controlPreamble(task),
      `export LC_ALL=C.UTF-8 2>/dev/null || export LC_ALL=en_US.UTF-8 2>/dev/null || true`,
      `_STATUS_FILE="/tmp/restream_${task.id}.status"`,
      `_write_status() {`,
      `  _STATUS_BG_PID="${'${6:-0}'}"`,
      `  _STATUS_COVER_TYPE="${'${7:-}'}"`,
      `  printf '{"state":"%s","source":"%s","target":"%s","fallback":%s,"fallback_round":%d,"ts":%d,"pid":%d,"bg_pid":%d,"cover_type":"%s"}\\n' "$1" "$2" "$3" "$4" "$5" "$(date +%s)" "$$" "$_STATUS_BG_PID" "$_STATUS_COVER_TYPE" > "$_STATUS_FILE" 2>/dev/null || true`,
      `}`,
      `_write_status idle unknown unknown false 0 0`,
      `_FIRST=1`,
      `_MISS=0`,
      `_OFFLINE_HOLD_MISS_LIMIT=3`,
      `_FALLBACK_ROUND=0`,
      `_TASK_FALLBACK_FILE="${dqEsc(task.fallback_file_path || '')}"`,
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
      `  _stop_control_watch`,
      `  _drop_bg_cover_nowait`,
      `  _finalize_auto_record_tmp`,
      `  exit 0`,
      `}`,
      `trap _cleanup_on_term INT TERM`,
      `_start_control_watch || exit 0`,
      `_reset_auto_record_for_next_live() {`,
      `  rm -f "$_AUTO_REC_DONE"`,
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
      `    return`,
      `  fi`,
      `  if [ -n "$_TASK_FALLBACK_FILE" ] && [ -s "$_TASK_FALLBACK_FILE" ]; then`,
      `    _PLAY_REC="$_TASK_FALLBACK_FILE"`,
      `    echo "[兜底-任务文件] 使用任务配置的兜底媒体文件: $_TASK_FALLBACK_FILE"`,
      `    return`,
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
      `  timeout "$_FALLBACK_SECONDS" ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_PLAY_REC" ${outArgsTee} ${teeOut}`,
      `  _FB_RC=$?`,
      `  if [ "$_FB_RC" -ne 0 ] && [ "$_FB_RC" -ne 124 ]; then`,
      `    _write_status target_lost live lost false 0 0`,
      `    echo "[TARGET_LOST] fallback push failed rc=$_FB_RC; target RTMP/live event may have ended"`,
      `    return 2`,
      `  fi`,
      `  echo "[兜底-录播] 录播兜底结束，重新探测直播源..."`,
      `  return 0`,
      `}`,
      `_hold_auto_record_forever() {`,
      `  _pick_auto_record_for_fallback`,
      `  [ -z "$_PLAY_REC" ] && return 1`,
      `  _FALLBACK_ROUND=$((_FALLBACK_ROUND + 1))`,
      `  echo "[兜底-保持] 已确认直播源下播，停止探测，循环播放录播保持 YouTube 推流: $_PLAY_REC"`,
      `  if [ -n "$_BG_COVER_PID" ] && kill -0 "$_BG_COVER_PID" 2>/dev/null; then`,
      `    echo "[兜底-保持] 后台录播仍在推流，只进入保持监控，不主动切断 YouTube 数据流"`,
      `    while true; do`,
      `      _require_control || return 0`,
      `      _write_status fallback offline connected true "$_FALLBACK_ROUND" "$_BG_COVER_PID" rec_hold`,
      `      kill -0 "$_BG_COVER_PID" 2>/dev/null || { echo "[兜底-保持] 后台录播退出，改为前台保持重推"; _BG_COVER_PID=""; break; }`,
      `      sleep 5`,
      `    done`,
      `  fi`,
      `  while true; do`,
      `    _require_control || return 0`,
      `    _write_status fallback offline connected true "$_FALLBACK_ROUND" "$$" rec_hold`,
      `    ${encodeNotice}`,
      `    ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_PLAY_REC" ${outArgsTee} ${teeOut}`,
      `    _HOLD_RC=$?`,
      `    _require_control || return 0`,
      `    _write_status target_lost offline lost true "$_FALLBACK_ROUND" "$$" rec_hold`,
      `    echo "[TARGET_LOST] 录播保持推流退出 rc=$_HOLD_RC，3 秒后继续尝试维持 YouTube 数据流"`,
      `    sleep 3`,
      `  done`,
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
      `  _FALLBACK_ROUND=$((_FALLBACK_ROUND + 1))`,
      `  (exec -a restream_bg_${task.id} ffmpeg -stream_loop -1 -re -fflags +genpts -i "$_PLAY_REC" ${outArgs} -f flv "${fallbackDest}") >/tmp/restream_bgcover_${task.id}.log 2>&1 &`,
      `  _NEW_BG_COVER_PID=$!`,
      `  sleep 3`,
      `  if ! kill -0 "$_NEW_BG_COVER_PID" 2>/dev/null; then`,
      `    wait "$_NEW_BG_COVER_PID" 2>/dev/null || true`,
      `    echo "[兜底-后台] 录播覆盖启动失败（3s 内已退出），跳过后台兜底"`,
      `    return 1`,
      `  fi`,
      `  _BG_COVER_PID="$_NEW_BG_COVER_PID"`,
      `  _write_status fallback live unknown true "$_FALLBACK_ROUND" "$_BG_COVER_PID" rec`,
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
      `_has_active_cover() {`,
      `  if [ -n "$_BG_COVER_PID" ] && kill -0 "$_BG_COVER_PID" 2>/dev/null; then return 0; fi`,
      `  return 1`,
      `}`,
      `_live_pid_stable() {`,
      `  _LIVE_PID_TO_CHECK="$1"`,
      `  _LIVE_CHECKED=0`,
      `  while [ "$_LIVE_CHECKED" -lt 10 ]; do`,
      `    _require_control || return 1`,
      `    kill -0 "$_LIVE_PID_TO_CHECK" 2>/dev/null || return 1`,
      `    sleep 1`,
      `    _LIVE_CHECKED=$((_LIVE_CHECKED + 1))`,
      `  done`,
      `  kill -0 "$_LIVE_PID_TO_CHECK" 2>/dev/null`,
      `}`,
      `_kill_live_tree() {`,
      `  _ROOT_PID="$1"`,
      `  [ -z "$_ROOT_PID" ] && return 0`,
      `  _LIVE_KILL_PIDS="$_ROOT_PID"`,
      `  if command -v pgrep >/dev/null 2>&1; then`,
      `    _SCAN="$_ROOT_PID"`,
      `    while [ -n "$_SCAN" ]; do`,
      `      _NEXT=""`,
      `      for _PP in $_SCAN; do`,
      `        for _CP in $(pgrep -P "$_PP" 2>/dev/null); do`,
      `          _LIVE_KILL_PIDS="$_LIVE_KILL_PIDS $_CP"`,
      `          _NEXT="$_NEXT $_CP"`,
      `        done`,
      `      done`,
      `      _SCAN="$_NEXT"`,
      `    done`,
      `  fi`,
      `  for _P in $_LIVE_KILL_PIDS; do kill -TERM "$_P" 2>/dev/null || true; done`,
      `  sleep 1`,
      `  for _P in $_LIVE_KILL_PIDS; do kill -KILL "$_P" 2>/dev/null || true; done`,
      `  wait "$_ROOT_PID" 2>/dev/null || true`,
      `}`,
      `_wait_live_with_watchdog() {`,
      `  _LIVE_PUSH_PID="$1"`,
      `  _LIVE_LOG="$2"`,
      `  _LIVE_STALL_LIMIT=12`,
      `  _LIVE_GRACE=60`,
      `  _LIVE_STARTED_AT=$(date +%s)`,
      `  _LIVE_LAST_FRAME_PROGRESS="$_LIVE_STARTED_AT"`,
      `  _LIVE_LAST_TIME_TAG=""`,
      `  while kill -0 "$_LIVE_PUSH_PID" 2>/dev/null; do`,
      `    _require_control || { _kill_live_tree "$_LIVE_PUSH_PID"; wait "$_LIVE_PUSH_PID" 2>/dev/null; return 130; }`,
      `    _NOW=$(date +%s)`,
      `    if [ -s "$_LIVE_LOG" ]; then`,
      `      _CUR_TIME=$(tail -c 4096 "$_LIVE_LOG" 2>/dev/null | tr '\\r' '\\n' | grep -oE 'time=[0-9:]+\\.[0-9]+' | tail -1)`,
      `      if [ -n "$_CUR_TIME" ] && [ "$_CUR_TIME" != "$_LIVE_LAST_TIME_TAG" ]; then`,
      `        _LIVE_LAST_TIME_TAG="$_CUR_TIME"`,
      `        _LIVE_LAST_FRAME_PROGRESS="$_NOW"`,
      `      fi`,
      `    fi`,
      `    _AGE=$((_NOW - _LIVE_LAST_FRAME_PROGRESS))`,
      `    _UPTIME=$((_NOW - _LIVE_STARTED_AT))`,
      `    if [ "$_UPTIME" -ge "$_LIVE_GRACE" ] && [ "$_AGE" -ge "$_LIVE_STALL_LIMIT" ]; then`,
      `      echo "[LIVE_WATCHDOG] no frame progress for ${'${_AGE}'}s (last: ${'${_LIVE_LAST_TIME_TAG:-none}'}); switching to fallback before YouTube ends the live event"`,
      `      _ensure_bg_cover`,
      `      if _has_active_cover; then`,
      `        _kill_live_tree "$_LIVE_PUSH_PID"`,
      `        wait "$_LIVE_PUSH_PID" 2>/dev/null || true`,
      `        return 200`,
      `      fi`,
      `      _LIVE_LAST_FRAME_PROGRESS=$((_NOW + 54))`,
      `    fi`,
      `    sleep 2`,
      `  done`,
      `  wait "$_LIVE_PUSH_PID"`,
      `  return $?`,
      `}`,
      `_run_live_push() {`,
      `  _LIVE_MODE="$1"`,
      `  _LIVE_LOG="/tmp/restream_live_${task.id}_$$_$(date +%s).log"`,
      `  if _has_active_cover; then`,
      `    echo "[LIVE_HANDOFF] fallback/placeholder is active; start live output first and release fallback after stable"`,
      `    _write_status live_handoff live connected true "$_FALLBACK_ROUND" 0 live_handoff`,
      `    if [ "$_LIVE_MODE" = "record" ]; then`,
      `      timeout "$_FFMPEG_MAX_TIME" ffmpeg -re ${httpInputArgs} -i "$STREAM_URL" ${outArgsTee} ${teeOut} ${recordArgs} -t "$_AUTO_REC_MAX_SECONDS" -fs "$_AUTO_REC_MAX_BYTES" -flush_packets 1 -muxdelay 0 -muxpreload 0 -f mpegts "$_AUTO_REC_TMP" > "$_LIVE_LOG" 2>&1 &`,
      `    else`,
      `      timeout "$_FFMPEG_MAX_TIME" ffmpeg -re ${httpInputArgs} -i "$STREAM_URL" ${outArgsTee} ${teeOut} > "$_LIVE_LOG" 2>&1 &`,
      `    fi`,
      `    _LIVE_PUSH_PID=$!`,
      `    if _live_pid_stable "$_LIVE_PUSH_PID"; then`,
      `      echo "[LIVE_HANDOFF] live output is stable; releasing fallback/placeholder"`,
      `      _drop_bg_cover_nowait`,
      `      _wait_live_with_watchdog "$_LIVE_PUSH_PID" "$_LIVE_LOG"`,
      `      return $?`,
      `    fi`,
      `    wait "$_LIVE_PUSH_PID"`,
      `    _LIVE_PUSH_RC=$?`,
      `    echo "[LIVE_HANDOFF] live output was not stable rc=$_LIVE_PUSH_RC; keep fallback and retry"`,
      `    return "$_LIVE_PUSH_RC"`,
      `  fi`,
      `  if [ "$_LIVE_MODE" = "record" ]; then`,
      `    timeout "$_FFMPEG_MAX_TIME" ffmpeg -re ${httpInputArgs} -i "$STREAM_URL" ${outArgsTee} ${teeOut} ${recordArgs} -t "$_AUTO_REC_MAX_SECONDS" -fs "$_AUTO_REC_MAX_BYTES" -flush_packets 1 -muxdelay 0 -muxpreload 0 -f mpegts "$_AUTO_REC_TMP" > "$_LIVE_LOG" 2>&1 &`,
      `  else`,
      `    timeout "$_FFMPEG_MAX_TIME" ffmpeg -re ${httpInputArgs} -i "$STREAM_URL" ${outArgsTee} ${teeOut} > "$_LIVE_LOG" 2>&1 &`,
      `  fi`,
      `  _LIVE_PUSH_PID=$!`,
      `  _wait_live_with_watchdog "$_LIVE_PUSH_PID" "$_LIVE_LOG"`,
      `}`,
      `_probe_live_stream() {`,
      `  _require_control || return 1`,
      `  echo "[LIVE_PROBE] probing recovered live source before cutting fallback"`,
      `  timeout 18 ffmpeg -v error -nostdin ${httpInputArgs} -i "$STREAM_URL" -t 8 -map 0:v:0 -f null - >/tmp/restream_probe_${task.id}.log 2>&1`,
      `  _PROBE_RC=$?`,
      `  if [ "$_PROBE_RC" -ne 0 ]; then`,
      `    echo "[LIVE_PROBE] live source is not stable yet rc=$_PROBE_RC: $(tail -1 /tmp/restream_probe_${task.id}.log 2>/dev/null | tr -d '\\r' | cut -c1-180)"`,
      `    return 1`,
      `  fi`,
      `  echo "[LIVE_PROBE] live source produced video frames; safe to cut back"`,
      `  return 0`,
      `}`,
      task._douyinCookieFile
        ? `if [ -f "${task._douyinCookieFile}" ]; then _DOUYIN_COOKIE=$(tr -d '\\n' < "${task._douyinCookieFile}"); fi`
        : `true`,
      `while true; do`,
      `  _require_control || break`,
      `  if [ "$_FIRST" = "1" ] && [ -n "${firstUrl}" ]; then`,
      `    STREAM_URL="${firstUrl}"`,
      `    echo "[直链-API] ${firstUrl.substring(0, 80)}..."`,
      `    _FIRST=0`,
      `  else`,
      `    STREAM_URL=""`,
      `    _ensure_bg_cover`,
      `    for _SRC in ${urlsArr}; do`,
      `      _require_control || break`,
      `      echo "[解析] 尝试源: $_SRC"`,
      isDouyin
        ? `      if [ -f "${dyHelper}" ]; then STREAM_URL=$(${relayEnv}python3 "${dyHelper}" --stream-url "$_SRC" ${ckRawArg} 2>/tmp/restream_douyin_${task.id}.err | grep -m1 '^https\\?://'); if [ -n "$STREAM_URL" ]; then echo "[抖音解析] 使用源: $_SRC"; _MISS=0; break; fi; continue; fi`
        : (isKuaishou
          ? `      if [ -f "${ksHelper}" ]; then STREAM_URL=$(python3 "${ksHelper}" --stream-url "$_SRC" 2>/tmp/restream_kuaishou_${task.id}.err | grep -m1 '^https\\?://'); if [ -n "$STREAM_URL" ]; then echo "[快手解析] 使用源: $_SRC"; _MISS=0; break; fi; continue; fi`
          : (isTiktok
            ? `      if [ -f "${tkHelper}" ]; then STREAM_URL=$(python3 "${tkHelper}" --stream-url "$_SRC" 2>/tmp/restream_tiktok_${task.id}.err | grep -m1 '^https\\?://'); if [ -n "$STREAM_URL" ]; then echo "[TikTok解析] 使用源: $_SRC"; _MISS=0; break; fi; continue; fi`
            : `      true`)),
      `      STREAM_URL=$(yt-dlp --no-warnings --socket-timeout 15 --retries 2 --fragment-retries 2 ${ckArg} ${ytHdrs} ${ytFormatArgs} -g "$_SRC" 2>/tmp/restream_ytdlp_${task.id}.err | grep -m1 '^https\\?://')`,
      `      if [ -n "$STREAM_URL" ]; then echo "[yt-dlp] 使用源: $_SRC"; _MISS=0; break; fi`,
      `    done`,
      `  fi`,
      `  if [ -z "$STREAM_URL" ]; then`,
      `    _MISS=$((_MISS + 1))`,
      `    _SLEEP=$((15 * _MISS))`,
      `    if [ "$_SLEEP" -gt 300 ]; then _SLEEP=300; fi`,
      isDouyin
        ? `    if [ -s /tmp/restream_douyin_${task.id}.err ]; then echo "[解析失败-抖音]"; tail -5 /tmp/restream_douyin_${task.id}.err | tr -d '\\r' | cut -c1-200; fi`
        : (isKuaishou
          ? `    if [ -s /tmp/restream_kuaishou_${task.id}.err ]; then echo "[解析失败-快手]"; tail -5 /tmp/restream_kuaishou_${task.id}.err | tr -d '\\r' | cut -c1-200; fi`
          : (isTiktok
            ? `    if [ -s /tmp/restream_tiktok_${task.id}.err ]; then echo "[解析失败-TikTok]"; tail -5 /tmp/restream_tiktok_${task.id}.err | tr -d '\\r' | cut -c1-200; fi`
            : `    true`)),
      `    if [ -s /tmp/restream_ytdlp_${task.id}.err ]; then echo "[解析失败-yt-dlp]"; tail -3 /tmp/restream_ytdlp_${task.id}.err | tr -d '\\r' | cut -c1-200; fi`,
      `    _ensure_bg_cover`,
      `    if [ -n "$_BG_COVER_PID" ]; then`,
      `      if [ "$_MISS" -ge "$_OFFLINE_HOLD_MISS_LIMIT" ]; then`,
      `        echo "[兜底-保持] 连续 $_MISS 次无法获取直播直链，确认下播，停止探测并改为录播循环保持"`,
      `        _hold_auto_record_forever || true`,
      `      fi`,
      `      echo "[兜底-后台] 录播持续覆盖 YouTube，$_SLEEP 秒后重新探测..."`,
      `      _WAITED=0; while [ "$_WAITED" -lt "$_SLEEP" ]; do _require_control || break 2; sleep 5; _WAITED=$((_WAITED + 5)); kill -0 "$_BG_COVER_PID" 2>/dev/null || { echo "[兜底-后台] 录播进程意外退出，立即重启..."; _ensure_bg_cover; [ -n "$_BG_COVER_PID" ] || break; }; done`,
      `      continue`,
      `    fi`,
      `    if [ "$_MISS" -ge "$_OFFLINE_HOLD_MISS_LIMIT" ]; then`,
      `      echo "[兜底-保持] 连续 $_MISS 次无法获取直播直链，尝试使用录播循环保持 YouTube 推流"`,
      `      _hold_auto_record_forever || true`,
      `    fi`,
      `    if _push_auto_record_fallback 300; then`,
      `      _require_control || break`,
      `      sleep 3`,
      `      continue`,
      `    fi`,
      `    _write_status source_retry retry unknown false 0 0`,
      `    echo "[错误] 无法获取直链，$_SLEEP 秒后重试..."`,
      `    _WAITED=0; while [ "$_WAITED" -lt "$_SLEEP" ]; do _require_control || break 2; sleep 5; _WAITED=$((_WAITED + 5)); done`,
      `    continue`,
      `  fi`,
      `  _require_control || break`,
      `  if [ -n "$_BG_COVER_PID" ]; then`,
      `    echo "[直播恢复] 已重新获取直播源，延迟确认后再从录播兜底切回直播"`,
      `    _RECOVER_OK=1`,
      `    _RECOVER_WAIT=0`,
      `    while [ "$_RECOVER_WAIT" -lt 45 ]; do`,
      `      _require_control || { _RECOVER_OK=0; break; }`,
      `      if [ -n "$_BG_COVER_PID" ]; then kill -0 "$_BG_COVER_PID" 2>/dev/null || { _RECOVER_OK=0; break; }; fi`,
      `      sleep 5`,
      `      _RECOVER_WAIT=$((_RECOVER_WAIT + 5))`,
      `    done`,
      `    [ "$_RECOVER_OK" = "1" ] && _probe_live_stream || _RECOVER_OK=0`,
      `    [ "$_RECOVER_OK" = "1" ] || { echo "[直播恢复] 确认期间兜底或控制信号变化，继续探测"; continue; }`,
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
      `  ${encodeNotice}`,
      `  if [ -f "$_AUTO_REC_DONE" ]; then`,
      `    echo "[录播] 本场已留存录播文件，本轮只推直播源"`,
      `    _run_live_push direct`,
      `  else`,
      `    _prepare_auto_record_file`,
      `    rm -f "$_AUTO_REC_TMP"`,
      `    echo "[录播] 与主推流共用同一条输入录制，最多 ${'$_AUTO_REC_MAX_SECONDS'} 秒或 2GB：$_AUTO_REC_FILE"`,
      `    _run_live_push record`,
      `  fi`,
      `  _FFMPEG_RC=$?`,
      `  _ensure_bg_cover || _ensure_bg_cover || true`,
      `  if [ -z "$_BG_COVER_PID" ]; then _ensure_bg_cover || true; fi`,
      `  _finalize_auto_record_tmp`,
      `  if [ "$_FFMPEG_RC" -eq 124 ]; then echo "[TTL] 直链到期主动刷新，重新获取直链..."; elif [ "$_FFMPEG_RC" -ne 0 ]; then echo "[FFMPEG_EXIT] main ffmpeg exited rc=$_FFMPEG_RC; will inspect source/target and retry"; _FFMPEG_ERR=$(grep -v '^frame=' "$_LIVE_LOG" 2>/dev/null | grep -iE 'error|fail|refused|reject|rtmp|Connection|timeout|Invalid|forbidden|Output' | tail -3 | tr -s ' \\r\\n' ' ' | cut -c1-300); [ -n "$_FFMPEG_ERR" ] && echo "[FFMPEG_ERR] $_FFMPEG_ERR"; fi`,
      `  echo "[退出] ffmpeg 退出(code=$_FFMPEG_RC)，准备快速兜底/重连..."`,
      `  if [ -n "$_BG_COVER_PID" ]; then`,
      `    _MISS=0`,
      `    echo "[兜底-后台] 录播持续覆盖中，先确认直播源是否已恢复..."`,
      `    sleep 3`,
      `    continue`,
      `  fi`,
      `  if _push_auto_record_fallback 90; then`,
      `    _MISS=0`,
      `    _require_control || break`,
      `    sleep 1`,
      `    continue`,
      `  fi`,
      `  _MISS=$((_MISS + 1))`,
      `  _SLEEP=$((5 * _MISS))`,
      `  if [ "$_SLEEP" -gt 30 ]; then _SLEEP=30; fi`,
      `  echo "[重连] $_SLEEP 秒后重新获取直链..."`,
      `  _WAITED=0; while [ "$_WAITED" -lt "$_SLEEP" ]; do _require_control || break 2; sleep 5; _WAITED=$((_WAITED + 5)); done`,
      `done`,
      `_cleanup_on_term`,
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
  remoteControlFile,
  MEDIA_LIBRARY_DIR,
  AUTO_RECORDING_PREFIX,
};
