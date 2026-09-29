const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const viewModel = require(path.resolve(ROOT, 'components/social-post-card/view-model.js'))
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const check = (name, run) => test(name, { timeout: 1500 }, run)
const event = dataset => ({ currentTarget: { dataset } })
const input = value => ({ detail: { value } })
const post = (id, status = 'approved') => ({ id, status, content: `故事 ${id}`, author: { nickname: '猫友甲' } })
const comment = (id, status = 'approved', parentId = '') => ({ id, status, parentId, content: `回应 ${id}`, author: { nickname: '猫友乙' } })

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(name, overrides = {}, options = {}) {
  let definition
  const calls = [], navigation = [], writes = [], scrolls = [], storage = new Map()
  let stopped = 0, hidden = 0
  const defaults = {
    listPosts: async () => ({ posts: [], nextCursor: null }),
    listNotifications: async () => ({ notifications: [] }),
    getPost: async () => ({ post: post('post-one'), comments: [] }),
    listComments: async () => ({ comments: [], nextCursor: null }),
    addComment: async () => ({ comment: comment('new-comment') }),
    markNotification: async id => ({ id, read: true })
  }
  const community = Object.fromEntries(Object.keys(defaults).map(method => [method, (...args) => {
    calls.push({ method, args: clone(args) })
    return (overrides[method] || defaults[method])(...args)
  }]))
  const wx = {
    getWindowInfo: () => ({ windowWidth: options.width || 375 }),
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => { storage.set(key, clone(value)) },
    removeStorageSync: key => { storage.delete(key) },
    stopPullDownRefresh: () => { stopped += 1 },
    hideKeyboard: () => { hidden += 1 },
    navigateTo: value => { navigation.push(clone(value)) },
    pageScrollTo: value => { scrolls.push(clone(value)) },
    switchTab: value => { navigation.push(clone(value)) }
  }
  const filename = path.resolve(ROOT, 'pages', name, 'index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: value => { definition = value }, wx,
    require(request) {
      if (request === '../../services/community') return community
      if (request === '../../components/social-post-card/view-model') return viewModel
      throw new Error(`Unexpected require: ${request}`)
    }
  }, { filename, timeout: 1000 })
  const page = { ...definition, data: clone(definition.data), setData(patch, callback) {
    writes.push(clone(patch))
    Object.assign(this.data, clone(patch))
    if (callback) callback()
  } }
  return { page, calls, navigation, writes, scrolls, storage, stopped: () => stopped, hidden: () => hidden }
}

function detail(overrides = {}, options = {}) {
  const f = fixture('social-post', overrides, options)
  f.page.setData({ postId: 'post-one', post: viewModel.postOf(post('post-one')) })
  f.page._rpx = (options.width || 375) / 750
  return f
}

