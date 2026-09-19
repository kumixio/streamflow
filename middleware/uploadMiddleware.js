const multer = require('multer');
const path = require('path');
const { getUniqueFilename, paths } = require('../utils/storage');

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, paths.videos);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = getUniqueFilename(file.originalname);
    cb(null, uniqueFilename);
  }
});

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, paths.audio);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = getUniqueFilename(file.originalname);
    cb(null, uniqueFilename);
  }
});

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, paths.avatars);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = getUniqueFilename(file.originalname);
    cb(null, uniqueFilename);
  }
});

const thumbnailStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, paths.thumbnails);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = getUniqueFilename(file.originalname);
    cb(null, uniqueFilename);
  }
});

const videoFilter = (req, file, cb) => {
  const allowedFormats = ['video/mp4', 'video/avi', 'video/quicktime'];
  const fileExt = path.extname(file.originalname).toLowerCase();
  const allowedExts = ['.mp4', '.avi', '.mov'];
  if (allowedFormats.includes(file.mimetype) || allowedExts.includes(fileExt)) {
    cb(null, true);
  } else {
    cb(new Error('Only .mp4, .avi, and .mov formats are allowed'), false);
  }
};

const audioFilter = (req, file, cb) => {
  const allowedFormats = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/ogg', 'audio/flac', 'audio/x-flac'];
  const fileExt = path.extname(file.originalname).toLowerCase();
  const allowedExts = ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac'];
  if (allowedFormats.includes(file.mimetype) || allowedExts.includes(fileExt)) {
    cb(null, true);
  } else {
    cb(new Error('Only .mp3, .wav, .aac, .m4a, .ogg, and .flac formats are allowed'), false);
  }
};

const imageFilter = (req, file, cb) => {
  const allowedFormats = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
  const fileExt = path.extname(file.originalname).toLowerCase();
  const allowedExts = ['.jpg', '.jpeg', '.png', '.gif'];
  if (allowedFormats.includes(file.mimetype) || allowedExts.includes(fileExt)) {
    cb(null, true);
  } else {
    cb(new Error('Only .jpg, .jpeg, .png, and .gif formats are allowed'), false);
  }
};

// browsers send multipart filenames as raw UTF-8 bytes, but busboy decodes
// them as latin1 by default — turning "Café" into "CafÃ©". Decode as UTF-8
// so non-ASCII filenames survive the upload.
const uploadVideo = multer({
  storage: videoStorage,
  fileFilter: videoFilter,
  defParamCharset: 'utf8'
});

const uploadAudio = multer({
  storage: audioStorage,
  fileFilter: audioFilter,
  defParamCharset: 'utf8'
});

const upload = multer({
  storage: avatarStorage,
  fileFilter: imageFilter,
  defParamCharset: 'utf8'
});

const uploadThumbnail = multer({
  storage: thumbnailStorage,
  fileFilter: imageFilter,
  defParamCharset: 'utf8'
});

// stream thumbnails are stored and served as original files and forwarded
// to YouTube, which caps custom thumbnails at 2MB — enforce the same cap
const uploadStreamThumbnail = multer({
  storage: thumbnailStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
  defParamCharset: 'utf8'
});

module.exports = {
  uploadVideo,
  uploadAudio,
  upload,
  uploadThumbnail,
  uploadStreamThumbnail
};