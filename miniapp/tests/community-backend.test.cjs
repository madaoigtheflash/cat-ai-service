'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createCommunityCore, CommunityError, isPublicPost } = require('../cloudfunctions/catCommunity/core')
const { createTrustedReviewer, signReview } = require('../cloudfunctions/catCommunity/review')
const { signProjectedPhotos } = require('../cloudfunctions/catCommunity/media-urls')

const OWNER_SECRET = 'unit-test-owner-secret-not-production-000000000'
const REVIEW_SECRET = 'unit-test-review-secret-not-production-00000000'
const ENV = 'community-test-env'
const START = Date.parse('2026-09-29T00:00:00.000Z')
const approved = async () => ({ status: 'approved', verified: true })

class MemoryRepository {
  constructor() { this.posts = new Map(); this.comments = new Map(); this.notices = new Map(); this.limits = new Map() }
  async getPost(id) { return this.posts.get(id) || null }
  async getComment(id) { return this.comments.get(id) || null }
  limit(kind, actor, at, max, gap) {
    const key = `${kind}:${actor}:${at.slice(0, 10)}`
    const current = this.limits.get(key) || { count: 0, at: 0 }
    if (current.count >= max || Date.parse(at) - current.at < gap) throw new CommunityError('RATE_LIMITED', '发布太频繁')
    this.limits.set(key, { count: current.count + 1, at: Date.parse(at) })
  }
  async reservePostAttempt({ postId, actorId, createdAt, dailyLimit, minIntervalMs }) {
    if (this.posts.has(postId)) return { post: this.posts.get(postId) }
    this.limit('post_attempt', actorId, createdAt, dailyLimit, minIntervalMs)
    return { post: null }
  }
  async createPost({ post, dailyLimit, minIntervalMs }) {
    if (this.posts.has(post.id)) return { post: this.posts.get(post.id), idempotent: true }
    this.limit('post', post.author.id, post.createdAt, dailyLimit, minIntervalMs)
    this.posts.set(post.id, post)
    return { post, idempotent: false }
  }
  async createComment({ comment, notifications, dailyLimit, minIntervalMs }) {
    if (this.comments.has(comment.id)) return { comment: this.comments.get(comment.id), idempotent: true }
    const post = this.posts.get(comment.postId)
    if (!isPublicPost(post)) throw new CommunityError('NOT_FOUND', '动态不存在')
    this.limit('comment', comment.author.id, comment.createdAt, dailyLimit, minIntervalMs)
    this.comments.set(comment.id, comment)
    if (comment.status === 'approved') {
      post.commentCount += 1
      notifications.forEach(notice => this.notices.set(notice.id, notice))
    }
    return { comment, idempotent: false }
  }
  page(rows, cursor, limit) {
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .filter(row => !cursor || row.createdAt < cursor.createdAt || (row.createdAt === cursor.createdAt && row.id < cursor.id)).slice(0, limit)
  }
  async listPosts({ authorId, cursor, limit }) {
    return this.page([...this.posts.values()].filter(post => authorId ? post.author.id === authorId : post.status === 'approved'), cursor, limit)
  }
  async listComments({ postId, cursor, limit }) { return this.page([...this.comments.values()].filter(item => item.postId === postId && item.status === 'approved'), cursor, limit) }
  async listNotifications({ recipientId, cursor, limit }) { return this.page([...this.notices.values()].filter(item => item.recipientId === recipientId), cursor, limit) }
  async markNotification({ id, recipientId, readAt }) {
    const item = this.notices.get(id)
    if (!item || item.recipientId !== recipientId) throw new CommunityError('NOT_FOUND', '通知不存在')
    item.readAt = item.readAt || readAt
  }
  async applyReview({ postId, requestHash, reviewId, decision, approvedPhotos, review }) {
    const post = this.posts.get(postId)
    if (!post || post.requestHash !== requestHash) throw new CommunityError('REVIEW_CONFLICT', '内容变化')
    if (post.review && post.review.id === reviewId) return { postId, status: post.status, idempotent: true }
    if (post.status !== 'pending') throw new CommunityError('REVIEW_CONFLICT', '状态变化')
    Object.assign(post, { status: decision, textReview: decision, imageReview: decision, imagesSanitized: decision === 'approved', approvedPhotos, review })
    return { postId, status: decision, idempotent: false }
  }
}

function setup(options = {}) {
  const repository = new MemoryRepository()
  let clock = START
  const core = createCommunityCore({ repository, moderation: { text: approved, ...options.moderation }, ownerSecret: OWNER_SECRET, cloudEnvId: ENV, mediaEnabled: true, now: () => new Date(clock).toISOString(), ...options.core })
  const call = (action, args = {}, openid = 'alice-real-openid') => core.handle({ action, ...args }, { openid })
  return { repository, core, call, tick: (ms = 11000) => { clock += ms } }
}

async function post(fixture, args = {}, openid) {
  return fixture.call('publishPost', { requestId: 'request-post-0001', content: '今天的小猫在窗边晒太阳', consent: true, ...args }, openid)
}

async function imageFile(fixture, openid = 'alice-real-openid') {
  const result = await fixture.call('mediaContext', {}, openid)
  return `cloud://${ENV}.storage/${result.data.cloudPathPrefix}image-00000001.jpg`
}

function seedComment(fixture, postId, index, overrides = {}) {
  const comment = {
    id: `comment_${index.toString(16).padStart(40, '0')}`, postId, parentId: null,
    content: `历史评论${index}`, author: { id: `cu_${'a'.repeat(40)}`, nickname: '历史猫友' },
    status: 'approved', createdAt: new Date(START).toISOString(), requestHash: 'private-comment-request-hash',
    ...overrides
  }
  fixture.repository.comments.set(comment.id, comment)
  if (comment.status === 'approved') fixture.repository.posts.get(postId).commentCount += 1
  return comment
}

test('requires a trusted WeChat identity and dedicated secret; ignores forged client identities', async () => {
  const f = setup()
  const rejected = await f.call('identity', { userId: 'demo-user', openid: 'forged' }, '')
  assert.equal(rejected.error.code, 'AUTH_REQUIRED')
  const alice = await f.call('identity', { userId: 'bob', author: { id: 'bob' } })
  const again = await f.call('identity')
  const bob = await f.call('identity', {}, 'bob-real-openid')
  assert.deepEqual(alice, again)
  assert.notEqual(alice.data.user.id, bob.data.user.id)
  assert.doesNotMatch(JSON.stringify(alice), /alice-real-openid|demo|bob/)
  const missing = setup({ core: { ownerSecret: '' } })
  assert.equal((await missing.call('identity')).error.code, 'CONFIG_ERROR')
})

