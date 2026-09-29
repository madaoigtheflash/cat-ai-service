function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
}

function timeLabel(value) {
  const raw = value && typeof value === 'object' ? value.$date || value.timestamp : value
  const date = new Date(raw)
  if (!raw || !Number.isFinite(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  const now = new Date()
  const sameDay = now.getFullYear() === date.getFullYear() && now.getMonth() === date.getMonth() && now.getDate() === date.getDate()
  return sameDay ? `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}` : `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

function authorOf(value) {
  const author = value || {}
  const nickname = text(author.nickname) || '猫友'
  return { id: text(author.id), nickname, initial: nickname.slice(0, 1) }
}

function commentOf(value) {
  const comment = value || {}
  return {
    id: text(comment.id || comment._id), parentId: text(comment.parentId), content: text(comment.content),
    author: authorOf(comment.author), replyToName: text(comment.replyToName || (comment.replyTo && comment.replyTo.nickname)),
    timeLabel: comment.timeLabel || timeLabel(comment.createdAt)
  }
}

function postOf(value) {
  const post = value || {}
  const cat = post.cat || {}
  const status = text(post.status)
  const statuses = { pending: '审核中', pending_review: '审核中', rejected: '未通过审核', hidden: '已隐藏', removed: '已移除', deleted: '已删除', published: '已公开', public: '已公开', approved: '已公开' }
  return {
    id: text(post.id || post._id), content: text(post.content),
    photos: (Array.isArray(post.photos) ? post.photos : []).map(photo => text(typeof photo === 'object' && photo ? photo.url || photo.tempFileURL : photo)).filter(Boolean),
    photoExpiresAt: typeof post.photoExpiresAt === 'string' ? post.photoExpiresAt : null,
    photosUnavailable: Boolean(post.photosUnavailable),
    cat: { name: text(cat.name) || '未命名猫咪', breed: text(cat.breed), coatColor: text(cat.coatColor) },
    hasCat: typeof post.hasCat === 'boolean' ? post.hasCat : Boolean(cat.name || cat.breed || cat.coatColor),
    author: authorOf(post.author), status, statusLabel: statuses[status] || '',
    timeLabel: post.timeLabel || timeLabel(post.createdAt),
    comments: (Array.isArray(post.comments) ? post.comments : []).slice(0, 2).map(commentOf),
    commentCount: Math.max(0, Number(post.commentCount) || 0)
  }
}

function uniquePosts(posts) {
  const ids = new Set()
  return posts.filter(post => {
    if (!post.id || ids.has(post.id)) return false
    ids.add(post.id)
    return true
  })
}

module.exports = { text, timeLabel, authorOf, commentOf, postOf, uniquePosts }