for (const [name, filter, busy, loaded] of [
  ['home', 'public', 'loading', 'loaded'],
  ['social', 'mine', 'loadingPosts', 'mineLoaded']
]) {
  check(`${name}: real ${filter} request distinguishes empty success from error and stops spinners`, async () => {
    let fail = false
    const f = fixture(name, { listPosts: async () => {
      if (fail) throw new Error('网络不可用')
      return { posts: [], nextCursor: null }
    } })
    assert.equal(f.page.data[loaded], false)
    assert.equal(await f.page.loadPosts(true), true)
    assert.deepEqual(f.calls[0], { method: 'listPosts', args: [{ filter, cursor: null }] })
    assert.equal(f.page.data[loaded], true)
    assert.deepEqual(f.page.data.posts, [])
    assert.equal(f.page.data.error, '')
    assert.equal(f.page.data[busy], false)
    fail = true
    assert.equal(await f.page.onPullDownRefresh(), false)
    assert.equal(f.page.data.error, '网络不可用')
    assert.equal(f.page.data[busy], false)
    assert.equal(f.stopped(), 1)
    if (name === 'home') assert.equal(f.page.data.refreshing, false)

    const failed = fixture(name, { listPosts: async () => { throw new Error('首次加载失败') } })
    await failed.page.loadPosts(true)
    assert.equal(failed.page.data[loaded], false, 'failure must not become an empty successful feed')
    assert.equal(failed.page.data[busy], false)
    assert.equal(failed.page.data.error, '首次加载失败')
  })

  check(`${name}: pagination uses server cursor, deduplicates IDs and retries the failed page`, async () => {
    let count = 0
    const f = fixture(name, { listPosts: async () => {
      count += 1
      if (count === 1) return { posts: [post('one')], nextCursor: 'cursor-1' }
      if (count === 2) throw new Error('翻页失败')
      return { posts: [post('one'), post('two'), post('')], nextCursor: null }
    } })
    await f.page.loadPosts(true)
    await f.page.loadMore()
    assert.deepEqual(f.page.data.posts.map(item => item.id), ['one'])
    assert.equal(f.page.data.nextCursor, 'cursor-1')
    assert.equal(f.page.data[busy], false)
    await (name === 'home' ? f.page.retry() : f.page.retryPosts())
    assert.deepEqual(f.calls.slice(1).map(call => call.args[0]), [
      { filter, cursor: 'cursor-1' }, { filter, cursor: 'cursor-1' }
    ])
    assert.deepEqual(f.page.data.posts.map(item => item.id), ['one', 'two'])
    assert.equal(f.page.data.error, '')
    assert.equal(await f.page.loadMore(), false)
    assert.equal(f.calls.length, 3)
  })

  check(`${name}: stale pagination cannot replace a newer refresh or stop its spinner`, async () => {
    const older = deferred(), newer = deferred()
    let count = 0
    const f = fixture(name, { listPosts: () => (++count === 1 ? older : newer).promise })
    f.page.setData({ posts: [viewModel.postOf(post('existing'))], nextCursor: 'old-cursor' })
    const pagination = f.page.loadPosts(false)
    assert.equal(await f.page.loadPosts(false), false, 'busy pagination must not duplicate its request')
    const refresh = f.page.loadPosts(true)
    older.resolve({ posts: [post('stale')], nextCursor: 'stale-cursor' })
    assert.equal(await pagination, false)
    assert.equal(f.page.data[busy], true)
    assert.deepEqual(f.page.data.posts.map(item => item.id), ['existing'])
    newer.resolve({ posts: [post('fresh')], nextCursor: 'fresh-cursor' })
    assert.equal(await refresh, true)
    assert.equal(f.page.data[busy], false)
    assert.deepEqual(f.page.data.posts.map(item => item.id), ['fresh'])
    assert.equal(f.page.data.nextCursor, 'fresh-cursor')
  })

  check(`${name}: late old response and unloaded response do not mutate current feed`, async () => {
    const old = deferred(), fresh = deferred(), disposed = deferred()
    const queue = [old, fresh, disposed]
    const f = fixture(name, { listPosts: () => queue.shift().promise })
    const first = f.page.loadPosts(true)
    const second = f.page.loadPosts(true)
    fresh.resolve({ posts: [post('fresh')], nextCursor: null })
    await second
    old.resolve({ posts: [post('stale')], nextCursor: 'stale' })
    await first
    assert.deepEqual(f.page.data.posts.map(item => item.id), ['fresh'])
    const last = f.page.loadPosts(true)
    f.page.onUnload()
    const writeCount = f.writes.length
    disposed.reject(new Error('卸载后的错误'))
    await last
    assert.equal(f.writes.length, writeCount)
  })
}

check('social: notifications prefer actor nickname, normalize read state and omit unusable targets', async () => {
  const f = fixture('social', { listNotifications: async () => ({ notifications: [
    { _id: 'n1', postId: 'p1', actor: { nickname: '回应者' }, author: { nickname: '帖子作者' }, content: '你好', read: false },
    { id: 'n2', postId: 'p2', author: { nickname: '旧格式' }, readAt: '2026-01-01' },
    { id: 'n3', postId: 'p3' }, { id: 'missing-post' }, { postId: 'missing-id' }
  ] }) })
  await f.page.loadNotifications()
  assert.deepEqual(f.page.data.notifications.map(item => [item.id, item.authorName, item.read]), [
    ['n1', '回应者', false], ['n2', '旧格式', true], ['n3', '猫友', false]
  ])
  assert.equal(f.page.data.notifications[1].content, '有猫友回应了你的故事')
  assert.equal(f.page.data.notificationsLoaded, true)
  assert.equal(f.page.data.loadingNotifications, false)
})

