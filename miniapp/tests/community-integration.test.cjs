'use strict'

// Offline contract tests: the real client adapter calls the real function entrypoint,
// repository, moderation adapter and reviewer. Only WeChat/CloudBase I/O is simulated.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const boundedMedia = require('../cloudfunctions/catCommunity/bounded-media')
const { signReview } = require('../cloudfunctions/catCommunity/review')
const core = require('../cloudfunctions/catCommunity/core')
const handoff = require('../utils/social-handoff')
const { parseContext } = require('../cloudfunctions/catOnline/node_modules/@cloudbase/node-sdk')
const requestContext = require('../cloudfunctions/catCommunity/request-context')

const ENV = 'cloud1-d6gpjpxunc74669d7'
const OWNER_SECRET = 'offline-integration-owner-secret-not-production'
const REVIEW_SECRET = 'offline-integration-review-secret-not-production'
const FUNCTION_ROOT = path.join(__dirname, '../cloudfunctions/catCommunity')
const COLLECTIONS = ['cc_posts_private', 'cc_comments_private', 'cc_notifications_private', 'cc_limits_private']

function runtimeContext(openid = '') {
  return { request_id: 'offline-integration-request', namespace: ENV,
    environment: JSON.stringify({ SCF_NAMESPACE: ENV, ...(openid ? { WX_OPENID: openid, WX_APPID: 'wx-offline-integration' } : {}) }) }
}

function loadModule(filename, overrides = {}, globals = {}) {
  const localRequire = createRequire(filename)
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, Map, Set, Promise, Date, Math,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name), ...globals
  }, { filename })
  return module.exports
}

function memoryDatabase() {
  let tables = new Map(COLLECTIONS.map(name => [name, new Map()]))
  const command = {
    and: terms => ({ op: 'and', terms }), or: terms => ({ op: 'or', terms }),
    lt: value => ({ op: 'lt', value }), inc: value => ({ op: 'inc', value })
  }
  const field = (row, key) => key.split('.').reduce((value, part) => value && value[part], row)
  function matches(row, condition) {
    if (condition.op === 'and') return condition.terms.every(term => matches(row, term))
    if (condition.op === 'or') return condition.terms.some(term => matches(row, term))
    return Object.entries(condition).every(([key, expected]) => expected && expected.op === 'lt'
      ? field(row, key) < expected.value : field(row, key) === expected)
  }
  const db = {
    command,
    collection(name) {
      assert.ok(COLLECTIONS.includes(name), `must not read or write original collection: ${name}`)
      return {
        doc(id) {
          return {
            async get() { return { data: tables.get(name).has(id) ? structuredClone(tables.get(name).get(id)) : null } },
            async set({ data }) { tables.get(name).set(id, { ...structuredClone(data), _id: id }) },
            async update({ data }) {
              const row = tables.get(name).get(id)
              assert.ok(row, 'update must target an existing document')
              for (const [key, value] of Object.entries(data)) row[key] = value && value.op === 'inc'
                ? (row[key] || 0) + value.value : structuredClone(value)
            }
          }
        },
        where(condition) {
          const order = []
          let maximum = Infinity
          const query = {
            orderBy(key, direction) { order.push([key, direction]); return query },
            limit(value) { maximum = value; return query },
            async get() {
              const rows = [...tables.get(name).values()].filter(row => matches(row, condition))
              rows.sort((a, b) => {
                for (const [key, direction] of order) {
                  const left = field(a, key), right = field(b, key)
                  if (left !== right) return (left < right ? -1 : 1) * (direction === 'desc' ? -1 : 1)
                }
                return 0
              })
              return { data: structuredClone(rows.slice(0, maximum)) }
            }
          }
          return query
        }
      }
    },
    async runTransaction(callback) {
      const before = structuredClone(tables)
      try { return await callback(db) } catch (error) { tables = before; throw error }
    },
    rows(name) { return [...tables.get(name).values()] }
  }
  return db
}

