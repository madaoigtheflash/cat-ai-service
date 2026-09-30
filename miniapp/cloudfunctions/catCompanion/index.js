const cloud = require('wx-server-sdk')
const { createHandler } = require('./core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = createHandler({
  getContext: () => cloud.getWXContext(),
  env: process.env
})
