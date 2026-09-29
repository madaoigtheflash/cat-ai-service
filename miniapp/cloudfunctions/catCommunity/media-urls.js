'use strict'

const PHOTO_TTL_SECONDS = 300

// Call only on the completed core response, AFTER its ownership/public-review
// checks and whitelist projection. Never pass repository documents to this helper.
async function signProjectedPhotos(result, getTempFileURL, now = () => Date.now()) {
  if (!result || result.ok !== true || !result.data) return result
  const posts = Array.isArray(result.data.posts) ? result.data.posts : result.data.post ? [result.data.post] : []
  const fileIDs = [...new Set(posts.flatMap(post => Array.isArray(post.photos) ? post.photos.filter(fileID => typeof fileID === 'string' && fileID.startsWith('cloud://')) : []))]
  if (!fileIDs.length) return result
  const urls = new Map()
  for (let start = 0; start < fileIDs.length; start += 50) {
    const batch = fileIDs.slice(start, start + 50)
    // Count network time against the viewing window. The provider may grant a
    // shorter lifetime than requested; never advertise a later local expiry.
    const requestedAt = now()
    try {
      const response = await getTempFileURL({ fileList: batch.map(fileID => ({ fileID, maxAge: PHOTO_TTL_SECONDS })) })
      for (const item of response && response.fileList || []) {
        const ttl = item && item.maxAge === undefined ? PHOTO_TTL_SECONDS : item && item.maxAge
        if (item && batch.includes(item.fileID) && (item.status === 0 || item.status == null) &&
          typeof item.tempFileURL === 'string' && item.tempFileURL.startsWith('https://') &&
          Number.isFinite(ttl) && ttl > 0) {
          urls.set(item.fileID, { url: item.tempFileURL, expiresAt: requestedAt + Math.min(ttl, PHOTO_TTL_SECONDS) * 1000 })
        }
      }
    } catch (error) { /* Do not expose source IDs or storage errors on signing failure. */ }
  }
  const completedAt = now()
  function decorate(post) {
    const original = Array.isArray(post.photos) ? post.photos : []
    const signed = original.map(fileID => urls.get(fileID)).filter(item => item && item.expiresAt > completedAt)
    const photos = signed.map(item => item.url)
    const expiresAt = signed.length ? new Date(Math.min(...signed.map(item => item.expiresAt))).toISOString() : null
    return { ...post, photos, photoExpiresAt: expiresAt, photosUnavailable: photos.length !== original.length }
  }
  return { ...result, data: { ...result.data,
    ...(Array.isArray(result.data.posts) ? { posts: result.data.posts.map(decorate) } : {}),
    ...(result.data.post ? { post: decorate(result.data.post) } : {})
  } }
}

module.exports = { signProjectedPhotos, PHOTO_TTL_SECONDS }
