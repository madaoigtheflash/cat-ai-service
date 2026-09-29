// Public stories are a separate service: never send local archives to catOnline
// or the A/B staging function through this adapter.
const CLOUD_ENV = 'cloud1-d6gpjpxunc74669d7'
const FUNCTION_NAME = 'catCommunity'
const DRAFT_KEY = 'catai_community_compose_v1'
const RETRY_KEY = 'catai_community_retry_v1'
const MAX_PENDING_COMMENTS = 32
const flights = new Map()
let publishingRequest = ''

function requestId() { return `social_${Date.now()}_${Math.random().toString(36).slice(2, 12)}` }
function read(key, fallback) {
  try { return wx.getStorageSync(key) || fallback } catch (_) { return fallback }
}
function errorMessage(error) {
  const detail = String(error && (error.message || error.errMsg) || '')
  if (/FUNCTION_NOT_FOUND|FUNCTION_NOT_EXIST|function.*not.*found|FunctionName.*could not|ResourceNotFound.Function/i.test(detail)) return '广场服务尚未部署；草稿仍保留在本机。'
  if (/cloud.callFunction:fail|network|timeout|timed out/i.test(detail)) return '暂时连接不上广场，请稍后重试；未完成的草稿仍保留在本机。'
  return detail.slice(0, 180) || '暂时连接不上广场，请稍后重试。'
}
async function call(action, input = {}) {
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && app.globalData && app.globalData.catoLabOffline) {
    throw new Error('此分支为离线审计实验，不连接生产云端；没有发送或上传。')
  }
  if (!wx.cloud) throw new Error('当前微信版本不支持云开发，请升级后重试。')
  try {
    const response = await wx.cloud.callFunction({ name: FUNCTION_NAME, config: { env: CLOUD_ENV }, data: { action, ...input } })
    const result = response && response.result
    if (!result || result.ok !== true) {
      const error = new Error(result && result.error && result.error.message || '广场没有返回有效结果，请重试。')
      error.code = result && result.error && result.error.code
      throw error
    }
    return result.data
  } catch (error) {
    const normalized = new Error(errorMessage(error))
    normalized.code = error.code
    throw normalized
  }
}

function once(key, fn) {
  if (flights.has(key)) return flights.get(key)
  const promise = Promise.resolve().then(fn).finally(() => flights.delete(key))
  flights.set(key, promise)
  return promise
}

