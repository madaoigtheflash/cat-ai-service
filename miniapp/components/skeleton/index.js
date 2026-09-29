Component({
  properties: {
    // cards: 上下排列的卡片；list: 列表行；grid: 2x2 图格
    type: { type: String, value: 'cards' },
    // 重复单元数量
    count: { type: Number, value: 2 },
    // 是否展示（配合页面 loading 状态）
    show: { type: Boolean, value: true }
  },
  data: { rows: [] },
  observers: {
    count(value) {
      const safe = Math.max(1, Math.min(8, Number(value) || 1))
      this.setData({ rows: Array.from({ length: safe }, (_, index) => index) })
    }
  },
  lifetimes: {
    attached() {
      const safe = Math.max(1, Math.min(8, Number(this.data.count) || 1))
      this.setData({ rows: Array.from({ length: safe }, (_, index) => index) })
    }
  }
})
