'use strict'

const crypto = require('crypto')
const { CommunityError, MAX_IMAGE_BYTES } = require('./core')

function reviewBody(event) {
  return {
    action: 'reviewPost', postId: event.postId, requestHash: event.requestHash,
    reviewId: event.reviewId, decision: event.decision, reason: event.reason,
    reviewedText: event.reviewedText, reviewedImages: event.reviewedImages,
    expiresAt: event.expiresAt
  }
}

function signReview(event, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(reviewBody(event))).digest('hex')
}

function createTrustedReviewer({ repository, media, reviewSecret, now = () => Date.now() }) {
  return {
    async handle(event, context = {}) {
      try {
        // This is not a mini-program action. A separate reviewer secret is necessary
        // even for a privileged invocation; absent OPENID alone grants no authority.
        if (context.openid) throw new CommunityError('FORBIDDEN', '请使用受信任的审核工具')
        if (typeof reviewSecret !== 'string' || Buffer.byteLength(reviewSecret) < 32) throw new CommunityError('REVIEW_DISABLED', '可信审核尚未配置')
        if (!event || typeof event.signature !== 'string' || !/^[a-f0-9]{64}$/.test(event.signature) ||
          !crypto.timingSafeEqual(Buffer.from(event.signature), Buffer.from(signReview(event, reviewSecret)))) {
          throw new CommunityError('FORBIDDEN', '审核签名无效')
        }
        const currentMs = now()
        const expiry = Date.parse(event.expiresAt)
        if (!Number.isFinite(expiry) || expiry < currentMs || expiry > currentMs + 5 * 60 * 1000) throw new CommunityError('REVIEW_EXPIRED', '审核请求已过期或有效期过长')
        if (!/^post_[a-f0-9]{40}$/.test(event.postId) || !/^[a-f0-9]{64}$/.test(event.requestHash) ||
          !/^[A-Za-z0-9_-]{16,100}$/.test(event.reviewId) || !['approved', 'rejected'].includes(event.decision) ||
          typeof event.reason !== 'string' || !event.reason.trim() || event.reason.length > 300) {
          throw new CommunityError('VALIDATION_ERROR', '审核参数无效')
        }
        if (event.decision === 'approved' && (event.reviewedText !== true || event.reviewedImages !== true)) {
          throw new CommunityError('REVIEW_REQUIRED', '需明确确认已人工审核文字和图片')
        }
        const post = await repository.getPost(event.postId)
        if (!post || post.requestHash !== event.requestHash) throw new CommunityError('REVIEW_CONFLICT', '内容已经变化，请重新检查')
        if (post.review && post.review.id === event.reviewId) return { ok: true, data: { postId: post.id, status: post.status, idempotent: true } }
        if (post.status !== 'pending') throw new CommunityError('REVIEW_CONFLICT', '仅可处理待审核动态')
        const approvedPhotos = []
        if (event.decision === 'approved') {
          if (post.sourcePhotos.length !== post.sourceAssets.length) throw new CommunityError('REVIEW_REQUIRED', '原始图片未完成校验，请拒绝本次提交后重新上传')
          for (let index = 0; index < post.sourcePhotos.length; index += 1) {
            const fileID = post.sourcePhotos[index]
            const asset = post.sourceAssets[index]
            const buffer = await media.download(fileID)
            if (!asset || asset.fileID !== fileID || !Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES ||
              buffer.length !== asset.sizeBytes || crypto.createHash('sha256').update(buffer).digest('hex') !== asset.sha256) {
              throw new CommunityError('MEDIA_CHANGED', '图片自提交后发生变化，请拒绝本次提交后重新上传')
            }
            const sanitized = await media.sanitize(buffer)
            if (!Buffer.isBuffer(sanitized) || !sanitized.length || sanitized.length > MAX_IMAGE_BYTES) throw new CommunityError('MEDIA_SANITIZE_FAILED', '图片安全转码失败')
            const digest = crypto.createHash('sha256').update(sanitized).digest('hex')
            // A submitting user can reproduce a sanitized digest and preclaim a
            // deterministic destination. Every promotion attempt uses a fresh,
            // server-only nonce; retries and racing reviews never overwrite copies.
            // This does not replace the deployment's server-write-only storage gate.
            const nonce = crypto.randomBytes(32).toString('hex')
            const cloudPath = `community-approved/${post.id}/${nonce}-${digest}.jpg`
            const publishedFile = await media.upload(cloudPath, sanitized)
            if (typeof publishedFile !== 'string' || !publishedFile.startsWith('cloud://') || !publishedFile.endsWith(`/${cloudPath}`)) throw new CommunityError('MEDIA_PROMOTION_FAILED', '图片安全副本上传失败')
            const stored = await media.download(publishedFile)
            if (!Buffer.isBuffer(stored) || stored.length !== sanitized.length ||
              crypto.createHash('sha256').update(stored).digest('hex') !== digest) {
              throw new CommunityError('MEDIA_PROMOTION_FAILED', '图片安全副本回读校验失败，动态仍未公开')
            }
            approvedPhotos.push(publishedFile)
          }
        }
        const data = await repository.applyReview({
          postId: post.id, requestHash: event.requestHash, reviewId: event.reviewId,
          decision: event.decision, approvedPhotos,
          review: { id: event.reviewId, decision: event.decision, reason: event.reason.trim(), createdAt: new Date(currentMs).toISOString(), method: 'signed-human-review-v1' }
        })
        return { ok: true, data }
      } catch (error) {
        return { ok: false, error: { code: error instanceof CommunityError ? error.code : 'REVIEW_FAILED', message: error instanceof CommunityError ? error.message : '审核失败，动态仍未公开，请检查配置后重试' } }
      }
    }
  }
}

module.exports = { createTrustedReviewer, signReview }
