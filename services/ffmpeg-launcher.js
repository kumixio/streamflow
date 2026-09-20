// Short-lived intermediate process that spawns the real FFmpeg and exits.
//
// PM2 restarts signal the app's whole process tree. A detached child only
// gets its own session — it stays a descendant of the app — so every
// `pm2 restart` used to kill the live FFmpeg processes together with the
// app. With this launcher in between, FFmpeg is orphaned the moment the
// launcher exits, gets re-parented to init (PPID 1), and is out of reach
// of any tree kill aimed at the app.
//
// argv: <pidFile> <ffmpegPath> <logFile> [ffmpeg args...]

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const [, , pidFile, ffmpegPath, logFile, ...ffmpegArgs] = process.argv;

if (!pidFile || !ffmpegPath || !logFile) {
  process.exit(1);
}

try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, 'a');
  try {
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });
    if (!ffmpeg.pid) {
      // a missing binary surfaces as an async 'error' event with no pid —
      // exit cleanly so no bogus pid file is written
      ffmpeg.on('error', () => {});
      throw new Error('FFmpeg failed to start');
    }
    ffmpeg.unref();
    fs.writeFileSync(pidFile, String(ffmpeg.pid));
  } finally {
    fs.closeSync(logFd);
  }
} catch (e) {
  process.exit(1);
}