test('explicit publish consent is mandatory; no implied publication from a cat record', async () => {
  const f = setup()
  assert.equal((await post(f, { consent: false })).error.code, 'CONSENT_REQUIRED')
  assert.equal((await post(f, { consent: 'true' })).error.code, 'CONSENT_REQUIRED')
  assert.equal(f.repository.posts.size, 0)
})

test('media defaults off, denies upload context and photo publication, but permits moderated text', async () => {
  for (const mediaEnabled of [undefined, false, 'true', 1]) {
    const f = setup({ core: { mediaEnabled } })
    const context = await f.call('mediaContext')
    assert.equal(context.error.code, 'MEDIA_DISABLED')
    assert.match(context.error.message, /照片分享暂未开放/)
    const withPhoto = await post(f, { photos: ['cloud://community-test-env.storage/anything.jpg'] })
    assert.equal(withPhoto.error.code, 'MEDIA_DISABLED')
    assert.equal(f.repository.posts.size, 0)
    const textOnly = await post(f, { photos: [] })
    assert.equal(textOnly.data.post.status, 'approved')
    assert.equal(f.repository.posts.size, 1)
  }
})

test('public whitelist excludes private health, location, local IDs, raw identity and arbitrary fields', async () => {
  const f = setup()
  const result = await post(f, { cat: { name: '奶糖', breed: '中华田园猫', coatColor: '橘白', localId: 'private-local-id', health: 'private-medical-record', location: { lat: 1 } }, health: 'private-medical-record', location: { lat: 1 }, author: { id: 'forged-id' } })
  assert.equal(result.data.post.status, 'approved')
  assert.deepEqual(result.data.post.cat, { name: '奶糖', breed: '中华田园猫', coatColor: '橘白' })
  const saved = [...f.repository.posts.values()][0]
  assert.doesNotMatch(JSON.stringify(saved), /private-local-id|private-medical-record|location|forged-id|alice-real-openid/)
  assert.equal((await f.call('listPosts', {}, 'bob-real-openid')).data.posts.length, 1)
  assert.doesNotMatch(JSON.stringify(result), /requestHash|sourceAssets|textReview/)
})

test('all visible text including the cat snapshot is moderated', async () => {
  const seen = []
  const f = setup({ moderation: { text: async input => { seen.push(input); return approved() } } })
  await post(f, { cat: { name: '奶糖', breed: '短毛', coatColor: '橘白' } })
  assert.match(seen[0].content, /奶糖\n短毛\n橘白/)
  assert.equal(seen[0].openid, 'alice-real-openid')
})

for (const [label, moderation, status] of [
  ['outage', async () => { throw new Error('secret-provider-error') }, 'pending'],
  ['unverified pass', async () => ({ status: 'approved' }), 'pending'],
  ['unknown result', async () => ({ suggest: 'pass' }), 'pending'],
  ['verified rejection', async () => ({ status: 'rejected', verified: true }), 'rejected']
]) {
  test(`text moderation ${label} never reaches the global feed`, async () => {
    const f = setup({ moderation: { text: moderation } })
    const result = await post(f)
    assert.equal(result.data.post.status, status)
    assert.equal((await f.call('listPosts', {}, 'bob-real-openid')).data.posts.length, 0)
    assert.equal((await f.call('listPosts', { filter: 'mine' })).data.posts.length, 1)
    assert.equal((await f.call('getPost', { postId: result.data.post.id }, 'bob-real-openid')).error.code, 'NOT_FOUND')
    assert.doesNotMatch(JSON.stringify(result), /secret-provider-error/)
  })
}

test('media ownership is server-bound; cross-owner, foreign-environment, arbitrary or traversal paths fail', async () => {
  const f = setup()
  const aliceFile = await imageFile(f)
  assert.equal((await post(f, { photos: [aliceFile] }, 'bob-real-openid')).error.code, 'FILE_NOT_OWNED')
  for (const file of ['https://example.com/cat.jpg', aliceFile.replace(ENV, 'foreign-env'), aliceFile.replace('image-00000001.jpg', '../secret.jpg'), aliceFile.replace('image-00000001.jpg', 'image%2fescape.jpg')]) {
    assert.equal((await post(f, { photos: [file] })).error.code, 'INVALID_FILE')
  }
  const limits = (await f.call('mediaContext')).data
  assert.equal(limits.maxPhotos, 3)
  assert.equal(limits.maxBytes, 5 * 1024 * 1024)
})

test('pending image posts expose original file IDs only to their owner', async () => {
  const f = setup()
  const file = await imageFile(f)
  const result = await post(f, { photos: [file] })
  assert.equal(result.data.post.status, 'pending')
  assert.deepEqual(result.data.post.photos, [file])
  assert.deepEqual((await f.call('listPosts', {}, 'bob-real-openid')).data.posts, [])
  assert.equal((await f.call('getPost', { postId: result.data.post.id }, 'bob-real-openid')).error.code, 'NOT_FOUND')
  assert.equal((await f.call('listPosts', { filter: 'mine' })).data.posts[0].photos[0], file)
})

test('image approval requires verified sanitized server copies, not format validation or a claimed pass', async () => {
  for (const review of [{ status: 'approved', verified: false, sanitized: true }, { status: 'approved', verified: true, sanitized: false }]) {
    const f = setup({ moderation: { images: async () => review } })
    const result = await post(f, { photos: [await imageFile(f)] })
    assert.equal(result.data.post.status, 'pending')
  }
  const f = setup({ moderation: { images: async ({ photos }) => ({ status: 'approved', verified: true, sanitized: true, photos }) } })
  assert.equal((await post(f, { photos: [await imageFile(f)] })).error.code, 'MEDIA_REVIEW_INVALID')
  assert.equal(f.repository.posts.size, 0)
})

test('verified sanitized promotion returns only the approved copy in public posts', async () => {
  const f = setup({ moderation: { images: async ({ postId }) => ({ status: 'approved', verified: true, sanitized: true, photos: [`cloud://${ENV}.storage/community-approved/${postId}/safe.jpg`] }) } })
  const source = await imageFile(f)
  const result = await post(f, { photos: [source] })
  assert.equal(result.data.post.status, 'approved')
  const global = await f.call('listPosts', {}, 'bob-real-openid')
  assert.match(global.data.posts[0].photos[0], /community-approved/)
  assert.doesNotMatch(JSON.stringify(global), /community-pending/)
})

