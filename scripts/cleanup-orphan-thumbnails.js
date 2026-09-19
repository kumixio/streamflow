#!/usr/bin/env node
/**
 * One-time maintenance: remove files in public/uploads/thumbnails that are
 * no longer referenced by any stream, video, or rotation item.
 *
 * The old stream-thumbnail pipeline (pre-rework) left both an untouched
 * original upload and a resized thumb-*.jpg behind while only one of them
 * was ever recorded in the database — the rest are dead weight.
 *
 * Usage:
 *   node scripts/cleanup-orphan-thumbnails.js           # dry run (report only)
 *   node scripts/cleanup-orphan-thumbnails.js --apply   # actually delete
 */
const fs = require('fs');
const path = require('path');
const { db } = require('../db/database');

const THUMBNAIL_DIRS = [
  path.join(__dirname, '..', 'public', 'uploads', 'thumbnails')
];

const REFERENCE_QUERIES = [
  'SELECT youtube_thumbnail AS ref FROM streams',
  'SELECT thumbnail_path AS ref FROM videos',
  'SELECT thumbnail_path AS ref FROM rotation_items'
];

const apply = process.argv.includes('--apply');

db.serialize(() => {
  let pending = REFERENCE_QUERIES.length;
  const referenced = new Set();
  let failed = false;

  REFERENCE_QUERIES.forEach((sql) => {
    db.all(sql, [], (err, rows) => {
      if (err) {
        console.error('Query failed:', err.message);
        failed = true;
      }
      (rows || []).forEach((row) => {
        if (row.ref && row.ref.startsWith('/uploads/')) {
          referenced.add(path.basename(row.ref));
        }
      });
      if (--pending === 0) finish();
    });
  });

  function finish() {
    if (failed) process.exit(1);

    let deleted = 0;
    let kept = 0;
    let freedBytes = 0;
    const orphans = [];

    THUMBNAIL_DIRS.forEach((dir) => {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach((file) => {
        const full = path.join(dir, file);
        if (!fs.statSync(full).isFile()) return;
        if (referenced.has(file)) {
          kept++;
          return;
        }
        const size = fs.statSync(full).size;
        orphans.push(`${file} (${(size / 1024).toFixed(0)} KB)`);
        freedBytes += size;
        if (apply) fs.unlinkSync(full);
        deleted++;
      });
    });

    if (orphans.length) {
      console.log('Orphan files:');
      orphans.forEach((f) => console.log(`  - ${f}`));
    }
    console.log(`\nReferenced (kept): ${kept} file`);
    console.log(`Orphans found: ${deleted} file, ~${(freedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(apply ? 'Deleted.' : 'Dry run only — re-run with --apply to delete.');
    process.exit(0);
  }
});
