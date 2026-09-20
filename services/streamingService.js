const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const Stream = require('../models/Stream');
const Playlist = require('../models/Playlist');
const Video = require('../models/Video');

let ffmpegPath;
if (fs.existsSync('/usr/bin/ffmpeg')) {
  ffmpegPath = '/usr/bin/ffmpeg';
} else {
  ffmpegPath = ffmpegInstaller.path;
}

let ffprobePath;
if (fs.existsSync('/usr/bin/ffprobe')) {
  ffprobePath = '/usr/bin/ffprobe';
} else {
  ffprobePath = ffprobeInstaller.path;
}

function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

const activeStreams = new Map();
const streamLogs = new Map();
const streamRetryCount = new Map();
const manuallyStoppingStreams = new Set();
const startingStreams = new Set();

const MAX_LOG_LINES = 50;
const MAX_RETRY_ATTEMPTS = 15;
const BASE_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 30000;
const HEALTH_CHECK_INTERVAL = 30000;
const SYNC_INTERVAL = 60000;
const STREAM_START_TIMEOUT = 15000;

// on Linux (VPS) ffmpeg runs detached from this process, writing its output
// to a log file, so live streams keep running through app restarts and are
// re-adopted on the next boot. On Windows (local dev) nothing changes:
// attached pipes, streams die with the app like before.
const DETACHED_STREAMS = process.platform === 'linux';
const FFMPEG_LOG_DIR = path.join(path.resolve(__dirname, '..'), 'logs', 'ffmpeg');
const FFMPEG_LOG_MAX_BYTES = 100 * 1024 * 1024;

const YOUTUBE_COPY_ALLOWED_VIDEO_CODECS = new Set(['h264']);
const YOUTUBE_COPY_ALLOWED_AUDIO_CODECS = new Set(['aac', 'mp3']);

let schedulerService = null;
let syncIntervalId = null;
let healthCheckIntervalId = null;
let initialized = false;

function setSchedulerService(service) {
  schedulerService = service;

  if (!initialized) {
    initialized = true;
    syncIntervalId = setInterval(syncStreamStatuses, SYNC_INTERVAL);
    healthCheckIntervalId = setInterval(healthCheckStreams, HEALTH_CHECK_INTERVAL);
  }
}

function addStreamLog(streamId, message) {
  if (!streamLogs.has(streamId)) {
    streamLogs.set(streamId, []);
  }
  const logs = streamLogs.get(streamId);
  logs.push({ timestamp: new Date().toISOString(), message });
  if (logs.length > MAX_LOG_LINES) {
    logs.shift();
  }
}

function getStreamLogs(streamId) {
  return streamLogs.get(streamId) || [];
}

function cleanupStreamData(streamId) {
  streamRetryCount.delete(streamId);
  manuallyStoppingStreams.delete(streamId);
  startingStreams.delete(streamId);
  stopLogTailer(streamId);
  try { fs.unlinkSync(ffmpegPidPath(streamId)); } catch (e) { }
  db.run('UPDATE streams SET ffmpeg_pid = NULL WHERE id = ?', [streamId]);
}

function ffmpegLogPath(streamId) {
  return path.join(FFMPEG_LOG_DIR, `stream-${streamId}.log`);
}

function ffmpegPidPath(streamId) {
  return path.join(FFMPEG_LOG_DIR, `stream-${streamId}.pid`);
}

// resolves once the launcher has written FFmpeg's real pid, or rejects fast
// when the launcher dies without ever starting FFmpeg
function waitForPidFile(pidFile, launcher, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let launcherDied = false;

    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      launcher.removeAllListeners('exit');
      launcher.removeAllListeners('error');
      fn(value);
    };

    launcher.on('error', (err) => {
      launcherDied = true;
      finish(reject, new Error(`Failed to launch FFmpeg: ${err.message}`));
    });
    launcher.on('exit', () => {
      // the launcher exits right after a successful spawn too — only a
      // missing pid file at this point means FFmpeg never started
      launcherDied = true;
    });

    const poll = setInterval(() => {
      if (launcherDied && !fs.existsSync(pidFile)) {
        finish(reject, new Error('FFmpeg launcher exited before FFmpeg started'));
        return;
      }
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (pid > 0) {
          finish(resolve, pid);
        }
      } catch (e) { /* pid file not written yet */ }
    }, 50);

    const timer = setTimeout(() => {
      try { launcher.kill(); } catch (e) { }
      finish(reject, new Error('Timed out waiting for the FFmpeg launcher'));
    }, timeoutMs);

    if (typeof poll.unref === 'function') {
      poll.unref();
    }
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

function isFfmpegPidAlive(pid) {
  if (!pid || process.platform !== 'linux') {
    return false;
  }
  try {
    process.kill(pid, 0);
    // guard against pid recycling: only trust a pid that is still ffmpeg
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('ffmpeg');
  } catch (e) {
    return false;
  }
}

// shared by the pipe handler (attached mode) and the file tailer (detached
// mode): progress lines confirm startup, everything else feeds the console
function processFfmpegLogLine(streamId, line, startupState) {
  if (!line) {
    return;
  }

  updateStreamActivity(streamId);

  if (isProgressLogLine(line)) {
    if (startupState && startupState.resolve) {
      startupState.resolve();
    }
    return;
  }

  addStreamLog(streamId, `[FFmpeg] ${line}`);

  if (!startupState) {
    return;
  }

  const relevantLog = getRelevantStartupLog(line);
  if (relevantLog) {
    startupState.lastLogLine = relevantLog;

    if (/(error|failed|invalid|unsupported|broken pipe|connection.*refused|input\/output error|could not write header)/i.test(relevantLog)) {
      startupState.lastErrorLine = relevantLog;
    }
  }
}

const logTailers = new Map();

