const crypto = require('crypto')

const ALLOWED_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
})

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, maxLength)
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex')
}

function makeOwnerKey(secret, openid) {
  if (!secret || Buffer.byteLength(String(secret), 'utf8') < 32) throw new Error('IDENTIFY_UPLOAD_SECRET_NOT_CONFIGURED')
  if (!openid) throw new Error('WECHAT_IDENTITY_REQUIRED')
  return crypto.createHmac('sha256', secret).update(openid).digest('hex')
}

function normalizeFile(input, maxBytes) {
  const file = input || {}
  const mime = cleanText(file.mime, 40).toLowerCase()
  const sizeBytes = Number(file.sizeBytes)
  if (!ALLOWED_MIME[mime]) throw new Error('UNSUPPORTED_IMAGE_TYPE')
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxBytes) throw new Error('INVALID_IMAGE_SIZE')
  return { mime, sizeBytes, extension: ALLOWED_MIME[mime] }
}

function makeUploadId(ownerKey, idempotencyKey) {
  const key = cleanText(idempotencyKey, 100)
  if (!key) throw new Error('IDEMPOTENCY_KEY_REQUIRED')
  return `identify_${stableHash(`${ownerKey}|${key}`).slice(0, 28)}`
}

function makeCloudPath(ownerKey, uploadId, extension) {
  return `identify-pending/${ownerKey.slice(0, 16)}/${uploadId}/source.${extension}`
}

function fileIdMatchesPath(fileID, expectedPath, expectedEnvId) {
  const value = cleanText(fileID, 1024)
  const path = cleanText(expectedPath, 512)
  if (!value.startsWith('cloud://') || !path || path.includes('..') || path.startsWith('/')) return false
  const separator = value.indexOf('/', 'cloud://'.length)
  if (separator < 0) return false
  const host = value.slice('cloud://'.length, separator).toLowerCase()
  const expected = cleanText(expectedEnvId, 160).toLowerCase()
  if (expected && host !== expected && !host.startsWith(`${expected}.`)) return false
  return value.slice(separator + 1) === path
}

function mimeFromMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return ''
}

function validateActualFile(buffer, declaredFile, maxBytes) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('EMPTY_IMAGE')
  if (buffer.length > maxBytes) throw new Error('INVALID_IMAGE_SIZE')
  if (!declaredFile || buffer.length !== declaredFile.sizeBytes) throw new Error('IMAGE_SIZE_MISMATCH')
  const mime = mimeFromMagic(buffer)
  if (!mime || mime !== declaredFile.mime) throw new Error('IMAGE_TYPE_MISMATCH')
  return { mime, sizeBytes: buffer.length }
}

module.exports = {
  ALLOWED_MIME,
  cleanText,
  stableHash,
  makeOwnerKey,
  normalizeFile,
  makeUploadId,
  makeCloudPath,
  fileIdMatchesPath,
  mimeFromMagic,
  validateActualFile
}
