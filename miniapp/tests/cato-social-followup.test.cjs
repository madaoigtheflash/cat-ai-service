const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const domain = require('../utils/cato-social-followup')
const { createStore } = require('../services/cato-lab')

function comment(state, extra = {}) {
  return domain.transition(state, { type: 'comment', actor: 'momo', storyId: 'window', text: '你家猫也喜欢窗边吗？', requestId: 'comment_1', ...extra })
}
function setup() {
  const state = comment(domain.createInitialState())
  return { state, context: { storyId: 'window', commentId: state.comments[0].id } }
}
function send(state, context, extra = {}) {
  return domain.transition(state, { type: 'message', actor: 'momo', peer: 'lin', context, kind: 'TEXT', text: '你好，想聊聊猫的小习惯。', requestId: 'greeting_1', ...extra })
}
function pending() { const { state, context } = setup(); return { state: send(state, context), context } }
function pageHarness(options = {}) {
  const values = options.values || {}
  const api = {
    getStorageSync(key) { if (options.readFail) throw Error('read unavailable'); return values[key] },
    setStorageSync(key, value) { if (options.writeFail) throw Error('quota'); values[key] = JSON.parse(JSON.stringify(value)) },
    showModal(config) { config.success({ confirm: options.confirm !== false }) }
  }
  global.wx = api
  let definition
  global.Page = value => { definition = value }
  delete require.cache[require.resolve('../pages/cato-social-followup/index')]
  require('../pages/cato-social-followup/index')
  delete global.Page
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(values) { Object.assign(this.data, values) } }
  page.onLoad()
  return { page, values, api }
}
const event = data => ({ currentTarget: { dataset: data } })

test('仅有两个合成身份和两个公开故事，非法身份与故事被拒绝', () => {
  const state = domain.createInitialState()
  assert.equal(domain.USERS.length, 2)
  assert.equal(domain.STORIES.length, 2)
  assert.throws(() => comment(state, { actor: 'real-user' }), /模拟身份/)
  assert.throws(() => comment(state, { storyId: 'private-story' }), /故事不存在/)
  assert.throws(() => comment(state, { actor: 'lin' }), /另一位/)
  assert.deepEqual(state, domain.createInitialState())
})

test('开场只填草稿；取消不会创建评论、通知或消息', () => {
  const { page } = pageHarness()
  const before = JSON.stringify(page._state)
  page.fillOpener()
  assert.ok(page.data.commentDraft.length)
  assert.equal(JSON.stringify(page._state), before)
  page.cancelComment()
  assert.equal(page.data.commentDraft, '')
  assert.equal(JSON.stringify(page._state), before)
  delete global.wx
})

test('明确评论和回复创建通知，通知准确定位故事、根评论和回复', () => {
  let { state, context } = setup()
  const first = state.notifications[0]
  assert.deepEqual(domain.resolveNotification(state, 'lin', first.id), { stage: 'story', storyId: 'window', commentId: context.commentId, focusId: state.comments[0].id })
  state = comment(state, { actor: 'lin', parentId: context.commentId, text: '是的，每天都来。', requestId: 'reply_1' })
  const reply = state.comments[1]
  const notice = state.notifications[1]
  assert.deepEqual(domain.resolveNotification(state, 'momo', notice.id), { stage: 'story', storyId: 'window', commentId: context.commentId, focusId: reply.id })
  assert.throws(() => domain.resolveNotification(state, 'lin', notice.id), /其他身份/)
  const next = domain.transition(state, { type: 'readNotification', actor: 'momo', id: notice.id })
  assert.equal(next.notifications[1].read, true)
  assert.equal(state.notifications[1].read, false)
})

test('评论和私信禁止空白、超长、错误类型，状态保持不变', () => {
  const { state, context } = setup()
  const before = JSON.stringify(state)
  for (const value of ['', '   ', '字'.repeat(301), 123, null]) {
    assert.throws(() => comment(state, { text: value, requestId: 'bad_comment' }), /1–300/)
    assert.throws(() => send(state, context, { text: value }), /1–300/)
  }
  assert.equal(JSON.stringify(state), before)
  assert.throws(() => send(state, context, { kind: 'IMAGE' }), /只允许文字/)
  assert.throws(() => send(state, context, { requestId: '../bad' }), /编号无效/)
})