// detached ffmpeg writes stdout/stderr to a file; poll it so the in-app
// console, startup detection and the stale-stream health check keep working
function startLogTailer(streamId, startOffset = 0) {
  stopLogTailer(streamId);
  const logFile = ffmpegLogPath(streamId);
  const state = { offset: startOffset, pending: '', timer: null, stopped: false };

  const poll = () => {
    if (state.stopped) {
      return;
    }
    try {
      let size = fs.statSync(logFile).size;

      // stats lines accumulate ~15-20MB/day on a 24/7 stream; cap the file so
      // it can't grow forever. ffmpeg appends with O_APPEND, so truncating
      // from outside is safe — its next write lands at the new end.
      if (size > FFMPEG_LOG_MAX_BYTES) {
        fs.truncateSync(logFile, 0);
        state.offset = 0;
        state.pending = '';
        size = 0;
      }

      if (size <= state.offset) {
        return;
      }
      const fd = fs.openSync(logFile, 'r');
      const buffer = Buffer.alloc(size - state.offset);
      fs.readSync(fd, buffer, 0, buffer.length, state.offset);
      fs.closeSync(fd);
      state.offset = size;

      state.pending += buffer.toString('utf8');
      // ffmpeg progress lines are carriage-return separated (they rewrite one
      // terminal line), so both \r and \n must count as line endings —
      // waiting for \n alone starves startup detection on healthy streams
      const lastSep = Math.max(state.pending.lastIndexOf('\n'), state.pending.lastIndexOf('\r'));
      if (lastSep === -1) {
        return;
      }
      const complete = state.pending.slice(0, lastSep);
      state.pending = state.pending.slice(lastSep + 1);

      const streamData = activeStreams.get(streamId);
      const startupState = streamData ? streamData.startupState : null;
      for (const rawLine of complete.split(/\r\n|\r|\n/g)) {
        processFfmpegLogLine(streamId, rawLine.trim(), startupState);
      }
    } catch (e) {
      // log file may not exist yet between spawn and ffmpeg's first write
    }
  };

  state.timer = setInterval(poll, 1000);
  if (typeof state.timer.unref === 'function') {
    state.timer.unref();
  }
  logTailers.set(streamId, state);
}

function stopLogTailer(streamId) {
  const state = logTailers.get(streamId);
  if (state) {
    state.stopped = true;
    clearInterval(state.timer);
    logTailers.delete(streamId);
  }
}

function getRetryDelay(retryCount) {
  const delay = Math.min(BASE_RETRY_DELAY * Math.pow(1.5, retryCount), MAX_RETRY_DELAY);
  return delay + Math.random() * 1000;
}

function getProjectRoot() {
  return path.resolve(__dirname, '..');
}

function resolvePublicFilePath(relativePath) {
  if (!relativePath) {
    throw new Error('Missing media filepath');
  }

  const relPath = relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
  return path.join(getProjectRoot(), 'public', relPath);
}

function isYouTubeDestination(stream) {
  if (stream && stream.is_youtube_api) {
    return true;
  }

  const rtmpUrl = (stream.rtmp_url || '').toLowerCase();
  return rtmpUrl.includes('youtube.com');
}

function isProgressLogLine(line) {
  return line.includes('frame=') || line.includes('time=') || line.includes('speed=');
}

function buildMediaLabel(media, index, type) {
  if (media && media.title) {
    return `${type} "${media.title}"`;
  }

  return `${type} #${index + 1}`;
}

function isSupportedYouTubePixelFormat(pixFmt) {
  const normalized = (pixFmt || '').toLowerCase();
  return normalized === 'yuv420p' || normalized === 'yuvj420p';
}

function getPrimaryStream(probeData, codecType) {
  return (probeData.streams || []).find(stream => stream.codec_type === codecType) || null;
}

function getFrameRateLabel(videoStream) {
  return videoStream && videoStream.avg_frame_rate ? videoStream.avg_frame_rate : 'unknown fps';
}

function buildCopyModeCompatibilityError(label, detail) {
  return `${label} tidak kompatibel dengan YouTube: ${detail}.`;
}

function createUnsupportedCopyModeError(message) {
  const error = new Error(message);
  error.code = 'UNSUPPORTED_COPY_MODE_MEDIA';
  return error;
}

function getRelevantStartupLog(line) {
  const trimmed = (line || '').trim();
  if (!trimmed || isProgressLogLine(trimmed)) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('press [q]') ||
    lower.startsWith('input #') ||
    lower.startsWith('output #') ||
    lower.startsWith('metadata:') ||
    lower.startsWith('stream mapping:')
  ) {
    return null;
  }

  return trimmed;
}

function buildStartupFailureMessage(startupState, fallbackMessage = null) {
  const detail = startupState.lastErrorLine || startupState.lastLogLine || fallbackMessage;
  if (detail) {
    return `FFmpeg gagal memulai stream: ${detail}`;
  }

  return 'FFmpeg gagal memulai stream';
}

