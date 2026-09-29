'use strict'

const crypto = require('crypto')
const cloud = require('wx-server-sdk')
const { createCommunityCore, CommunityError, isPublicPost, MAX_IMAGE_BYTES } = require('./core')
const { createTrustedReviewer } = require('./review')
const { createStorageProbe, ACTION: STORAGE_PROBE_ACTION } = require('./storage-probe')
const { signProjectedPhotos } = require('./media-urls')
const { createBoundedMediaDownloader } = require('./bounded-media')
const { resolveRequestContext } = require('./request-context')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const command = db.command
const COLLECTIONS = Object.freeze({
  posts: 'cc_posts_private', comments: 'cc_comments_private',
  notifications: 'cc_notifications_private', limits: 'cc_limits_private'
})

function withoutId(value) {
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => key !== 'id' && key !== '_id' && item !== undefined))
}

async function getDocument(collection, id, source = db) {
  try {
    const response = await source.collection(collection).doc(id).get()
    const value = Array.isArray(response.data) ? response.data[0] : response.data
    return value ? Object.assign({}, value, { id: value._id || id }) : null
  } catch (error) {
    if (/document.*(not exist|not found)|document_not_exist/i.test(`${error.code || ''} ${error.message || ''}`)) return null
    throw error
  }
}

async function setDocument(collection, value, source = db) {
  await source.collection(collection).doc(value.id).set({ data: withoutId(value) })
}

function matchCursor(where, cursor) {
  if (!cursor) return where
  return command.and([where, command.or([
    { createdAt: command.lt(cursor.createdAt) },
    { createdAt: cursor.createdAt, _id: command.lt(cursor.id) }
  ])])
}

async function listDocuments(collection, where, cursor, limit) {
  const response = await db.collection(collection).where(matchCursor(where, cursor))
    .orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(limit).get()
  return (response.data || []).map(value => Object.assign({}, value, { id: value._id }))
}

async function enforceLimit(transaction, kind, actorId, createdAt, dailyLimit, minIntervalMs) {
  const id = `${kind}_${actorId}_${createdAt.slice(0, 10)}`
  const current = await getDocument(COLLECTIONS.limits, id, transaction)
  if (current && (current.count >= dailyLimit || Date.parse(createdAt) - Date.parse(current.lastAt) < minIntervalMs)) {
    throw new CommunityError('RATE_LIMITED', '发布太频繁，请稍后再试')
  }
  await setDocument(COLLECTIONS.limits, { id, count: (current && current.count || 0) + 1, lastAt: createdAt }, transaction)
}

class CommunityRepository {
  getPost(id) { return getDocument(COLLECTIONS.posts, id) }
  getComment(id) { return getDocument(COLLECTIONS.comments, id) }

  async reservePostAttempt({ postId, actorId, createdAt, dailyLimit, minIntervalMs }) {
    return db.runTransaction(async transaction => {
      const existing = await getDocument(COLLECTIONS.posts, postId, transaction)
      if (existing) return { post: existing }
      await enforceLimit(transaction, 'post_attempt', actorId, createdAt, dailyLimit, minIntervalMs)
      return { post: null }
    })
  }

  listPosts({ authorId, cursor, limit }) {
    const where = authorId ? { 'author.id': authorId } : { status: 'approved' }
    return listDocuments(COLLECTIONS.posts, where, cursor, limit)
  }

  listComments({ postId, cursor, limit }) {
    return listDocuments(COLLECTIONS.comments, { postId, status: 'approved' }, cursor, limit)
  }

  listNotifications({ recipientId, cursor, limit }) {
    return listDocuments(COLLECTIONS.notifications, { recipientId }, cursor, limit)
  }

  async createPost({ post, dailyLimit, minIntervalMs }) {
    return db.runTransaction(async transaction => {
      const existing = await getDocument(COLLECTIONS.posts, post.id, transaction)
      if (existing) return { post: existing, idempotent: true }
      await enforceLimit(transaction, 'post', post.author.id, post.createdAt, dailyLimit, minIntervalMs)
      await setDocument(COLLECTIONS.posts, post, transaction)
      return { post, idempotent: false }
    })
  }

  async createComment({ comment, notifications, dailyLimit, minIntervalMs }) {
    return db.runTransaction(async transaction => {
      const existing = await getDocument(COLLECTIONS.comments, comment.id, transaction)
      if (existing) return { comment: existing, idempotent: true }
      const post = await getDocument(COLLECTIONS.posts, comment.postId, transaction)
      if (!isPublicPost(post)) throw new CommunityError('NOT_FOUND', '这条动态暂不可评论')
      if (comment.parentId) {
        const parent = await getDocument(COLLECTIONS.comments, comment.parentId, transaction)
        if (!parent || parent.postId !== post.id || parent.status !== 'approved' || parent.parentId) throw new CommunityError('NOT_FOUND', '要回复的评论不存在')
      }
      await enforceLimit(transaction, 'comment', comment.author.id, comment.createdAt, dailyLimit, minIntervalMs)
      await setDocument(COLLECTIONS.comments, comment, transaction)
      if (comment.status === 'approved') {
        await transaction.collection(COLLECTIONS.posts).doc(post.id).update({ data: { commentCount: command.inc(1) } })
        for (const notice of notifications) await setDocument(COLLECTIONS.notifications, notice, transaction)
      }
      return { comment, idempotent: false }
    })
  }

  async markNotification({ id, recipientId, readAt }) {
    return db.runTransaction(async transaction => {
      const current = await getDocument(COLLECTIONS.notifications, id, transaction)
      if (!current || current.recipientId !== recipientId) throw new CommunityError('NOT_FOUND', '通知不存在')
      if (!current.readAt) await transaction.collection(COLLECTIONS.notifications).doc(id).update({ data: { readAt } })
    })
  }

