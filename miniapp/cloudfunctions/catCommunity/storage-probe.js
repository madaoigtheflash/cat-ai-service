'use strict'

const crypto = require('crypto')
const { CommunityError } = require('./core')

const ACTION = 'probeMediaOwnership'
const DOMAIN = 'cat-community-storage-probe-v1\n'
const PROBE_PREFIX = 'community-approved/_ownership-probe/'
const MAX_PROBE_BYTES = 16 * 1024
// An 8x8 solid pink PNG generated locally; contains no user or identifying metadata.
const FIXED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4ceE2VsQwtCQA9teowbATP4cAAAAASUVORK5CYII='

function probeBody(event) {
  return { action: ACTION, requestId: event.requestId, expiresAt: event.expiresAt }
}

function signStorageProbe(event, secret) {
  return crypto.createHmac('sha256', secret).update(DOMAIN).update(JSON.stringify(probeBody(event))).digest('hex')
}

function createStorageProbe({ media, reviewSecret, enabled = false, now = () => Date.now() }) {
  return {
    async handle(event, context = {}) {
      let cloudPath = '', uploadedFile = ''
      try {
        // The diagnostic has no ordinary-user path, even with a valid copied signature.
        if (context.openid) throw new CommunityError('FORBIDDEN', '请使用受信任的运维工具')
        if (enabled !== true) throw new CommunityError('PROBE_DISABLED', '存储运维探针未启用')
        if (typeof reviewSecret !== 'string' || Buffer.byteLength(reviewSecret) < 32) throw new CommunityError('PROBE_DISABLED', '存储运维签名尚未配置')
        const allowed = new Set(['action', 'requestId', 'expiresAt', 'signature'])
        if (!event || typeof event !== 'object' || Array.isArray(event) ||
          Object.keys(event).length !== allowed.size || Object.keys(event).some(key => !allowed.has(key)) ||
          event.action !== ACTION || typeof event.requestId !== 'string' || !/^[a-f0-9]{32,64}$/.test(event.requestId) ||
          typeof event.expiresAt !== 'string' || typeof event.signature !== 'string' || !/^[a-f0-9]{64}$/.test(event.signature)) {
          throw new CommunityError('VALIDATION_ERROR', '存储探针参数无效')
        }
        if (!crypto.timingSafeEqual(Buffer.from(event.signature, 'hex'), Buffer.from(signStorageProbe(event, reviewSecret), 'hex'))) {
          throw new CommunityError('FORBIDDEN', '存储探针签名无效')
        }
        const currentMs = now(), expiry = Date.parse(event.expiresAt)
        if (!Number.isFinite(currentMs) || !Number.isFinite(expiry) || expiry <= currentMs || expiry > currentMs + 5 * 60 * 1000) {
          throw new CommunityError('PROBE_EXPIRED', '存储探针请求已过期或有效期过长')
        }
        const buffer = await media.sanitize(Buffer.from(FIXED_PNG, 'base64'))
        if (!Buffer.isBuffer(buffer) || buffer.length < 3 || buffer.length > MAX_PROBE_BYTES ||
          buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
          throw new CommunityError('PROBE_SANITIZE_FAILED', '固定测试图片转码失败')
        }
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
        // Never accept a destination from the request, reuse keys or expose a key before upload.
        cloudPath = `${PROBE_PREFIX}${crypto.randomBytes(32).toString('hex')}.jpg`
        const fileID = await media.upload(cloudPath, buffer)
        if (typeof fileID !== 'string' || !/^cloud:\/\/[^/?#\s]+\//.test(fileID) || !fileID.endsWith(`/${cloudPath}`)) {
          throw new CommunityError('PROBE_UPLOAD_FAILED', '测试文件上传结果无效')
        }
        uploadedFile = fileID
        const returned = await media.download(fileID)
        if (!Buffer.isBuffer(returned) || returned.length !== buffer.length ||
          crypto.createHash('sha256').update(returned).digest('hex') !== sha256) {
          throw new CommunityError('PROBE_READBACK_FAILED', '测试文件回读校验失败')
        }
        return { ok: true, data: { fileID, sha256, sizeBytes: buffer.length, cleanupRequired: true } }
      } catch (error) {
        return { ok: false,
          error: { code: error instanceof CommunityError ? error.code : 'PROBE_FAILED',
            message: error instanceof CommunityError ? error.message : '存储探针失败，请检查后按精确路径清理测试文件' },
          // A timed-out upload can still have succeeded. Only authenticated invocations
          // reach allocation; report the exact generated path, never arbitrary SDK errors.
          ...(cloudPath ? { cleanup: { required: true, cloudPath, ...(uploadedFile ? { fileID: uploadedFile } : {}) } } : {})
        }
      }
    }
  }
}

module.exports = { createStorageProbe, signStorageProbe, ACTION, PROBE_PREFIX }