function runFFprobe(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobeProcess = spawn(ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    ffprobeProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ffprobeProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobeProcess.on('error', (error) => {
      reject(error);
    });

    ffprobeProcess.on('exit', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function validateYouTubeCopyVideoProbe(probeData, label) {
  const videoStream = getPrimaryStream(probeData, 'video');
  if (!videoStream) {
    return buildCopyModeCompatibilityError(label, 'video stream tidak ditemukan');
  }

  const videoCodec = (videoStream.codec_name || '').toLowerCase();
  if (!YOUTUBE_COPY_ALLOWED_VIDEO_CODECS.has(videoCodec)) {
    return buildCopyModeCompatibilityError(label, `codec video ${videoCodec || 'unknown'} tidak didukung`);
  }

  if (!isSupportedYouTubePixelFormat(videoStream.pix_fmt)) {
    return buildCopyModeCompatibilityError(label, `pixel format ${videoStream.pix_fmt || 'unknown'} bukan 4:2:0 standar`);
  }

  const audioStream = getPrimaryStream(probeData, 'audio');
  if (audioStream) {
    const audioCodec = (audioStream.codec_name || '').toLowerCase();
    if (!YOUTUBE_COPY_ALLOWED_AUDIO_CODECS.has(audioCodec)) {
      return buildCopyModeCompatibilityError(label, `codec audio ${audioCodec || 'unknown'} tidak didukung`);
    }
  }

  return null;
}

function validateYouTubeCopyAudioProbe(probeData, label) {
  const audioStream = getPrimaryStream(probeData, 'audio');
  if (!audioStream) {
    return buildCopyModeCompatibilityError(label, 'audio stream tidak ditemukan');
  }

  const audioCodec = (audioStream.codec_name || '').toLowerCase();
  if (!YOUTUBE_COPY_ALLOWED_AUDIO_CODECS.has(audioCodec)) {
    return buildCopyModeCompatibilityError(label, `codec audio ${audioCodec || 'unknown'} tidak didukung`);
  }

  return null;
}

function validatePlaylistCopyConsistency(referenceStream, currentStream, label) {
  const mismatches = [];

  if ((currentStream.codec_name || '').toLowerCase() !== (referenceStream.codec_name || '').toLowerCase()) {
    mismatches.push('codec video berbeda');
  }

  if (currentStream.width !== referenceStream.width || currentStream.height !== referenceStream.height) {
    mismatches.push('resolusi berbeda');
  }

  if ((currentStream.pix_fmt || '').toLowerCase() !== (referenceStream.pix_fmt || '').toLowerCase()) {
    mismatches.push('pixel format berbeda');
  }

  if (getFrameRateLabel(currentStream) !== getFrameRateLabel(referenceStream)) {
    mismatches.push('frame rate berbeda');
  }

  if (mismatches.length === 0) {
    return null;
  }

  return `${label} tidak bisa digabung aman di copy mode YouTube karena ${mismatches.join(', ')}.`;
}

async function validateCopyModeCompatibility(stream) {
  return validateCopyModeCompatibilityForInput({
    videoId: stream.video_id,
    useAdvancedSettings: stream.use_advanced_settings,
    isYouTubeApi: stream.is_youtube_api,
    rtmpUrl: stream.rtmp_url
  });
}

async function validateCopyModeCompatibilityForInput({
  videoId,
  useAdvancedSettings = false,
  isYouTubeApi = false,
  rtmpUrl = ''
}) {
  if (useAdvancedSettings || !isYouTubeDestination({ is_youtube_api: isYouTubeApi, rtmp_url: rtmpUrl })) {
    return;
  }

  const playlist = await Playlist.findByIdWithVideos(videoId);

  if (playlist) {
    if (!playlist.videos || playlist.videos.length === 0) {
      throw new Error('Playlist is empty');
    }

    let referenceVideoStream = null;

    for (let index = 0; index < playlist.videos.length; index++) {
      const video = playlist.videos[index];
      const probeData = await runFFprobe(resolvePublicFilePath(video.filepath));
      const label = buildMediaLabel(video, index, 'Video');
      const compatibilityError = validateYouTubeCopyVideoProbe(probeData, label);

      if (compatibilityError) {
        throw createUnsupportedCopyModeError(compatibilityError);
      }

      const currentVideoStream = getPrimaryStream(probeData, 'video');
      if (!referenceVideoStream) {
        referenceVideoStream = currentVideoStream;
      } else {
        const consistencyError = validatePlaylistCopyConsistency(referenceVideoStream, currentVideoStream, label);
        if (consistencyError) {
          throw createUnsupportedCopyModeError(consistencyError);
        }
      }
    }

    for (let index = 0; index < (playlist.audios || []).length; index++) {
      const audio = playlist.audios[index];
      const probeData = await runFFprobe(resolvePublicFilePath(audio.filepath));
      const label = buildMediaLabel(audio, index, 'Audio');
      const compatibilityError = validateYouTubeCopyAudioProbe(probeData, label);

      if (compatibilityError) {
        throw createUnsupportedCopyModeError(compatibilityError);
      }
    }

    return;
  }

  const video = await Video.findById(videoId);
  if (!video) {
    throw new Error('Video not found');
  }

  const compatibilityError = validateYouTubeCopyVideoProbe(
    await runFFprobe(resolvePublicFilePath(video.filepath)),
    buildMediaLabel(video, 0, 'Video')
  );

  if (compatibilityError) {
    throw createUnsupportedCopyModeError(compatibilityError);
  }
}

function waitForStreamStartup(streamId, ffmpegProcess, startupState) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const finishReject = (message) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      finishReject(buildStartupFailureMessage(
        startupState,
        `tidak ada progres FFmpeg dalam ${Math.round(STREAM_START_TIMEOUT / 1000)} detik`
      ));
    }, STREAM_START_TIMEOUT);

    startupState.resolve = finishResolve;

    startupState.reject = finishReject;
  });
}

