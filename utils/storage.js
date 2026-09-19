const fs = require('fs-extra');
const path = require('path');
const ensureDirectories = () => {
  const dirs = [
    path.join(__dirname, '../public/uploads/videos'),
    path.join(__dirname, '../public/uploads/thumbnails'),
    path.join(__dirname, '../public/uploads/avatars'),
    path.join(__dirname, '../public/uploads/temp'),
    path.join(__dirname, '../public/uploads/temp/info'),
    path.join(__dirname, '../public/uploads/audio')
  ];
  dirs.forEach(dir => {
    fs.ensureDirSync(dir);
  });
};
const getUniqueFilename = (originalFilename) => {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000000);
  const ext = path.extname(originalFilename);
  const basename = path.basename(originalFilename, ext)
    .replace(/[^a-z0-9]/gi, '-')
    .toLowerCase();
  return `${basename}-${timestamp}-${random}${ext}`;
};

// removes a locally-stored upload referenced by its public URL (e.g. a
// stream thumbnail). Remote URLs and anything outside /uploads/ are
// ignored so stale DB values can never delete arbitrary files.
const deleteLocalUpload = (publicUrl) => {
  if (!publicUrl || !publicUrl.startsWith('/uploads/') || publicUrl.includes('..')) {
    return;
  }
  fs.remove(path.join(__dirname, '../public', publicUrl)).catch((err) => {
    console.error(`Error deleting upload file ${publicUrl}:`, err.message);
  });
};

const getUniqueFilenameWithNumber = (originalFilename, targetDir) => {
  const ext = path.extname(originalFilename);
  const basename = path.basename(originalFilename, ext);
  
  let finalFilename = originalFilename;
  let counter = 2;
  
  while (fs.existsSync(path.join(targetDir, finalFilename))) {
    finalFilename = `${basename} (${counter})${ext}`;
    counter++;
  }
  
  return finalFilename;
};
module.exports = {
  ensureDirectories,
  getUniqueFilename,
  getUniqueFilenameWithNumber,
  deleteLocalUpload,
  paths: {
    videos: path.join(__dirname, '../public/uploads/videos'),
    thumbnails: path.join(__dirname, '../public/uploads/thumbnails'),
    avatars: path.join(__dirname, '../public/uploads/avatars'),
    temp: path.join(__dirname, '../public/uploads/temp'),
    tempInfo: path.join(__dirname, '../public/uploads/temp/info'),
    audio: path.join(__dirname, '../public/uploads/audio')
  }
};