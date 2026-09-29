'use strict'

const crypto = require('crypto')

const MAX_PHOTOS = 3
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ACTIONS = new Set(['identity', 'mediaContext', 'listPosts', 'getPost', 'listComments', 'publishPost', 'addComment', 'listNotifications', 'markNotification'])

class CommunityError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function fail(code, message) { throw new CommunityError(code, message) }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function hmac(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('hex') }

function text(value, field, max, required = false) {
  if (value == null && !required) return ''
  if (typeof value !== 'string') fail('VALIDATION_ERROR', `${field}格式不正确`)
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  if ((required && !clean) || clean.length > max) fail('VALIDATION_ERROR', `${field}不能为空或超过${max}字`)
  return clean
}

function requestKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(value)) fail('VALIDATION_ERROR', '请提供有效的 requestId')
  return value
}

function entityId(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-f0-9]{40}$`).test(value)) fail('VALIDATION_ERROR', '内容编号格式不正确')
  return value
}

function safeCat(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) fail('VALIDATION_ERROR', '猫咪资料格式不正确')
  // Explicit public whitelist: never persist or echo health, local IDs or location.
  const cat = {
    name: text(value.name, '猫咪名字', 40),
    breed: text(value.breed, '品种', 60),
    coatColor: text(value.coatColor, '毛色', 60)
  }
  return Object.values(cat).some(Boolean) ? cat : null
}

function filePath(fileID, envId) {
  if (typeof fileID !== 'string' || fileID.length > 1024 || /\s/.test(fileID)) fail('INVALID_FILE', '图片文件无效')
  const match = /^cloud:\/\/([A-Za-z0-9-]+)(?:\.([A-Za-z0-9-]+))?\/(.+)$/.exec(fileID)
  if (!match || !envId || match[1] !== envId) fail('INVALID_FILE', '只接受当前云环境的图片')
  if (/\.\.|[\\?#%\s]/.test(match[3])) fail('INVALID_FILE', '图片路径无效')
  return match[3]
}

function isPublicPost(post) {
  return Boolean(post && Array.isArray(post.sourcePhotos) && Array.isArray(post.approvedPhotos) && post.status === 'approved' && post.textReview === 'approved' &&
    (!post.sourcePhotos.length || (post.imageReview === 'approved' && post.imagesSanitized === true &&
      post.approvedPhotos.length === post.sourcePhotos.length)))
}

function publicComment(comment) {
  return {
    id: comment.id, postId: comment.postId, parentId: comment.parentId || null,
    content: comment.content, author: { id: comment.author.id, nickname: comment.author.nickname },
    status: comment.status, createdAt: comment.createdAt
  }
}

function publicPost(post, actorId, comments = []) {
  const owns = post.author.id === actorId
  return {
    id: post.id, content: post.content,
    photos: isPublicPost(post) ? post.approvedPhotos.slice() : (owns ? post.sourcePhotos.slice() : []),
    cat: post.cat ? { name: post.cat.name, breed: post.cat.breed, coatColor: post.cat.coatColor } : null,
    author: { id: post.author.id, nickname: post.author.nickname },
    status: post.status, createdAt: post.createdAt,
    comments: comments.filter(item => item.status === 'approved').map(publicComment),
    commentCount: Math.max(0, Number(post.commentCount) || 0)
  }
}

function createCommunityCore({ repository, moderation = {}, ownerSecret = '', cloudEnvId = '', mediaEnabled = false, now = () => new Date().toISOString() }) {
  function requireMedia() {
    if (mediaEnabled !== true) fail('MEDIA_DISABLED', '照片分享暂未开放；请保留照片草稿，或移除照片后先发布文字。')
  }

  function actorFor(context) {
    if (!context || typeof context.openid !== 'string' || !context.openid.trim()) fail('AUTH_REQUIRED', '请通过微信登录后再使用社区')
    if (context.openid.length > 256) fail('AUTH_REQUIRED', '微信身份无效')
    if (Buffer.byteLength(ownerSecret, 'utf8') < 32) fail('CONFIG_ERROR', '社区身份密钥尚未配置')
    const id = `cu_${hmac(ownerSecret, `community-user-v1|${context.openid}`).slice(0, 40)}`
    return { id, nickname: `猫友${id.slice(-6)}` }
  }

  function mediaPrefix(actor) {
    return `community-pending/${hmac(ownerSecret, `community-upload-v1|${actor.id}`)}/`
  }

  function normalizePhotos(value, actor) {
    if (value == null) return []
    if (!Array.isArray(value) || value.length > MAX_PHOTOS) fail('VALIDATION_ERROR', `最多上传${MAX_PHOTOS}张图片`)
    if (value.length) requireMedia()
    const unique = new Set(value)
    if (unique.size !== value.length) fail('INVALID_FILE', '请勿重复上传同一图片')
    return value.map(fileID => {
      const path = filePath(fileID, cloudEnvId)
      const prefix = mediaPrefix(actor)
      if (!path.startsWith(prefix) || !/^[A-Za-z0-9_-]{8,100}\.(jpg|jpeg|png|webp)$/.test(path.slice(prefix.length))) {
        fail('FILE_NOT_OWNED', '请先使用当前微信账号上传要发布的图片')
      }
      return fileID
    })
  }

  function cursorEncode(scope, item) {
    const payload = Buffer.from(JSON.stringify({ v: 1, scope, at: item.createdAt, id: item.id })).toString('base64url')
    return `${payload}.${hmac(ownerSecret, `cursor|${payload}`)}`
  }

  function cursorDecode(value, scope) {
    if (!value) return null
    if (typeof value !== 'string' || value.length > 1200) fail('INVALID_CURSOR', '分页信息无效，请刷新列表')
    const [payload, signature, extra] = value.split('.')
    const expected = hmac(ownerSecret, `cursor|${payload}`)
    if (extra || !signature || !/^[a-f0-9]{64}$/.test(signature) || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      fail('INVALID_CURSOR', '分页信息无效，请刷新列表')
    }
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      if (parsed.v !== 1 || parsed.scope !== scope || typeof parsed.id !== 'string' || typeof parsed.at !== 'string' || new Date(parsed.at).toISOString() !== parsed.at) throw new Error('cursor')
      return { createdAt: parsed.at, id: parsed.id }
    } catch (error) { fail('INVALID_CURSOR', '分页信息无效，请刷新列表') }
  }

  function pageLimit(value, defaultLimit = 20) {
    if (value == null) return defaultLimit
    if (!Number.isInteger(value) || value < 1 || value > 50) fail('VALIDATION_ERROR', '每页数量必须在1到50之间')
    return value
  }

  async function reviewText(content, openid) {
    try {
      if (typeof moderation.text !== 'function') return 'pending'
      const result = await moderation.text({ content, openid })
      if (result && result.status === 'approved' && result.verified === true) return 'approved'
      if (result && result.status === 'rejected' && result.verified === true) return 'rejected'
    } catch (error) { /* Unavailable moderation is never a public approval. */ }
    return 'pending'
  }

  async function reviewImages(photos, actor, postId) {
    if (!photos.length) return { status: 'approved', photos: [], assets: [], sanitized: true }
    if (typeof moderation.images !== 'function') return { status: 'pending', photos: [], assets: [], sanitized: false }
    const result = await moderation.images({ photos, actorId: actor.id, postId, maxBytes: MAX_IMAGE_BYTES })
    if (result && result.status === 'rejected' && result.verified === true) return { status: 'rejected', photos: [], assets: result.assets || [], sanitized: false }
    if (result && result.status === 'approved' && result.verified === true && result.sanitized === true && Array.isArray(result.photos) && result.photos.length === photos.length) {
      const approved = result.photos.map(fileID => {
        const path = filePath(fileID, cloudEnvId)
        if (!path.startsWith(`community-approved/${postId}/`) || photos.includes(fileID)) fail('MEDIA_REVIEW_INVALID', '图片尚未完成安全处理')
        return fileID
      })
      return { status: 'approved', photos: approved, assets: result.assets || [], sanitized: true }
    }
    return { status: 'pending', photos: [], assets: result && result.assets || [], sanitized: false }
  }

  function checkIdempotency(existing, requestHash) {
    if (existing && existing.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', '此请求编号已用于其他内容，请重新提交')
    return existing
  }

  async function publishPost(event, actor, context) {
    if (event.consent !== true) fail('CONSENT_REQUIRED', '请明确同意将本次内容发布到公开社区')
    const key = requestKey(event.requestId)
    const content = text(event.content, '动态正文', 1200)
    const photos = normalizePhotos(event.photos, actor)
    const cat = safeCat(event.cat)
    if (!content && !photos.length) fail('VALIDATION_ERROR', '请写下动态或选择猫咪图片')
    const id = `post_${hmac(ownerSecret, `post|${actor.id}|${key}`).slice(0, 40)}`
    const requestHash = hash(JSON.stringify({ content, photos, cat, consent: true }))
    const prior = checkIdempotency(await repository.getPost(id), requestHash)
    if (prior) return { post: publicPost(prior, actor.id), idempotent: true }
    // Consume an atomic attempt BEFORE paid moderation or any image I/O. Failed
    // downloads/reviews cannot bypass the successful-post quota indefinitely.
    // Recheck in the same transaction: a just-committed retry consumes no attempt.
    const reservation = await repository.reservePostAttempt({ postId: id, actorId: actor.id,
      createdAt: now(), dailyLimit: 30, minIntervalMs: 2000 })
    const committed = checkIdempotency(reservation && reservation.post, requestHash)
    if (committed) return { post: publicPost(committed, actor.id), idempotent: true }
    const textReview = await reviewText([content, cat && cat.name, cat && cat.breed, cat && cat.coatColor].filter(Boolean).join('\n') || '猫咪照片', context.openid)
    let imageReview
    try { imageReview = await reviewImages(photos, actor, id) } catch (error) {
      if (error instanceof CommunityError) throw error
      imageReview = { status: 'pending', photos: [], assets: [], sanitized: false }
    }
    const status = textReview === 'rejected' || imageReview.status === 'rejected' ? 'rejected'
      : textReview === 'approved' && imageReview.status === 'approved' ? 'approved' : 'pending'
    const post = {
      id, requestHash, author: actor, content, cat, sourcePhotos: photos,
      approvedPhotos: imageReview.photos, sourceAssets: imageReview.assets,
      textReview, imageReview: imageReview.status, imagesSanitized: imageReview.sanitized,
      status, createdAt: now(), commentCount: 0, schemaVersion: 1, consent: true
    }
    const saved = await repository.createPost({ post, dailyLimit: 12, minIntervalMs: 10000 })
    checkIdempotency(saved.post, requestHash)
    return { post: publicPost(saved.post, actor.id), idempotent: Boolean(saved.idempotent) }
  }

  async function addComment(event, actor, context) {
    const key = requestKey(event.requestId)
    const postId = entityId(event.postId, 'post')
    const content = text(event.content, '评论', 300, true)
    const parentId = event.parentId ? entityId(event.parentId, 'comment') : null
    const id = `comment_${hmac(ownerSecret, `comment|${actor.id}|${key}`).slice(0, 40)}`
    const requestHash = hash(JSON.stringify({ postId, content, parentId }))
    const post = await repository.getPost(postId)
    if (!isPublicPost(post)) fail('NOT_FOUND', '这条动态暂不可评论')
    const prior = checkIdempotency(await repository.getComment(id), requestHash)
    if (prior) return { comment: publicComment(prior), idempotent: true }
    let parent = null
    if (parentId) {
      parent = await repository.getComment(parentId)
      if (!parent || parent.postId !== postId || parent.status !== 'approved') fail('NOT_FOUND', '要回复的评论不存在')
      if (parent.parentId) fail('VALIDATION_ERROR', '请回复一级评论')
    }
    const status = await reviewText(content, context.openid)
    // Unlike posts, comments have no operator-review queue in this slice. Keep
    // failed checks retryable and do not persist invisible, permanently pending replies.
    if (status === 'pending') fail('MODERATION_UNAVAILABLE', '审核暂不可用，文字已保留，请稍后重试')
    if (status === 'rejected') fail('CONTENT_REJECTED', '评论未通过内容审核，请修改后重试')
    const createdAt = now()
    const comment = { id, postId, parentId, content, author: actor, status, createdAt, requestHash, schemaVersion: 1 }
    const recipients = status === 'approved' ? [...new Set([post.author.id, parent && parent.author.id].filter(recipient => recipient && recipient !== actor.id))] : []
    const notifications = recipients.map(recipientId => ({
      id: `notice_${hmac(ownerSecret, `notice|${id}|${recipientId}`).slice(0, 40)}`,
      recipientId, postId, commentId: id, actor, type: parentId ? 'reply' : 'comment', createdAt
    }))
    const saved = await repository.createComment({ comment, notifications, dailyLimit: 120, minIntervalMs: 2000 })
    checkIdempotency(saved.comment, requestHash)
    return { comment: publicComment(saved.comment), idempotent: Boolean(saved.idempotent) }
  }

  async function listPosts(event, actor) {
    const filter = event.filter == null ? 'all' : event.filter
    if (!['all', 'mine'].includes(filter)) fail('VALIDATION_ERROR', '动态筛选条件无效')
    const scope = `posts:${filter}:${filter === 'mine' ? actor.id : 'public'}`
    const limit = pageLimit(event.limit)
    const rows = await repository.listPosts({ authorId: filter === 'mine' ? actor.id : null, cursor: cursorDecode(event.cursor, scope), limit: limit + 1 })
    const selected = rows.slice(0, limit)
    const visible = selected.filter(post => filter === 'mine' ? post.author.id === actor.id : isPublicPost(post))
    const posts = await Promise.all(visible.map(async post => publicPost(post, actor.id, await repository.listComments({ postId: post.id, limit: 3 }))))
    return { posts, nextCursor: rows.length > limit ? cursorEncode(scope, selected[selected.length - 1]) : null }
  }

  async function getPost(event, actor) {
    const post = await repository.getPost(entityId(event.postId, 'post'))
    if (!post || (!isPublicPost(post) && post.author.id !== actor.id)) fail('NOT_FOUND', '这条动态不存在或暂未公开')
    const targetRequested = Object.prototype.hasOwnProperty.call(event, 'commentId') && event.commentId !== undefined
    const page = isPublicPost(post) ? await commentPage(post.id, null, 30) : { comments: [], nextCursor: null }
    let targetComment = null
    let targetParent = null
    // Notification links are optional context. An invalid or stale target must not
    // prevent an otherwise accessible story from opening or permit arbitrary reads.
    if (isPublicPost(post) && targetRequested && typeof event.commentId === 'string' && /^comment_[a-f0-9]{40}$/.test(event.commentId)) {
      const target = await repository.getComment(event.commentId)
      if (target && target.postId === post.id && target.status === 'approved') {
        targetComment = publicComment(target)
        if (typeof target.parentId === 'string' && /^comment_[a-f0-9]{40}$/.test(target.parentId)) {
          const parent = await repository.getComment(target.parentId)
          if (parent && parent.postId === post.id && parent.status === 'approved' && !parent.parentId) targetParent = publicComment(parent)
        }
      }
    }
    return {
      post: publicPost(post, actor.id, page.comments), comments: page.comments,
      nextCommentsCursor: page.nextCursor, targetComment, targetParent,
      targetUnavailable: targetRequested && !targetComment
    }
  }

  async function commentPage(postId, cursor, limit) {
    const scope = `comments:${postId}`
    const rows = await repository.listComments({ postId, cursor: cursorDecode(cursor, scope), limit: limit + 1 })
    const selected = rows.slice(0, limit)
    return {
      comments: selected.filter(item => item.postId === postId && item.status === 'approved').map(publicComment),
      nextCursor: rows.length > limit ? cursorEncode(scope, selected[selected.length - 1]) : null
    }
  }

  async function listComments(event) {
    const postId = entityId(event.postId, 'post')
    const limit = pageLimit(event.limit, 30)
    // Recheck visibility on every page: a valid cursor does not grant access to a
    // story that has since been withdrawn, even when requested by its author.
    if (!isPublicPost(await repository.getPost(postId))) fail('NOT_FOUND', '这条动态不存在或暂未公开')
    return commentPage(postId, event.cursor, limit)
  }

  async function listNotifications(event, actor) {
    const scope = `notifications:${actor.id}`
    const limit = pageLimit(event.limit)
    const rows = await repository.listNotifications({ recipientId: actor.id, cursor: cursorDecode(event.cursor, scope), limit: limit + 1 })
    const selected = rows.slice(0, limit)
    const notifications = []
    for (const item of selected) {
      if (item.recipientId !== actor.id) continue
      const [post, comment] = await Promise.all([repository.getPost(item.postId), repository.getComment(item.commentId)])
      if (!isPublicPost(post) || !comment || comment.status !== 'approved' || comment.postId !== post.id) continue
      notifications.push({ id: item.id, type: item.type, postId: item.postId, commentId: item.commentId,
        actor: { id: item.actor.id, nickname: item.actor.nickname }, content: comment.content, createdAt: item.createdAt, read: Boolean(item.readAt) })
    }
    return { notifications, nextCursor: rows.length > limit ? cursorEncode(scope, selected[selected.length - 1]) : null }
  }

  async function markNotification(event, actor) {
    const id = entityId(event.id, 'notice')
    await repository.markNotification({ id, recipientId: actor.id, readAt: now() })
    return { id, read: true }
  }

  return {
    async handle(event = {}, context = {}) {
      try {
        if (!event || typeof event !== 'object' || !ACTIONS.has(event.action)) fail('UNKNOWN_ACTION', '不支持的社区操作')
        const actor = actorFor(context)
        let data
        if (event.action === 'identity') data = { user: actor }
        if (event.action === 'mediaContext') {
          requireMedia()
          if (!cloudEnvId) fail('CONFIG_ERROR', '社区云环境尚未配置')
          data = { cloudPathPrefix: mediaPrefix(actor), maxPhotos: MAX_PHOTOS, maxBytes: MAX_IMAGE_BYTES, acceptedMime: ['image/jpeg', 'image/png', 'image/webp'] }
        }
        if (event.action === 'publishPost') data = await publishPost(event, actor, context)
        if (event.action === 'addComment') data = await addComment(event, actor, context)
        if (event.action === 'listPosts') data = await listPosts(event, actor)
        if (event.action === 'getPost') data = await getPost(event, actor)
        if (event.action === 'listComments') data = await listComments(event)
        if (event.action === 'listNotifications') data = await listNotifications(event, actor)
        if (event.action === 'markNotification') data = await markNotification(event, actor)
        return { ok: true, data }
      } catch (error) {
        return { ok: false, error: { code: error instanceof CommunityError ? error.code : 'SERVICE_UNAVAILABLE', message: error instanceof CommunityError ? error.message : '社区暂时不可用，请稍后重试' } }
      }
    }
  }
}

module.exports = { createCommunityCore, CommunityError, isPublicPost, filePath, MAX_PHOTOS, MAX_IMAGE_BYTES }
