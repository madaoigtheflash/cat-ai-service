const domain = require('../../utils/cato-social-followup')
const { createStore, uid } = require('../../services/cato-lab')

Page({
  data: { ready: false, error: '', feedback: '', actor: 'momo', stage: 'story', storyId: 'window', rootId: '', focusId: '', commentDraft: '', messageDraft: '', users: domain.USERS, stories: domain.STORIES, comments: [], notices: [], messages: [] },
  onLoad() {
    this._store = createStore('social-followup')
    this._drafts = {}
    this.loadState()
  },
  loadState() {
    try {
      this._state = domain.validateState(this._store.load('state', domain.createInitialState()))
      this.setData({ ready: true, error: '' })
      this.refresh()
    } catch (_) { this.setData({ ready: false, error: '本地记录读取失败或格式不兼容。未写入任何数据；可重试读取，或回审计入口重置本实验。' }) }
  },
  draftKey(kind) {
    return [kind, this.data.actor, this.data.storyId, this.data.rootId].join(':')
  },
  draft(kind) { return this._drafts[this.draftKey(kind)] || { text: '', requestId: '' } },
  setDraft(kind, value) {
    this._drafts[this.draftKey(kind)] = { text: value, requestId: uid('send') }
    this.setData({ [kind + 'Draft']: value, error: '', feedback: '' })
  },
  refresh() {
    const state = this._state
    const actor = this.data.actor
    const peer = domain.peerOf(actor)
    const contact = domain.contactFor(state, actor)
    const reference = { storyId: this.data.storyId, commentId: this.data.rootId }
    const post = domain.STORIES.find(item => item.id === this.data.storyId)
    const names = domain.USERS.reduce((result, item) => { result[item.id] = item.name; return result }, {})
    let context = null
    try { context = domain.contextFor(state, actor, reference) } catch (_) {}
    const comments = state.comments.filter(item => item.storyId === post.id).map(item => ({ ...item, name: names[item.author], rootId: item.parentId || item.id, selected: this.data.focusId === item.id }))
    const notices = state.notifications.filter(item => item.recipient === actor).slice().reverse().map(item => ({ ...item, name: names[item.actor], label: item.kind === 'message' ? '发来一条本地文字消息' : item.kind === 'reply' ? '回复了公开评论' : '评论了你的公开故事', title: domain.STORIES.find(post => post.id === item.storyId).title }))
    this.setData({ me: names[actor], peer, peerName: names[peer], post: { ...post, name: names[post.author] }, ownStory: post.author === actor, comments, notices, unread: notices.filter(item => !item.read).length, context, contact, permission: domain.sendPermission(state, actor, reference), canIgnore: !!contact && contact.status === 'pending' && contact.recipient === actor, acceptStrangers: state.settings[actor].acceptStrangers, ownBlock: state.settings[actor].blocked, messages: state.messages.filter(item => !item.hiddenFor.includes(actor)).map(item => ({ ...item, name: names[item.author], mine: item.author === actor, selected: item.id === this.data.focusId })), commentDraft: this.draft('comment').text, messageDraft: this.draft('message').text })
  },
  commit(action, feedback) {
    if (!this.data.ready) return false
    try {
      const next = domain.transition(this._state, { ...action, actor: this.data.actor })
      this._store.save('state', next)
      this._state = next
      this.setData({ error: '', feedback: feedback || '本地模拟记录已保存。' })
      this.refresh()
      return true
    } catch (error) {
      this.setData({ error: '未完成：' + error.message + ' 输入已保留，可修改或重试。', feedback: '' })
      return false
    }
  },
  switchRole(event) {
    if (!this.data.ready) return
    this.setData({ actor: event.currentTarget.dataset.id, focusId: '', error: '', feedback: '已切换模拟身份；没有登录真实账号。' })
    this.refresh()
  },
  switchStage(event) {
    const stage = event.currentTarget.dataset.stage
    if (stage === 'chat') {
      const contact = domain.contactFor(this._state, this.data.actor)
      if (contact) this.setData({ storyId: contact.context.storyId, rootId: contact.context.commentId })
    }
    this.setData({ stage, error: '', feedback: '' })
    this.refresh()
  },
  selectStory(event) {
    this.setData({ storyId: event.currentTarget.dataset.id, rootId: '', focusId: '', error: '', feedback: '' })
    this.refresh()
  },
  selectComment(event) {
    this.setData({ rootId: event.currentTarget.dataset.root, focusId: event.currentTarget.dataset.id, error: '', feedback: '已选中公开评论。可回复，或从这个上下文发招呼。' })
    this.refresh()
  },
  clearSelection() { this.setData({ rootId: '', focusId: '', error: '', feedback: '' }); this.refresh() },
  inputComment(event) { this.setDraft('comment', event.detail.value) },
  inputMessage(event) { this.setDraft('message', event.detail.value) },
  fillOpener() {
    this.setDraft('comment', this.data.rootId ? '看到你也有同感，想听听你家猫的小习惯。' : '这个小日常好可爱！你家猫每天都会来这里待一会儿吗？')
    this.setData({ feedback: '仅填入可编辑草稿，尚未发送。' })
  },
  fillGreeting() {
    this.setDraft('message', this.data.contact ? '谢谢你的分享！也想听听你家猫最近的小日常。' : '你好，我是刚才在故事下留言的猫友。想和你聊聊猫咪的小习惯，不方便回复也没关系。')
    this.setData({ feedback: '仅填入文字草稿，尚未发送。' })
  },
  cancelComment() { this.setDraft('comment', ''); this.setData({ feedback: '已取消草稿，没有发送。' }) },
  cancelMessage() { this.setDraft('message', ''); this.setData({ feedback: '已取消草稿，没有发送。' }) },
  sendComment() {
    const draft = this.draft('comment')
    if (this.commit({ type: 'comment', storyId: this.data.storyId, parentId: this.data.rootId, text: draft.text, requestId: draft.requestId || uid('send') }, '公开评论已保存到本机模拟中，未对外发布。')) {
      this._drafts[this.draftKey('comment')] = { text: '', requestId: '' }
      this.refresh()
    }
  },
  openChat() {
    if (!this.data.context) return
    const contact = domain.contactFor(this._state, this.data.actor)
    if (contact) this.setData({ storyId: contact.context.storyId, rootId: contact.context.commentId })
    this.setData({ stage: 'chat', focusId: '', feedback: contact ? '沿用首次招呼的公开上下文，不重新获得招呼次数。' : '', error: '' })
    this.refresh()
  },
  sendMessage() {
    const draft = this.draft('message')
    if (this.commit({ type: 'message', kind: 'TEXT', peer: this.data.peer, context: { storyId: this.data.storyId, commentId: this.data.rootId }, text: draft.text, requestId: draft.requestId || uid('send') }, '文字消息已保存到本机模拟中，未发送给真实用户。')) {
      this._drafts[this.draftKey('message')] = { text: '', requestId: '' }
      this.refresh()
    }
  },
  openNotice(event) {
    try {
      const route = domain.resolveNotification(this._state, this.data.actor, event.currentTarget.dataset.id)
      if (this.commit({ type: 'readNotification', id: event.currentTarget.dataset.id }, '已定位到这条本地通知的原始上下文。')) {
        this.setData({ stage: route.stage, storyId: route.storyId, rootId: route.commentId, focusId: route.focusId })
        this.refresh()
      }
    } catch (error) { this.setData({ error: error.message, feedback: '' }) }
  },
  showSource() { this.setData({ stage: 'story', focusId: this.data.rootId, feedback: '', error: '' }); this.refresh() },
  toggleStrangers() { this.commit({ type: 'settings', acceptStrangers: !this.data.acceptStrangers }, '当前模拟身份的陌生人招呼设置已保存。') },
  toggleBlock() { this.commit({ type: 'block', blocked: !this.data.ownBlock }, this.data.ownBlock ? '已解除本身份的拉黑；首次招呼许可不会重置。' : '已在本机拉黑另一模拟身份；双方不能继续发送。') },
  ignoreGreeting() {
    wx.showModal({ title: '忽略这条模拟招呼？', content: '本实验中将停止该会话的后续发送。删除记录不会恢复许可。不会通知真实用户。', success: result => { if (result.confirm) this.commit({ type: 'ignore' }, '已忽略这条模拟招呼，后续发送被阻止。') } })
  },
  deleteHistory() {
    wx.showModal({ title: '删除当前身份的本地消息？', content: '仅清除本身份可见的会话内容。对方的模拟记录和首次招呼许可保留，不能再发第二条陌生招呼。', success: result => { if (result.confirm) this.commit({ type: 'deleteHistory' }, '本身份的消息已删除；首次招呼与忽略、拉黑状态均保留。') } })
  }
})