async function buildFFmpegArgsForPlaylist(stream, playlist) {
  if (!playlist.videos || playlist.videos.length === 0) {
    throw new Error('Playlist is empty');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const tempDir = path.join(projectRoot, 'temp');

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  let videoPaths = [];
  const videos = playlist.is_shuffle ? shuffleArray(playlist.videos) : playlist.videos;

  for (const video of videos) {
    const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
    const fullPath = path.join(projectRoot, 'public', relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Video file not found: ${fullPath}`);
    }
    videoPaths.push(fullPath);
  }

  const concatFile = path.join(tempDir, `playlist_${stream.id}.txt`);
  let content = '';
  const loopCount = stream.loop_video ? 10000 : 1;

  for (let i = 0; i < loopCount; i++) {
    for (const vp of videoPaths) {
      content += `file '${vp.replace(/\\/g, '/')}'\n`;
    }
  }
  fs.writeFileSync(concatFile, content);

  const hasAudio = playlist.audios && playlist.audios.length > 0;

  if (!hasAudio) {
    if (!stream.use_advanced_settings) {
      return [
        '-nostdin',
        '-loglevel', 'warning',
        '-stats',
        '-re',
        '-fflags', '+genpts+igndts+discardcorrupt',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        rtmpUrl
      ];
    }

    const resolution = stream.resolution || '1280x720';
    const bitrate = stream.bitrate || 2500;
    const fps = stream.fps || 30;

    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'high',
      '-level', '4.1',
      '-b:v', `${bitrate}k`,
      '-maxrate', `${Math.round(bitrate * 1.1)}k`,
      '-bufsize', `${bitrate * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2),
      '-keyint_min', String(fps),
      '-sc_threshold', '0',
      '-s', resolution,
      '-r', String(fps),
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl
    ];
  }

  let audioPaths = [];
  const audios = playlist.is_shuffle ? shuffleArray(playlist.audios) : playlist.audios;

  for (const audio of audios) {
    const relPath = audio.filepath.startsWith('/') ? audio.filepath.substring(1) : audio.filepath;
    const fullPath = path.join(projectRoot, 'public', relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Audio file not found: ${fullPath}`);
    }
    audioPaths.push(fullPath);
  }

  const audioConcatFile = path.join(tempDir, `playlist_audio_${stream.id}.txt`);
  let audioContent = '';
  for (let i = 0; i < 10000; i++) {
    for (const ap of audioPaths) {
      audioContent += `file '${ap.replace(/\\/g, '/')}'\n`;
    }
  }
  fs.writeFileSync(audioConcatFile, audioContent);

  if (!stream.use_advanced_settings) {
    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-re',
      '-f', 'concat',
      '-safe', '0',
      '-i', audioConcatFile,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl
    ];
  }

  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatFile,
    '-re',
    '-f', 'concat',
    '-safe', '0',
    '-i', audioConcatFile,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.1)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-s', resolution,
    '-r', String(fps),
    '-c:a', 'copy',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];
}

async function buildFFmpegArgs(stream) {
  const streamWithVideo = await Stream.getStreamWithVideo(stream.id);

  if (streamWithVideo && streamWithVideo.video_type === 'playlist') {
    const playlist = await Playlist.findByIdWithVideos(stream.video_id);
    if (!playlist) {
      throw new Error('Playlist not found');
    }
    return await buildFFmpegArgsForPlaylist(stream, playlist);
  }

  const video = await Video.findById(stream.video_id);
  if (!video) {
    throw new Error('Video not found');
  }

  const relPath = video.filepath.startsWith('/') ? video.filepath.substring(1) : video.filepath;
  const projectRoot = path.resolve(__dirname, '..');
  const videoPath = path.join(projectRoot, 'public', relPath);

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const rtmpUrl = `${stream.rtmp_url.replace(/\/$/, '')}/${stream.stream_key}`;
  const loopValue = stream.loop_video ? '-1' : '0';

  if (!stream.use_advanced_settings) {
    return [
      '-nostdin',
      '-loglevel', 'warning',
      '-stats',
      '-re',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      '-stream_loop', loopValue,
      '-i', videoPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl
    ];
  }

  const resolution = stream.resolution || '1280x720';
  const bitrate = stream.bitrate || 2500;
  const fps = stream.fps || 30;

  return [
    '-nostdin',
    '-loglevel', 'warning',
    '-stats',
    '-re',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-avoid_negative_ts', 'make_zero',
    '-stream_loop', loopValue,
    '-i', videoPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', `${bitrate}k`,
    '-maxrate', `${Math.round(bitrate * 1.1)}k`,
    '-bufsize', `${bitrate * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-g', String(fps * 2),
    '-keyint_min', String(fps),
    '-sc_threshold', '0',
    '-s', resolution,
    '-r', String(fps),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];
}


async function killFFmpegProcess(streamId, streamData) {
  return new Promise((resolve) => {
    if (!streamData) {
      resolve(true);
      return;
    }

    // adopted process from a previous app run: no child object, kill by pid
    if (!streamData.process) {
      const pid = streamData.pid;
      if (!pid || !isFfmpegPidAlive(pid)) {
        resolve(true);
        return;
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) { }

      const deadline = Date.now() + 3000;
      const waitDeath = setInterval(() => {
        if (!isFfmpegPidAlive(pid)) {
          clearInterval(waitDeath);
          resolve(true);
        } else if (Date.now() > deadline) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (e) { }
          clearInterval(waitDeath);
          resolve(true);
        }
      }, 200);
      if (typeof waitDeath.unref === 'function') {
        waitDeath.unref();
      }
      return;
    }

    const proc = streamData.process;

    if (proc.exitCode !== null) {
      resolve(true);
      return;
    }

    let resolved = false;
    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve(true);
      }
    };

    proc.once('exit', cleanup);
    proc.once('error', cleanup);

    try {
      proc.kill('SIGTERM');
    } catch (e) { }

    setTimeout(() => {
      if (!resolved) {
        try {
          if (proc.exitCode === null) {
            proc.kill('SIGKILL');
          }
        } catch (e) { }
      }
    }, 3000);

    setTimeout(cleanup, 5000);
  });
}

