const storage = require('./utils/storage')

const CLOUD_ENV = 'cloud1-d6gpjpxunc74669d7'

App({
  globalData: {
    appName: '猫猫小屋',
    appId: 'wx1112379224ace9f9',
    cloudEnv: CLOUD_ENV,
    cloudReady: false,
    settings: {
      apiBaseUrl: 'http://yacoyacoyaco.asuscomm.com:8503'
    }
  },

  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({ env: CLOUD_ENV, traceUser: true })
      this.globalData.cloudReady = true
    } else {
      console.error('当前基础库不支持微信云开发，请升级微信后重试')
    }
    this.globalData.settings = storage.getSettings()
  }
})
