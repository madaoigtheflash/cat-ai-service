const community = require('../../services/community')
const { postOf, uniquePosts } = require('../../components/social-post-card/view-model')

Page({
  data: { posts: [], nextCursor: null, loading: false, refreshing: false, loaded: false, error: '' },
  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ selected: 0 })
    this._disposed = false
    this.loadPosts(true)
  },
  onUnload() { this._disposed = true; this._loadToken = (this._loadToken || 0) + 1 },
  onPullDownRefresh() { return this.loadPosts(true).finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() { if (this.data.nextCursor && !this.data.loading) this.loadPosts(false) },
  async loadPosts(reset) {
    if (this.data.loading && !reset) return false
    if (!reset && !this.data.nextCursor) return false
    const token = (this._loadToken || 0) + 1
    this._loadToken = token
    this._lastLoadReset = reset
    this.setData({ loading: true, refreshing: Boolean(reset && this.data.posts.length), error: '' })
    try {
      const result = await community.listPosts({ filter: 'public', cursor: reset ? null : this.data.nextCursor })
      if (this._disposed || token !== this._loadToken) return false
      const incoming = (Array.isArray(result.posts) ? result.posts : []).map(postOf)
      this.setData({ posts: uniquePosts((reset ? [] : this.data.posts).concat(incoming)), nextCursor: result.nextCursor || null, loaded: true })
      return true
    } catch (error) {
      if (!this._disposed && token === this._loadToken) this.setData({ error: error.message || '故事暂时没能加载，请重试。' })
      return false
    } finally {
      if (!this._disposed && token === this._loadToken) this.setData({ loading: false, refreshing: false })
    }
  },
  retry() { return this.loadPosts(this._lastLoadReset !== false) },
  loadMore() { return this.loadPosts(false) },
  goIdentify() { wx.navigateTo({ url: '/pages/identify/index' }) },
  goCompose() { wx.navigateTo({ url: '/pages/social-compose/index' }) },
  openPost(event) {
    const id = event.detail.id
    if (id) wx.navigateTo({ url: '/pages/social-post/index?id=' + encodeURIComponent(id) })
  },
  replyPost(event) {
    const id = event.detail.id
    if (id) wx.navigateTo({ url: '/pages/social-post/index?id=' + encodeURIComponent(id) + '&reply=1' })
  },
  onShareAppMessage() { return { title: '来猫猫小屋，看看猫咪的新故事', path: '/pages/home/index' } }
})
