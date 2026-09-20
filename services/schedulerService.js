const Stream = require('../models/Stream');

const scheduledTerminations = new Map();
const SCHEDULE_CHECK_INTERVAL = 15000;
const DURATION_CHECK_INTERVAL = 30000;

// a stream whose schedule time has passed is retried every sweep — without a
// cap, one broken stream (dead token, missing file) hammers the log and the
// YouTube API forever. Give up after this many consecutive failures within
// the window, then park the stream offline with the reason in its console.
const scheduleStartFailures = new Map();
const MAX_SCHEDULE_START_ATTEMPTS = 5;
const SCHEDULE_FAILURE_WINDOW_MS = 60 * 60 * 1000;

let streamingService = null;
let initialized = false;
let scheduleIntervalId = null;
let durationIntervalId = null;

function init(streamingServiceInstance) {
  if (initialized) {
    return;
  }

  streamingService = streamingServiceInstance;
  streamingService.setSchedulerService(module.exports);
  initialized = true;

  scheduleIntervalId = setInterval(checkScheduledStreams, SCHEDULE_CHECK_INTERVAL);
  durationIntervalId = setInterval(checkStreamDurations, DURATION_CHECK_INTERVAL);

  checkScheduledStreams();
  checkStreamDurations();
}

async function checkScheduledStreams() {
  try {
    if (!streamingService) {
      return;
    }

    const now = new Date();
    const streams = await Stream.findScheduledInRange(null, now);

    for (const stream of streams) {
      if (streamingService.isStreamActive(stream.id) || streamingService.isStreamStarting(stream.id)) {
        continue;
      }

      const currentStream = await Stream.findById(stream.id);
      if (!currentStream || currentStream.status !== 'scheduled') {
        continue;
      }

      const baseUrl = process.env.BASE_URL || 'http://localhost:7575';
      const result = await streamingService.startStream(stream.id, false, baseUrl);

      if (!result.success) {
        console.error(`[Scheduler] Failed to start stream ${stream.id}: ${result.error}`);
        recordScheduleStartFailure(stream, result.error);
      } else {
        scheduleStartFailures.delete(stream.id);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking scheduled streams:', error);
  }
}

function recordScheduleStartFailure(stream, errorMessage) {
  const now = Date.now();
  const entry = scheduleStartFailures.get(stream.id);

  if (!entry || now - entry.firstFailedAt > SCHEDULE_FAILURE_WINDOW_MS) {
    // first failure, or the previous streak is stale — start a fresh window
    scheduleStartFailures.set(stream.id, { count: 1, firstFailedAt: now });
    return;
  }

  entry.count += 1;
  if (entry.count < MAX_SCHEDULE_START_ATTEMPTS) {
    return;
  }

  scheduleStartFailures.delete(stream.id);
  console.error(`[Scheduler] Stream ${stream.id} failed ${entry.count} start attempts (${errorMessage}) — marking offline`);

  (async () => {
    try {
      streamingService.addStreamLog(stream.id, `Schedule failed: ${errorMessage} — gave up after ${entry.count} attempts, stream set offline (schedule times are kept). Edit the stream to reschedule.`);
    } catch (e) { }
    // only the status changes: the schedule times stay so rescheduling from
    // the edit form is just a tweak away
    await Stream.update(stream.id, {
      status: 'offline',
      status_updated_at: new Date().toISOString()
    });
  })().catch((e) => console.error('[Scheduler] Failed to park stream offline:', e.message));
}

async function checkStreamDurations() {
  try {
    if (!streamingService) {
      return;
    }

    const liveStreams = await Stream.findAll(null, 'live');

    for (const stream of liveStreams) {
      if (!stream.end_time) {
        continue;
      }

      const endTime = new Date(stream.end_time);
      const now = new Date();
      const timeUntilEnd = endTime.getTime() - now.getTime();

      if (timeUntilEnd <= 0) {
        scheduledTerminations.delete(stream.id);

        try {
          await streamingService.stopStream(stream.id);
        } catch (e) {
          await Stream.updateStatus(stream.id, 'offline', stream.user_id);
        }
      } else if (timeUntilEnd <= 60000 && !scheduledTerminations.has(stream.id)) {
        scheduleStreamTermination(stream.id, timeUntilEnd / 60000, stream.user_id);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking stream durations:', error);
  }
}

// setTimeout overflows (and fires immediately) above 2^31-1 ms (~24.8 days);
// anything further out is left to the duration sweep, which picks it up once
// the end time is within its 60s scheduling window
const MAX_TERMINATION_DELAY_MS = 2147483647;

function scheduleStreamTermination(streamId, durationMinutes, userId = null) {
  if (!streamingService) {
    return;
  }

  if (typeof durationMinutes !== 'number' || Number.isNaN(durationMinutes) || durationMinutes < 0) {
    return;
  }

  if (scheduledTerminations.has(streamId)) {
    const existing = scheduledTerminations.get(streamId);
    if (existing.timeoutId) {
      clearTimeout(existing.timeoutId);
    }
  }

  const durationMs = Math.max(0, durationMinutes * 60 * 1000);
  if (durationMs > MAX_TERMINATION_DELAY_MS) {
    return;
  }
  const targetEndTime = Date.now() + durationMs;

  const timeoutId = setTimeout(async () => {
    try {
      const stream = await Stream.findById(streamId);
      if (!stream || stream.status !== 'live') {
        scheduledTerminations.delete(streamId);
        return;
      }

      await streamingService.stopStream(streamId);
      scheduledTerminations.delete(streamId);
    } catch (error) {
      scheduledTerminations.delete(streamId);
    }
  }, durationMs);

  scheduledTerminations.set(streamId, {
    timeoutId,
    targetEndTime,
    userId
  });
}

// precise end-time stop for a just-started stream: the duration sweep only
// guarantees a stop within its 30s check interval — this schedules the exact
// moment instead, so a stream with an end time doesn't overshoot it
function scheduleStreamTerminationByEndTime(streamId, endTime, userId = null) {
  const target = endTime instanceof Date ? endTime : new Date(endTime);
  if (isNaN(target.getTime())) {
    return;
  }

  const timeUntilEnd = target.getTime() - Date.now();
  if (timeUntilEnd <= 0) {
    // past-due end times are handled (and stopped) by the duration sweep
    return;
  }

  scheduleStreamTermination(streamId, timeUntilEnd / 60000, userId);
}

function cancelStreamTermination(streamId) {
  if (scheduledTerminations.has(streamId)) {
    const scheduled = scheduledTerminations.get(streamId);
    if (scheduled.timeoutId) {
      clearTimeout(scheduled.timeoutId);
    }
    scheduledTerminations.delete(streamId);
    return true;
  }
  return false;
}

function getScheduledTermination(streamId) {
  const scheduled = scheduledTerminations.get(streamId);
  if (!scheduled) return null;

  return {
    streamId,
    targetEndTime: scheduled.targetEndTime,
    remainingMs: scheduled.targetEndTime ? scheduled.targetEndTime - Date.now() : null
  };
}

function handleStreamStopped(streamId) {
  return cancelStreamTermination(streamId);
}

// drop every in-memory trace of a deleted stream
function forgetStream(streamId) {
  scheduleStartFailures.delete(streamId);
  cancelStreamTermination(streamId);
}

function shutdown() {
  if (scheduleIntervalId) {
    clearInterval(scheduleIntervalId);
  }
  if (durationIntervalId) {
    clearInterval(durationIntervalId);
  }

  for (const [streamId, scheduled] of scheduledTerminations) {
    if (scheduled.timeoutId) {
      clearTimeout(scheduled.timeoutId);
    }
  }
  scheduledTerminations.clear();
}

module.exports = {
  init,
  scheduleStreamTermination,
  scheduleStreamTerminationByEndTime,
  cancelStreamTermination,
  getScheduledTermination,
  handleStreamStopped,
  checkScheduledStreams,
  checkStreamDurations,
  forgetStream,
  shutdown
};
