const community = require('../../services/community')
const { postOf, commentOf, text } = require('../../components/social-post-card/view-model')
const DRAFT_PREFIX = 'catai_community_reply_'
const MAX_COMMENT = 300

function mergeComments(rows, context = []) {
  const comments = new Map()
  for (const row of rows) {
    const item = commentOf(row)
    if (item.id) comments.set(item.id, item)
  }
  const names = new Map([...comments.values(), ...context.filter(Boolean)].map(item => [item.id, item.author.nickname]))
  return [...comments.values()].map(item => ({ ...item,
    replyToName: item.parentId ? names.get(item.parentId) || item.replyToName || '猫友' : '' }))
}

Page({
  data: { postId: '', post: null, comments: [], commentsCursor: null, loadingComments: false, commentsError: '', targetCommentId: '', targetComment: null, targetParent: null, targetUnavailable: false, loading: false, error: '', draft: '', replyTo: null, sending: false, sendError: '', feedback: '', inputFocus: false, inputHeight: 44, keyboardHeight: 0, maxComment: MAX_COMMENT },
  onLoad(options) {
    const postId = text(options && (options.id || options.postId))
    let width = 375
    try { width = wx.getWindowInfo ? wx.getWindowInfo().windowWidth : wx.getSystemInfoSync().windowWidth } catch (_) {}
    this._rpx = width / 750
    this.setData({ postId, targetCommentId: text(options && options.commentId), inputHeight: Math.round(88 * this._rpx) })
    this._locateOnLoad = Boolean(this.data.targetCommentId)
    this._focusOnLoad = Boolean(options && options.reply === '1')
    this.restoreDraft()
    if (!postId) { this.setData({ error: '这个故事的链接不完整，请回到首页重新打开。' }); return }
    this.loadPost()
  },
  onUnload() { this.persistDraft(); this._disposed = true; this._loadToken = (this._loadToken || 0) + 1 },
  onHide() { this.persistDraft() },
  onPullDownRefresh() { return this.loadPost().finally(() => wx.stopPullDownRefresh()) },
  async loadPost() {
    if (!this.data.postId) return false
    const token = (this._loadToken || 0) + 1
    this._loadToken = token
    this._commentsToken = (this._commentsToken || 0) + 1
    this.setData({ loading: true, error: '', loadingComments: false, commentsError: '' })
    try {
      const result = await (this.data.targetCommentId
        ? community.getPost(this.data.postId, { commentId: this.data.targetCommentId })
        : community.getPost(this.data.postId))
      if (this._disposed || token !== this._loadToken) return false
      if (!result.post || !text(result.post.id || result.post._id)) throw new Error('这条故事暂时无法查看，可能还在审核中或已被移除。')
      const targetComment = result.targetComment && result.targetComment.status === 'approved' && result.targetComment.id === this.data.targetCommentId ? commentOf(result.targetComment) : null
      const targetParent = targetComment && result.targetParent && result.targetParent.status === 'approved' && result.targetParent.id === targetComment.parentId && !result.targetParent.parentId ? commentOf(result.targetParent) : null
      const comments = mergeComments(Array.isArray(result.comments) ? result.comments : [], [targetComment, targetParent])
      this.setData({ post: postOf(result.post), comments, commentsCursor: result.nextCommentsCursor || null,
        targetComment, targetParent, targetUnavailable: Boolean(this.data.targetCommentId && !targetComment),
        inputFocus: Boolean(this._focusOnLoad) }, () => {
        if (!this._disposed && token === this._loadToken && this._locateOnLoad) {
          this._locateOnLoad = false
          if (wx.pageScrollTo) wx.pageScrollTo({ selector: '#notification-context', duration: 0 })
        }
      })
      this._focusOnLoad = false
      return true
    } catch (error) {
      if (!this._disposed && token === this._loadToken) this.setData({ error: error.message || '故事暂时没能加载，请重试。' })
      return false
    } finally {
      if (!this._disposed && token === this._loadToken) this.setData({ loading: false })
    }
  },
  async loadMoreComments() {
    if (this.data.loading || this.data.loadingComments || !this.data.commentsCursor || !this.data.post || this.data.post.status !== 'approved') return false
    const token = (this._commentsToken || 0) + 1
    this._commentsToken = token
    this.setData({ loadingComments: true, commentsError: '' })
    try {
      const result = await community.listComments(this.data.postId, { cursor: this.data.commentsCursor })
      if (this._disposed || token !== this._commentsToken) return false
      const comments = mergeComments(this.data.comments.concat(Array.isArray(result.comments) ? result.comments : []), [this.data.targetComment, this.data.targetParent])
      this.setData({ comments, commentsCursor: result.nextCursor || null })
      return true
    } catch (error) {
      if (!this._disposed && token === this._commentsToken) this.setData({ commentsError: error.message || '更早的回应暂时没能加载，请重试。' })
      return false
    } finally {
      if (!this._disposed && token === this._commentsToken) this.setData({ loadingComments: false })
    }
  },
  replyToNotification() {
    const target = this.data.targetParent || this.data.targetComment
    if (target && !target.parentId) this.replyComment({ currentTarget: { dataset: { id: target.id } } })
  },
  retry() { return this.loadPost() },
  goHome() { wx.switchTab({ url: '/pages/home/index' }) },
  onDraftInput(event) {
    this.setData({ draft: String(event.detail.value || '').slice(0, MAX_COMMENT), sendError: '', feedback: '' })
    this.persistDraft()
  },
  onLineChange(event) {
    const unit = this._rpx || .5
    const height = Math.max(88 * unit, Math.min(220 * unit, (Number(event.detail.height) || 0) + 32 * unit))
    this.setData({ inputHeight: Math.round(height) })
  },
  onKeyboardChange(event) { this.setData({ keyboardHeight: Math.max(0, Number(event.detail.height) || 0) }) },
  onInputBlur() { this.setData({ inputFocus: false, keyboardHeight: 0 }); this.persistDraft() },
  focusComment() { this.setData({ inputFocus: true }) },
  choosePrompt(event) {
    if (this.data.sending) return
    const prompt = text(event.currentTarget.dataset.prompt)
    if (!prompt) return
    const draft = this.data.draft ? this.data.draft + (this.data.draft.endsWith('\n') ? '' : '\n') + prompt : prompt
    this.setData({ draft: draft.slice(0, MAX_COMMENT), inputFocus: true, feedback: '已放进输入框，可以修改后再发送。', sendError: '' })
    this.persistDraft()
  },
  replyComment(event) {
    if (this.data.sending) return
    const comment = this.data.comments.concat([this.data.targetParent, this.data.targetComment]).find(item => item && item.id === event.currentTarget.dataset.id)
    if (!comment || comment.parentId) return
    this.setData({ replyTo: { id: comment.id, nickname: comment.author.nickname, content: comment.content }, inputFocus: true, sendError: '', feedback: '' })
    this.persistDraft()
  },
  cancelReply() {
    if (this.data.sending) return
    this.setData({ replyTo: null, sendError: '' })
    this.persistDraft()
  },
  restoreDraft() {
    if (!this.data.postId) return
    try {
      const saved = wx.getStorageSync(DRAFT_PREFIX + this.data.postId)
      if (saved && typeof saved === 'object') this.setData({ draft: String(saved.draft || '').slice(0, MAX_COMMENT), replyTo: saved.replyTo && saved.replyTo.id ? { id: text(saved.replyTo.id), nickname: text(saved.replyTo.nickname), content: text(saved.replyTo.content) } : null })
    } catch (_) {}
  },
  persistDraft() {
    if (!this.data.postId) return
    try {
      if (this.data.draft || this.data.replyTo) wx.setStorageSync(DRAFT_PREFIX + this.data.postId, { draft: this.data.draft, replyTo: this.data.replyTo })
      else wx.removeStorageSync(DRAFT_PREFIX + this.data.postId)
    } catch (_) {}
  },
  async sendComment() {
    if (this.data.sending || !this.data.post || this.data.post.status !== 'approved') return false
    const content = this.data.draft.trim()
    if (!content) { this.setData({ sendError: '先写下一句话，再发送给猫友。', inputFocus: true }); return false }
    const parentId = this.data.replyTo && this.data.replyTo.id || ''
    this.setData({ sending: true, sendError: '', feedback: '' })
    try {
      const result = await community.addComment(this.data.postId, content, parentId)
      if (this._disposed) return false
      if (!result || !result.comment || !text(result.comment.id || result.comment._id)) throw new Error('发送结果尚未确认，文字已保留，请稍后重试。')
      if (result.comment.status === 'rejected') throw new Error('这条回应未通过审核，文字已保留，请修改后再试。')
      if (!['approved', 'pending'].includes(result.comment.status)) throw new Error('发送状态尚未确认，文字已保留，请稍后重试。')
      const comment = commentOf(result.comment)
      const pending = result.comment.status === 'pending'
      if (parentId && this.data.replyTo) comment.replyToName = this.data.replyTo.nickname
      const comments = pending || this.data.comments.some(item => item.id === comment.id) ? this.data.comments : this.data.comments.concat(comment)
      this.setData({ comments, draft: '', replyTo: null, inputFocus: false, keyboardHeight: 0, inputHeight: Math.round(88 * (this._rpx || .5)), feedback: pending ? '回应已提交审核，通过后会显示。' : '回应已送达。' })
      this.persistDraft()
      if (wx.hideKeyboard) wx.hideKeyboard()
      return true
    } catch (error) {
      if (!this._disposed) this.setData({ sendError: error.message || '回应暂时没能发送，文字已保留，请重试。' })
      return false
    } finally {
      if (!this._disposed) this.setData({ sending: false })
    }
  },
  onShareAppMessage() {
    const post = this.data.post
    if (!post || post.status !== 'approved') return { title: '来猫猫小屋，看看猫咪的新故事', path: '/pages/home/index', imageUrl: '/assets/tabbar/home-selected.png' }
    return { title: post.hasCat ? post.cat.name + '的猫咪故事' : '猫咪的新故事', path: '/pages/social-post/index?id=' + encodeURIComponent(this.data.postId), imageUrl: post.photos[0] || '/assets/tabbar/home-selected.png' }
  }
})
