const community = require('../../services/community')
const { postOf, uniquePosts, text, timeLabel } = require('../../components/social-post-card/view-model')

Page({
  goPublic() { wx.navigateTo({ url: '/pages/home-classic/index' }) },
  data: { activeSection: 'mine', posts: [], nextCursor: null, notifications: [], notificationCursor: null, loadingPosts: false, loadingNotifications: false, mineLoaded: false, notificationsLoaded: false, error: '', notificationError: '' },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 2 })
    this._disposed = false
    this.refresh()
  },
  onUnload() { this._disposed = true },
  onPullDownRefresh() { return this.refresh().finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() {
    if (this.data.activeSection === 'replies') return this.loadNotifications(false)
    return this.loadPosts(false)
  },
  refresh() { return this.data.activeSection === 'replies' ? this.loadNotifications(true) : this.loadPosts(true) },
  selectSection(event) {
    const section = event.currentTarget.dataset.section
    if (!['mine', 'replies'].includes(section) || section === this.data.activeSection) return
    this.setData({ activeSection: section })
    this.refresh()
  },
  async loadPosts(reset) {
    if (this.data.loadingPosts && !reset) return false
    if (!reset && !this.data.nextCursor) return false
    const token = (this._postToken || 0) + 1
    this._postToken = token
    this._lastLoadReset = reset
    this.setData({ loadingPosts: true, error: '' })
    try {
      const result = await community.listPosts({ filter: 'mine', cursor: reset ? null : this.data.nextCursor })
      if (this._disposed || token !== this._postToken) return false
      this.setData({ posts: uniquePosts((reset ? [] : this.data.posts).concat((result.posts || []).map(postOf))), nextCursor: result.nextCursor || null, mineLoaded: true })
      return true
    } catch (error) {
      if (!this._disposed && token === this._postToken) this.setData({ error: error.message || '你的故事暂时没能加载，请重试。' })
      return false
    } finally {
      if (!this._disposed && token === this._postToken) this.setData({ loadingPosts: false })
    }
  },
  async loadNotifications(reset = true) {
    if (!reset && (this.data.loadingNotifications || !this.data.notificationCursor)) return false
    const token = (this._notificationToken || 0) + 1
    this._notificationToken = token
    this._lastNotificationReset = reset
    this.setData({ loadingNotifications: true, notificationError: '' })
    try {
      const result = await community.listNotifications({ cursor: reset ? null : this.data.notificationCursor })
      if (this._disposed || token !== this._notificationToken) return false
      const notifications = (Array.isArray(result.notifications) ? result.notifications : []).map(item => ({
        id: text(item.id || item._id), postId: text(item.postId), commentId: text(item.commentId),
        content: text(item.content) || '有猫友回应了你的故事',
        authorName: text((item.actor || item.author || {}).nickname) || '猫友',
        read: Boolean(item.read || item.readAt || (this._confirmedReads && this._confirmedReads.has(text(item.id || item._id)))), timeLabel: timeLabel(item.createdAt)
      })).filter(item => item.id && item.postId)
      const merged = new Map()
      for (const item of (reset ? [] : this.data.notifications).concat(notifications)) {
        const prior = merged.get(item.id)
        merged.set(item.id, prior ? { ...item, read: prior.read || item.read } : item)
      }
      this.setData({ notifications: [...merged.values()], notificationCursor: result.nextCursor || null, notificationsLoaded: true })
      return true
    } catch (error) {
      if (!this._disposed && token === this._notificationToken) this.setData({ notificationError: error.message || '回应暂时没能加载，请重试。' })
      return false
    } finally {
      if (!this._disposed && token === this._notificationToken) this.setData({ loadingNotifications: false })
    }
  },
  retryPosts() { return this.loadPosts(this._lastLoadReset !== false) },
  retryNotifications() { return this.loadNotifications(this._lastNotificationReset !== false) },
  loadMoreNotifications() { return this.loadNotifications(false) },
  loadMore() { return this.loadPosts(false) },
  openPost(event) {
    const id = event.detail.id
    if (id) wx.navigateTo({ url: '/pages/social-post/index?id=' + encodeURIComponent(id) })
  },
  replyPost(event) {
    const id = event.detail.id
    if (id) wx.navigateTo({ url: '/pages/social-post/index?id=' + encodeURIComponent(id) + '&reply=1' })
  },
  async openNotification(event) {
    const id = event.currentTarget.dataset.id
    const item = this.data.notifications.find(notification => notification.id === id)
    if (!item) return
    wx.navigateTo({ url: '/pages/social-post/index?id=' + encodeURIComponent(item.postId) + (item.commentId ? '&commentId=' + encodeURIComponent(item.commentId) : '') })
    if (item.read) return
    try {
      const result = await community.markNotification(id)
      if (!result || result.id !== id || result.read !== true) throw new Error('已读状态尚未确认')
      if (!this._disposed) {
        if (!this._confirmedReads) this._confirmedReads = new Set()
        this._confirmedReads.add(id)
        this.setData({ notifications: this.data.notifications.map(notification => notification.id === id ? Object.assign({}, notification, { read: true }) : notification) })
      }
    } catch (error) {
      if (!this._disposed) {
        this._lastNotificationReset = true
        this.setData({ notificationError: '故事已打开，但未能标记回应为已读。下次刷新后可重试。' })
      }
    }
  },
  goCompose() { wx.navigateTo({ url: '/pages/social-compose/index' }) },
  goHouse() { wx.navigateTo({ url: '/pages/online/index' }) },
  goPets() { wx.switchTab({ url: '/pages/pets/index' }) },
  goIdentify() { wx.navigateTo({ url: '/pages/identify/index' }) },
  goHome() { wx.switchTab({ url: '/pages/home/index' }) }
})