async function startStream(streamId, isRetry = false, baseUrl = null) {
  if (startingStreams.has(streamId)) {
    return { success: false, error: 'Stream start is already in progress' };
  }

  startingStreams.add(streamId);

  try {
    if (!isRetry) {
      streamRetryCount.set(streamId, 0);
    }

    if (activeStreams.has(streamId)) {
      const existing = activeStreams.get(streamId);
      const isAttachedAlive = existing.process && existing.process.exitCode === null;
      const isAdoptedAlive = !existing.process && isFfmpegPidAlive(existing.pid);
      if (isAttachedAlive || isAdoptedAlive) {
        if (!isRetry) {
          return { success: false, error: 'Stream is already active' };
        }
        addStreamLog(streamId, 'Killing existing FFmpeg process before restart...');
        manuallyStoppingStreams.add(streamId);
        await killFFmpegProcess(streamId, existing);
        manuallyStoppingStreams.delete(streamId);
      }
      activeStreams.delete(streamId);
    }

    let stream = await Stream.findById(streamId);
    if (!stream) {
      return { success: false, error: 'Stream not found' };
    }

    const originalStartTime = stream.start_time;
    const originalEndTime = stream.end_time;

    await validateCopyModeCompatibility(stream);

    if (stream.is_youtube_api) {
      const youtubeService = require('./youtubeService');
      const effectiveBaseUrl = baseUrl || process.env.BASE_URL || 'http://localhost:7575';

      addStreamLog(streamId, 'Creating YouTube broadcast...');

      try {
        const ytResult = await youtubeService.createYouTubeBroadcast(streamId, effectiveBaseUrl);
        if (!ytResult.success) {
          addStreamLog(streamId, `YouTube broadcast failed: ${ytResult.error}`);
          return { success: false, error: ytResult.error || 'Failed to create YouTube broadcast' };
        }
        stream = await Stream.findById(streamId);
        addStreamLog(streamId, `YouTube broadcast created: ${ytResult.broadcastId}`);
      } catch (ytError) {
        addStreamLog(streamId, `YouTube API error: ${ytError.message}`);
        return { success: false, error: `YouTube API error: ${ytError.message}` };
      }
    }

    if (!stream.rtmp_url || !stream.stream_key) {
      return { success: false, error: 'Missing RTMP URL or stream key' };
    }

    const ffmpegArgs = await buildFFmpegArgs(stream);

    addStreamLog(streamId, `Starting FFmpeg process${DETACHED_STREAMS ? ' (detached, survives app restarts)' : ''}`);

    const startupState = {
      lastLogLine: '',
      lastErrorLine: '',
      resolve: null,
      reject: null
    };

    let ffmpegProcess;
    let detachedPid = null;
    let tailStartOffset = 0;
    if (DETACHED_STREAMS) {
      fs.mkdirSync(FFMPEG_LOG_DIR, { recursive: true });
      const pidFile = ffmpegPidPath(streamId);
      try { fs.unlinkSync(pidFile); } catch (e) { /* no stale pid file */ }

      // capture the offset BEFORE spawning: ffmpeg starts writing the moment
      // the launcher brings it up, and the pid-file round trip takes ~100 ms —
      // snapshotting later would skip early banner/error lines
      const logFile = ffmpegLogPath(streamId);
      const tailStartAt = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;

      // spawn through a short-lived launcher so FFmpeg is re-parented to
      // init and out of reach of process-tree kills (pm2 restart) — see
      // services/ffmpeg-launcher.js
      const launcher = spawn(process.execPath, [
        path.join(__dirname, 'ffmpeg-launcher.js'),
        pidFile,
        ffmpegPath,
        logFile,
        ...ffmpegArgs
      ], { detached: true, stdio: 'ignore' });
      launcher.unref();

      detachedPid = await waitForPidFile(pidFile, launcher);
      db.run('UPDATE streams SET ffmpeg_pid = ? WHERE id = ?', [detachedPid, streamId]);
      tailStartOffset = tailStartAt;
    } else {
      ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }

    const startupPromise = waitForStreamStartup(streamId, ffmpegProcess, startupState);

    let startTimeIso;
    if (isRetry && originalStartTime) {
      startTimeIso = originalStartTime;
    } else {
      startTimeIso = new Date().toISOString();
    }

    activeStreams.set(streamId, {
      process: ffmpegProcess,
      userId: stream.user_id,
      startTime: startTimeIso,
      endTime: originalEndTime,
      pid: ffmpegProcess ? ffmpegProcess.pid : detachedPid,
      lastActivity: Date.now(),
      detached: DETACHED_STREAMS,
      startupState
    });

    if (DETACHED_STREAMS) {
      // the file also holds output from previous runs of this stream
      // (retries/restarts) and replaying it would flood the console and
      // fake a startup-success on old progress lines — hence the offset
      // captured before the spawn above
      startLogTailer(streamId, tailStartOffset);
    } else {
      ffmpegProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          addStreamLog(streamId, `[OUT] ${msg}`);
          updateStreamActivity(streamId);
        }
      });

      ffmpegProcess.stderr.on('data', (data) => {
        const lines = data.toString().split(/\r?\n|\r/g);
        for (const rawLine of lines) {
          processFfmpegLogLine(streamId, rawLine.trim(), startupState);
        }
      });
    }

    // detached FFmpeg runs pid-polled (no child handle here) — its exit is
    // detected by the health check, same as streams adopted after a restart
    if (ffmpegProcess) ffmpegProcess.on('exit', async (code, signal) => {
      addStreamLog(streamId, `FFmpeg exited: code=${code}, signal=${signal}`);

      const wasActive = activeStreams.delete(streamId);
      const isManualStop = manuallyStoppingStreams.has(streamId);

      if (isManualStop) {
        manuallyStoppingStreams.delete(streamId);
        cleanupStreamData(streamId);
        return;
      }

      if (startupState.reject) {
        startupState.reject(buildStartupFailureMessage(
          startupState,
          `FFmpeg exited with code=${code}, signal=${signal}`
        ));
      }

      const currentStream = await Stream.findById(streamId);

      if (currentStream && currentStream.end_time) {
        const endTime = new Date(currentStream.end_time);
        const now = new Date();
        if (endTime.getTime() <= now.getTime()) {
          addStreamLog(streamId, 'Stream ended - scheduled end time reached');
          if (wasActive) {
            try {
              await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
              if (schedulerService) {
                schedulerService.handleStreamStopped(streamId);
              }
            } catch (e) { }
          }
          cleanupStreamData(streamId);
          return;
        }
      }

      const shouldRetry = signal === 'SIGSEGV' || signal === 'SIGKILL' || signal === 'SIGPIPE' ||
        (code !== 0 && code !== null) || (code === null && signal === null);

      if (shouldRetry && currentStream && currentStream.status !== 'offline') {
        const retryCount = streamRetryCount.get(streamId) || 0;

        if (retryCount < MAX_RETRY_ATTEMPTS) {
          streamRetryCount.set(streamId, retryCount + 1);
          const delay = getRetryDelay(retryCount);

          addStreamLog(streamId, `Retry #${retryCount + 1} in ${Math.round(delay / 1000)}s`);

          setTimeout(async () => {
            try {
              const latestStream = await Stream.findById(streamId);
              if (latestStream && latestStream.status !== 'offline') {
                if (latestStream.end_time) {
                  const endTime = new Date(latestStream.end_time);
                  const now = new Date();
                  if (endTime.getTime() <= now.getTime()) {
                    await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
                    cleanupStreamData(streamId);
                    return;
                  }
                }
                const result = await startStream(streamId, true, baseUrl);
                if (!result.success) {
                  await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
                  cleanupStreamData(streamId);
                }
              } else {
                cleanupStreamData(streamId);
              }
            } catch (e) {
              cleanupStreamData(streamId);
            }
          }, delay);
          return;
        } else {
          addStreamLog(streamId, `Max retries (${MAX_RETRY_ATTEMPTS}) reached`);
        }
      }

      if (wasActive && currentStream) {
        try {
          await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
          if (schedulerService) {
            schedulerService.handleStreamStopped(streamId);
          }
        } catch (e) { }
        cleanupStreamData(streamId);
      }
    });

    if (ffmpegProcess) ffmpegProcess.on('error', async (err) => {
      addStreamLog(streamId, `Process error: ${err.message}`);
      startupState.lastErrorLine = err.message;
      if (startupState.reject) {
        startupState.reject(buildStartupFailureMessage(startupState, err.message));
      }
      activeStreams.delete(streamId);
      try {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
      } catch (e) { }
      cleanupStreamData(streamId);
    });

    try {
      await startupPromise;
    } catch (startupError) {
      manuallyStoppingStreams.add(streamId);
      await killFFmpegProcess(streamId, activeStreams.get(streamId));
      manuallyStoppingStreams.delete(streamId);
      activeStreams.delete(streamId);
      cleanupTempFiles(streamId);
      cleanupStreamData(streamId);
      throw startupError;
    }

    if (!isRetry) {
      await Stream.updateStatus(streamId, 'live', stream.user_id, { startTimeOverride: startTimeIso });
    }

    if (schedulerService && originalEndTime) {
      schedulerService.scheduleStreamTerminationByEndTime(streamId, originalEndTime, stream.user_id);
    }

    return {
      success: true,
      message: 'Stream started successfully',
      isAdvancedMode: stream.use_advanced_settings
    };
  } catch (error) {
    addStreamLog(streamId, `Start failed: ${error.message}`);
    return { success: false, error: error.message, code: error.code || null };
  } finally {
    startingStreams.delete(streamId);
  }
}