check('social: notification empty, error and stale refresh states are distinct', async () => {
  const older = deferred(), newer = deferred()
  const queue = [older, newer]
  const f = fixture('social', { listNotifications: () => queue.shift().promise })
  const first = f.page.loadNotifications()
  const second = f.page.loadNotifications()
  newer.resolve({ notifications: [] })
  await second
  older.reject(new Error('过期错误'))
  await first
  assert.equal(f.page.data.notificationError, '')
  assert.equal(f.page.data.notificationsLoaded, true)
  assert.equal(f.page.data.loadingNotifications, false)
  const failed = fixture('social', { listNotifications: async () => { throw new Error('回应加载失败') } })
  failed.page.setData({ activeSection: 'replies' })
  await failed.page.onPullDownRefresh()
  assert.equal(failed.stopped(), 1)
  assert.equal(failed.page.data.notificationError, '回应加载失败')
  assert.equal(failed.page.data.notificationsLoaded, false)
  assert.equal(failed.page.data.loadingNotifications, false)
})

check('social: only confirmed mark-read success updates local state; failed marks still open story', async () => {
  for (const result of [null, { id: 'other', read: true }, { id: 'n1', read: false }, new Error('离线')]) {
    const f = fixture('social', { markNotification: async () => { if (result instanceof Error) throw result; return result } })
    f.page.setData({ notifications: [{ id: 'n1', postId: 'post / one', read: false }] })
    await f.page.openNotification(event({ id: 'n1' }))
    assert.equal(f.page.data.notifications[0].read, false)
    assert.match(f.page.data.notificationError, /未能标记/)
    assert.equal(f.navigation[0].url, '/pages/social-post/index?id=post%20%2F%20one')
  }
  const pending = deferred()
  const f = fixture('social', { markNotification: () => pending.promise })
  f.page.setData({ notifications: [{ id: 'n1', postId: 'p1', read: false }] })
  const open = f.page.openNotification(event({ id: 'n1' }))
  assert.equal(f.page.data.notifications[0].read, false)
  pending.resolve({ id: 'n1', read: true })
  await open
  assert.equal(f.page.data.notifications[0].read, true)
  await f.page.openNotification(event({ id: 'n1' }))
  await f.page.openNotification(event({ id: 'missing' }))
  assert.equal(f.calls.filter(call => call.method === 'markNotification').length, 1)
})

check('social: notification pagination preserves prior rows and retries the failed cursor without duplicates', async () => {
  let count = 0
  const notice = (id, read = false) => ({ id, postId: 'post-one', content: `回应 ${id}`, read })
  const f = fixture('social', { listNotifications: async () => {
    count += 1
    if (count === 1) return { notifications: [notice('n1', true)], nextCursor: 'older-1' }
    if (count === 2) throw new Error('早期回应暂时没能加载')
    return { notifications: [notice('n1'), notice('n2'), { id: 'invalid' }], nextCursor: null }
  } })
  f.page.setData({ activeSection: 'replies' })
  await f.page.refresh()
  assert.equal(await f.page.onReachBottom(), false)
  assert.deepEqual(f.page.data.notifications.map(item => item.id), ['n1'])
  assert.equal(f.page.data.notificationCursor, 'older-1')
  assert.equal(f.page.data.loadingNotifications, false)
  assert.match(f.page.data.notificationError, /早期回应/)
  await f.page.retryNotifications()
  assert.deepEqual(f.calls.map(call => call.args), [[{ cursor: null }], [{ cursor: 'older-1' }], [{ cursor: 'older-1' }]])
  assert.deepEqual(f.page.data.notifications.map(item => [item.id, item.read]), [['n1', true], ['n2', false]])
  assert.equal(f.page.data.notificationCursor, null)
  assert.equal(await f.page.loadMoreNotifications(), false)
  assert.equal(f.calls.length, 3)
})

check('social: filtered empty notification pages still expose their continuation cursor', async () => {
  const f = fixture('social', { listNotifications: async ({ cursor }) => cursor
    ? { notifications: [{ id: 'older', postId: 'post-one' }], nextCursor: null }
    : { notifications: [], nextCursor: 'hidden-page-cursor' } })
  f.page.setData({ activeSection: 'replies' })
  await f.page.refresh()
  assert.equal(f.page.data.notifications.length, 0)
  assert.equal(f.page.data.notificationCursor, 'hidden-page-cursor')
  await f.page.loadMoreNotifications()
  assert.equal(f.page.data.notifications[0].id, 'older')
  const wxml = fs.readFileSync(path.resolve(ROOT, 'pages/social/index.wxml'), 'utf8')
  assert.match(wxml, /wx:if="\{\{notificationCursor\}\}"[^>]+bindtap="loadMoreNotifications"/)
  assert.match(wxml, /!notifications\.length && !notificationCursor/)
  const wxss = fs.readFileSync(path.resolve(ROOT, 'pages/social/index.wxss'), 'utf8')
  assert.match(wxss, /\.community-page \.notification-row\s*\{[^}]*width:\s*100%/)
  assert.match(wxss, /\.community-page \.social-tab\s*\{[^}]*width:\s*auto/)
})

