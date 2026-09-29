'use strict'

const sharp = require('sharp')

// Same promotion convention as catOnline/sanitize.js, copied locally so that this
// independently deployed function never imports or modifies the original backend.
async function sanitizeApprovedImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('empty image')
  return sharp(buffer, { failOn: 'warning', limitInputPixels: 24000000, animated: false })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer()
}

module.exports = { sanitizeApprovedImage }