function updateStreamActivity(streamId) {
  const streamData = activeStreams.get(streamId);
  if (streamData) {
    streamData.lastActivity = Date.now();
  }
}

async function stopStream(streamId) {
  try {
    const streamData = activeStreams.get(streamId);
    const stream = await Stream.findById(streamId);

    if (!streamData) {
      if (stream && stream.status === 'live') {
        // no in-memory entry, but a detached process may still be running
        // under the pid recorded in the database — kill it before flipping
        // the status, otherwise it would stream on with no row to manage it
        if (stream.ffmpeg_pid) {
          manuallyStoppingStreams.add(streamId);
          await killFFmpegProcess(streamId, { pid: stream.ffmpeg_pid });
          manuallyStoppingStreams.delete(streamId);
        }
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        if (schedulerService) {
          schedulerService.handleStreamStopped(streamId);
        }
        cleanupStreamData(streamId);
        return { success: true, message: 'Stream status fixed' };
      }
      return { success: false, error: 'Stream is not active' };
    }

    addStreamLog(streamId, 'Stopping stream...');
    manuallyStoppingStreams.add(streamId);

    await killFFmpegProcess(streamId, streamData);

    activeStreams.delete(streamId);
    cleanupTempFiles(streamId);

    if (stream) {
      if (stream.is_youtube_api && stream.youtube_broadcast_id) {
        try {
          const youtubeService = require('./youtubeService');
          await youtubeService.deleteYouTubeBroadcast(streamId);
        } catch (e) { }
      }

      await saveStreamHistory(stream);
      await Stream.updateStatus(streamId, 'offline', stream.user_id);
    }

    if (schedulerService) {
      schedulerService.handleStreamStopped(streamId);
    }

    cleanupStreamData(streamId);
    return { success: true, message: 'Stream stopped successfully' };
  } catch (error) {
    manuallyStoppingStreams.delete(streamId);
    return { success: false, error: error.message };
  }
}

function cleanupTempFiles(streamId) {
  const tempDir = path.join(__dirname, '..', 'temp');
  const files = [
    path.join(tempDir, `playlist_${streamId}.txt`),
    path.join(tempDir, `playlist_audio_${streamId}.txt`)
  ];

  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (e) { }
  }
}

function isStreamActive(streamId) {
  const streamData = activeStreams.get(streamId);
  if (!streamData) return false;

  if (!streamData.process) {
    return isFfmpegPidAlive(streamData.pid);
  }

  if (streamData.process.exitCode !== null) {
    activeStreams.delete(streamId);
    return false;
  }

  return true;
}

function isStreamStarting(streamId) {
  return startingStreams.has(streamId);
}

function getActiveStreams() {
  return Array.from(activeStreams.keys());
}

function getActiveStreamInfo(streamId) {
  const streamData = activeStreams.get(streamId);
  if (!streamData) return null;

  return {
    streamId,
    userId: streamData.userId,
    startTime: streamData.startTime,
    endTime: streamData.endTime,
    pid: streamData.pid,
    lastActivity: streamData.lastActivity,
    retryCount: streamRetryCount.get(streamId) || 0
  };
}