test('消息与回复不能伪造、跨故事引用、引用嵌套回复或发送给自己', () => {
  let { state, context } = setup()
  assert.throws(() => send(state, { ...context, storyId: 'box' }), /不匹配/)
  assert.throws(() => send(state, { ...context, commentId: 'missing' }), /不匹配/)
  assert.throws(() => send(state, null), /先选择/)
  assert.throws(() => send(state, context, { peer: 'momo' }), /另一位/)
  assert.throws(() => comment(state, { storyId: 'box', parentId: context.commentId, requestId: 'wrong' }), /不匹配/)
  state = comment(state, { actor: 'lin', parentId: context.commentId, requestId: 'reply_1' })
  assert.throws(() => send(state, { ...context, commentId: state.comments[1].id }), /不匹配/)
})

test('一条招呼之后必须等另一身份明确回复，才解锁双方续聊', () => {
  let { state, context } = pending()
  assert.equal(domain.contactFor(state, 'momo').status, 'pending')
  assert.equal(domain.sendPermission(state, 'momo', context).allowed, false)
  assert.throws(() => send(state, context, { requestId: 'second_greeting' }), /等对方主动回复/)
  state = send(state, context, { actor: 'lin', peer: 'momo', text: '你好，可以呀。', requestId: 'reply_dm' })
  assert.equal(domain.contactFor(state, 'momo').status, 'open')
  state = send(state, context, { text: '谢谢！', requestId: 'continued' })
  assert.equal(state.messages.length, 3)
  assert.equal(state.messages[0].kind, 'TEXT')
  assert.deepEqual(state.messages[2].context, context)
})

test('公开回复不等于同意私信，不能提前解锁续聊', () => {
  let { state, context } = pending()
  state = comment(state, { actor: 'lin', parentId: context.commentId, requestId: 'public_reply' })
  assert.equal(domain.contactFor(state, 'momo').status, 'pending')
  assert.throws(() => send(state, context, { requestId: 'still_waiting' }), /等对方主动回复/)
})

test('首次联系关闭陌生人开关在 domain 拒绝；显式回复后正常续聊', () => {
  let { state, context } = setup()
  state = domain.transition(state, { type: 'settings', actor: 'lin', acceptStrangers: false })
  assert.throws(() => send(state, context), /关闭陌生人/)
  state = domain.transition(state, { type: 'settings', actor: 'lin', acceptStrangers: true })
  state = send(state, context)
  state = domain.transition(state, { type: 'settings', actor: 'lin', acceptStrangers: false })
  state = send(state, context, { actor: 'lin', peer: 'momo', requestId: 'consent' })
  state = send(state, context, { requestId: 'after_consent' })
  assert.equal(state.messages.length, 3)
})

test('忽略只有收件人可操作；忽略后双方发送均被阻止', () => {
  let { state, context } = pending()
  assert.throws(() => domain.transition(state, { type: 'ignore', actor: 'momo' }), /只有收件人/)
  state = domain.transition(state, { type: 'ignore', actor: 'lin' })
  assert.throws(() => send(state, context, { requestId: 'ignored_a' }), /忽略/)
  assert.throws(() => send(state, context, { actor: 'lin', peer: 'momo', requestId: 'ignored_b' }), /忽略/)
})

test('任一方拉黑会在 domain 阻止双方评论、消息与通知访问', () => {
  const original = pending()
  for (const blocker of ['momo', 'lin']) {
    const state = domain.transition(original.state, { type: 'block', actor: blocker, blocked: true })
    for (const actor of ['momo', 'lin']) {
      assert.throws(() => send(state, original.context, { actor, peer: domain.peerOf(actor), requestId: 'blocked_' + actor }), /拉黑/)
      assert.throws(() => comment(state, { actor, parentId: original.context.commentId, requestId: 'blocked_comment_' + actor }), /拉黑/)
    }
    assert.throws(() => domain.resolveNotification(state, 'lin', state.notifications[0].id), /拉黑/)
  }
})

test('删除消息、重载、解除拉黑都不能重置首次招呼权限', () => {
  let { state, context } = pending()
  state = domain.transition(state, { type: 'deleteHistory', actor: 'momo' })
  assert.ok(state.messages[0].hiddenFor.includes('momo'))
  assert.ok(!state.messages[0].hiddenFor.includes('lin'))
  state = domain.transition(state, { type: 'block', actor: 'lin', blocked: true })
  state = domain.transition(state, { type: 'block', actor: 'lin', blocked: false })
  state = JSON.parse(JSON.stringify(state))
  assert.throws(() => send(state, context, { requestId: 'delete_bypass' }), /等对方主动回复/)
  state = domain.transition(state, { type: 'ignore', actor: 'lin' })
  state = domain.transition(state, { type: 'deleteHistory', actor: 'lin' })
  assert.throws(() => send(state, context, { requestId: 'ignored_delete_bypass' }), /忽略/)
  assert.equal(state.requests.length, 2)
})