let sharp
try { sharp = require('../cloudfunctions/catOnline/node_modules/sharp') } catch (_) { /* install cloud dependencies for image roundtrip tests */ }

function setup(options = {}) {
  const db = memoryDatabase(), files = new Map(), requests = [], signedFiles = [], uploads = [], downloads = []
  const downloadURLs = new Map()
  let openid = '', moderationAvailable = true, clock = Date.now()
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'offline-only', init() {}, database: () => db,
    getWXContext: () => ({ OPENID: openid, ENV }),
    openapi: { security: { async msgSecCheck(value) {
      assert.equal(value.version, 2)
      assert.equal(value.openid, openid)
      if (!moderationAvailable) throw new Error('simulated platform outage')
      return { errCode: 0, result: { suggest: 'pass' } }
    } } },
    async downloadFile() { assert.fail('unbounded SDK download must not be used') },
    async uploadFile({ cloudPath, fileContent }) {
      const fileID = `cloud://${ENV}.offline/${cloudPath}`
      files.set(fileID, Buffer.from(fileContent)); uploads.push({ fileID, source: 'server' })
      return { fileID }
    },
    async getTempFileURL({ fileList }) {
      return { fileList: fileList.map(({ fileID, maxAge }) => {
        assert.ok(files.has(fileID))
        if (maxAge === 60) {
          const tempFileURL = `https://offline.invalid/download/${downloadURLs.size}`
          downloadURLs.set(tempFileURL, fileID)
          return { fileID, status: 0, tempFileURL }
        }
        assert.equal(maxAge, 300)
        signedFiles.push(fileID)
        return { fileID, status: 0, tempFileURL: `https://offline.invalid/photo/${signedFiles.length}` }
      }) }
    }
  }
  const env = { CAT_COMMUNITY_OWNER_SECRET: OWNER_SECRET, CAT_COMMUNITY_REVIEW_SECRET: REVIEW_SECRET, CLOUDBASE_ENV_ID: ENV,
    CAT_COMMUNITY_MEDIA_ENABLED: Object.hasOwn(options, 'mediaEnabled') ? options.mediaEnabled : 'true' }
  const sanitizer = sharp ? loadModule(path.join(FUNCTION_ROOT, 'sanitize.js'), { sharp }) : null
  const entry = loadModule(path.join(FUNCTION_ROOT, 'index.js'), {
    'wx-server-sdk': cloud, './sanitize': sanitizer,
    './request-context': { resolveRequestContext: context => requestContext.resolveRequestContext(context, parseContext) },
    './bounded-media': { createBoundedMediaDownloader: options => boundedMedia.createBoundedMediaDownloader({ ...options,
      request(url, config, callback) {
        const fileID = downloadURLs.get(url.href)
        assert.ok(files.has(fileID), 'HTTPS transfer reads only a just-signed fixture')
        downloads.push(fileID)
        const response = new PassThrough(), req = new EventEmitter()
        response.statusCode = 200; response.headers = { 'content-length': String(files.get(fileID).length) }
        req.destroy = () => response.destroy()
        req.end = () => queueMicrotask(() => { callback(response); if (!response.destroyed) response.end(Buffer.from(files.get(fileID))) })
        return req
      }
    }) },
    './core': { ...core, createCommunityCore: options => core.createCommunityCore({ ...options, now: () => new Date(clock).toISOString() }) }
  }, { process: { env } })

  function client(identity, values = new Map()) {
    let lostAction = ''
    const localPhotos = new Map()
    const wx = {
      getStorageSync: key => values.get(key),
      setStorageSync: (key, value) => values.set(key, structuredClone(value)),
      removeStorageSync: key => values.delete(key),
      getFileInfo: options => options.success({ size: localPhotos.get(options.filePath).length }),
      getImageInfo: options => options.success({ type: 'jpeg' }),
      cloud: {
        async callFunction(options) {
          assert.equal(options.name, 'catCommunity'); assert.equal(options.config.env, ENV)
          openid = identity
          requests.push(structuredClone(options.data))
          const result = await entry.main(options.data, runtimeContext(identity))
          if (lostAction === options.data.action && result.ok) { lostAction = ''; throw new Error('network timeout after server commit') }
          return { result }
        },
        async uploadFile({ cloudPath, filePath }) {
          assert.ok(localPhotos.has(filePath))
          const fileID = `cloud://${ENV}.offline/${cloudPath}`
          files.set(fileID, Buffer.from(localPhotos.get(filePath))); uploads.push({ fileID, source: identity })
          return { fileID }
        },
        async getTempFileURL() { assert.fail('the deployed entrypoint must return signed photos, not raw file IDs') }
      }
    }
    const api = loadModule(path.join(__dirname, '../services/community.js'), {}, { wx })
    return { api, values, localPhotos, loseResponse: action => { lostAction = action } }
  }
  return {
    db, files, requests, signedFiles, uploads, downloads, client,
    tick: (milliseconds = 11000) => { clock += milliseconds },
    setModeration: available => { moderationAvailable = available },
    setMedia: value => { env.CAT_COMMUNITY_MEDIA_ENABLED = value },
    async review(postId, decision = 'approved') {
      const post = db.rows('cc_posts_private').find(row => row._id === postId)
      const event = { action: 'reviewPost', postId, requestHash: post.requestHash,
        reviewId: 'offline-human-review-0001', decision, reason: 'Synthetic test fixture only',
        reviewedText: true, reviewedImages: true, expiresAt: new Date(Date.now() + 120000).toISOString() }
      event.signature = signReview(event, REVIEW_SECRET)
      openid = ''
      return entry.main(event, runtimeContext())
    }
  }
}