test('a legacy or manually toggled approval cannot leak an unreviewed image', async () => {
  const f = setup()
  const result = await post(f, { photos: [await imageFile(f)] })
  f.repository.posts.get(result.data.post.id).status = 'approved'
  assert.deepEqual((await f.call('listPosts', {}, 'bob-real-openid')).data.posts, [])
  assert.equal((await f.call('getPost', { postId: result.data.post.id }, 'bob-real-openid')).error.code, 'NOT_FOUND')
})

test('post retries are idempotent; concurrent attempts are throttled without duplicate commits', async () => {
  const f = setup()
  const results = await Promise.all([post(f), post(f)])
  assert.equal(results.filter(item => item.ok).length, 1)
  assert.equal(results.find(item => !item.ok).error.code, 'RATE_LIMITED')
  assert.equal(f.repository.posts.size, 1)
  assert.equal((await post(f)).data.idempotent, true)
  assert.equal((await post(f, { content: '另外一段内容' })).error.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal((await post(f, {}, 'bob-real-openid')).ok, true)
  assert.equal(f.repository.posts.size, 2)
})

test('failed media attempts are charged before moderation and cannot retry without bound', async () => {
  let texts = 0, reads = 0
  const f = setup({ moderation: {
    text: async () => { texts += 1; return approved() },
    images: async () => { reads += 1; throw new CommunityError('INVALID_FILE', 'oversized') }
  } })
  const photos = [await imageFile(f)]
  assert.equal((await post(f, { photos })).error.code, 'INVALID_FILE')
  assert.equal((await post(f, { photos })).error.code, 'RATE_LIMITED')
  assert.equal(texts, 1); assert.equal(reads, 1)
  for (let attempt = 1; attempt < 30; attempt += 1) {
    f.tick(2000)
    assert.equal((await post(f, { photos })).error.code, 'INVALID_FILE')
  }
  f.tick(2000)
  assert.equal((await post(f, { photos })).error.code, 'RATE_LIMITED')
  assert.equal(texts, 30); assert.equal(reads, 30)
  assert.equal(f.repository.posts.size, 0)
  assert.equal([...f.repository.limits.values()][0].count, 30)
})

test('already committed exact retries never reserve another attempt or invoke moderation', async () => {
  let texts = 0
  const f = setup({ moderation: { text: async () => { texts += 1; return approved() } } })
  await post(f)
  const before = [...f.repository.limits.values()].map(value => value.count)
  for (let retry = 0; retry < 4; retry += 1) assert.equal((await post(f)).data.idempotent, true)
  assert.equal(texts, 1)
  assert.deepEqual([...f.repository.limits.values()].map(value => value.count), before)
})

test('a missing or failing atomic attempt guard fails closed before expensive work', async () => {
  let texts = 0, reads = 0
  const f = setup({ moderation: { text: async () => { texts += 1; return approved() }, images: async () => { reads += 1 } } })
  f.repository.reservePostAttempt = undefined
  assert.equal((await post(f, { photos: [await imageFile(f)] })).error.code, 'SERVICE_UNAVAILABLE')
  assert.equal(texts, 0); assert.equal(reads, 0)
})

test('deterministic tied-time keyset pagination has no repeats and cursors are signed and scope bound', async () => {
  const f = setup()
  for (let index = 0; index < 7; index += 1) await post(f, { requestId: `same-time-post-${index}` }, `user-${index}`)
  let cursor = null
  const ids = []
  do {
    const result = await f.call('listPosts', { limit: 2, cursor })
    ids.push(...result.data.posts.map(item => item.id))
    cursor = result.data.nextCursor
  } while (cursor)
  assert.equal(new Set(ids).size, 7)
  assert.deepEqual(ids, ids.slice().sort().reverse())
  const first = await f.call('listPosts', { limit: 2 })
  assert.equal((await f.call('listPosts', { filter: 'mine', cursor: first.data.nextCursor })).error.code, 'INVALID_CURSOR')
  assert.equal((await f.call('listPosts', { cursor: `${first.data.nextCursor}a` })).error.code, 'INVALID_CURSOR')
})

test('pending/rejected mine lists are isolated and pagination is not a global fixed-size singleton', async () => {
  const f = setup({ moderation: { text: async () => ({ status: 'pending' }) } })
  await post(f)
  await post(f, { requestId: 'bob-private-post' }, 'bob-real-openid')
  const mine = await f.call('listPosts', { filter: 'mine' })
  assert.equal(mine.data.posts.length, 1)
  assert.match(mine.data.posts[0].author.id, /^cu_/)
  assert.equal(f.repository.posts.size, 2)
})

test('comments require public posts and same-post approved top-level parents', async () => {
  const f = setup()
  const first = (await post(f)).data.post
  f.tick()
  const second = (await post(f, { requestId: 'post-number-two' })).data.post
  const comment = (await f.call('addComment', { requestId: 'comment-first-0001', postId: first.id, content: '好可爱' }, 'bob-real-openid')).data.comment
  assert.equal((await f.call('addComment', { requestId: 'comment-crosspost', postId: second.id, parentId: comment.id, content: '跨动态回复' }, 'cathy')).error.code, 'NOT_FOUND')
  const reply = (await f.call('addComment', { requestId: 'comment-validreply', postId: first.id, parentId: comment.id, content: '一起晒太阳' }, 'cathy')).data.comment
  assert.equal((await f.call('addComment', { requestId: 'comment-deepreply', postId: first.id, parentId: reply.id, content: '过深回复' }, 'daisy')).error.code, 'VALIDATION_ERROR')
  f.repository.posts.get(second.id).status = 'pending'
  assert.equal((await f.call('addComment', { requestId: 'comment-pendingpost', postId: second.id, content: '不能回复' })).error.code, 'NOT_FOUND')
  const detail = await f.call('getPost', { postId: first.id })
  assert.equal(detail.data.comments.length, 2)
  assert.equal(detail.data.post.commentCount, 2)
})

test('comment history pages beyond 30 with stable timestamp ties and signed post-bound cursors', async () => {
  const f = setup()
  const first = (await post(f)).data.post
  const second = (await post(f, { requestId: 'other-history-post' }, 'bob-real-openid')).data.post
  const expected = []
  for (let index = 1; index <= 65; index += 1) {
    expected.push(seedComment(f, first.id, index, { createdAt: new Date(START + (index % 3) * 1000).toISOString() }))
  }
  seedComment(f, first.id, 66, { status: 'pending', content: 'private pending comment' })
  seedComment(f, first.id, 67, { status: 'rejected', content: 'private rejected comment' })
  seedComment(f, second.id, 68, { content: 'other post comment' })
  const firstPage = await f.call('listComments', { postId: first.id })
  assert.equal(firstPage.ok, true)
  assert.equal(firstPage.data.comments.length, 30)
  assert.ok(firstPage.data.nextCursor)
  const detail = await f.call('getPost', { postId: first.id })
  assert.deepEqual(detail.data.comments, firstPage.data.comments)
  assert.deepEqual(detail.data.post.comments, firstPage.data.comments)
  assert.equal(detail.data.nextCommentsCursor, firstPage.data.nextCursor)
  assert.equal(detail.data.targetComment, null)
  assert.equal(detail.data.targetParent, null)
  assert.equal(detail.data.targetUnavailable, false)
  const feed = await f.call('listPosts')
  assert.equal(feed.data.posts.find(item => item.id === first.id).comments.length, 3)
  const ids = firstPage.data.comments.map(item => item.id)
  let cursor = detail.data.nextCommentsCursor
  while (cursor) {
    const next = await f.call('listComments', { postId: first.id, cursor, limit: 17 })
    assert.equal(next.ok, true)
    assert.ok(next.data.comments.length <= 17)
    ids.push(...next.data.comments.map(item => item.id))
    cursor = next.data.nextCursor
  }
  assert.equal(ids.length, 65)
  assert.equal(new Set(ids).size, 65)
  assert.deepEqual(ids, f.repository.page(expected, null, 65).map(item => item.id))
  assert.equal((await f.call('listComments', { postId: first.id, limit: 50 })).data.comments.length, 50)
  for (const limit of [0, 51, -1, 1.5, '30']) {
    assert.equal((await f.call('listComments', { postId: first.id, limit })).error.code, 'VALIDATION_ERROR')
  }
  assert.equal((await f.call('listComments', { postId: second.id, cursor: firstPage.data.nextCursor })).error.code, 'INVALID_CURSOR')
  assert.equal((await f.call('listComments', { postId: first.id, cursor: `${firstPage.data.nextCursor}a` })).error.code, 'INVALID_CURSOR')
  assert.equal((await f.call('listPosts', { cursor: firstPage.data.nextCursor })).error.code, 'INVALID_CURSOR')
  assert.doesNotMatch(JSON.stringify(firstPage), /private pending|private rejected|other post|requestHash/)
})

test('notification detail resolves an old approved target and its top-level parent without changing the first page', async () => {
  const f = setup()
  const story = (await post(f)).data.post
  const parent = seedComment(f, story.id, 1)
  const target = seedComment(f, story.id, 2, { parentId: parent.id, content: '很久以前的回复' })
  for (let index = 3; index <= 40; index += 1) seedComment(f, story.id, index)
  const detail = await f.call('getPost', { postId: story.id, commentId: target.id }, 'bob-real-openid')
  assert.equal(detail.ok, true)
  assert.equal(detail.data.comments.length, 30)
  assert.equal(detail.data.comments.some(item => item.id === target.id || item.id === parent.id), false)
  assert.equal(detail.data.targetComment.id, target.id)
  assert.equal(detail.data.targetComment.content, target.content)
  assert.equal(detail.data.targetParent.id, parent.id)
  assert.equal(detail.data.targetUnavailable, false)
  assert.doesNotMatch(JSON.stringify(detail), /private-comment-request-hash|requestHash/)
  const topLevel = await f.call('getPost', { postId: story.id, commentId: parent.id })
  assert.equal(topLevel.data.targetComment.id, parent.id)
  assert.equal(topLevel.data.targetParent, null)
})

test('unavailable notification targets never leak pending, rejected, cross-post or malformed comments', async () => {
  const f = setup()
  const story = (await post(f)).data.post
  const other = (await post(f, { requestId: 'target-other-story' }, 'bob-real-openid')).data.post
  const visible = seedComment(f, story.id, 1)
  const pending = seedComment(f, story.id, 2, { status: 'pending', content: 'secret pending target' })
  const rejected = seedComment(f, story.id, 3, { status: 'rejected', content: 'secret rejected target' })
  const crossPost = seedComment(f, other.id, 4, { content: 'secret cross-post target' })
  for (const commentId of [pending.id, rejected.id, crossPost.id, `comment_${'f'.repeat(40)}`]) {
    const result = await f.call('getPost', { postId: story.id, commentId })
    assert.equal(result.ok, true)
    assert.equal(result.data.post.id, story.id)
    assert.deepEqual(result.data.comments.map(item => item.id), [visible.id])
    assert.equal(result.data.targetComment, null)
    assert.equal(result.data.targetParent, null)
    assert.equal(result.data.targetUnavailable, true)
    assert.doesNotMatch(JSON.stringify(result), /secret pending|secret rejected|secret cross-post/)
  }
  const requestedIds = []
  const readComment = f.repository.getComment.bind(f.repository)
  f.repository.getComment = async id => { requestedIds.push(id); return readComment(id) }
  for (const commentId of ['', 'arbitrary/private/document', `post_${'a'.repeat(40)}`, null, 42, { id: visible.id }]) {
    const result = await f.call('getPost', { postId: story.id, commentId })
    assert.equal(result.ok, true)
    assert.equal(result.data.targetUnavailable, true)
    assert.equal(result.data.targetComment, null)
  }
  const plain = await f.call('getPost', { postId: story.id })
  assert.equal(plain.ok, true)
  assert.equal(plain.data.targetUnavailable, false)
  assert.deepEqual(requestedIds, [])
})

test('target parent must itself be an approved same-post top-level comment', async () => {
  const f = setup()
  const story = (await post(f)).data.post
  const other = (await post(f, { requestId: 'parent-other-story' }, 'bob-real-openid')).data.post
  const target = seedComment(f, story.id, 1)
  const ancestor = seedComment(f, story.id, 2)
  const pending = seedComment(f, story.id, 3, { status: 'pending', content: 'hidden parent pending' })
  const rejected = seedComment(f, story.id, 4, { status: 'rejected', content: 'hidden parent rejected' })
  const nested = seedComment(f, story.id, 5, { parentId: ancestor.id, content: 'not a top-level parent' })
  const crossPost = seedComment(f, other.id, 6, { content: 'hidden parent cross-post' })
  for (const parentId of [pending.id, rejected.id, nested.id, crossPost.id, `comment_${'f'.repeat(40)}`, 'arbitrary/private/document']) {
    target.parentId = parentId
    const result = await f.call('getPost', { postId: story.id, commentId: target.id })
    assert.equal(result.ok, true)
    assert.equal(result.data.targetComment.id, target.id)
    assert.equal(result.data.targetParent, null)
    assert.equal(result.data.targetUnavailable, false)
    assert.doesNotMatch(JSON.stringify(result), /hidden parent/)
  }
})

test('comment paging rechecks public post access and stale notification targets cannot bypass it', async () => {
  const f = setup()
  const story = (await post(f)).data.post
  const target = seedComment(f, story.id, 1)
  seedComment(f, story.id, 2)
  const first = await f.call('listComments', { postId: story.id, limit: 1 })
  assert.ok(first.data.nextCursor)
  const record = f.repository.posts.get(story.id)
  record.status = 'pending'
  const readTargets = []
  f.repository.getComment = async id => { readTargets.push(id); return f.repository.comments.get(id) }
  for (const openid of ['alice-real-openid', 'bob-real-openid']) {
    assert.equal((await f.call('listComments', { postId: story.id, cursor: first.data.nextCursor }, openid)).error.code, 'NOT_FOUND')
  }
  assert.equal((await f.call('getPost', { postId: story.id, commentId: target.id }, 'bob-real-openid')).error.code, 'NOT_FOUND')
  const own = await f.call('getPost', { postId: story.id, commentId: target.id })
  assert.equal(own.ok, true)
  assert.deepEqual(own.data.comments, [])
  assert.deepEqual(own.data.post.comments, [])
  assert.equal(own.data.nextCommentsCursor, null)
  assert.equal(own.data.targetUnavailable, true)
  assert.equal(own.data.targetComment, null)
  assert.deepEqual(readTargets, [])
  record.status = 'approved'
  record.textReview = 'pending'
  assert.equal((await f.call('listComments', { postId: story.id })).error.code, 'NOT_FOUND')
  f.repository.posts.delete(story.id)
  assert.equal((await f.call('listComments', { postId: story.id, cursor: first.data.nextCursor })).error.code, 'NOT_FOUND')
  assert.equal((await f.call('getPost', { postId: story.id, commentId: target.id })).error.code, 'NOT_FOUND')
})

test('unreviewed comments are retryable failures, never stored or notified without an operator path', async () => {
  let allow = true
  const f = setup({ moderation: { text: async () => allow ? approved() : { status: 'pending' } } })
  const parent = (await post(f)).data.post
  allow = false
  const result = await f.call('addComment', { requestId: 'pending-comment-01', postId: parent.id, content: '等待审核' }, 'bob-real-openid')
  assert.equal(result.error.code, 'MODERATION_UNAVAILABLE')
  assert.equal((await f.call('getPost', { postId: parent.id })).data.comments.length, 0)
  assert.equal(f.repository.notices.size, 0)
  assert.equal(f.repository.comments.size, 0)
  allow = true
  const retry = await f.call('addComment', { requestId: 'pending-comment-01', postId: parent.id, content: '等待审核' }, 'bob-real-openid')
  assert.equal(retry.data.comment.status, 'approved')
  assert.equal(f.repository.comments.size, 1)
})

test('rejected comments return editable failures and do not enter a permanent hidden queue', async () => {
  let reject = false
  const f = setup({ moderation: { text: async () => reject ? { status: 'rejected', verified: true } : approved() } })
  const parent = (await post(f)).data.post
  reject = true
  const result = await f.call('addComment', { requestId: 'rejected-comment-01', postId: parent.id, content: '测试审核拒绝' }, 'bob-real-openid')
  assert.equal(result.error.code, 'CONTENT_REJECTED')
  assert.equal(f.repository.comments.size, 0)
  assert.equal(f.repository.notices.size, 0)
})

test('comment retries do not duplicate counts or notifications; reads are recipient-only', async () => {
  const f = setup()
  const parent = (await post(f)).data.post
  const args = { requestId: 'comment-idempotent-01', postId: parent.id, content: '你好小猫' }
  await f.call('addComment', args, 'bob-real-openid')
  assert.equal((await f.call('addComment', args, 'bob-real-openid')).data.idempotent, true)
  assert.equal(f.repository.comments.size, 1)
  assert.equal(f.repository.posts.get(parent.id).commentCount, 1)
  const inbox = await f.call('listNotifications')
  assert.equal(inbox.data.notifications.length, 1)
  const id = inbox.data.notifications[0].id
  assert.equal((await f.call('listNotifications', {}, 'bob-real-openid')).data.notifications.length, 0)
  assert.equal((await f.call('markNotification', { id }, 'bob-real-openid')).error.code, 'NOT_FOUND')
  assert.equal((await f.call('markNotification', { id })).data.read, true)
  assert.equal((await f.call('listNotifications')).data.notifications[0].read, true)
  f.repository.posts.get(parent.id).status = 'rejected'
  assert.equal((await f.call('listNotifications')).data.notifications.length, 0)
})

test('limits and validation are bounded, and idempotent retries bypass rate consumption', async () => {
  const f = setup()
  await post(f)
  assert.equal((await post(f)).ok, true)
  assert.equal((await post(f, { requestId: 'too-fast-0001' })).error.code, 'RATE_LIMITED')
  for (let index = 1; index < 12; index += 1) { f.tick(); assert.equal((await post(f, { requestId: `daily-post-${index}` })).ok, true) }
  f.tick()
  assert.equal((await post(f, { requestId: 'daily-thirteenth' })).error.code, 'RATE_LIMITED')
  assert.equal((await f.call('listPosts', { limit: 51 })).error.code, 'VALIDATION_ERROR')
  assert.equal((await post(f, { content: '猫'.repeat(1201) })).error.code, 'VALIDATION_ERROR')
  assert.equal((await post(f, { requestId: 'x' })).error.code, 'VALIDATION_ERROR')
  assert.equal((await post(f, { photos: Array(4).fill('x') })).error.code, 'VALIDATION_ERROR')
  assert.equal((await f.call('deleteEverything')).error.code, 'UNKNOWN_ACTION')
})

async function reviewerFixture(photoCount = 1) {
  const raw = Buffer.from('original-jpeg-fixture')
  const sanitized = Buffer.from('sanitized-image-no-exif-fixture')
  const f = setup({ moderation: { images: async ({ photos }) => ({ status: 'pending', assets: photos.map(fileID => ({ fileID, sizeBytes: raw.length, sha256: crypto.createHash('sha256').update(raw).digest('hex') })) }) } })
  const originalFile = await imageFile(f)
  const photos = Array.from({ length: photoCount }, (_, index) => originalFile.replace('image-00000001.jpg', `image-${String(index + 1).padStart(8, '0')}.jpg`))
  const pending = (await post(f, { photos })).data.post
  const internal = f.repository.posts.get(pending.id)
  const uploads = []
  const files = new Map(internal.sourcePhotos.map(fileID => [fileID, raw]))
  const downloads = []
  const media = {
    download: async fileID => { downloads.push(fileID); return files.get(fileID) },
    sanitize: async bytes => { assert.equal(bytes, raw); return sanitized },
    upload: async (cloudPath, bytes) => {
      assert.equal(bytes, sanitized)
      uploads.push(cloudPath)
      const fileID = `cloud://${ENV}.storage/${cloudPath}`
      files.set(fileID, Buffer.from(bytes))
      return fileID
    }
  }
  const reviewer = createTrustedReviewer({ repository: f.repository, media, reviewSecret: REVIEW_SECRET, now: () => START })
  function event(overrides = {}) {
    const value = { action: 'reviewPost', postId: pending.id, requestHash: internal.requestHash, reviewId: 'review-event-00000001', decision: 'approved', reason: '已人工检查本次文字和原始图片', reviewedText: true, reviewedImages: true, expiresAt: new Date(START + 240000).toISOString(), ...overrides }
    return { ...value, signature: signReview(value, REVIEW_SECRET) }
  }
  return { ...f, pending, internal, media, reviewer, event, uploads, files, downloads, raw, sanitized }
}

test('trusted review rejects client calls, invalid signatures, stale signatures and missing human attestations', async () => {
  const f = await reviewerFixture()
  assert.equal((await f.reviewer.handle(f.event(), { openid: 'alice-real-openid' })).error.code, 'FORBIDDEN')
  assert.equal((await f.reviewer.handle({ ...f.event(), decision: 'rejected' })).error.code, 'FORBIDDEN')
  assert.equal((await f.reviewer.handle(f.event({ expiresAt: new Date(START - 1).toISOString() }))).error.code, 'REVIEW_EXPIRED')
  assert.equal((await f.reviewer.handle(f.event({ reviewedImages: false }))).error.code, 'REVIEW_REQUIRED')
  assert.equal(f.internal.status, 'pending')
  assert.equal(f.uploads.length, 0)
})

test('trusted review verifies exact source bytes, sanitizes, publishes only server copies, and is idempotent', async () => {
  const f = await reviewerFixture()
  const result = await f.reviewer.handle(f.event())
  assert.equal(result.ok, true)
  assert.equal(f.internal.status, 'approved')
  assert.equal(f.uploads.length, 1)
  assert.match(f.uploads[0], new RegExp(`^community-approved/${f.pending.id}/[a-f0-9]{64}-[a-f0-9]{64}\\.jpg$`))
  assert.deepEqual(f.downloads, [f.internal.sourcePhotos[0], f.internal.approvedPhotos[0]])
  assert.equal((await f.reviewer.handle(f.event())).data.idempotent, true)
  assert.equal(f.uploads.length, 1)
  const feed = await f.call('listPosts', {}, 'bob-real-openid')
  assert.equal(feed.data.posts.length, 1)
  assert.doesNotMatch(JSON.stringify(feed), /community-pending|requestHash|sourceAssets/)
})

test('promotion never overwrites a preclaimed predictable content-addressed destination', async () => {
  const f = await reviewerFixture()
  const digest = crypto.createHash('sha256').update(f.sanitized).digest('hex')
  const predictable = `cloud://${ENV}.storage/community-approved/${f.pending.id}/${digest}.jpg`
  const attackerBytes = Buffer.from('preclaimed object owned by an ordinary user')
  f.files.set(predictable, attackerBytes)
  assert.equal((await f.reviewer.handle(f.event())).ok, true)
  assert.notEqual(f.internal.approvedPhotos[0], predictable)
  assert.equal(f.files.get(predictable), attackerBytes)
  assert.ok(f.internal.approvedPhotos[0].endsWith(`-${digest}.jpg`))
  assert.deepEqual(f.files.get(f.internal.approvedPhotos[0]), f.sanitized)
})

test('wrong uploaded bytes, missing readback or read failure never commit approval', async () => {
  for (const mode of ['same-size-different-bytes', 'short', 'missing', 'throw']) {
    const f = await reviewerFixture()
    const originalDownload = f.media.download
    f.media.download = async fileID => {
      if (fileID === f.internal.sourcePhotos[0]) return originalDownload(fileID)
      if (mode === 'throw') throw new Error('unavailable object store')
      if (mode === 'missing') return undefined
      return mode === 'short' ? Buffer.from('short') : Buffer.alloc(f.sanitized.length, 65)
    }
    let applies = 0
    f.repository.applyReview = async () => { applies += 1; assert.fail('bad promoted object must never be committed') }
    const result = await f.reviewer.handle(f.event())
    assert.equal(result.ok, false)
    assert.equal(result.error.code, mode === 'throw' ? 'REVIEW_FAILED' : 'MEDIA_PROMOTION_FAILED')
    assert.equal(applies, 0)
    assert.equal(f.internal.status, 'pending')
    assert.deepEqual(f.internal.approvedPhotos, [])
    assert.deepEqual((await f.call('listPosts', {}, 'bob-real-openid')).data.posts, [])
  }
})

test('every photo must finish readback; a later failed copy prevents the entire post approval', async () => {
  const f = await reviewerFixture(2), originalDownload = f.media.download
  let checkedCopies = 0, applies = 0
  f.media.download = async fileID => {
    if (fileID.includes('/community-approved/')) {
      checkedCopies += 1
      if (checkedCopies === 2) return Buffer.from('second uploaded copy was changed')
    }
    return originalDownload(fileID)
  }
  f.repository.applyReview = async () => { applies += 1; assert.fail('partial image verification cannot approve a post') }
  assert.equal((await f.reviewer.handle(f.event())).error.code, 'MEDIA_PROMOTION_FAILED')
  assert.equal(checkedCopies, 2)
  assert.equal(f.uploads.length, 2)
  assert.equal(new Set(f.uploads).size, 2)
  assert.equal(applies, 0)
  assert.equal(f.internal.status, 'pending')
  assert.deepEqual(f.internal.approvedPhotos, [])
})

test('retry after an ambiguous upload uses a new path and committed-review retries do no more media I/O', async () => {
  const f = await reviewerFixture(), originalUpload = f.media.upload
  let loseResponse = true
  f.media.upload = async (...args) => {
    const fileID = await originalUpload(...args)
    if (loseResponse) { loseResponse = false; throw new Error('response lost after successful upload') }
    return fileID
  }
  assert.equal((await f.reviewer.handle(f.event())).error.code, 'REVIEW_FAILED')
  assert.equal(f.internal.status, 'pending')
  assert.equal(f.uploads.length, 1)
  const abandoned = `cloud://${ENV}.storage/${f.uploads[0]}`
  assert.equal((await f.reviewer.handle(f.event())).ok, true)
  assert.equal(f.uploads.length, 2)
  assert.notEqual(f.uploads[0], f.uploads[1])
  assert.deepEqual(f.files.get(abandoned), f.sanitized)
  assert.deepEqual(f.internal.approvedPhotos, [`cloud://${ENV}.storage/${f.uploads[1]}`])
  const downloadCount = f.downloads.length
  assert.equal((await f.reviewer.handle(f.event())).data.idempotent, true)
  assert.equal(f.uploads.length, 2)
  assert.equal(f.downloads.length, downloadCount)
})

test('racing distinct reviews upload separate copies and only the CAS winner is published', async () => {
  const f = await reviewerFixture(), originalUpload = f.media.upload
  let releaseUploads
  const bothUploaded = new Promise(resolve => { releaseUploads = resolve })
  f.media.upload = async (...args) => {
    const fileID = await originalUpload(...args)
    if (f.uploads.length === 2) releaseUploads()
    await bothUploaded
    return fileID
  }
  const results = await Promise.all([
    f.reviewer.handle(f.event({ reviewId: 'review-race-first-0001' })),
    f.reviewer.handle(f.event({ reviewId: 'review-race-second-0002' }))
  ])
  assert.equal(results.filter(result => result.ok).length, 1)
  assert.equal(results.find(result => !result.ok).error.code, 'REVIEW_CONFLICT')
  assert.equal(f.uploads.length, 2)
  assert.equal(new Set(f.uploads).size, 2)
  assert.equal(f.internal.approvedPhotos.length, 1)
  assert.deepEqual(f.files.get(f.internal.approvedPhotos[0]), f.sanitized)
  const publicCopies = (await f.call('listPosts', {}, 'bob-real-openid')).data.posts[0].photos
  assert.deepEqual(publicCopies, f.internal.approvedPhotos)
  assert.equal(f.uploads.filter(cloudPath => !publicCopies.includes(`cloud://${ENV}.storage/${cloudPath}`)).length, 1)
})

test('changed original bytes and failed sanitization cannot be approved', async () => {
  const f = await reviewerFixture()
  f.media.download = async () => Buffer.from('changed malicious image')
  assert.equal((await f.reviewer.handle(f.event())).error.code, 'MEDIA_CHANGED')
  assert.equal(f.internal.status, 'pending')
  assert.equal(f.uploads.length, 0)
  const second = await reviewerFixture()
  second.media.sanitize = async () => { throw new Error('decoder failure') }
  assert.equal((await second.reviewer.handle(second.event())).error.code, 'REVIEW_FAILED')
  assert.equal(second.internal.status, 'pending')
})

test('trusted rejection needs no image upload and stays out of public views', async () => {
  const f = await reviewerFixture()
  assert.equal((await f.reviewer.handle(f.event({ decision: 'rejected', reviewedText: false, reviewedImages: false }))).data.status, 'rejected')
  assert.equal(f.uploads.length, 0)
  assert.deepEqual((await f.call('listPosts', {}, 'bob-real-openid')).data.posts, [])
})

test('production text adapter demands the explicit successful v2 moderation result', async () => {
  const filename = path.resolve(__dirname, '../cloudfunctions/catCommunity/index.js')
  let result = { errCode: 0, result: { suggest: 'pass' } }
  let observed
  const cloud = { DYNAMIC_CURRENT_ENV: 'current', init() {}, database: () => ({ command: {} }), openapi: { security: { msgSecCheck: async input => { observed = input; return result } } } }
  const exports = {}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, require: name => name === 'wx-server-sdk' ? cloud : require(name.startsWith('./') ? path.join(path.dirname(filename), name) : name), Buffer, process }, { filename })
  assert.equal((await exports.moderation.text({ content: '测试', openid: 'real-openid' })).status, 'approved')
  assert.equal(observed.version, 2)
  assert.equal(observed.openid, 'real-openid')
  for (const next of [{ result: { suggest: 'pass' } }, { errCode: 1, result: { suggest: 'pass' } }, { errCode: 0, result: { suggest: 'review' } }, {}]) {
    result = next
    assert.equal((await exports.moderation.text({ content: '测试', openid: 'real-openid' })).status, 'pending')
  }
})

