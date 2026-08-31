'use strict'

const sharp = require('sharp')

const MAX_SANITIZED_PIXELS = 24000000

async function sanitizeApprovedImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('image buffer is empty')
  return sharp(buffer, {
    failOn: 'warning',
    limitInputPixels: MAX_SANITIZED_PIXELS,
    animated: false
  })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    // Metadata is intentionally not copied. Sharp strips EXIF/GPS by default.
    .jpeg({ quality: 82, progressive: true })
    .toBuffer()
}

module.exports = { MAX_SANITIZED_PIXELS, sanitizeApprovedImage }
