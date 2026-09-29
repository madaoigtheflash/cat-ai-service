const knowledge = require('../../data/knowledge')

Page({
  data: {
    categories: knowledge.categories,
    category: '全部',
    query: '',
    articles: knowledge.articles,
    expandedId: ''
  },

  onSearchInput(event) {
    this.setData({ query: event.detail.value })
    this.filter()
  },

  selectCategory(event) {
    this.setData({ category: event.currentTarget.dataset.category })
    this.filter()
  },

  filter() {
    this.setData({ articles: knowledge.search(this.data.query, this.data.category) })
  },

  toggleArticle(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ expandedId: this.data.expandedId === id ? '' : id })
  },

  onPullDownRefresh() {
    this.filter()
    wx.stopPullDownRefresh()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  onShareAppMessage() {
    return {
      title: '养猫知识库：品种、健康、饮食一查就有',
      path: '/pages/knowledge/index?from=share'
    }
  },

  onShareTimeline() {
    return {
      title: '养猫知识库：品种、健康、饮食一查就有',
      query: 'from=timeline'
    }
  }
})