test('production comment repository keeps approved post filtering and descending keyset ordering', async () => {
  const filename = path.resolve(__dirname, '../cloudfunctions/catCommunity/index.js')
  const queries = []
  const db = {
    command: { lt: value => ({ lt: value }), and: values => ({ and: values }), or: values => ({ or: values }) },
    collection(name) {
      const query = { collection: name, order: [] }
      queries.push(query)
      const chain = {
        where(value) { query.where = value; return chain },
        orderBy(field, direction) { query.order.push([field, direction]); return chain },
        limit(value) { query.limit = value; return chain },
        async get() { return { data: [] } }
      }
      return chain
    }
  }
  const cloud = { DYNAMIC_CURRENT_ENV: 'current', init() {}, database: () => db }
  const exports = {}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, require: name => name === 'wx-server-sdk' ? cloud : require(name.startsWith('./') ? path.join(path.dirname(filename), name) : name), Buffer, process }, { filename })
  const repository = new exports.CommunityRepository()
  const postId = `post_${'a'.repeat(40)}`
  const cursor = { createdAt: new Date(START).toISOString(), id: `comment_${'b'.repeat(40)}` }
  await repository.listComments({ postId, limit: 3 })
  await repository.listComments({ postId, cursor, limit: 31 })
  const [preview, history] = JSON.parse(JSON.stringify(queries))
  assert.deepEqual(preview, {
    collection: 'cc_comments_private', where: { postId, status: 'approved' },
    order: [['createdAt', 'desc'], ['_id', 'desc']], limit: 3
  })
  assert.deepEqual(history, {
    collection: 'cc_comments_private', where: { and: [
      { postId, status: 'approved' },
      { or: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { lt: cursor.id } }] }
    ] },
    order: [['createdAt', 'desc'], ['_id', 'desc']], limit: 31
  })
})

