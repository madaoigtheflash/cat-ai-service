// Refresh only media through getPost's normal visibility checks. Never resolve raw
// cloud file IDs, cache privileged URLs, or mutate the page's story/comment draft.
function mediaOf(post = {}) {
  const requested = Array.isArray(post.photos) ? post.photos : []
  const photos = requested.filter(value => typeof value === 'string' && /^https:\/\//.test(value))
  return { photos, photoExpiresAt: typeof post.photoExpiresAt === 'string' ? post.photoExpiresAt : null,
    photosUnavailable: Boolean(post.photosUnavailable) || photos.length !== requested.length }
}

function expired(media, now = Date.now()) {
  const expiry = Date.parse(media.photoExpiresAt)
  return Boolean(media.photos.length && Number.isFinite(expiry) && expiry <= now)
}

function createPhotoRecovery({ getPost, onChange, now = () => Date.now() }) {
  let id = '', sourceVersion = '', epoch = 0, revision = 0, disposed = false, flight = null, automaticUsed = false
  let media = mediaOf(), failed = false, blocked = false, loading = false, message = ''

  function snapshot() {
    return { id, epoch, revision, media: { ...media, photos: media.photos.slice() }, failed, blocked, loading, message,
      hasPhotos: Boolean(media.photos.length || media.photosUnavailable || message || loading),
      canRetry: !blocked && Boolean(failed || media.photosUnavailable || message || loading) }
  }
  function emit() { if (!disposed) onChange(snapshot()) }
  function current(token) { return !disposed && token === epoch }
  function hasMedia() { return Boolean(media.photos.length || media.photosUnavailable) }

  function observe(post = {}) {
    const incoming = mediaOf(post), nextId = String(post.id || '')
    const version = JSON.stringify([nextId, post.status || '', incoming])
    if (disposed) return
    // Only a fresh parent-supplied signature/version earns a new automatic attempt.
    // URLs obtained by this controller never reset this budget.
    if (sourceVersion !== version) {
      sourceVersion = version; id = nextId; epoch += 1; revision += 1
      flight = null; automaticUsed = false; media = incoming; loading = false; blocked = false
      failed = expired(media, now())
      message = failed ? '照片链接已过期，可以重新加载。' : media.photosUnavailable ? '有照片暂时没能加载，可以重试。' : ''
    }
    emit()
  }

  function refresh(automatic = false) {
    if (disposed || !id || blocked || !hasMedia()) return Promise.resolve(false)
    if (flight) return flight
    if (automatic && automaticUsed) return Promise.resolve(false)
    automaticUsed = true
    const token = epoch, postId = id
    loading = true; message = '正在重新加载照片…'; emit()
    const operation = Promise.resolve().then(() => getPost(postId)).then(result => {
      if (!current(token)) return false
      const post = result && result.post
      if (!post || post.id !== postId || !Array.isArray(post.photos)) throw new Error('invalid photo response')
      media = mediaOf(post); revision += 1
      failed = expired(media, now())
      message = failed ? '照片链接仍已过期，请稍后重试。' : media.photosUnavailable ? '有照片仍未加载，稍后可以重试。' : ''
      return !failed && !media.photosUnavailable && media.photos.length > 0
    }).catch(error => {
      if (!current(token)) return false
      failed = true
      if (['NOT_FOUND', 'FORBIDDEN', 'AUTH_REQUIRED'].includes(error && error.code)) {
        blocked = true; media = mediaOf(); revision += 1
        message = '这些照片已不可查看，已停止显示。'
      } else message = '照片暂时没能加载，请重试。'
      return false
    }).finally(() => {
      if (current(token) && flight === operation) { flight = null; loading = false; emit() }
    })
    flight = operation
    return operation
  }

  function resume() {
    if (disposed || blocked || !hasMedia()) return Promise.resolve(false)
    if (expired(media, now())) { failed = true; message = '照片链接已过期，可以重新加载。'; emit() }
    return failed || media.photosUnavailable ? refresh(true) : Promise.resolve(false)
  }

  function imageError({ imageRevision, src } = {}) {
    if (disposed || blocked || String(imageRevision) !== String(revision) || src !== media.photos[0]) return Promise.resolve(false)
    failed = true; message = '照片暂时无法显示，可以重新加载。'; emit()
    return refresh(true)
  }

  async function preview() {
    const token = epoch
    if (disposed || blocked || !hasMedia()) return []
    if (flight || failed || media.photosUnavailable || expired(media, now())) await refresh(false)
    if (!current(token) || blocked || failed || media.photosUnavailable || expired(media, now())) return []
    return media.photos.slice()
  }

  function previewError(token, imageRevision) {
    if (!current(token) || imageRevision !== revision) return
    failed = true; message = '照片预览暂时没有打开，请重试。'; emit()
  }

  return { observe, snapshot, resume, imageError, preview, previewError, retry: () => refresh(false),
    dispose() { disposed = true; epoch += 1; flight = null }, current }
}

module.exports = { mediaOf, expired, createPhotoRecovery }
