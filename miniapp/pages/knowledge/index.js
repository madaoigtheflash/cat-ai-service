const knowledge = require('../../data/knowledge')
const api = require('../../services/api')

Page({
  data: {
    categories: knowledge.categories,
    category: '全部',
    query: '',
    articles: knowledge.articles,
    expandedId: '',
    question: '',
    asking: false,
    answer: '',
    askError: '',
    configured: false
  },

  onShow() {
    const app = getApp()
    this.setData({ configured: Boolean(wx.cloud && app && app.globalData && app.globalData.cloudReady) })
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

  onQuestionInput(event) { this.setData({ question: event.detail.value }) },
  goSettings() { wx.navigateTo({ url: '/pages/settings/index' }) },

  async askAI() {
    const question = this.data.question.trim()
    if (!question) {
      wx.showToast({ title: '请先输入问题', icon: 'none' })
      return
    }
    if (!this.data.configured) {
      this.setData({ askError: 'AI 问答需要先连接 CloudBase 云服务，本地知识查询不受影响。' })
      return
    }
    this.setData({ asking: true, answer: '', askError: '' })
    try {
      const response = await api.askKnowledge(question)
      const answer = response.answer || response.result || response.content || ''
      if (!answer) throw new Error('服务未返回有效答案')
      this.setData({ answer })
    } catch (error) {
      this.setData({ askError: error.message || 'AI 问答失败' })
    } finally {
      this.setData({ asking: false })
    }
  }
})