check('social: newer notification refresh supersedes pagination; duplicate load and unloaded callbacks do not write', async () => {
  const older = deferred(), newer = deferred(), disposed = deferred()
  const queue = [older, newer, disposed]
  const f = fixture('social', { listNotifications: () => queue.shift().promise })
  f.page.setData({ notifications: [{ id: 'existing', postId: 'post-one' }], notificationCursor: 'old-cursor' })
  const pagination = f.page.loadMoreNotifications()
  assert.equal(await f.page.loadMoreNotifications(), false)
  const refresh = f.page.loadNotifications(true)
  older.resolve({ notifications: [{ id: 'stale', postId: 'post-one' }], nextCursor: 'stale-cursor' })
  assert.equal(await pagination, false)
  assert.equal(f.page.data.loadingNotifications, true)
  assert.equal(f.page.data.notifications[0].id, 'existing')
  newer.resolve({ notifications: [{ id: 'fresh', postId: 'post-one' }], nextCursor: 'fresh-cursor' })
  assert.equal(await refresh, true)
  assert.equal(f.page.data.notificationCursor, 'fresh-cursor')
  assert.equal(f.page.data.notifications[0].id, 'fresh')
  const last = f.page.loadMoreNotifications()
  f.page.onUnload()
  const count = f.writes.length
  disposed.reject(new Error('卸载后的分页失败'))
  await last
  assert.equal(f.writes.length, count)
})

check('social: an in-flight list cannot turn a confirmed read notification back into unread', async () => {
  const pending = deferred()
  const f = fixture('social', { listNotifications: () => pending.promise })
  f.page.setData({ notifications: [{ id: 'n1', postId: 'post-one', read: false }] })
  const refresh = f.page.loadNotifications(true)
  await f.page.openNotification(event({ id: 'n1' }))
  pending.resolve({ notifications: [{ id: 'n1', postId: 'post-one', read: false }], nextCursor: null })
  await refresh
  assert.equal(f.page.data.notifications[0].read, true)
  assert.equal(f.page.data.loadingNotifications, false)
})

check('detail: loading maps first-level reply names and failure stops refresh without fake content', async () => {
  const f = detail({ getPost: async () => ({ post: post('post-one'), comments: [comment('root'), comment('child', 'approved', 'root')] }) })
  await f.page.loadPost()
  assert.equal(f.page.data.comments[1].replyToName, '猫友乙')
  assert.equal(f.page.data.loading, false)
  const failed = fixture('social-post', { getPost: async () => ({ post: null, comments: [] }) })
  failed.page.setData({ postId: 'unavailable' })
  assert.equal(await failed.page.onPullDownRefresh(), false)
  assert.equal(failed.page.data.post, null)
  assert.match(failed.page.data.error, /无法查看/)
  assert.equal(failed.page.data.loading, false)
  assert.equal(failed.stopped(), 1)
})

check('detail: a stale load cannot replace refreshed detail', async () => {
  const older = deferred(), newer = deferred()
  const queue = [older, newer]
  const f = detail({ getPost: () => queue.shift().promise })
  const first = f.page.loadPost()
  const second = f.page.loadPost()
  newer.resolve({ post: { ...post('post-one'), content: '新内容' }, comments: [comment('fresh')] })
  await second
  older.resolve({ post: { ...post('post-one'), content: '旧内容' }, comments: [comment('stale')] })
  await first
  assert.equal(f.page.data.post.content, '新内容')
  assert.deepEqual(f.page.data.comments.map(item => item.id), ['fresh'])
  assert.equal(f.page.data.loading, false)
})