async function syncStreamStatuses() {
  try {
    const liveStreams = await Stream.findAll(null, 'live');

    for (const stream of liveStreams) {
      const isActive = activeStreams.has(stream.id);

      if (!isActive) {
        const retryCount = streamRetryCount.get(stream.id);
        if (retryCount !== undefined && retryCount < MAX_RETRY_ATTEMPTS) {
          continue;
        }

        if (stream.end_time) {
          const endTime = new Date(stream.end_time);
          if (endTime.getTime() <= Date.now()) {
            await Stream.updateStatus(stream.id, 'offline', stream.user_id);
            cleanupStreamData(stream.id);
            continue;
          }
        }

        await Stream.updateStatus(stream.id, 'offline', stream.user_id, { preserveEndTime: true });
        cleanupStreamData(stream.id);
      }
    }

    for (const [streamId, streamData] of activeStreams) {
      const stream = await Stream.findById(streamId);

      if (!stream) {
        await killFFmpegProcess(streamId, streamData);
        activeStreams.delete(streamId);
        cleanupStreamData(streamId);
        continue;
      }

      if (stream.status !== 'live') {
        await Stream.updateStatus(streamId, 'live', stream.user_id);
      }

      if (streamData.process && streamData.process.exitCode !== null) {
        activeStreams.delete(streamId);
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
        cleanupStreamData(streamId);
      }
    }
  } catch (error) { }
}

async function healthCheckStreams() {
  try {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000;

    for (const [streamId, streamData] of activeStreams) {
      if (streamData.process && streamData.process.exitCode !== null) {
        activeStreams.delete(streamId);
        const stream = await Stream.findById(streamId);
        if (stream && stream.status === 'live') {
          if (stream.end_time) {
            const endTime = new Date(stream.end_time);
            if (endTime.getTime() <= Date.now()) {
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }
          await Stream.updateStatus(streamId, 'offline', stream.user_id, { preserveEndTime: true });
        }
        cleanupStreamData(streamId);
        continue;
      }

      // adopted process from a previous app run: no exit events, poll by pid
      if (!streamData.process) {
        if (isFfmpegPidAlive(streamData.pid)) {
          continue;
        }
        await handleAdoptedStreamExit(streamId);
        continue;
      }

      if (streamData.lastActivity && (now - streamData.lastActivity) > staleThreshold) {
        addStreamLog(streamId, 'Stream appears stale, restarting...');

        const stream = await Stream.findById(streamId);
        if (stream && stream.status === 'live') {
          if (stream.end_time) {
            const endTime = new Date(stream.end_time);
            if (endTime.getTime() <= Date.now()) {
              manuallyStoppingStreams.add(streamId);
              await killFFmpegProcess(streamId, streamData);
              activeStreams.delete(streamId);
              manuallyStoppingStreams.delete(streamId);
              await Stream.updateStatus(streamId, 'offline', stream.user_id);
              cleanupStreamData(streamId);
              continue;
            }
          }

          manuallyStoppingStreams.add(streamId);
          await killFFmpegProcess(streamId, streamData);
          activeStreams.delete(streamId);
          manuallyStoppingStreams.delete(streamId);

          setTimeout(async () => {
            try {
              const currentStream = await Stream.findById(streamId);
              if (currentStream && currentStream.status === 'live') {
                await startStream(streamId, true);
              }
            } catch (e) { }
          }, 3000);
        }
      }
    }
  } catch (error) { }
}

// mirror of the attached-process exit handler, driven by pid polling
async function handleAdoptedStreamExit(streamId) {
  addStreamLog(streamId, 'FFmpeg process ended');
  const wasActive = activeStreams.delete(streamId);
  stopLogTailer(streamId);

  const currentStream = await Stream.findById(streamId);

  if (!currentStream || currentStream.status === 'offline') {
    cleanupStreamData(streamId);
    return;
  }

  if (currentStream.end_time && new Date(currentStream.end_time).getTime() <= Date.now()) {
    addStreamLog(streamId, 'Stream ended - scheduled end time reached');
    if (wasActive) {
      try {
        await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
        if (schedulerService) {
          schedulerService.handleStreamStopped(streamId);
        }
      } catch (e) { }
    }
    cleanupStreamData(streamId);
    return;
  }

  const retryCount = streamRetryCount.get(streamId) || 0;
  if (retryCount < MAX_RETRY_ATTEMPTS) {
    streamRetryCount.set(streamId, retryCount + 1);
    const delay = getRetryDelay(retryCount);
    addStreamLog(streamId, `Retry #${retryCount + 1} in ${Math.round(delay / 1000)}s`);

    setTimeout(async () => {
      try {
        const latestStream = await Stream.findById(streamId);
        if (latestStream && latestStream.status !== 'offline') {
          const result = await startStream(streamId, true);
          if (!result.success) {
            await Stream.updateStatus(streamId, 'offline', latestStream.user_id);
            cleanupStreamData(streamId);
          }
        } else {
          cleanupStreamData(streamId);
        }
      } catch (e) {
        cleanupStreamData(streamId);
      }
    }, delay);
    return;
  }

  addStreamLog(streamId, `Max retries (${MAX_RETRY_ATTEMPTS}) reached`);
  if (wasActive) {
    try {
      await Stream.updateStatus(streamId, 'offline', currentStream.user_id);
      if (schedulerService) {
        schedulerService.handleStreamStopped(streamId);
      }
    } catch (e) { }
  }
  cleanupStreamData(streamId);
}

// after a restart, detached ffmpeg processes may still be pushing their live
// stream — re-attach to them by pid instead of resetting the stream offline
async function adoptRunningStreams() {
  try {
    const liveStreams = await Stream.findAll(null, 'live');
    if (!liveStreams || liveStreams.length === 0) {
      return;
    }

    let adopted = 0;
    for (const stream of liveStreams) {
      if (!isFfmpegPidAlive(stream.ffmpeg_pid)) {
        await Stream.updateStatus(stream.id, 'offline');
        cleanupStreamData(stream.id);
        continue;
      }

      // the app was down across the scheduled end time — stop the process
      // right away instead of adopting it and waiting for the scheduler
      if (stream.end_time && new Date(stream.end_time).getTime() <= Date.now()) {
        addStreamLog(stream.id, 'Stream ended - scheduled end time reached while app was down');
        await killFFmpegProcess(stream.id, { pid: stream.ffmpeg_pid });
        await Stream.updateStatus(stream.id, 'offline', stream.user_id);
        cleanupStreamData(stream.id);
        continue;
      }

      activeStreams.set(stream.id, {
        process: null,
        pid: stream.ffmpeg_pid,
        userId: stream.user_id,
        startTime: stream.start_time || new Date().toISOString(),
        endTime: stream.end_time,
        lastActivity: Date.now(),
        detached: true
      });
      addStreamLog(stream.id, `Re-attached to running FFmpeg (pid ${stream.ffmpeg_pid}) after app restart`);

      const logFile = ffmpegLogPath(stream.id);
      const startOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
      startLogTailer(stream.id, startOffset);
      adopted++;
    }

    if (adopted > 0) {
      console.log(`[Streaming] Re-attached to ${adopted} running stream(s) after restart`);
    }

    // a start interrupted by a restart/crash (ffmpeg spawned, pid persisted,
    // but the status never flipped to 'live') leaves a detached ffmpeg that
    // nothing manages — the sweep above only looks at 'live' rows, and such
    // an orphan could never be stopped from the UI. Anything else holding a
    // live pid gets killed; dead pids just get cleared.
    const pidRows = await new Promise((resolve) => {
      db.all('SELECT id, ffmpeg_pid FROM streams WHERE ffmpeg_pid IS NOT NULL', [], (err, rows) => {
        resolve(err ? [] : (rows || []));
      });
    });
    for (const row of pidRows) {
      if (activeStreams.has(row.id)) {
        continue; // adopted just above
      }
      if (isFfmpegPidAlive(row.ffmpeg_pid)) {
        console.log(`[Streaming] Killing orphaned FFmpeg (pid ${row.ffmpeg_pid}) for stream ${row.id}`);
        addStreamLog(row.id, 'Stopped orphaned FFmpeg process left over from an interrupted start');
        await killFFmpegProcess(row.id, { pid: row.ffmpeg_pid });
      }
      db.run('UPDATE streams SET ffmpeg_pid = NULL WHERE id = ?', [row.id]);
    }
  } catch (error) {
    console.error('[Streaming] Failed to adopt running streams:', error);
  }
}

async function saveStreamHistory(stream) {
  try {
    if (!stream.start_time) {
      return false;
    }

    const startTime = new Date(stream.start_time);
    const endTime = new Date();
    const durationSeconds = Math.floor((endTime - startTime) / 1000);

    if (durationSeconds < 10) {
      return false;
    }

    const videoDetails = stream.video_id ? await Video.findById(stream.video_id) : null;

    const historyData = {
      id: uuidv4(),
      stream_id: stream.id,
      title: stream.title,
      platform: stream.platform || 'Custom',
      platform_icon: stream.platform_icon,
      video_id: stream.video_id,
      video_title: videoDetails ? videoDetails.title : null,
      resolution: stream.resolution,
      bitrate: stream.bitrate,
      fps: stream.fps,
      start_time: stream.start_time,
      end_time: endTime.toISOString(),
      duration: durationSeconds,
      use_advanced_settings: stream.use_advanced_settings ? 1 : 0,
      user_id: stream.user_id
    };

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO stream_history (
          id, stream_id, title, platform, platform_icon, video_id, video_title,
          resolution, bitrate, fps, start_time, end_time, duration, use_advanced_settings, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyData.id, historyData.stream_id, historyData.title,
          historyData.platform, historyData.platform_icon, historyData.video_id, historyData.video_title,
          historyData.resolution, historyData.bitrate, historyData.fps,
          historyData.start_time, historyData.end_time, historyData.duration,
          historyData.use_advanced_settings, historyData.user_id
        ],
        function (err) {
          if (err) {
            return reject(err);
          }
          resolve(historyData);
        }
      );
    });
  } catch (error) {
    return false;
  }
}