test('deployment media setting is opt-in and never blocks the text-only adapter path', async () => {
  for (const mediaEnabled of [undefined, '', 'false', 'TRUE', '1', true]) {
    const f = setup({ mediaEnabled }), alice = f.client('synthetic-alice')
    await assert.rejects(alice.api._test.call('mediaContext'), error => error.code === 'MEDIA_DISABLED')
    const result = await alice.api.publishPost({ content: '部署联调文字', photos: [], consent: true, requestId: 'deployment-text-0001' })
    assert.equal(result.post.status, 'approved')
    assert.equal(f.requests.filter(item => item.action === 'mediaContext').length, 1)
    assert.equal(f.uploads.length, 0)
    await assert.rejects(alice.api._test.call('publishPost', { content: '伪造图片提交', photos: ['cloud://any/photo.jpg'], consent: true, requestId: 'deployment-photo-0001' }), error => error.code === 'MEDIA_DISABLED')
    assert.equal(f.db.rows('cc_posts_private').length, 1)
  }
})

test('turning media off refuses trusted photo approval before download or promotion; rejection still works', async () => {
  const f = setup(), alice = f.client('synthetic-alice')
  alice.localPhotos.set('fixture.jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00]))
  const submitted = await alice.api.publishPost({ content: '关闭前的待审图片', photos: ['fixture.jpg'], consent: true, requestId: 'media-gate-photo-0001' })
  assert.equal(submitted.post.status, 'pending')
  f.setMedia('false')
  // Removing the original makes any accidental download observable as failure.
  f.files.clear()
  const denied = await f.review(submitted.post.id)
  assert.equal(denied.error.code, 'MEDIA_DISABLED')
  assert.equal(f.db.rows('cc_posts_private')[0].status, 'pending')
  assert.equal(f.uploads.filter(item => item.source === 'server').length, 0)
  const rejected = await f.review(submitted.post.id, 'rejected')
  assert.equal(rejected.data.status, 'rejected')
})

test('real entrypoint bounds oversized reads and commits attempt quotas even when image publication fails', async () => {
  const f = setup(), alice = f.client('synthetic-oversized-author')
  const context = await alice.api._test.call('mediaContext')
  const fileID = `cloud://${ENV}.offline/${context.cloudPathPrefix}oversized-image-0001.jpg`
  f.files.set(fileID, Buffer.alloc(core.MAX_IMAGE_BYTES + 1))
  const input = { requestId: 'oversized-attempt-0001', content: '', photos: [fileID], consent: true }
  await assert.rejects(alice.api._test.call('publishPost', input), error => error.code === 'INVALID_FILE')
  assert.equal(f.downloads.length, 1)
  assert.equal(f.db.rows('cc_posts_private').length, 0)
  assert.equal(f.db.rows('cc_limits_private').length, 1)
  assert.equal(f.db.rows('cc_limits_private')[0].count, 1)
  await assert.rejects(alice.api._test.call('publishPost', input), error => error.code === 'RATE_LIMITED')
  assert.equal(f.downloads.length, 1, 'throttled retries must not sign or read an image')
  f.tick(2000)
  await assert.rejects(alice.api._test.call('publishPost', input), error => error.code === 'INVALID_FILE')
  assert.equal(f.downloads.length, 2)
  assert.equal(f.db.rows('cc_limits_private')[0].count, 2)
  assert.equal(f.db.rows('cc_posts_private').length, 0)
})

test('archive → deliberate photo sharing → private review → another user feed → comment and reply', { skip: !sharp }, async () => {
  const f = setup(), alice = f.client('synthetic-alice'), bob = f.client('synthetic-bob')
  const image = await sharp({ create: { width: 2200, height: 1100, channels: 3, background: '#ffd6df' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer()
  alice.localPhotos.set('wxfile://synthetic-cat.jpg', image)
  const pet = { id: 'private-local-id', name: '奶糖', breed: '田园猫', coatColor: '橘白',
    imagePath: 'wxfile://synthetic-cat.jpg', health: 'private-medical-notes', location: { latitude: 32 }, recognition: { description: 'private-result' } }
  const before = structuredClone(pet)
  const draft = { content: '它今天主动靠近了。你们家的猫会这样吗？', cat: handoff.toPublicCat(pet),
    includeCat: true, photos: [handoff.getPhotoCandidate(pet)], requestId: 'integration-photo-0001' }
  alice.api.saveDraft(draft)
  await assert.rejects(alice.api.publishPost(draft), /确认/)
  assert.equal(f.requests.length, 0); assert.equal(f.uploads.length, 0)

  const submitted = await alice.api.publishPost({ ...draft, consent: true })
  assert.equal(submitted.post.status, 'pending')
  assert.equal(alice.api.getDraft(), null)
  assert.equal((await bob.api.listPosts()).posts.length, 0)
  assert.equal((await alice.api.listPosts({ filter: 'mine' })).posts.length, 1)
  const signedBeforeDenial = f.signedFiles.length
  await assert.rejects(bob.api.getPost(submitted.post.id), error => error.code === 'NOT_FOUND')
  assert.equal(f.signedFiles.length, signedBeforeDenial, 'denied read must not sign a private photo')

  const reviewed = await f.review(submitted.post.id)
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed))
  const serverUpload = f.uploads.find(item => item.source === 'server')
  assert.match(serverUpload.fileID, /\/community-approved\/post_[a-f0-9]{40}\/[a-f0-9]{64}-[a-f0-9]{64}\.jpg$/)
  assert.equal(f.downloads.filter(fileID => fileID === serverUpload.fileID).length, 1, 'the real entrypoint must read back its new server copy before approval')
  const promoted = f.files.get(serverUpload.fileID), metadata = await sharp(promoted).metadata()
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 800); assert.equal(metadata.height, 1600)
  assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined)
  assert.equal(image.includes(Buffer.from('Exif\0\0', 'binary')), true)
  assert.equal(promoted.includes(Buffer.from('Exif\0\0', 'binary')), false)

  f.signedFiles.length = 0
  const feed = await bob.api.listPosts({ filter: 'public' })
  assert.equal(feed.posts.length, 1); assert.equal(feed.posts[0].id, submitted.post.id)
  assert.equal(feed.posts[0].cat.name, '奶糖')
  assert.match(feed.posts[0].photos[0], /^https:\/\/offline.invalid\//)
  assert.deepEqual(f.signedFiles, [serverUpload.fileID])
  assert.doesNotMatch(JSON.stringify(feed), /private-|synthetic-alice|requestHash|sourceAssets|latitude|cloud:\/\//)
  assert.deepEqual(pet, before, 'local archive must stay untouched')

  const comment = await bob.api.addComment(submitted.post.id, '它叫什么名字呀？')
  const aliceNotices = await alice.api.listNotifications()
  assert.equal(aliceNotices.notifications.length, 1)
  assert.equal(aliceNotices.notifications[0].commentId, comment.comment.id)
  await assert.rejects(bob.api.markNotification(aliceNotices.notifications[0].id), error => error.code === 'NOT_FOUND')
  await alice.api.markNotification(aliceNotices.notifications[0].id)
  assert.equal((await alice.api.listNotifications()).notifications[0].read, true)
  const returned = await alice.api.getPost(aliceNotices.notifications[0].postId)
  assert.equal(returned.comments[0].content, '它叫什么名字呀？')
  await alice.api.addComment(submitted.post.id, '它叫奶糖，谢谢你来接话。', comment.comment.id)
  const bobNotices = await bob.api.listNotifications()
  assert.equal(bobNotices.notifications.length, 1)
  assert.equal(bobNotices.notifications[0].type, 'reply')
  assert.equal((await bob.api.getPost(bobNotices.notifications[0].postId)).comments.length, 2)
})

test('lost server responses survive client reload without duplicate posts, comments or notifications', async () => {
  const f = setup(), alice = f.client('synthetic-alice'), bob = f.client('synthetic-bob')
  alice.loseResponse('publishPost')
  const input = { content: '没有猫咪档案也可以分享故事。', photos: [], requestId: 'integration-retry-0001', consent: true }
  await assert.rejects(alice.api.publishPost(input), /连接不上/)
  assert.equal(f.db.rows('cc_posts_private').length, 1)
  const reloadedAlice = f.client('synthetic-alice', alice.values)
  const retried = await reloadedAlice.api.publishPost({ ...reloadedAlice.api.getDraft(), consent: true })
  assert.equal(retried.idempotent, true)
  assert.equal(f.db.rows('cc_posts_private').length, 1)
  bob.loseResponse('addComment')
  await assert.rejects(bob.api.addComment(retried.post.id, '我也有这样的相遇。'), /连接不上/)
  const reloadedBob = f.client('synthetic-bob', bob.values)
  const comment = await reloadedBob.api.addComment(retried.post.id, '我也有这样的相遇。')
  assert.equal(comment.idempotent, true)
  assert.equal(f.db.rows('cc_comments_private').length, 1)
  assert.equal(f.db.rows('cc_notifications_private').length, 1)
  assert.equal((await reloadedAlice.api.getPost(retried.post.id)).post.commentCount, 1)
  assert.ok(f.db.rows('cc_limits_private').every(row => row.count === 1))
})

test('platform review outage creates no public comment or notice; exact draft can retry after recovery', async () => {
  const f = setup(), alice = f.client('synthetic-alice'), bob = f.client('synthetic-bob')
  const post = await alice.api.publishPost({ content: '猫咪在窗边。', photos: [], requestId: 'integration-outage-0001', consent: true })
  f.setModeration(false)
  await assert.rejects(bob.api.addComment(post.post.id, '后来怎么样了？'), error => error.code === 'MODERATION_UNAVAILABLE')
  assert.equal(f.db.rows('cc_comments_private').length, 0)
  assert.equal(f.db.rows('cc_notifications_private').length, 0)
  f.setModeration(true)
  const comment = await bob.api.addComment(post.post.id, '后来怎么样了？')
  assert.equal(comment.comment.status, 'approved')
  assert.equal(f.db.rows('cc_comments_private').length, 1)
  const attempts = f.requests.filter(request => request.action === 'addComment')
  assert.equal(attempts[0].requestId, attempts[1].requestId)
  assert.equal((await alice.api.listNotifications()).notifications.length, 1)
})

test('sending another comment never discards an earlier ambiguous request after client reload', async () => {
  const f = setup(), alice = f.client('synthetic-alice'), bob = f.client('synthetic-bob')
  const post = await alice.api.publishPost({ content: '一起聊猫。', photos: [], requestId: 'integration-interleaved-0001', consent: true })
  bob.loseResponse('addComment')
  await assert.rejects(bob.api.addComment(post.post.id, '第一句回应'), /连接不上/)
  f.tick()
  await bob.api.addComment(post.post.id, '另一句回应')
  const reloadedBob = f.client('synthetic-bob', bob.values)
  f.tick()
  const retried = await reloadedBob.api.addComment(post.post.id, '第一句回应')
  assert.equal(retried.idempotent, true)
  assert.equal(f.db.rows('cc_comments_private').length, 2)
  assert.equal(f.db.rows('cc_notifications_private').length, 2)
  assert.equal((await alice.api.getPost(post.post.id)).post.commentCount, 2)
})

test('notification cursors page every approved comment once and continue past a filtered-empty page', async () => {
  const f = setup(), recipient = f.client('synthetic-notice-recipient'), outsider = f.client('synthetic-notice-outsider')
  const post = await recipient.api.publishPost({ content: '欢迎分享猫咪的小故事。', photos: [], requestId: 'integration-notice-pages-0001', consent: true })
  for (let index = 0; index < 45; index += 1) {
    // Distinct synthetic actors avoid rate limits while keeping every timestamp
    // identical, so paging must use the repository's document-ID tie-breaker.
    const commenter = f.client(`synthetic-notice-commenter-${index}`)
    const result = await commenter.api.addComment(post.post.id, `第${index + 1}位猫友来接话。`)
    assert.equal(result.comment.status, 'approved')
  }
  const notices = f.db.rows('cc_notifications_private').sort((left, right) => left._id < right._id ? 1 : -1)
  assert.equal(notices.length, 45)
  assert.equal(new Set(notices.map(notice => notice.createdAt)).size, 1)
  assert.equal(new Set(notices.map(notice => notice.recipientId)).size, 1)

  const first = await recipient.api.listNotifications()
  assert.equal(first.notifications.length, 20)
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/)
  assert.deepEqual(f.requests.at(-1), { action: 'listNotifications', cursor: '', limit: 20 })
  await assert.rejects(outsider.api.listNotifications({ cursor: first.nextCursor }), error => error.code === 'INVALID_CURSOR')
  const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('0') ? '1' : '0'}`
  await assert.rejects(recipient.api.listNotifications({ cursor: tampered }), error => error.code === 'INVALID_CURSOR')

  const pages = [first]
  while (pages.at(-1).nextCursor) {
    assert.ok(pages.length < 3, 'the cursor must advance instead of repeating a page')
    const cursor = pages.at(-1).nextCursor
    pages.push(await recipient.api.listNotifications({ cursor }))
    assert.deepEqual(f.requests.at(-1), { action: 'listNotifications', cursor, limit: 20 })
  }
  const delivered = pages.flatMap(page => [...page.notifications].map(notice => notice.id))
  assert.deepEqual(pages.map(page => page.notifications.length), [20, 20, 5])
  assert.equal(pages.at(-1).nextCursor, null)
  assert.equal(new Set(delivered).size, 45, 'each notification must appear exactly once')
  assert.deepEqual(delivered, notices.map(notice => notice._id))

  // Simulate approval being withdrawn only in this test's in-memory database.
  // The raw middle page still exists but none of its comments may be projected.
  for (const notice of notices.slice(20, 40)) {
    await f.db.collection('cc_comments_private').doc(notice.commentId).update({ data: { status: 'rejected' } })
  }
  const refreshed = await recipient.api.listNotifications()
  const filtered = await recipient.api.listNotifications({ cursor: refreshed.nextCursor })
  assert.equal(refreshed.notifications.length, 20)
  assert.equal(filtered.notifications.length, 0)
  assert.match(filtered.nextCursor, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/)
  assert.notEqual(filtered.nextCursor, refreshed.nextCursor, 'an empty visible page must still advance its cursor')
  const final = await recipient.api.listNotifications({ cursor: filtered.nextCursor })
  assert.deepEqual([...final.notifications].map(notice => notice.id), notices.slice(40).map(notice => notice._id))
  assert.equal(final.nextCursor, null)
})

test('comment history pages once and old notification targets include off-page reply context', async () => {
  const f = setup(), author = f.client('synthetic-history-author'), reader = f.client('synthetic-history-reader')
  const published = await author.api.publishPost({ content: '记录猫友们的四十五次接话。', photos: [], requestId: 'integration-history-0001', consent: true })
  const postId = published.post.id
  const parent = await reader.api.addComment(postId, '最早的一句：它现在还好吗？')
  const comments = [parent.comment]
  f.tick()
  const responder = f.client('synthetic-history-responder')
  const reply = await responder.api.addComment(postId, '回复最早的一句：它很好，谢谢惦记。', parent.comment.id)
  comments.push(reply.comment)
  for (let index = 2; index < 45; index += 1) {
    f.tick()
    const commenter = f.client(`synthetic-history-commenter-${index}`)
    const result = await commenter.api.addComment(postId, `第${index + 1}次接话。`)
    assert.equal(result.comment.status, 'approved')
    comments.push(result.comment)
  }
  const expected = comments.map(comment => comment.id).reverse()
  const detail = await reader.api.getPost(postId)
  assert.deepEqual(f.requests.at(-1), { action: 'getPost', postId })
  assert.equal(detail.post.commentCount, 45)
  assert.deepEqual([...detail.comments].map(comment => comment.id), expected.slice(0, 30))
  assert.deepEqual([...detail.post.comments].map(comment => comment.id), expected.slice(0, 30))
  assert.match(detail.nextCommentsCursor, /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/)
  assert.equal(detail.targetUnavailable, false)
  assert.equal(detail.targetComment, null)
  assert.equal(detail.targetParent, null)

  const first = await reader.api.listComments(postId)
  assert.deepEqual(f.requests.at(-1), { action: 'listComments', postId, cursor: '', limit: 30 })
  assert.deepEqual([...first.comments].map(comment => comment.id), expected.slice(0, 30))
  assert.equal(first.nextCursor, detail.nextCommentsCursor)
  const remaining = await reader.api.listComments(postId, { cursor: detail.nextCommentsCursor })
  assert.deepEqual(f.requests.at(-1), { action: 'listComments', postId, cursor: detail.nextCommentsCursor, limit: 30 })
  assert.equal(remaining.comments.length, 15)
  assert.equal(remaining.nextCursor, null)
  const delivered = [...detail.comments, ...remaining.comments].map(comment => comment.id)
  assert.deepEqual(delivered, expected)
  assert.equal(new Set(delivered).size, 45, 'the detail and history pages must not duplicate or omit comments')

  const notices = []
  let cursor = ''
  do {
    assert.ok(notices.length < 45, 'notification paging must eventually reach the oldest comment')
    const page = await author.api.listNotifications({ cursor })
    notices.push(...page.notifications)
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(notices.length, 45)
  const earliest = notices.at(-1)
  assert.equal(earliest.commentId, parent.comment.id)
  const fromOldNotice = await author.api.getPost(earliest.postId, { commentId: earliest.commentId })
  assert.deepEqual(f.requests.at(-1), { action: 'getPost', postId, commentId: parent.comment.id })
  assert.equal(fromOldNotice.post.id, postId)
  assert.equal(fromOldNotice.targetUnavailable, false)
  assert.equal(fromOldNotice.targetComment.id, parent.comment.id)
  assert.equal(fromOldNotice.targetComment.content, parent.comment.content)
  assert.equal(fromOldNotice.targetParent, null)
  assert.ok(!fromOldNotice.comments.some(comment => comment.id === earliest.commentId), 'old targets are returned separately from the latest page')
  assert.equal(fromOldNotice.nextCommentsCursor, detail.nextCommentsCursor)

  const replyNotice = notices.find(notice => notice.commentId === reply.comment.id)
  assert.equal(replyNotice.type, 'reply')
  const fromReplyNotice = await author.api.getPost(replyNotice.postId, { commentId: replyNotice.commentId })
  assert.equal(fromReplyNotice.targetUnavailable, false)
  assert.equal(fromReplyNotice.targetComment.id, reply.comment.id)
  assert.equal(fromReplyNotice.targetComment.parentId, parent.comment.id)
  assert.equal(fromReplyNotice.targetParent.id, parent.comment.id)
  assert.equal(fromReplyNotice.targetParent.content, parent.comment.content)
  assert.ok(!fromReplyNotice.comments.some(comment => [parent.comment.id, reply.comment.id].includes(comment.id)))
  assert.doesNotMatch(JSON.stringify(fromReplyNotice), /synthetic-history-|requestHash|schemaVersion|recipientId/)
})

test('private, cross-post and stale comment targets never leak content or prevent an accessible story from opening', async () => {
  const f = setup(), author = f.client('synthetic-target-author'), reader = f.client('synthetic-target-reader')
  const published = await author.api.publishPost({ content: '仍然可以打开的公开故事。', photos: [], requestId: 'integration-target-0001', consent: true })
  const postId = published.post.id
  const parent = await reader.api.addComment(postId, '稍后会撤下的私密父评论。')
  f.tick()
  const reply = await author.api.addComment(postId, '仍然获准展示的回复。', parent.comment.id)
  f.tick()
  const hidden = await reader.api.addComment(postId, '不应出现在响应中的私密目标。')
  f.tick()
  const otherPost = await author.api.publishPost({ content: '另一个故事。', photos: [], requestId: 'integration-target-0002', consent: true })
  f.tick()
  const unrelated = await reader.api.addComment(otherPost.post.id, '不应混入当前故事的跨动态目标。')

  for (const status of ['pending', 'rejected']) {
    // Only the in-memory fixture changes; exercise the actual entrypoint's
    // visibility checks for a comment whose approval has been withdrawn.
    await f.db.collection('cc_comments_private').doc(hidden.comment.id).update({ data: { status } })
    const detail = await reader.api.getPost(postId, { commentId: hidden.comment.id })
    assert.equal(detail.post.id, postId)
    assert.equal(detail.post.content, published.post.content)
    assert.equal(detail.targetUnavailable, true)
    assert.equal(detail.targetComment, null)
    assert.equal(detail.targetParent, null)
    assert.equal(detail.comments.length, 2)
    assert.doesNotMatch(JSON.stringify(detail), /不应出现在响应中的私密目标/)
  }
  for (const commentId of [unrelated.comment.id, `comment_${'0'.repeat(40)}`, 'invalid-comment-link']) {
    const detail = await reader.api.getPost(postId, { commentId })
    assert.equal(detail.post.id, postId)
    assert.equal(detail.targetUnavailable, true)
    assert.equal(detail.targetComment, null)
    assert.equal(detail.targetParent, null)
    assert.equal(detail.comments.length, 2)
    assert.doesNotMatch(JSON.stringify(detail), /不应混入当前故事的跨动态目标|不应出现在响应中的私密目标/)
  }

  await f.db.collection('cc_comments_private').doc(parent.comment.id).update({ data: { status: 'rejected' } })
  const replyDetail = await reader.api.getPost(postId, { commentId: reply.comment.id })
  assert.equal(replyDetail.post.id, postId)
  assert.equal(replyDetail.targetUnavailable, false)
  assert.equal(replyDetail.targetComment.id, reply.comment.id)
  assert.equal(replyDetail.targetParent, null, 'an approved reply must not expose a withdrawn parent')
  assert.deepEqual([...replyDetail.comments].map(comment => comment.id), [reply.comment.id])
  assert.doesNotMatch(JSON.stringify(replyDetail), /稍后会撤下的私密父评论|不应出现在响应中的私密目标/)
})