test('production attempt reservation reads and charges only within one transaction; a committed race is free', async () => {
  const filename = path.resolve(__dirname, '../cloudfunctions/catCommunity/index.js')
  const postId = `post_${'b'.repeat(40)}`, actorId = `cu_${'c'.repeat(40)}`
  const rows = new Map(), writes = []
  let transactions = 0, inside = false
  const transaction = { collection(collection) {
    assert.equal(inside, true)
    return { doc(id) { return {
      async get() { return { data: rows.get(`${collection}/${id}`) || null } },
      async set({ data }) { writes.push({ collection, id, ...data }); rows.set(`${collection}/${id}`, data) }
    } } }
  } }
  const db = { command: {}, collection() { assert.fail('reservation must never bypass the transaction') },
    async runTransaction(callback) { transactions += 1; inside = true; try { return await callback(transaction) } finally { inside = false } }
  }
  const cloud = { DYNAMIC_CURRENT_ENV: 'current', init() {}, database: () => db }
  const exports = {}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports, require: name => name === 'wx-server-sdk' ? cloud : require(name.startsWith('./') ? path.join(path.dirname(filename), name) : name), Buffer, process }, { filename })
  const repository = new exports.CommunityRepository()
  const input = { postId, actorId, createdAt: new Date(START).toISOString(), dailyLimit: 30, minIntervalMs: 2000 }
  assert.equal((await repository.reservePostAttempt(input)).post, null)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].collection, 'cc_limits_private')
  assert.equal(writes[0].id, `post_attempt_${actorId}_2026-09-29`)
  assert.equal(writes[0].count, 1)
  await assert.rejects(repository.reservePostAttempt(input), error => error.code === 'RATE_LIMITED')
  assert.equal(writes.length, 1)
  rows.set(`cc_posts_private/${postId}`, { requestHash: 'committed', status: 'approved' })
  assert.equal((await repository.reservePostAttempt(input)).post.requestHash, 'committed')
  assert.equal(writes.length, 1)
  assert.equal(transactions, 3)
})