check('social: notification routing carries the exact comment id without requiring an unread state', async () => {
  const f = fixture('social', { listNotifications: async () => ({ notifications: [{ id: 'n1', postId: 'post / one', commentId: 'comment / one', read: true }] }) })
  await f.page.loadNotifications()
  await f.page.openNotification(event({ id: 'n1' }))
  assert.equal(f.navigation[0].url, '/pages/social-post/index?id=post%20%2F%20one&commentId=comment%20%2F%20one')
  assert.equal(f.calls.filter(call => call.method === 'markNotification').length, 0)
})

check('detail: a notification retrieves an off-page comment and approved parent without auto-sending', async () => {
  const f = detail({ getPost: async () => ({ post: post('post-one'), comments: [comment('recent')], nextCommentsCursor: 'history-1',
    targetComment: comment('old-child', 'approved', 'old-parent'), targetParent: comment('old-parent') }) })
  f.page.setData({ targetCommentId: 'old-child' })
  f.page._locateOnLoad = true
  await f.page.loadPost()
  assert.deepEqual(f.calls[0].args, ['post-one', { commentId: 'old-child' }])
  assert.equal(f.page.data.targetComment.id, 'old-child')
  assert.equal(f.page.data.targetParent.id, 'old-parent')
  assert.equal(f.page.data.commentsCursor, 'history-1')
  assert.equal(f.page.data.targetUnavailable, false)
  assert.equal(f.page.data.inputFocus, false)
  assert.deepEqual(f.scrolls, [{ selector: '#notification-context', duration: 0 }])
  f.page.replyToNotification()
  assert.equal(f.page.data.replyTo.id, 'old-parent')
  assert.equal(f.page.data.draft, '')
  assert.equal(f.calls.filter(call => call.method === 'addComment').length, 0)
})

check('detail: an unavailable or unconfirmed notification target preserves the story and private draft', async () => {
  for (const target of [null, comment('other'), comment('wanted', 'pending')]) {
    const f = detail({ getPost: async () => ({ post: post('post-one'), comments: [comment('visible')], targetComment: target, targetUnavailable: true }) })
    f.page.setData({ targetCommentId: 'wanted', draft: '未发送的草稿' })
    await f.page.loadPost()
    assert.equal(f.page.data.post.id, 'post-one')
    assert.equal(f.page.data.targetComment, null)
    assert.equal(f.page.data.targetUnavailable, true)
    assert.equal(f.page.data.draft, '未发送的草稿')
    f.page.replyToNotification()
    assert.equal(f.page.data.replyTo, null)
  }
})

check('detail: historical comments retry the same cursor, deduplicate and resolve parent names across pages', async () => {
  let attempts = 0
  const f = detail({
    getPost: async () => ({ post: post('post-one'), comments: [comment('child', 'approved', 'root')], nextCommentsCursor: 'older-1' }),
    listComments: async () => {
      if (++attempts === 1) throw new Error('历史加载失败')
      return { comments: [comment('child', 'approved', 'root'), { ...comment('root'), author: { nickname: '早期猫友' } }], nextCursor: null }
    }
  })
  await f.page.loadPost()
  assert.equal(f.page.data.comments[0].replyToName, '猫友')
  assert.equal(await f.page.loadMoreComments(), false)
  assert.equal(f.page.data.commentsCursor, 'older-1')
  assert.equal(f.page.data.comments.length, 1)
  assert.match(f.page.data.commentsError, /历史/)
  assert.equal(await f.page.loadMoreComments(), true)
  assert.deepEqual(f.page.data.comments.map(item => item.id), ['child', 'root'])
  assert.equal(f.page.data.comments[0].replyToName, '早期猫友')
  assert.equal(f.page.data.commentsCursor, null)
  assert.deepEqual(f.calls.filter(call => call.method === 'listComments').map(call => call.args), [
    ['post-one', { cursor: 'older-1' }], ['post-one', { cursor: 'older-1' }]
  ])
  assert.equal(await f.page.loadMoreComments(), false)
})