test('更换公开故事不能绕过许可账本；续聊也保留首次上下文', () => {
  let { state, context } = pending()
  state = comment(state, { actor: 'lin', storyId: 'box', text: '也喜欢纸箱。', requestId: 'other_story' })
  const other = { storyId: 'box', commentId: state.comments[1].id }
  assert.throws(() => send(state, other, { requestId: 'new_story_bypass' }), /等对方主动回复/)
  assert.throws(() => send(state, other, { actor: 'lin', peer: 'momo', requestId: 'wrong_consent' }), /最初/)
  state = send(state, context, { actor: 'lin', peer: 'momo', requestId: 'right_consent' })
  assert.throws(() => send(state, other, { requestId: 'wrong_continued' }), /最初/)
})

test('同编号发送幂等，不重复评论、招呼、回复或通知；内容冲突被拒绝', () => {
  const first = comment(domain.createInitialState())
  assert.deepEqual(comment(first), first)
  assert.throws(() => comment(first, { text: '不同内容' }), /重复发送编号/)
  const context = { storyId: 'window', commentId: first.comments[0].id }
  const state = send(first, context)
  assert.deepEqual(send(state, context), state)
  const reply = { actor: 'lin', peer: 'momo', requestId: 'reply' }
  const replied = send(state, context, reply)
  assert.deepEqual(send(replied, context, reply), replied)
  assert.equal(replied.messages.length, 2)
  assert.equal(replied.notifications.length, 3)
})

test('私信通知定位原故事和消息；删除后通知不能重新显示已删除消息', () => {
  let { state, context } = pending()
  const notice = state.notifications[1]
  assert.deepEqual(domain.resolveNotification(state, 'lin', notice.id), { stage: 'chat', storyId: context.storyId, commentId: context.commentId, focusId: state.messages[0].id })
  state = domain.transition(state, { type: 'deleteHistory', actor: 'lin' })
  assert.throws(() => domain.resolveNotification(state, 'lin', notice.id), /已删除/)
  assert.equal(domain.contactFor(state, 'lin').status, 'pending')
})

test('通知伪造故事或目标时拒绝，不静默跳到其他上下文', () => {
  const { state } = setup()
  const corrupted = JSON.parse(JSON.stringify(state))
  corrupted.notifications[0].storyId = 'box'
  assert.throws(() => domain.resolveNotification(corrupted, 'lin', corrupted.notifications[0].id), /不匹配/)
  corrupted.notifications[0].storyId = 'window'
  corrupted.notifications[0].targetId = 'missing'
  assert.throws(() => domain.resolveNotification(corrupted, 'lin', corrupted.notifications[0].id), /不匹配/)
})

test('页面评论保存失败保留草稿和状态；重试成功只保存一条', () => {
  const options = { writeFail: true }
  const { page, values } = pageHarness(options)
  page.fillOpener()
  const draft = page.data.commentDraft
  const requestId = page.draft('comment').requestId
  page.sendComment()
  assert.equal(page.data.commentDraft, draft)
  assert.equal(page.draft('comment').requestId, requestId)
  assert.equal(page._state.comments.length, 0)
  assert.match(page.data.error, /输入已保留/)
  options.writeFail = false
  page.sendComment()
  assert.equal(page.data.commentDraft, '')
  assert.equal(page._state.comments.length, 1)
  assert.deepEqual(Object.keys(values), ['catai_cato_lab_v1:social-followup:state'])
  delete global.wx
})

test('页面招呼保存失败不消耗许可；通知已读保存失败不丢定位或草稿', () => {
  const fixture = setup()
  const options = { values: { 'catai_cato_lab_v1:social-followup:state': fixture.state } }
  const { page } = pageHarness(options)
  page.selectComment(event({ root: fixture.context.commentId, id: fixture.context.commentId }))
  page.openChat()
  page.fillGreeting()
  options.writeFail = true
  page.sendMessage()
  assert.ok(page.data.messageDraft.length)
  assert.equal(page._state.messages.length, 0)
  assert.equal(page.data.permission.allowed, true)
  options.writeFail = false
  page.sendMessage()
  assert.equal(page._state.messages.length, 1)
  page.switchRole(event({ id: 'lin' }))
  page.switchStage(event({ stage: 'notices' }))
  options.writeFail = true
  page.openNotice(event({ id: page._state.notifications[1].id }))
  assert.equal(page.data.stage, 'notices')
  assert.equal(page._state.notifications[1].read, false)
  options.writeFail = false
  page.openNotice(event({ id: page._state.notifications[1].id }))
  assert.equal(page.data.stage, 'chat')
  assert.equal(page.data.focusId, page._state.messages[0].id)
  delete global.wx
})

