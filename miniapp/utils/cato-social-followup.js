'use strict'

// Pure, synthetic two-role rehearsal. No network, wx, real accounts or private data.
const USERS = [{ id: 'momo', name: '桃桃（模拟）' }, { id: 'lin', name: '小林（模拟）' }]
const STORIES = [
  { id: 'window', author: 'lin', title: '奶盖的窗边十分钟', text: '今天把小凳子挪到窗边，奶盖盯着树影看了好久。你家猫也有固定的发呆位置吗？' },
  { id: 'box', author: 'momo', title: '团子的纸箱选择', text: '新猫窝没被选中，快递纸箱倒成了团子的午睡基地。准备给它留一个安静的小角落。' }
]
const copy = value => JSON.parse(JSON.stringify(value))
function fail(message) { throw new Error(message) }
function user(id) { return USERS.find(item => item.id === id) || fail('只允许两个模拟身份操作。') }
function story(id) { return STORIES.find(item => item.id === id) || fail('公开示例故事不存在。') }
function peerOf(actor) { user(actor); return USERS.find(item => item.id !== actor).id }
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 300) fail('请输入 1–300 字的文字。')
  return value.trim()
}
function pair(a, b) { user(a); user(b); if (a === b) fail('不能向自己发招呼。'); return [a, b].sort().join(':') }
function blocked(state, a, b) { return state.settings[a].blocked || state.settings[b].blocked }
function createInitialState() {
  return { version: 1, sequence: 0, settings: { momo: { acceptStrangers: true, blocked: false }, lin: { acceptStrangers: true, blocked: false } }, comments: [], messages: [], contacts: {}, notifications: [], requests: [] }
}
function validateState(state) {
  if (!state || state.version !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !state.contacts || typeof state.contacts !== 'object') fail('本地实验记录格式不兼容，请回审计入口重置本实验。')
  for (const key of ['comments', 'messages', 'notifications', 'requests']) if (!Array.isArray(state[key])) fail('本地实验记录不完整，请回审计入口重置。')
  USERS.forEach(item => {
    const settings = state.settings && state.settings[item.id]
    if (!settings || typeof settings.acceptStrangers !== 'boolean' || typeof settings.blocked !== 'boolean') fail('本地实验设置不完整，请回审计入口重置。')
  })
  return state
}
function contextFor(state, actor, reference) {
  user(actor)
  if (!reference || typeof reference !== 'object') fail('请先选择一条公开评论作为上下文。')
  const post = story(reference.storyId)
  const root = state.comments.find(item => item.id === reference.commentId)
  if (!root || root.storyId !== post.id || root.parentId || root.author === post.author) fail('评论与故事上下文不匹配。')
  const participants = [root.author, post.author]
  if (!participants.includes(actor)) fail('不能使用他人的评论上下文。')
  return { storyId: post.id, commentId: root.id, peer: participants.find(id => id !== actor), title: post.title, text: root.text }
}
function contactFor(state, actor) { return state.contacts[pair(actor, peerOf(actor))] || null }
function sendPermission(state, actor, reference) {
  const peer = peerOf(actor)
  if (blocked(state, actor, peer)) return { allowed: false, label: '双方存在拉黑设置，不能发送。' }
  const contact = contactFor(state, actor)
  if (contact && contact.status === 'ignored') return { allowed: false, label: '这条招呼已被忽略，不能继续发送。' }
  if (contact && contact.status === 'pending' && contact.initiator === actor) return { allowed: false, label: '已发送一条招呼，等对方主动回复后才能继续。' }
  if (!contact && !state.settings[peer].acceptStrangers) return { allowed: false, label: '对方已关闭陌生人招呼。' }
  try {
    const context = contextFor(state, actor, reference)
    if (contact && (contact.context.storyId !== context.storyId || contact.context.commentId !== context.commentId)) return { allowed: false, label: '请从最初的公开评论上下文继续。' }
  } catch (error) { return { allowed: false, label: error.message } }
  return { allowed: true, label: contact ? (contact.status === 'open' ? '双方已互相回应，可以继续文字聊天。' : '你可以回复；回复后才会开放双方续聊。') : '仅能发一条文字招呼，对方回复前不能追加。' }
}
function nextId(state, prefix) { state.sequence += 1; return prefix + '-' + state.sequence }
function notify(state, recipient, actor, kind, targetId, reference) {
  state.notifications.push({ id: nextId(state, 'notice'), recipient, actor, kind, targetId, storyId: reference.storyId, commentId: reference.commentId, read: false })
}
function resolveNotification(state, actor, id) {
  user(actor)
  const notice = state.notifications.find(item => item.id === id)
  if (!notice || notice.recipient !== actor) fail('不能查看其他身份的本地通知。')
  if (blocked(state, actor, notice.actor)) fail('双方存在拉黑设置，这条通知暂不可打开。')
  const context = contextFor(state, actor, notice)
  if (notice.kind === 'message') {
    const message = state.messages.find(item => item.id === notice.targetId)
    if (!message || message.recipient !== actor || message.hiddenFor.includes(actor)) fail('这条本地消息已删除；招呼许可仍保留。')
    if (message.context.storyId !== context.storyId || message.context.commentId !== context.commentId) fail('消息通知的上下文不匹配。')
    return { stage: 'chat', storyId: context.storyId, commentId: context.commentId, focusId: message.id }
  }
  const comment = state.comments.find(item => item.id === notice.targetId)
  if (!comment || comment.storyId !== context.storyId || (comment.parentId || comment.id) !== context.commentId) fail('评论通知的目标不匹配。')
  return { stage: 'story', storyId: context.storyId, commentId: context.commentId, focusId: comment.id }
}
function transition(original, action) {
  validateState(original)
  if (!action || typeof action !== 'object') fail('操作无效。')
  const actor = action.actor
  user(actor)
  const isSend = action.type === 'comment' || action.type === 'message'
  let fingerprint
  if (isSend) {
    if (typeof action.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(action.requestId)) fail('发送编号无效，请重新编辑文字。')
    fingerprint = JSON.stringify({ type: action.type, storyId: action.storyId, parentId: action.parentId || '', peer: action.peer, context: action.context, kind: action.kind, text: action.text })
    const previous = original.requests.find(item => item.actor === actor && item.id === action.requestId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('重复发送编号不能用于不同内容。')
      return copy(original)
    }
    if (original.requests.length >= 500) fail('本地演示已达 500 次发送上限，请结束审计或重置实验。')
  }
  const state = copy(original)
  const peer = peerOf(actor)
  if (action.type === 'comment') {
    const post = story(action.storyId)
    const value = text(action.text)
    if (blocked(state, actor, peer)) fail('双方存在拉黑设置，不能发送评论或回复。')
    let root = null
    if (action.parentId) {
      root = state.comments.find(item => item.id === action.parentId)
      if (!root || root.parentId || root.storyId !== post.id) fail('回复目标与当前故事不匹配。')
      contextFor(state, actor, { storyId: post.id, commentId: root.id })
    } else if (post.author === actor) fail('请选择另一位模拟猫友的故事来开始交流。')
    const comment = { id: nextId(state, 'comment'), author: actor, storyId: post.id, parentId: root ? root.id : '', text: value }
    state.comments.push(comment)
    notify(state, peer, actor, root ? 'reply' : 'comment', comment.id, { storyId: post.id, commentId: root ? root.id : comment.id })
  } else if (action.type === 'message') {
    if (action.kind !== 'TEXT') fail('本实验只允许文字招呼，不支持图片或其他消息。')
    if (action.peer !== peer) fail('招呼只能发给当前上下文中的另一位模拟身份。')
    const value = text(action.text)
    const permission = sendPermission(state, actor, action.context)
    if (!permission.allowed) fail(permission.label)
    const context = contextFor(state, actor, action.context)
    if (context.peer !== action.peer) fail('收件人与公开上下文不匹配。')
    const key = pair(actor, peer)
    const reference = { storyId: context.storyId, commentId: context.commentId }
    if (!state.contacts[key]) state.contacts[key] = { initiator: actor, recipient: peer, status: 'pending', context: reference }
    else if (state.contacts[key].status === 'pending') state.contacts[key].status = 'open'
    const message = { id: nextId(state, 'message'), author: actor, recipient: peer, kind: 'TEXT', text: value, context: reference, hiddenFor: [] }
    state.messages.push(message)
    notify(state, peer, actor, 'message', message.id, reference)
  } else if (action.type === 'settings') {
    if (typeof action.acceptStrangers !== 'boolean') fail('陌生人设置无效。')
    state.settings[actor].acceptStrangers = action.acceptStrangers
  } else if (action.type === 'block') {
    if (typeof action.blocked !== 'boolean') fail('拉黑设置无效。')
    state.settings[actor].blocked = action.blocked
  } else if (action.type === 'ignore') {
    const contact = contactFor(state, actor)
    if (!contact || contact.status !== 'pending' || contact.recipient !== actor) fail('只有收件人可以忽略尚未回复的招呼。')
    contact.status = 'ignored'
  } else if (action.type === 'deleteHistory') {
    if (!contactFor(state, actor)) fail('还没有本地会话记录。')
    state.messages.forEach(message => { if (!message.hiddenFor.includes(actor)) message.hiddenFor.push(actor) })
    // Never remove contacts or requests: deleting history cannot grant another greeting.
  } else if (action.type === 'readNotification') {
    resolveNotification(state, actor, action.id)
    state.notifications.find(item => item.id === action.id).read = true
  } else fail('不支持的实验操作。')
  if (isSend) state.requests.push({ id: action.requestId, actor, fingerprint })
  return state
}
module.exports = { USERS, STORIES, createInitialState, validateState, transition, contextFor, contactFor, sendPermission, resolveNotification, peerOf }
