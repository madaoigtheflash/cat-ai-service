'use strict'

// Shared pure domain. No wx, filesystem, network, crypto or Node-only dependencies.
const MUTATIONS = ['postCreate', 'commentCreate', 'postLike', 'userFollow', 'roomCreate', 'roomRequestJoin', 'roomApproveJoin', 'roomInvite', 'roomJoin', 'roomLeave', 'messageSend', 'conversationIgnore', 'conversationDelete', 'userBlock', 'profileUpdate', 'notificationRead', 'reportCreate']
const READS = ['snapshot', 'postDetail', 'roomDetail', 'conversationDetail', 'profileDetail', 'catDetail']
const clone = value => JSON.parse(JSON.stringify(value))
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
function fail(code, message) { const error = new Error(message); error.code = code; throw error }
function text(value, max, required) {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string') fail('INVALID_INPUT', '请输入文字内容')
  value = value.trim()
  if ((required && !value) || value.length > max) fail('INVALID_INPUT', '文字为空或超出长度限制')
  return value
}
function truth(value) { if (typeof value !== 'boolean') fail('INVALID_INPUT', '状态必须为布尔值'); return value }
function find(rows, id, kind) { const row = rows.find(item => item.id === id); if (!row) fail('NOT_FOUND', kind || '内容不存在'); return row }
function publicUser(user) { return { id: user.id, nickname: user.nickname, bio: user.bio, avatar: user.avatar } }
function member(room, actor) { return room.memberIds.includes(actor) }
function blocked(state, a, b) { return state.blocks.some(row => (row.actorId === a && row.userId === b) || (row.actorId === b && row.userId === a)) }
function canPost(state, actor, post) { return post.scope === 'public' || member(find(state.rooms, post.roomId), actor) }
function readablePost(state, actor, id) { const post = find(state.posts, id); if (!canPost(state, actor, post)) fail('FORBIDDEN', '你已无权查看这条讨论'); return post }
function accessibleRoom(state, actor, id, requireMember) {
  const room = find(state.rooms, id)
  if (room.archived || !room.memberIds.length) fail('ROOM_CLOSED', '这个小屋已关闭')
  if ((!member(room, actor) && room.visibility !== 'public') || (requireMember && !member(room, actor))) fail('FORBIDDEN', '小屋讨论仅成员可见')
  return room
}
function conversation(state, a, b) { return a === b ? undefined : state.conversations.find(row => row.participantIds.includes(a) && row.participantIds.includes(b)) }
function paged(rows, input) {
  const cursor = input.cursor === undefined || input.cursor === '' ? 0 : Number(input.cursor)
  const limit = input.limit === undefined ? 30 : Number(input.limit)
  if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) fail('INVALID_INPUT', '分页参数不合法')
  return { items: rows.slice(cursor, cursor + limit), nextCursor: cursor + limit < rows.length ? String(cursor + limit) : null, total: rows.length }
}
function nextId(state, prefix) { state.sequence += 1; return prefix + '-' + state.sequence }
function notify(state, recipientId, actorId, kind, targetId, now, postId) {
  if (recipientId === actorId || blocked(state, recipientId, actorId)) return
  state.notifications.push({ id: nextId(state, 'notice'), recipientId, actorId, kind, targetId, postId: postId || '', createdAt: now, read: false })
}
function enrichedComment(state, comment) { return Object.assign({}, comment, { author: publicUser(find(state.users, comment.authorId)) }) }
function enrichedPost(state, actor, post, full) {
  const comments = state.comments.filter(row => row.postId === post.id)
  return Object.assign({}, post, {
    author: publicUser(find(state.users, post.authorId)),
    cat: state.cats.find(row => row.id === post.catId && row.public) || null,
    room: post.roomId ? { id: post.roomId, name: find(state.rooms, post.roomId).name } : null,
    comments: (full ? comments : comments.slice(-2)).map(row => enrichedComment(state, row)),
    commentCount: comments.length,
    liked: state.likes.some(row => row.actorId === actor && row.postId === post.id)
  })
}
function roomView(state, actor, room, detail) {
  const joined = member(room, actor)
  return {
    id: room.id, name: room.name, description: room.description, visibility: room.visibility,
    ownerId: room.ownerId, joined, memberCount: room.memberIds.length,
    members: joined ? room.memberIds.map(id => publicUser(find(state.users, id))) : [],
    memberIds: joined ? room.memberIds.slice() : [],
    pending: joined && room.ownerId === actor ? room.pendingIds.map(id => publicUser(find(state.users, id))) : [],
    requested: room.pendingIds.includes(actor),
    cats: joined ? state.cats.filter(cat => room.catIds.includes(cat.id)) : [],
    posts: joined && detail ? state.posts.filter(post => post.roomId === room.id).slice().reverse().map(post => enrichedPost(state, actor, post, false)) : []
  }
}
function conversationView(state, actor, row) {
  const peerId = row.participantIds.find(id => id !== actor)
  const peer = find(state.users, peerId)
  const isBlocked = blocked(state, actor, peerId)
  const waiting = row.status === 'pending' && row.initiatorId === actor
  return {
    id: row.id, peerId, peer: publicUser(peer), status: row.status, waiting,
    blocked: isBlocked, ignored: row.ignoredBy.includes(actor),
    canSend: !isBlocked && !waiting,
    messages: row.messages.map(message => {
      const referenced = state.posts.find(post => post.id === message.referencePostId)
      const reference = referenced && canPost(state, actor, referenced) && canPost(state, peerId, referenced)
        ? { id: referenced.id, text: referenced.text, photos: referenced.photos.slice(0, 1) } : null
      return Object.assign({}, message, { reference, referencePostId: reference ? referenced.id : '' })
    })
  }
}
function noticeView(state, actor, notice) {
  let available = true
  if (notice.postId) {
    const post = state.posts.find(row => row.id === notice.postId)
    available = !!post && canPost(state, actor, post)
  }
  if (notice.kind === 'roomRequest' || notice.kind === 'roomApproved') {
    const room = state.rooms.find(row => row.id === notice.targetId)
    available = !!room && member(room, actor)
  }
  return Object.assign({}, notice, { actor: publicUser(find(state.users, notice.actorId)), available,
    targetId: available ? notice.targetId : '', postId: available ? notice.postId : '' })
}
function snapshot(state, actor, input) {
  input = input || {}
  const me = find(state.users, actor)
  const follows = state.follows.filter(row => row.actorId === actor).map(row => row.userId)
  const readable = state.posts.filter(post => canPost(state, actor, post)).slice().reverse()
  const feedPage = paged(readable.filter(post => post.scope === 'public' && (input.feed !== 'following' || follows.includes(post.authorId))), input)
  return {
    schemaVersion: state.schemaVersion, revision: state.revision, mode: state.mode,
    me: Object.assign(publicUser(me), { allowStrangers: me.allowStrangers, blockedUserIds: state.blocks.filter(row => row.actorId === actor).map(row => row.userId) }),
    users: state.users.map(publicUser), cats: state.cats.filter(cat => cat.public),
    posts: readable.slice(0, 100).map(post => enrichedPost(state, actor, post, false)),
    feed: feedPage.items.map(post => enrichedPost(state, actor, post, false)), nextCursor: feedPage.nextCursor,
    rooms: state.rooms.filter(room => !room.archived && room.memberIds.length && (room.visibility === 'public' || member(room, actor))).map(room => roomView(state, actor, room, false)),
    conversations: state.conversations.filter(row => row.participantIds.includes(actor) && !row.deletedBy.includes(actor) && !row.ignoredBy.includes(actor)).map(row => conversationView(state, actor, row)),
    notifications: state.notifications.filter(row => row.recipientId === actor).slice(-100).reverse().map(row => noticeView(state, actor, row)),
    follows, likedPostIds: state.likes.filter(row => row.actorId === actor && readable.some(post => post.id === row.postId)).map(row => row.postId)
  }
}
function createInitialState(options) {
  options = options || {}
  const now = options.now === undefined ? 1780000000000 : Number(options.now)
  if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_INPUT', '时间参数不合法')
  const state = { schemaVersion: 1, revision: 0, sequence: 20, mode: options.production ? 'production' : 'demo', users: [], cats: [], posts: [], comments: [], rooms: [], conversations: [], notifications: [], reports: [], follows: [], likes: [], blocks: [], invites: [], requests: [] }
  if (options.production) return state
  state.users = [
    { id: 'A', nickname: '小禾', bio: '没有养猫，也喜欢听猫咪的故事。', avatar: 'A', allowStrangers: true },
    { id: 'B', nickname: '阿桃', bio: '常在窗边遇见奶油和栗子。', avatar: 'B', allowStrangers: true }
  ]
  state.cats = [
    { id: 'cream', name: '奶油', description: '窗边常客，喜欢找暖和的位置。', public: true, photo: '/assets/cats/sunny-cuddle.jpg' },
    { id: 'chestnut', name: '栗子', description: '一起出现在猫友主动分享的故事里。', public: true, photo: '/assets/cats/sunny-cuddle.jpg' }
  ]
  state.rooms = [
    { id: 'window-room', name: '窗边猫友小屋', description: '聊聊今天遇到的小可爱。', visibility: 'public', ownerId: 'B', memberIds: ['A', 'B'], pendingIds: [], catIds: ['cream', 'chestnut'], createdAt: now },
    { id: 'garden-room', name: '花园散步小屋', description: '公开简介，讨论只对成员开放。', visibility: 'public', ownerId: 'B', memberIds: ['B'], pendingIds: [], catIds: [], createdAt: now },
    { id: 'invite-room', name: '晚安猫咪小屋', description: '只邀请熟悉的猫友。', visibility: 'invite', ownerId: 'B', memberIds: ['B'], pendingIds: [], catIds: [], createdAt: now }
  ]
  state.posts = [
    { id: 'post-windowsill', authorId: 'B', text: '午后的座位，被这两位占满了。', photos: ['/assets/cats/sunny-cuddle.jpg'], scope: 'public', roomId: '', catId: 'cream', topic: '窗边的小事', createdAt: now },
    { id: 'post-room', authorId: 'A', text: '奶油今天也来晒太阳了吗？', photos: ['/assets/cats/sunny-cuddle.jpg'], scope: 'room', roomId: 'window-room', catId: 'cream', topic: '', createdAt: now + 1 },
    { id: 'post-private', authorId: 'B', text: '仅邀请小屋里的晚安故事。', photos: [], scope: 'room', roomId: 'invite-room', catId: '', topic: '', createdAt: now + 2 }
  ]
  state.comments = [
    { id: 'comment-1', postId: 'post-windowsill', authorId: 'A', text: '它们一直这么黏吗？', parentId: '', createdAt: now + 3 },
    { id: 'comment-2', postId: 'post-windowsill', authorId: 'B', text: '今天第一次睡这么近。', parentId: 'comment-1', createdAt: now + 4 }
  ]
  return state
}
function ensureActor(state, actorId) { return find(state.users, actorId, '请先登录') }
function registerActor(state, actorId) {
  if (!state.users.some(user => user.id === actorId)) state.users.push({ id: actorId, nickname: '猫友', bio: '', avatar: '', allowStrangers: true })
  return state
}
function read(state, actor, action, input) {
  if (action === 'snapshot') return snapshot(state, actor, input)
  if (action === 'postDetail') return enrichedPost(state, actor, readablePost(state, actor, input.postId), true)
  if (action === 'roomDetail') return roomView(state, actor, accessibleRoom(state, actor, input.roomId, false), true)
  if (action === 'profileDetail') {
    const user = find(state.users, input.userId)
    return Object.assign(publicUser(user), { followed: state.follows.some(row => row.actorId === actor && row.userId === user.id), blocked: blocked(state, actor, user.id), posts: state.posts.filter(post => post.authorId === user.id && post.scope === 'public').slice().reverse().map(post => enrichedPost(state, actor, post, false)) })
  }
  if (action === 'catDetail') {
    const cat = find(state.cats, input.catId)
    if (!cat.public) fail('FORBIDDEN', '猫咪名片未公开')
    return Object.assign({}, cat, { posts: state.posts.filter(post => post.catId === cat.id && post.scope === 'public').map(post => enrichedPost(state, actor, post, false)) })
  }
  if (action === 'conversationDetail') {
    const peer = find(state.users, input.peerId)
    if (peer.id === actor) fail('INVALID_INPUT', '不能向自己发私信')
    const row = conversation(state, actor, peer.id)
    if (row) return conversationView(state, actor, row)
    return { id: '', peerId: peer.id, peer: publicUser(peer), status: 'new', waiting: false, blocked: blocked(state, actor, peer.id), canSend: peer.allowStrangers && !blocked(state, actor, peer.id), messages: [] }
  }
  fail('UNKNOWN_ACTION', '不支持的操作')
}
function mutate(state, actor, action, input, now) {
  if (action === 'postCreate') {
    const value = text(input.text, 2000, true)
    if (!['public', 'room'].includes(input.scope)) fail('INVALID_SCOPE', '请明确选择公开广场或仅小屋成员可见')
    const photos = input.photos === undefined ? [] : input.photos
    if (!Array.isArray(photos) || photos.length > 3 || photos.some(photo => typeof photo !== 'string' || photo.length > 1024 || !(/^(cloud:\/\/|\/assets\/|wxfile:\/\/|https?:\/\/(tmp|usr)\/)/.test(photo)))) fail('INVALID_PHOTOS', '最多选择三张合法照片')
    if (input.scope === 'room') accessibleRoom(state, actor, input.roomId, true)
    if (input.scope === 'public' && input.roomId) fail('INVALID_SCOPE', '小屋内容不会自动同步到广场')
    if (input.catId && !find(state.cats, input.catId).public) fail('FORBIDDEN', '私人猫咪档案不能直接公开')
    const post = { id: nextId(state, 'post'), authorId: actor, text: value, photos: photos.slice(), scope: input.scope, roomId: input.scope === 'room' ? input.roomId : '', catId: input.catId || '', topic: text(input.topic, 40), createdAt: now }
    state.posts.push(post); return post
  }
  if (action === 'commentCreate') {
    const post = readablePost(state, actor, input.postId)
    if (blocked(state, actor, post.authorId)) fail('BLOCKED', '拉黑关系下不能继续互动')
    const parent = input.parentId ? find(state.comments, input.parentId) : null
    if (parent && parent.postId !== post.id) fail('INVALID_INPUT', '回复必须属于当前动态')
    if (parent && blocked(state, actor, parent.authorId)) fail('BLOCKED', '拉黑关系下不能继续互动')
    const comment = { id: nextId(state, 'comment'), postId: post.id, authorId: actor, text: text(input.text, 500, true), parentId: parent ? parent.id : '', createdAt: now }
    state.comments.push(comment)
    const recipients = [post.authorId]; if (parent && !recipients.includes(parent.authorId)) recipients.push(parent.authorId)
    recipients.forEach(id => notify(state, id, actor, 'comment', comment.id, now, post.id))
    return comment
  }
  if (action === 'postLike') {
    const post = readablePost(state, actor, input.postId); const liked = truth(input.liked)
    if (blocked(state, actor, post.authorId)) fail('BLOCKED', '拉黑关系下不能继续互动')
    const index = state.likes.findIndex(row => row.actorId === actor && row.postId === post.id)
    if (liked && index < 0) state.likes.push({ actorId: actor, postId: post.id })
    if (!liked && index >= 0) state.likes.splice(index, 1)
    return { postId: post.id, liked }
  }
  if (action === 'userFollow') {
    const user = find(state.users, input.userId); const followed = truth(input.followed)
    if (user.id === actor) fail('INVALID_INPUT', '无需关注自己')
    if (blocked(state, actor, user.id)) fail('BLOCKED', '拉黑关系下不能关注')
    const index = state.follows.findIndex(row => row.actorId === actor && row.userId === user.id)
    if (followed && index < 0) state.follows.push({ actorId: actor, userId: user.id })
    if (!followed && index >= 0) state.follows.splice(index, 1)
    return { userId: user.id, followed }
  }
  if (action === 'roomCreate') {
    if (!['public', 'invite'].includes(input.visibility)) fail('INVALID_INPUT', '请选择公开简介或邀请制')
    const room = { id: nextId(state, 'room'), name: text(input.name, 40, true), description: text(input.description, 200), visibility: input.visibility, ownerId: actor, memberIds: [actor], pendingIds: [], catIds: [], createdAt: now }
    state.rooms.push(room); return roomView(state, actor, room, true)
  }
  if (action === 'roomRequestJoin') {
    const room = accessibleRoom(state, actor, input.roomId, false)
    if (room.visibility !== 'public') fail('FORBIDDEN', '邀请制小屋需要邀请码')
    if (!member(room, actor) && !room.pendingIds.includes(actor)) { room.pendingIds.push(actor); notify(state, room.ownerId, actor, 'roomRequest', room.id, now) }
    return roomView(state, actor, room, false)
  }
  if (action === 'roomApproveJoin') {
    const room = accessibleRoom(state, actor, input.roomId, true)
    if (room.ownerId !== actor) fail('FORBIDDEN', '仅小屋创建者可处理申请')
    find(state.users, input.userId)
    if (!room.pendingIds.includes(input.userId)) fail('NOT_FOUND', '加入申请不存在')
    room.pendingIds = room.pendingIds.filter(id => id !== input.userId)
    if (!member(room, input.userId)) room.memberIds.push(input.userId)
    notify(state, input.userId, actor, 'roomApproved', room.id, now)
    return roomView(state, actor, room, true)
  }
  if (action === 'roomInvite') {
    const room = accessibleRoom(state, actor, input.roomId, true)
    if (room.ownerId !== actor) fail('FORBIDDEN', '仅小屋创建者可生成邀请')
    const invite = { id: nextId(state, 'invite'), roomId: room.id, creatorId: actor, code: input.serverInviteCode || ('DEMO-' + state.sequence + '-' + now), expiresAt: now + 86400000 }
    if (state.mode === 'production' && !input.serverInviteCode) fail('INVALID_INPUT', '缺少服务端邀请凭证')
    state.invites.push(invite); return { roomId: room.id, inviteCode: invite.code, expiresAt: invite.expiresAt }
  }
  if (action === 'roomJoin') {
    const invite = state.invites.find(row => row.code === text(input.inviteCode, 100, true))
    if (!invite || invite.expiresAt <= now) fail('INVALID_INVITE', '邀请已失效或不存在')
    const room = find(state.rooms, invite.roomId)
    if (room.archived || !room.memberIds.length) fail('ROOM_CLOSED', '这个小屋已关闭')
    if (!member(room, invite.creatorId)) fail('INVALID_INVITE', '邀请者已退出小屋')
    if (!member(room, actor)) room.memberIds.push(actor)
    room.pendingIds = room.pendingIds.filter(id => id !== actor)
    return roomView(state, actor, room, true)
  }
  if (action === 'roomLeave') {
    const room = accessibleRoom(state, actor, input.roomId, true)
    if (room.ownerId === actor && room.memberIds.length > 1) room.ownerId = room.memberIds.find(id => id !== actor)
    room.memberIds = room.memberIds.filter(id => id !== actor)
    room.pendingIds = room.pendingIds.filter(id => id !== actor)
    if (!room.memberIds.length) { room.archived = true; room.ownerId = ''; room.pendingIds = [] }
    state.invites = state.invites.filter(invite => invite.roomId !== room.id || invite.creatorId !== actor)
    return { roomId: room.id, left: true }
  }
  if (action === 'messageSend') {
    const peer = find(state.users, input.peerId)
    if (peer.id === actor) fail('INVALID_INPUT', '不能向自己发私信')
    if (blocked(state, actor, peer.id)) fail('BLOCKED', '拉黑后不能继续联系')
    if (input.photos || input.location || input.file || input.type && input.type !== 'text') fail('TEXT_ONLY', '私信仅支持文字')
    const value = text(input.text, 1000, true)
    if (input.referencePostId) { readablePost(state, actor, input.referencePostId); readablePost(state, peer.id, input.referencePostId) }
    let row = conversation(state, actor, peer.id)
    if (!row) {
      if (!peer.allowStrangers) fail('STRANGERS_DISABLED', '对方已关闭陌生人招呼')
      row = { id: nextId(state, 'conversation'), participantIds: [actor, peer.id], initiatorId: actor, status: 'pending', messages: [], ignoredBy: [], deletedBy: [], createdAt: now }
      state.conversations.push(row)
    } else if (row.status === 'pending' && row.initiatorId === actor) fail('WAITING_REPLY', '请等待对方回复后再继续聊天')
    else if (row.status === 'pending') row.status = 'open'
    if (row.messages.length >= 500) fail('LIMIT_REACHED', '演示会话已达到容量限制')
    const message = { id: nextId(state, 'message'), authorId: actor, text: value, referencePostId: input.referencePostId || '', createdAt: now }
    row.messages.push(message); row.deletedBy = []; row.ignoredBy = row.ignoredBy.filter(id => id !== actor)
    notify(state, peer.id, actor, 'message', row.id, now)
    return conversationView(state, actor, row)
  }
  if (action === 'conversationIgnore' || action === 'conversationDelete') {
    const row = conversation(state, actor, input.peerId)
    if (!row) fail('NOT_FOUND', '会话不存在')
    const key = action === 'conversationIgnore' ? 'ignoredBy' : 'deletedBy'
    if (!row[key].includes(actor)) row[key].push(actor)
    return { peerId: input.peerId, hidden: true }
  }
  if (action === 'userBlock') {
    const user = find(state.users, input.userId); const value = truth(input.blocked)
    if (user.id === actor) fail('INVALID_INPUT', '不能拉黑自己')
    state.blocks = state.blocks.filter(row => !(row.actorId === actor && row.userId === user.id))
    if (value) {
      state.blocks.push({ actorId: actor, userId: user.id })
      state.follows = state.follows.filter(row => !(row.actorId === actor && row.userId === user.id) && !(row.actorId === user.id && row.userId === actor))
    }
    return { userId: user.id, blocked: value }
  }
  if (action === 'profileUpdate') {
    const me = find(state.users, actor)
    if (input.nickname !== undefined) me.nickname = text(input.nickname, 30, true)
    if (input.bio !== undefined) me.bio = text(input.bio, 200)
    if (input.allowStrangers !== undefined) me.allowStrangers = truth(input.allowStrangers)
    return publicUser(me)
  }
  if (action === 'notificationRead') {
    const notice = find(state.notifications, input.notificationId)
    if (notice.recipientId !== actor) fail('FORBIDDEN', '不能读取他人提醒')
    notice.read = true; return noticeView(state, actor, notice)
  }
  if (action === 'reportCreate') {
    if (!['post', 'comment', 'user', 'message'].includes(input.targetType)) fail('INVALID_INPUT', '举报类型不合法')
    if (input.targetType === 'post') readablePost(state, actor, input.targetId)
    if (input.targetType === 'comment') readablePost(state, actor, find(state.comments, input.targetId).postId)
    if (input.targetType === 'user') find(state.users, input.targetId)
    if (input.targetType === 'message' && !state.conversations.some(row => row.participantIds.includes(actor) && row.messages.some(message => message.id === input.targetId))) fail('FORBIDDEN', '不能举报无权查看的私信')
    const report = { id: nextId(state, 'report'), actorId: actor, targetType: input.targetType, targetId: input.targetId, reason: text(input.reason, 500, true), status: state.mode === 'demo' ? 'demo-recorded' : 'pending', createdAt: now }
    state.reports.push(report); return { id: report.id, status: report.status, message: state.mode === 'demo' ? '演示举报已记录，不会发给真实处理人员' : '举报已记录' }
  }
  fail('UNKNOWN_ACTION', '不支持的操作')
}
function execute(original, actorId, action, input, now) {
  input = input || {}; now = now === undefined ? Date.now() : Number(now)
  if (Object.prototype.toString.call(input) !== '[object Object]' || ['__proto__', 'constructor', 'prototype'].some(key => Object.prototype.hasOwnProperty.call(input, key))) fail('INVALID_INPUT', '参数格式错误')
  input = Object.assign({}, input) // Ignore inherited fields, including across VM realms.
  if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_INPUT', '时间参数不合法')
  ensureActor(original, actorId)
  if (READS.includes(action)) return { state: original, result: read(original, actorId, action, input) }
  if (!MUTATIONS.includes(action)) fail('UNKNOWN_ACTION', '不支持的操作')
  const requestId = text(input.requestId, 100, true)
  const fingerprintInput = Object.assign({}, input); delete fingerprintInput.requestId; delete fingerprintInput.serverInviteCode
  const fingerprint = action + ':' + stable(fingerprintInput)
  const prior = original.requests.find(row => row.actorId === actorId && row.requestId === requestId)
  if (prior) {
    if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '相同请求编号不能用于不同操作')
    // Re-resolve ACL rather than replaying private content after membership changes.
    if (action === 'roomInvite') {
      const room = accessibleRoom(original, actorId, input.roomId, true)
      if (room.ownerId !== actorId) fail('FORBIDDEN', '仅小屋创建者可生成邀请')
      const invite = original.invites.find(row => row.id === prior.inviteId)
      if (!invite || invite.expiresAt <= now) fail('INVALID_INVITE', '邀请已失效，请重新生成')
      return { state: original, result: { snapshot: snapshot(original, actorId), value: { roomId: room.id, inviteCode: invite.code, expiresAt: invite.expiresAt, replayed: true } } }
    }
    if (action === 'messageSend') {
      const row = conversation(original, actorId, input.peerId)
      return { state: original, result: { snapshot: snapshot(original, actorId), value: Object.assign(conversationView(original, actorId, row), { replayed: true }) } }
    }
    if (action === 'notificationRead') {
      return { state: original, result: { snapshot: snapshot(original, actorId), value: Object.assign(noticeView(original, actorId, find(original.notifications, input.notificationId)), { replayed: true }) } }
    }
    return { state: original, result: { snapshot: snapshot(original, actorId), value: { id: prior.entityId || '', replayed: true } } }
  }
  if (original.requests.length >= 1500 || original.users.length > 50 || (action === 'postCreate' && original.posts.length >= 300) || (action === 'commentCreate' && original.comments.length >= 1000) || (action === 'roomCreate' && original.rooms.length >= 100) || (action === 'reportCreate' && original.reports.length >= 300)) fail('LIMIT_REACHED', '隔离验证环境已达到容量限制，请先导出后重置')
  const state = clone(original)
  const value = mutate(state, actorId, action, input, now)
  state.revision += 1
  state.requests.push({ actorId, requestId, fingerprint, entityId: value.id || '', inviteId: action === 'roomInvite' ? state.invites.find(invite => invite.code === value.inviteCode).id : '', createdAt: now })
  return { state, result: { snapshot: snapshot(state, actorId), value } }
}

module.exports = { createInitialState, registerActor, execute, snapshot, MUTATIONS, READS }