check('detail: refresh supersedes historical pagination and disposed requests cannot update the page', async () => {
  const older = deferred(), newer = deferred(), disposed = deferred()
  let pages = 0
  const f = detail({ getPost: () => newer.promise, listComments: () => (++pages === 1 ? older : disposed).promise })
  f.page.setData({ comments: [viewModel.commentOf(comment('existing'))], commentsCursor: 'old-cursor' })
  const pagination = f.page.loadMoreComments()
  assert.equal(await f.page.loadMoreComments(), false)
  const refresh = f.page.loadPost()
  older.resolve({ comments: [comment('stale')], nextCursor: 'stale-cursor' })
  assert.equal(await pagination, false)
  newer.resolve({ post: post('post-one'), comments: [comment('fresh')], nextCommentsCursor: 'fresh-cursor' })
  await refresh
  assert.deepEqual(f.page.data.comments.map(item => item.id), ['fresh'])
  assert.equal(f.page.data.commentsCursor, 'fresh-cursor')
  const last = f.page.loadMoreComments()
  f.page.onUnload()
  const count = f.writes.length
  disposed.reject(new Error('页面已关闭'))
  await last
  assert.equal(f.writes.length, count)
})

check('detail: comment prompts only fill and persist editable drafts, never send', () => {
  const f = detail()
  f.page.choosePrompt(event({ prompt: '它平时也这么亲人吗？' }))
  assert.equal(f.page.data.draft, '它平时也这么亲人吗？')
  assert.equal(f.page.data.inputFocus, true)
  assert.match(f.page.data.feedback, /修改后再发送/)
  f.page.choosePrompt(event({ prompt: '想听听你们是怎么认识的。' }))
  assert.equal(f.page.data.draft, '它平时也这么亲人吗？\n想听听你们是怎么认识的。')
  assert.equal(f.storage.get('catai_community_reply_post-one').draft, f.page.data.draft)
  assert.equal(f.calls.length, 0)
  f.page.onDraftInput(input('猫'.repeat(400)))
  assert.equal(f.page.data.maxComment, 300)
  assert.equal(f.page.data.draft.length, 300)
  f.page.choosePrompt(event({ prompt: '不能超长' }))
  assert.equal(f.page.data.draft.length, 300)
})

check('detail: only first-level comments can become directed reply targets', () => {
  const f = detail()
  f.page.setData({ comments: [viewModel.commentOf(comment('root')), viewModel.commentOf(comment('child', 'approved', 'root'))] })
  f.page.replyComment(event({ id: 'child' }))
  assert.equal(f.page.data.replyTo, null)
  f.page.replyComment(event({ id: 'root' }))
  assert.deepEqual(f.page.data.replyTo, { id: 'root', nickname: '猫友乙', content: '回应 root' })
  f.page.replyComment(event({ id: 'child' }))
  assert.equal(f.page.data.replyTo.id, 'root')
  assert.equal(f.storage.get('catai_community_reply_post-one').replyTo.id, 'root')
  f.page.cancelReply()
  assert.equal(f.page.data.replyTo, null)
})

check('detail: duplicate send and reply/prompt changes are blocked while sending; failure preserves draft and target', async () => {
  const pending = deferred()
  const f = detail({ addComment: () => pending.promise })
  f.page.setData({ comments: [viewModel.commentOf(comment('root'))] })
  f.page.replyComment(event({ id: 'root' }))
  f.page.onDraftInput(input('  留给猫友的话  '))
  const send = f.page.sendComment()
  assert.equal(f.page.data.sending, true)
  assert.equal(await f.page.sendComment(), false)
  f.page.choosePrompt(event({ prompt: '不要插入' }))
  f.page.cancelReply()
  f.page.replyComment(event({ id: 'root' }))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0], { method: 'addComment', args: ['post-one', '留给猫友的话', 'root'] })
  pending.reject(new Error('发送失败，请重试'))
  assert.equal(await send, false)
  assert.equal(f.page.data.sending, false)
  assert.equal(f.page.data.draft, '  留给猫友的话  ')
  assert.equal(f.page.data.replyTo.id, 'root')
  assert.match(f.page.data.sendError, /发送失败/)
  assert.equal(f.storage.get('catai_community_reply_post-one').replyTo.id, 'root')
  assert.equal(f.page.data.comments.length, 1)
})

check('detail: pending acceptance clears draft but creates no fake visible comment', async () => {
  const f = detail({ addComment: async () => ({ comment: comment('pending-comment', 'pending') }) })
  f.page.onDraftInput(input('待审核的话'))
  assert.equal(await f.page.sendComment(), true)
  assert.deepEqual(f.page.data.comments, [])
  assert.equal(f.page.data.draft, '')
  assert.equal(f.page.data.sending, false)
  assert.match(f.page.data.feedback, /提交审核/)
  assert.equal(f.storage.has('catai_community_reply_post-one'), false)
})

