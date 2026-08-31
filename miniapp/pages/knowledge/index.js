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
  }
})