test('页面完整双身份流程：评论、公开回复、招呼、模拟回复、续聊', () => {
  const { page } = pageHarness()
  page.fillOpener(); page.sendComment()
  const rootId = page._state.comments[0].id
  page.switchRole(event({ id: 'lin' }))
  page.openNotice(event({ id: page._state.notifications[0].id }))
  assert.equal(page.data.rootId, rootId)
  page.fillOpener(); page.sendComment()
  page.switchRole(event({ id: 'momo' }))
  page.openNotice(event({ id: page._state.notifications[1].id }))
  page.openChat(); page.fillGreeting(); page.sendMessage()
  assert.equal(page.data.permission.allowed, false)
  page.switchRole(event({ id: 'lin' }))
  page.openNotice(event({ id: page._state.notifications[2].id }))
  page.fillGreeting(); page.sendMessage()
  assert.equal(page.data.contact.status, 'open')
  page.switchRole(event({ id: 'momo' }))
  page.fillGreeting(); page.sendMessage()
  assert.equal(page._state.messages.length, 3)
  page.showSource()
  assert.equal(page.data.stage, 'story')
  assert.equal(page.data.focusId, rootId)
  delete global.wx
})

test('取消忽略或删除的确认框不改变会话，草稿按角色与上下文隔离', () => {
  const fixture = pending()
  const options = { confirm: false, values: { 'catai_cato_lab_v1:social-followup:state': fixture.state } }
  const { page } = pageHarness(options)
  page.switchStage(event({ stage: 'chat' }))
  page.fillGreeting()
  const draft = page.data.messageDraft
  const before = JSON.stringify(page._state)
  page.deleteHistory()
  page.switchRole(event({ id: 'lin' }))
  assert.equal(page.data.messageDraft, '')
  page.ignoreGreeting()
  assert.equal(JSON.stringify(page._state), before)
  page.switchRole(event({ id: 'momo' }))
  assert.equal(page.data.messageDraft, draft)
  delete global.wx
})

test('存储读取失败关闭写入口；状态损坏不覆盖为默认记录', () => {
  const { page, values } = pageHarness({ readFail: true })
  assert.equal(page.data.ready, false)
  assert.equal(page.commit({ type: 'settings', acceptStrangers: false }), false)
  assert.deepEqual(values, {})
  const corrupt = { 'catai_cato_lab_v1:social-followup:state': { version: 99 } }
  const result = pageHarness({ values: corrupt })
  assert.equal(result.page.data.ready, false)
  assert.deepEqual(corrupt, { 'catai_cato_lab_v1:social-followup:state': { version: 99 } })
  delete global.wx
})

test('存储驱动失败明确抛错且不写原有私人命名空间', () => {
  const values = { catai_mini_pets_v1: ['private'] }
  const driver = { getStorageSync: key => values[key], setStorageSync() { throw Error('quota') } }
  const store = createStore('social-followup', driver)
  assert.throws(() => store.save('state', domain.createInitialState()), /quota/)
  assert.deepEqual(values, { catai_mini_pets_v1: ['private'] })
})

test('新页面所有 WXML 事件均有处理器；页面不引入云或真实社交适配器', () => {
  const folder = path.resolve(__dirname, '../pages/cato-social-followup')
  const source = fs.readFileSync(path.join(folder, 'index.js'), 'utf8')
  const markup = fs.readFileSync(path.join(folder, 'index.wxml'), 'utf8')
  const { page } = pageHarness()
  for (const match of markup.matchAll(/bind(?:tap|input)="([^"]+)"/g)) assert.equal(typeof page[match[1]], 'function', match[1])
  assert.doesNotMatch(source, /wx\.(cloud|request|connectSocket|uploadFile)|services\/(community|social)|readLocalCatCards/)
  assert.doesNotMatch(markup, /&amp;&amp;/)
  assert.match(markup, /离线 · 本机模拟/)
  assert.equal(require('../config/cato-lab').variant, 'social-followup')
  delete global.wx
})