check('detail: rejected, unknown and unconfirmed comment results preserve draft and target', async () => {
  for (const result of [
    { comment: comment('rejected', 'rejected') },
    { comment: comment('unknown', 'unknown') },
    { comment: { id: 'missing-status', content: '未确认' } },
    { comment: { status: 'approved' } }, null
  ]) {
    const f = detail({ addComment: async () => result })
    f.page.setData({ replyTo: { id: 'root', nickname: '猫友乙', content: '原回应' } })
    f.page.onDraftInput(input('保留文字'))
    assert.equal(await f.page.sendComment(), false)
    assert.equal(f.page.data.draft, '保留文字')
    assert.equal(f.page.data.replyTo.id, 'root')
    assert.equal(f.page.data.sending, false)
    assert.ok(f.page.data.sendError)
    assert.deepEqual(f.page.data.comments, [])
    assert.equal(f.storage.get('catai_community_reply_post-one').draft, '保留文字')
  }
})

check('detail: approved success appends actual server comment, clears draft and resets keyboard', async () => {
  const f = detail({ addComment: async () => ({ comment: comment('server-id', 'approved', 'root') }) })
  f.page.setData({ replyTo: { id: 'root', nickname: '猫友丙', content: '原回应' }, keyboardHeight: 300, inputHeight: 110, inputFocus: true })
  f.page.onDraftInput(input('发给猫友的话'))
  assert.equal(await f.page.sendComment(), true)
  assert.equal(f.page.data.comments.length, 1)
  assert.equal(f.page.data.comments[0].id, 'server-id')
  assert.equal(f.page.data.comments[0].replyToName, '猫友丙')
  assert.equal(f.page.data.draft, '')
  assert.equal(f.page.data.replyTo, null)
  assert.equal(f.page.data.sending, false)
  assert.equal(f.page.data.keyboardHeight, 0)
  assert.equal(f.page.data.inputHeight, 44)
  assert.equal(f.page.data.inputFocus, false)
  assert.equal(f.hidden(), 1)
  assert.equal(f.storage.has('catai_community_reply_post-one'), false)
  f.page.onDraftInput(input('重复服务器结果'))
  await f.page.sendComment()
  assert.equal(f.page.data.comments.length, 1, 'an existing server ID must not be appended twice')
})

check('detail: empty input and unapproved stories cannot submit comments', async () => {
  const f = detail()
  f.page.onDraftInput(input('   '))
  assert.equal(await f.page.sendComment(), false)
  assert.match(f.page.data.sendError, /先写下一句话/)
  for (const status of ['pending', 'rejected', 'hidden', 'published']) {
    f.page.setData({ post: viewModel.postOf(post('post-one', status)), draft: '不能发送' })
    assert.equal(await f.page.sendComment(), false)
  }
  assert.equal(f.calls.length, 0)
})

check('detail: persisted drafts restore within 300 characters and retain reply target', () => {
  const f = fixture('social-post')
  f.storage.set('catai_community_reply_post-one', { draft: '猫'.repeat(400), replyTo: { id: 'root', nickname: '猫友甲', content: '引用' } })
  f.page.loadPost = () => Promise.resolve(true)
  f.page.onLoad({ id: 'post-one', reply: '1' })
  assert.equal(f.page.data.draft.length, 300)
  assert.equal(f.page.data.replyTo.id, 'root')
  assert.equal(f.page._focusOnLoad, true)
  f.page.onHide()
  assert.equal(f.storage.get('catai_community_reply_post-one').draft.length, 300)
  const missing = fixture('social-post')
  missing.page.onLoad({})
  assert.match(missing.page.data.error, /链接不完整/)
  assert.equal(missing.calls.length, 0)
})

