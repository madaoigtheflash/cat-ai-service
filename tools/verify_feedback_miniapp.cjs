'use strict'

const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const moduleRoot = process.env.MINIPROGRAM_AUTOMATOR_ROOT
  if (!moduleRoot) throw new Error('MINIPROGRAM_AUTOMATOR_ROOT is required')
  const automator = require(path.join(moduleRoot, 'node_modules', 'miniprogram-automator'))
  const outputDir = path.join(projectRoot, 'artifacts', 'feedback-verification')
  fs.mkdirSync(outputDir, { recursive: true })
  const miniProgram = process.env.MINIPROGRAM_AUTOMATOR_WS
    ? await automator.connect({ wsEndpoint: process.env.MINIPROGRAM_AUTOMATOR_WS })
    : await automator.launch({
      cliPath: 'D:\\\\Program Files (x86)\\\\Tencent\\\\微信web开发者工具\\\\cli.bat',
      projectPath: path.join(projectRoot, 'miniapp'),
      trustProject: true
    })
  try {
    const page = await miniProgram.reLaunch('/pages/feedback/index')
    await page.waitFor(5000)
    const data = await page.data()
    const title = await page.$('.feedback-title')
    const submit = await page.$('button.primary-button')
    if (!title || !submit) throw new Error('feedback page core controls are missing')
    if (data.errorMessage) throw new Error(`feedback page cloud error: ${data.errorMessage}`)
    if (process.env.SUBMIT_FEEDBACK_TEST === '1' && !data.myFeedback.some(item => item.title === '联调验证：反馈状态说明')) {
      const titleInput = await page.$('.form-input')
      const contentInput = await page.$('.feedback-textarea')
      const stepsInput = await page.$('.steps-textarea')
      await titleInput.input('联调验证：反馈状态说明')
      await contentInput.input('希望反馈提交后能清楚说明已收到、已筛选、本地审计和已处理等阶段。这是一条开发阶段端到端联调记录。')
      await stepsInput.input('首页进入意见信箱，填写内容并提交，然后查看我的反馈状态。')
      await submit.tap()
      await page.waitFor(6000)
      const submittedData = await page.data()
      if (submittedData.errorMessage) throw new Error(`feedback submission failed: ${submittedData.errorMessage}`)
      if (!submittedData.myFeedback.some(item => item.title === '联调验证：反馈状态说明')) {
        throw new Error('submitted feedback is not visible in my feedback list')
      }
    }
    const verifiedData = await page.data()
    const forbiddenAdminState = ['proposals', 'canApprove', 'publicUserId', 'decisionLoading']
      .filter(key => Object.prototype.hasOwnProperty.call(verifiedData, key))
    if (forbiddenAdminState.length) {
      throw new Error(`feedback page still exposes admin state: ${forbiddenAdminState.join(', ')}`)
    }
    const submitSize = await submit.size()
    if (submitSize.height < 44) throw new Error(`submit touch target is only ${submitSize.height}px high`)
    await miniProgram.screenshot({ path: path.join(outputDir, 'feedback-standard.png') })
    await miniProgram.pageScrollTo(1050)
    await page.waitFor(500)
    await miniProgram.screenshot({ path: path.join(outputDir, 'feedback-form-bottom.png') })
    fs.writeFileSync(path.join(outputDir, 'runtime.json'), JSON.stringify({
      route: page.path,
      feedbackCount: verifiedData.myFeedback.length,
      feedbackOnly: true,
      errorMessage: verifiedData.errorMessage,
      submitSize
    }, null, 2))
    console.log(JSON.stringify({
      ok: true,
      route: page.path,
      cloudConnected: true,
      feedbackCount: verifiedData.myFeedback.length,
      feedbackOnly: true,
      submitSize,
      screenshot: path.join(outputDir, 'feedback-standard.png')
    }))
  } finally {
    await miniProgram.close()
  }
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
