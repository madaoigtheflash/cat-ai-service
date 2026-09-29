'use strict'

const https = require('node:https')
const { CommunityError, filePath, MAX_IMAGE_BYTES } = require('./core')

const DOWNLOAD_TIMEOUT_MS = 10000
const SIGN_TIMEOUT_MS = 5000
const SOURCE_PATH = /^community-pending\/[a-f0-9]{64}\/[A-Za-z0-9_-]{8,100}\.(?:jpg|jpeg|png|webp)$/
const APPROVED_PATH = /^community-approved\/post_[a-f0-9]{40}\/[a-f0-9]{64}-[a-f0-9]{64}\.jpg$/
const PROBE_PATH = /^community-approved\/_ownership-probe\/[a-f0-9]{64}\.jpg$/

function failure(code = 'MEDIA_DOWNLOAD_FAILED') {
  return new CommunityError(code, code === 'INVALID_FILE' ? '请选择5MB以内的 JPG、PNG 或 WebP 图片'
    : code === 'MEDIA_TIMEOUT' ? '图片读取超时，请稍后重试' : '图片暂时无法读取，请稍后重试')
}

function signingDeadline(operation, timeoutMs) {
  // The SDK exposes no cancellation handle for signing. A late result is ignored
  // and must never start an HTTPS transfer after this deadline has failed.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure('MEDIA_TIMEOUT')), timeoutMs)
    Promise.resolve().then(operation).then(resolve, () => reject(failure())).finally(() => clearTimeout(timer))
  })
}

// Native https does not follow redirects. Read in paused mode so application
// reads/retains no more than MAX_IMAGE_BYTES + one sentinel byte; never collect
// an unbounded response first and inspect its length afterwards.
function readHttpsImage(url, { request = https.request, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let req, response, settled = false, received = 0
    const chunks = []
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        if (response) response.destroy()
        if (req) req.destroy()
        reject(error)
      } else resolve(value)
    }
    const timer = setTimeout(() => finish(failure('MEDIA_TIMEOUT')), timeoutMs)
    try {
      req = request(url, { method: 'GET', headers: { 'Accept-Encoding': 'identity' } }, incoming => {
        response = incoming
        response.on('error', () => finish(failure()))
        response.on('aborted', () => finish(failure()))
        if (settled) { response.destroy(); return }
        // No 3xx, compressed expansion, partial response or arbitrary status.
        if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          finish(failure()); return
        }
        const length = response.headers['content-length']
        if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
          finish(failure()); return
        }
        if (length !== undefined && Number(length) > MAX_IMAGE_BYTES) { finish(failure('INVALID_FILE')); return }
        response.on('readable', () => {
          if (settled) return
          let chunk
          while (!settled && (chunk = response.read(Math.min(64 * 1024, MAX_IMAGE_BYTES + 1 - received))) !== null) {
            if (!Buffer.isBuffer(chunk)) { finish(failure()); return }
            received += chunk.length
            if (received > MAX_IMAGE_BYTES) { finish(failure('INVALID_FILE')); return }
            chunks.push(chunk)
          }
        })
        response.on('end', () => {
          if (!received || (length !== undefined && Number(length) !== received)) { finish(failure()); return }
          finish(null, Buffer.concat(chunks, received))
        })
        response.on('close', () => { if (!settled) finish(failure()) })
      })
      req.on('error', () => finish(failure()))
      req.end()
    } catch (_) { finish(failure()) }
  })
}

function createBoundedMediaDownloader({ getTempFileURL, cloudEnvId, request, timeoutMs, signTimeoutMs = SIGN_TIMEOUT_MS }) {
  return async function download(fileID) {
    const storagePath = filePath(fileID, cloudEnvId)
    if (!SOURCE_PATH.test(storagePath) && !APPROVED_PATH.test(storagePath) && !PROBE_PATH.test(storagePath)) throw failure('INVALID_FILE')
    const signed = await signingDeadline(() => getTempFileURL({ fileList: [{ fileID, maxAge: 60 }] }), signTimeoutMs)
    const item = signed && Array.isArray(signed.fileList) && signed.fileList.length === 1 && signed.fileList[0]
    if (!item || item.fileID !== fileID || item.status !== 0 || typeof item.tempFileURL !== 'string') throw failure()
    let url
    try { url = new URL(item.tempFileURL) } catch (_) { throw failure() }
    // The URL is supplied only by the authenticated SDK, never by an event field.
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw failure()
    return readHttpsImage(url, { request, timeoutMs })
  }
}

module.exports = { createBoundedMediaDownloader, readHttpsImage, DOWNLOAD_TIMEOUT_MS, SIGN_TIMEOUT_MS }