  async applyReview({ postId, requestHash, reviewId, decision, approvedPhotos, review }) {
    return db.runTransaction(async transaction => {
      const current = await getDocument(COLLECTIONS.posts, postId, transaction)
      if (!current || current.requestHash !== requestHash) throw new CommunityError('REVIEW_CONFLICT', '内容已经变化，请重新检查')
      if (current.review && current.review.id === reviewId) return { postId, status: current.status, idempotent: true }
      if (current.status !== 'pending') throw new CommunityError('REVIEW_CONFLICT', '仅可处理待审核动态')
      await transaction.collection(COLLECTIONS.posts).doc(postId).update({ data: {
        status: decision, textReview: decision, imageReview: decision,
        imagesSanitized: decision === 'approved', approvedPhotos: decision === 'approved' ? approvedPhotos : [], review
      } })
      return { postId, status: decision, idempotent: false }
    })
  }
}

function detectMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return ''
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return ''
}

function downloadMedia(fileID, cloudEnvId) {
  return createBoundedMediaDownloader({
    cloudEnvId,
    getTempFileURL: request => cloud.getTempFileURL(request)
  })(fileID)
}

function createModeration(cloudEnvId) { return {
  async text({ content, openid }) {
    // Version 2 binds review to the authenticated visitor; API errors fail closed in core.
    const result = await cloud.openapi.security.msgSecCheck({ content, openid, version: 2, scene: 2 })
    const successful = result && (result.errCode === 0 || result.errcode === 0)
    const suggestion = result && result.result && result.result.suggest
    if (successful && suggestion === 'pass') return { status: 'approved', verified: true }
    if (successful && suggestion === 'risky') return { status: 'rejected', verified: true }
    return { status: 'pending', verified: false }
  },

  async images({ photos }) {
    const assets = []
    for (const fileID of photos) {
      const buffer = await downloadMedia(fileID, cloudEnvId)
      const mime = detectMime(buffer)
      if (!mime || !buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new CommunityError('INVALID_FILE', '请选择5MB以内的 JPG、PNG 或 WebP 图片')
      assets.push({ fileID, mime, sizeBytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') })
    }
    // Download/format validation is NOT content approval. Until a verified image-review
    // callback and metadata-stripping promotion path exist, all images remain private.
    return { status: 'pending', verified: false, assets }
  }
} }
const moderation = createModeration(process.env.CLOUDBASE_ENV_ID || '')

exports.main = async (event, runtimeContext) => {
  let context
  try {
    context = resolveRequestContext(runtimeContext)
    if (process.env.CLOUDBASE_ENV_ID && context.envId !== process.env.CLOUDBASE_ENV_ID) throw new CommunityError('INVALID_CONTEXT', '本次请求环境无效')
  } catch (_) {
    return { ok: false, error: { code: 'INVALID_CONTEXT', message: '无法确认本次请求身份，请重新进入后再试' } }
  }
  if (event && event.action === STORAGE_PROBE_ACTION) {
    return createStorageProbe({
      enabled: process.env.CAT_COMMUNITY_STORAGE_PROBE_ENABLED === 'true',
      reviewSecret: process.env.CAT_COMMUNITY_REVIEW_SECRET || '',
      media: {
        async sanitize(buffer) { return require('./sanitize').sanitizeApprovedImage(buffer) },
        async upload(cloudPath, buffer) { return (await cloud.uploadFile({ cloudPath, fileContent: buffer })).fileID },
        async download(fileID) { return downloadMedia(fileID, context.envId) }
      }
    }).handle(event, { openid: context.openid })
  }
  // Enable only after the approved-media namespace is verified server-write-only.
  // A missing, misspelled or truthy non-boolean setting must remain fail-closed.
  const mediaEnabled = process.env.CAT_COMMUNITY_MEDIA_ENABLED === 'true'
  if (event && event.action === 'reviewPost') {
    const repository = new CommunityRepository()
    const reviewer = createTrustedReviewer({
      repository: {
        async getPost(id) {
          // The reviewer validates operator identity and signature before this read.
          // Text review and rejection remain possible while image promotion is gated.
          const post = await repository.getPost(id)
          if (!mediaEnabled && event.decision === 'approved' && post && Array.isArray(post.sourcePhotos) && post.sourcePhotos.length) {
            throw new CommunityError('MEDIA_DISABLED', '照片分享审核暂未开放，动态仍保持未公开。')
          }
          return post
        },
        applyReview(input) { return repository.applyReview(input) }
      }, reviewSecret: process.env.CAT_COMMUNITY_REVIEW_SECRET || '',
      media: {
        async download(fileID) { return downloadMedia(fileID, context.envId) },
        async sanitize(buffer) { return require('./sanitize').sanitizeApprovedImage(buffer) },
        async upload(cloudPath, buffer) { return (await cloud.uploadFile({ cloudPath, fileContent: buffer })).fileID }
      }
    })
    return reviewer.handle(event, { openid: context.openid })
  }
  const core = createCommunityCore({
    repository: new CommunityRepository(), moderation: createModeration(context.envId), mediaEnabled,
    ownerSecret: process.env.CAT_COMMUNITY_OWNER_SECRET || '',
    cloudEnvId: context.envId
  })
  const result = await core.handle(event || {}, { openid: context.openid })
  return signProjectedPhotos(result, request => cloud.getTempFileURL(request))
}

exports.CommunityRepository = CommunityRepository
exports.COLLECTIONS = COLLECTIONS
exports.moderation = moderation
exports.detectMime = detectMime