check('detail: textarea height stays within 88–220rpx and keyboard state resets on blur', () => {
  for (const width of [375, 750]) {
    const f = fixture('social-post', {}, { width })
    f.page.loadPost = () => Promise.resolve(true)
    f.page.onLoad({ id: 'post-one' })
    const unit = width / 750
    assert.equal(f.page.data.inputHeight, 88 * unit)
    f.page.onLineChange({ detail: { height: -500 } })
    assert.equal(f.page.data.inputHeight, 88 * unit)
    f.page.onLineChange({ detail: { height: 5000 } })
    assert.equal(f.page.data.inputHeight, 220 * unit)
    f.page.onLineChange({ detail: { height: 100 * unit } })
    assert.equal(f.page.data.inputHeight, 132 * unit)
    f.page.onKeyboardChange({ detail: { height: 320 } })
    assert.equal(f.page.data.keyboardHeight, 320)
    f.page.onKeyboardChange({ detail: { height: -10 } })
    assert.equal(f.page.data.keyboardHeight, 0)
    f.page.onKeyboardChange({ detail: { height: 320 } })
    f.page.onInputBlur()
    assert.equal(f.page.data.keyboardHeight, 0)
    assert.equal(f.page.data.inputFocus, false)
  }
  const wxml = fs.readFileSync(path.resolve(ROOT, 'pages/social-post/index.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.resolve(ROOT, 'pages/social-post/index.wxss'), 'utf8')
  const textarea = wxml.match(/<textarea\b[^>]*\/>/)[0]
  assert.match(textarea, /maxlength="\{\{maxComment\}\}"/)
  assert.match(textarea, /bindlinechange="onLineChange"/)
  assert.match(textarea, /bindkeyboardheightchange="onKeyboardChange"/)
  assert.match(textarea, /adjust-position="\{\{false\}\}"/)
  assert.match(textarea, /disabled="\{\{sending\}\}"/)
  assert.match(wxml, /wx:if="\{\{post && post\.status === 'approved'\}\}" class="comment-composer/)
  const style = wxss.match(/\.comment-input\s*\{([^}]+)\}/)[1]
  assert.match(style, /min-height:\s*88rpx/)
  assert.match(style, /max-height:\s*220rpx/)
})

check('detail: unapproved shares use safe home card; approved shares have an explicit image', () => {
  const f = detail()
  for (const status of ['pending', 'rejected']) {
    f.page.setData({ post: viewModel.postOf({ ...post('post-one', status), photos: ['private-photo'] }) })
    assert.deepEqual(clone(f.page.onShareAppMessage()), {
      title: '来猫猫小屋，看看猫咪的新故事', path: '/pages/home/index', imageUrl: '/assets/tabbar/home-selected.png'
    })
  }
  f.page.setData({ post: viewModel.postOf({ ...post('post-one'), cat: { name: '咪咪' }, photos: ['cloud-photo'] }) })
  assert.deepEqual(clone(f.page.onShareAppMessage()), { title: '咪咪的猫咪故事', path: '/pages/social-post/index?id=post-one', imageUrl: 'cloud-photo' })
  f.page.setData({ post: viewModel.postOf(post('post-one')) })
  assert.equal(f.page.onShareAppMessage().imageUrl, '/assets/tabbar/home-selected.png')
})

check('view-model: only normalized real IDs, public fields and two preview comments are rendered', () => {
  const mapped = viewModel.postOf({
    _id: ' p1 ', content: ' 真实故事 ', status: 'pending',
    photos: [' image-one ', { tempFileURL: 'image-two' }, { url: 'image-three' }, null, {}],
    cat: { name: ' 小橘 ', breed: '田园猫', coatColor: '橘白', medical: 'private' },
    author: { id: 'author', nickname: '猫友甲', openid: 'private' },
    comments: [comment('a'), comment('b'), comment('c')], commentCount: -3,
    medical: 'private', location: 'private'
  })
  assert.equal(mapped.id, 'p1')
  assert.equal(mapped.content, '真实故事')
  assert.equal(mapped.statusLabel, '审核中')
  assert.equal(mapped.hasCat, true)
  assert.equal(mapped.author.initial, '猫')
  assert.deepEqual(mapped.photos, ['image-one', 'image-two', 'image-three'])
  assert.deepEqual(mapped.comments.map(item => item.id), ['a', 'b'])
  assert.equal(mapped.commentCount, 0)
  assert.doesNotMatch(JSON.stringify(mapped), /private|openid|medical|location/)
  assert.deepEqual(viewModel.uniquePosts([mapped, mapped, viewModel.postOf({}), viewModel.postOf(post('p2'))]).map(item => item.id), ['p1', 'p2'])
  assert.equal(viewModel.postOf({}).hasCat, false)
  assert.equal(viewModel.authorOf(null).nickname, '猫友')
  assert.equal(viewModel.timeLabel('not-a-date'), '')
  assert.equal(viewModel.text({ unsafe: true }), '')
  assert.equal(viewModel.commentOf({ replyTo: { nickname: '猫友丁' } }).replyToName, '猫友丁')
})