// everything a deleted stream leaves behind: its ffmpeg log file (up to
// 100MB each, one per stream id), console buffer, and any lingering pid
function cleanupStreamFiles(streamId) {
  stopLogTailer(streamId);
  streamLogs.delete(streamId);
  try {
    const logFile = ffmpegLogPath(streamId);
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }
  } catch (e) { }
  try { fs.unlinkSync(ffmpegPidPath(streamId)); } catch (e) { }
  db.run('UPDATE streams SET ffmpeg_pid = NULL WHERE id = ?', [streamId]);
}

async function gracefulShutdown() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  if (healthCheckIntervalId) {
    clearInterval(healthCheckIntervalId);
    healthCheckIntervalId = null;
  }

  const streamIds = Array.from(activeStreams.keys());

  // detached streams are left running on purpose so lives survive the app
  // restart; their pids are already persisted and re-adopted on the next boot.
  // stopping a stream is done from the app (Stop button) at any time.
  if (DETACHED_STREAMS) {
    let running = 0;
    for (const streamId of streamIds) {
      const streamData = activeStreams.get(streamId);
      stopLogTailer(streamId);
      if (streamData && streamData.pid) {
        running++;
      }
      activeStreams.delete(streamId);
    }
    if (running > 0) {
      console.log(`[Streaming] Leaving ${running} stream(s) running across restart`);
    }
    return;
  }

  for (const streamId of streamIds) {
    try {
      const streamData = activeStreams.get(streamId);

      manuallyStoppingStreams.add(streamId);
      await killFFmpegProcess(streamId, streamData);

      const stream = await Stream.findById(streamId);
      if (stream) {
        await Stream.updateStatus(streamId, 'offline', stream.user_id);
      }

      activeStreams.delete(streamId);
      cleanupStreamData(streamId);
    } catch (e) { }
  }
}

// shutdown signals are handled by app.js, which calls gracefulShutdown()

module.exports = {
  startStream,
  stopStream,
  validateCopyModeCompatibilityForInput,
  isStreamActive,
  isStreamStarting,
  getActiveStreams,
  getActiveStreamInfo,
  getStreamLogs,
  addStreamLog,
  cleanupStreamFiles,
  syncStreamStatuses,
  healthCheckStreams,
  saveStreamHistory,
  gracefulShutdown,
  adoptRunningStreams,
  setSchedulerService
};