test('fresh collection rules deny client access; member API exposes no approval or arbitrary database access', async () => {
  const rules = require('../cloudfunctions/catCommunity/database.rules.json')
  assert.deepEqual(rules, { read: false, write: false })
  const f = setup()
  assert.equal((await f.call('reviewPost', { status: 'approved' })).error.code, 'UNKNOWN_ACTION')
  assert.equal((await f.call('query', { collection: 'cc_posts_private' })).error.code, 'UNKNOWN_ACTION')
  const main = fs.readFileSync(path.join(__dirname, '../cloudfunctions/catCommunity/index.js'), 'utf8')
  assert.doesNotMatch(main, /ci_users|ci_sightings|demo-user|catOnline.*require|\.collection\(event/)
})

test('only ACL-filtered photos are server-signed; another real identity never signs pending source media', async () => {
  const f = setup()
  const source = await imageFile(f)
  const pending = (await post(f, { photos: [source] })).data.post
  const signedRequests = []
  const signer = async request => {
    signedRequests.push(...request.fileList)
    return { fileList: request.fileList.map(item => ({ fileID: item.fileID, status: 0, tempFileURL: 'https://storage.example.test/signed-approved-photo' })) }
  }
  const othersFeed = await signProjectedPhotos(await f.call('listPosts', {}, 'bob-real-openid'), signer, () => START)
  assert.equal(signedRequests.length, 0)
  assert.deepEqual(othersFeed.data.posts, [])
  const otherDetail = await signProjectedPhotos(await f.call('getPost', { postId: pending.id }, 'bob-real-openid'), signer, () => START)
  assert.equal(otherDetail.error.code, 'NOT_FOUND')
  assert.equal(signedRequests.length, 0)
  const ownDetail = await signProjectedPhotos(await f.call('getPost', { postId: pending.id }), signer, () => START)
  assert.deepEqual(signedRequests.map(item => item.fileID), [source])
  assert.equal(signedRequests[0].maxAge, 300)
  assert.match(ownDetail.data.post.photos[0], /^https:/)
  assert.equal(ownDetail.data.post.photoExpiresAt, new Date(START + 300000).toISOString())
  assert.doesNotMatch(JSON.stringify(ownDetail), /community-pending/)
  const record = f.repository.posts.get(pending.id)
  Object.assign(record, { status: 'approved', imageReview: 'approved', imagesSanitized: true, approvedPhotos: [`cloud://${ENV}.storage/community-approved/${pending.id}/safe.jpg`] })
  signedRequests.length = 0
  const approvedFeed = await signProjectedPhotos(await f.call('listPosts', {}, 'bob-real-openid'), signer, () => START)
  assert.equal(approvedFeed.data.posts.length, 1)
  assert.equal(signedRequests.length, 1)
  assert.match(signedRequests[0].fileID, /community-approved/)
  assert.doesNotMatch(signedRequests[0].fileID, /community-pending/)
})

test('URL signing failures never return raw source IDs or storage errors', async () => {
  const f = setup()
  const pending = (await post(f, { photos: [await imageFile(f)] })).data.post
  const result = await signProjectedPhotos(await f.call('getPost', { postId: pending.id }), async () => { throw new Error('secret-storage-error') })
  assert.deepEqual(result.data.post.photos, [])
  assert.equal(result.data.post.photosUnavailable, true)
  assert.doesNotMatch(JSON.stringify(result), /cloud:\/\/|secret-storage-error/)
})