// Only accept the server's already ACL-checked, signed photo projection. Never
// resolve raw file IDs in the client: renewal must recheck access via getPost.
async function resolvePosts(posts) {
  return posts.map(post => {
    const original = Array.isArray(post.photos) ? post.photos : []
    const photos = original.filter(url => typeof url === 'string' && /^https:\/\/[^\s/]+\//.test(url))
    return { ...post, photos, photosUnavailable: Boolean(post.photosUnavailable) || photos.length !== original.length }
  })
}
async function listPosts(options = {}) {
  const result = await call('listPosts', { filter: options.filter === 'mine' ? 'mine' : 'all', cursor: options.cursor || '', limit: 12 })
  return { ...result, posts: await resolvePosts(result.posts || []) }
}
async function getPost(postId, options = {}) {
  const result = await call('getPost', { postId, ...(options.commentId ? { commentId: options.commentId } : {}) })
  const posts = await resolvePosts(result.post ? [result.post] : [])
  return { ...result, post: posts[0], comments: result.comments || (result.post && result.post.comments) || [] }
}
function whitelistCat(cat) {
  if (!cat) return null
  return { name: String(cat.name || '').trim().slice(0, 40), breed: String(cat.breed || '').trim().slice(0, 60), coatColor: String(cat.coatColor || '').trim().slice(0, 40) }
}
function saveDraft(draft) {
  // Deliberately excludes the entire pet object and previous recognition result.
  const value = { content: String(draft.content || '').slice(0, 1200), cat: whitelistCat(draft.cat),
    photos: (Array.isArray(draft.photos) ? draft.photos : []).slice(0, 3).map(String),
    includeCat: Boolean(draft.includeCat), requestId: draft.requestId || requestId(), uploads: draft.uploads || {}, updatedAt: Date.now() }
  wx.setStorageSync(DRAFT_KEY, value)
  return value
}
function getDraft() { return read(DRAFT_KEY, null) }
function clearDraft() { wx.removeStorageSync(DRAFT_KEY) }

function fileInfo(path) { return new Promise((resolve, reject) => wx.getFileInfo({ filePath: path, success: resolve, fail: () => reject(new Error('草稿照片已失效，请移除后重新选择。')) })) }
function imageInfo(path) { return new Promise((resolve, reject) => wx.getImageInfo({ src: path, success: resolve, fail: () => reject(new Error('无法读取这张照片，请重新选择。')) })) }
function persistPhoto(path) {
  return new Promise((resolve, reject) => wx.saveFile({ tempFilePath: path,
    success: result => resolve(result.savedFilePath), fail: () => reject(new Error('无法保存照片草稿，请检查本机存储空间。')) }))
}
async function choosePhotos(count = 3) {
  const result = await new Promise((resolve, reject) => wx.chooseMedia({ count: Math.max(1, Math.min(3, count)), mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: resolve, fail: reject }))
  const paths = []
  for (const file of (result.tempFiles || []).slice(0, count)) {
    const info = await fileInfo(file.tempFilePath)
    if (info.size > 5 * 1024 * 1024) throw new Error('单张照片请控制在 5MB 内。')
    paths.push(await persistPhoto(file.tempFilePath))
  }
  return paths
}
// Callback-style upload exposes UploadTask progress in WeChat. Promise-style
// runtimes are also supported, with one settlement even if both are provided.
function uploadPhoto(cloudPath, filePath, onProgress) {
  return new Promise((resolve, reject) => {
    let settled = false, task, lastPercent = 0
    const progress = event => {
      if (settled || !event) return
      let value = event.progress
      if (!Number.isFinite(value) && Number.isFinite(event.totalBytesSent) && event.totalBytesExpectedToSend > 0) {
        value = event.totalBytesSent / event.totalBytesExpectedToSend * 100
      }
      if (!Number.isFinite(value) || value < 0 || value > 100) return
      lastPercent = Math.max(lastPercent, value)
      onProgress(lastPercent)
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      try { if (task && task.offProgressUpdate) task.offProgressUpdate(progress) } catch (_) {}
      if (error) reject(new Error(errorMessage(error)))
      else resolve(result)
    }
    try {
      task = wx.cloud.uploadFile({ cloudPath, filePath, config: { env: CLOUD_ENV },
        success: result => finish(null, result), fail: error => finish(error) })
      if (task && typeof task.then === 'function') task.then(result => finish(null, result), error => finish(error))
      // A runtime without a progress hook can still finish through callbacks.
      try { if (!settled && task && task.onProgressUpdate) task.onProgressUpdate(progress) } catch (_) {}
    } catch (error) { finish(error) }
  })
}
async function publishPost(input, options = {}) {
  if (input.consent !== true) throw new Error('请先确认这些内容可以在公开广场展示。')
  const intent = input.requestId || requestId()
  if (flights.has('publish') && publishingRequest !== intent) throw new Error('上一条动态还在提交，请稍后重试；这份新草稿会保留。')
  publishingRequest = intent
  return once('publish', async () => {
    const draft = saveDraft({ ...input, requestId: intent })
    const total = draft.photos.length
    const progress = (phase, completed, percent = null) => {
      // UI callbacks are observers: a detached page or a rendering error must
      // never turn an uploaded/published post into an ambiguous failed request.
      try { if (typeof options.onProgress === 'function') options.onProgress({ phase, completed, total, percent }) } catch (_) {}
    }
    progress('preparing', 0)
    // Text sharing does not depend on image storage or the media rollout gate.
    const context = draft.photos.length ? await call('mediaContext') : null
    if (context) {
      context.prefix = context.prefix || context.cloudPathPrefix
      if (!context.prefix || !/^community(?:-pending)?\//.test(context.prefix)) throw new Error('照片上传配置不可用，请稍后重试。')
    }
    const photos = []
    for (let index = 0; index < draft.photos.length; index += 1) {
      const path = draft.photos[index]
      const prior = draft.uploads[path]
      if (prior && prior.prefix === context.prefix && prior.fileID) {
        photos.push(prior.fileID)
        progress('uploading', index + 1, Math.round((index + 1) / total * 100))
        continue
      }
      const [file, info] = await Promise.all([fileInfo(path), imageInfo(path)])
      if (file.size > (context.maxBytes || 5 * 1024 * 1024)) throw new Error('单张照片请控制在 5MB 内。')
      const extension = String(info.type || '').toLowerCase()
      if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension)) throw new Error('请选择 JPEG、PNG 或 WebP 照片。')
      progress('uploading', index, Math.round(index / total * 100))
      const uploaded = await uploadPhoto(`${context.prefix}${draft.requestId}_${index}.${extension}`, path,
        percent => progress('uploading', index, Math.round((index + percent / 100) / total * 100)))
      if (!uploaded || !uploaded.fileID) throw new Error('照片上传没有完成，请重试。')
      draft.uploads[path] = { prefix: context.prefix, fileID: uploaded.fileID }
      // Leaving and reopening the editor can create a newer draft while this
      // transfer continues. Never overwrite that newer intent with old uploads.
      if ((getDraft() || {}).requestId === draft.requestId) saveDraft(draft)
      photos.push(uploaded.fileID)
      progress('uploading', index + 1, Math.round((index + 1) / total * 100))
    }
    progress('submitting', total)
    const result = await call('publishPost', { requestId: draft.requestId, content: draft.content, photos, cat: draft.includeCat ? whitelistCat(draft.cat) : null, consent: true })
    // A timeout must retain uploads and requestId: server may already have saved it.
    if ((getDraft() || {}).requestId === draft.requestId) clearDraft()
    return result
  })
}
function pendingComments() {
  let saved
  try { saved = wx.getStorageSync(RETRY_KEY) }
  catch (_) { throw new Error('无法读取评论重试记录，请检查本机存储后重试。') }
  if (!saved) return {}
  // Migrate the old singleton without losing an ambiguous committed request.
  if (typeof saved.key === 'string' && typeof saved.requestId === 'string') return { [saved.key]: saved.requestId }
  if (saved.version === 2 && saved.requests && typeof saved.requests === 'object' && !Array.isArray(saved.requests) &&
    Object.values(saved.requests).every(value => typeof value === 'string')) return { ...saved.requests }
  throw new Error('评论重试记录无法读取，请勿清除本机数据，稍后重试。')
}
function savePendingComments(requests) {
  if (Object.keys(requests).length) wx.setStorageSync(RETRY_KEY, { version: 2, requests })
  else wx.removeStorageSync(RETRY_KEY)
}
function clearPendingComment(retryKey, request) {
  // Other comments may start/finish while a call is in flight. Re-read and
  // remove only this confirmed operation, never an earlier snapshot or all keys.
  const current = pendingComments()
  if (current[retryKey] === request) {
    delete current[retryKey]
    savePendingComments(current)
  }
}
function addComment(postId, content, parentId = '') {
  const payload = { postId, content: String(content || '').trim(), parentId }
  const key = JSON.stringify(payload)
  return once(`comment:${key}`, async () => {
    const actor = await call('identity')
    const saved = pendingComments()
    const retryKey = `${(actor.user || actor).id}:${key}`
    if (!saved[retryKey] && Object.keys(saved).length >= MAX_PENDING_COMMENTS) {
      throw new Error('待确认的评论较多，请先重试之前未完成的评论，再发送新内容。')
    }
    const request = saved[retryKey] || requestId()
    saved[retryKey] = request
    savePendingComments(saved)
    let result
    try { result = await call('addComment', { ...payload, requestId: request }) }
    catch (error) {
      // The server checks prior commits before moderation. Explicit rejection
      // therefore confirms no commit; outages and unknown failures remain pending.
      if (error.code === 'CONTENT_REJECTED') clearPendingComment(retryKey, request)
      throw error
    }
    clearPendingComment(retryKey, request)
    return result
  })
}

module.exports = { CLOUD_ENV, FUNCTION_NAME, listPosts, getPost, publishPost, addComment, choosePhotos,
  listComments: (postId, options = {}) => call('listComments', { postId, cursor: options.cursor || '', limit: 30 }),
  identity: async () => { const result = await call('identity'); return result.user || result },
  listNotifications: (options = {}) => call('listNotifications', { cursor: options.cursor || '', limit: 20 }),
  markNotification: id => call('markNotification', { id }),
  saveDraft, getDraft, clearDraft, requestId,
  _test: { call, whitelistCat, resolvePosts, flights, DRAFT_KEY, RETRY_KEY, MAX_PENDING_COMMENTS } }
