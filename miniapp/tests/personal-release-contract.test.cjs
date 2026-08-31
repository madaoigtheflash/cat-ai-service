const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '..')

function collectFiles(directory, extensions) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectFiles(target, extensions)
    return extensions.includes(path.extname(entry.name)) ? [target] : []
  })
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

test('personal release copy does not expose enterprise assistant branding', () => {
  const files = [
    path.join(ROOT, 'app.js'),
    path.join(ROOT, 'app.json'),
    path.join(ROOT, 'project.config.json'),
    path.join(ROOT, 'sitemap.json'),
    ...collectFiles(path.join(ROOT, 'pages'), ['.js', '.json', '.wxml']),
    ...collectFiles(path.join(ROOT, 'data'), ['.js']),
    ...collectFiles(path.join(ROOT, 'services'), ['.js'])
  ]
  const submittedSource = files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
    .replaceAll('cat-ai.relationship.directed', 'relationship.directed')

  assert.doesNotMatch(submittedSource, /\bAI\b/i)
  assert.doesNotMatch(submittedSource, /MiniMax|Codex|人工智能|AI问答|AI识别|模型密钥|默认模型/i)
})

test('knowledge page only searches bundled articles and never requests generated answers', () => {
  const pageScript = read('pages/knowledge/index.js')
  const pageMarkup = read('pages/knowledge/index.wxml')
  const apiService = read('services/api.js')

  assert.match(pageScript, /knowledge\.search/)
  assert.doesNotMatch(pageScript, /askKnowledge|askAI|callCloud/)
  assert.doesNotMatch(pageMarkup, /textarea|生成.{0,4}答案|回答/)
  assert.doesNotMatch(apiService, /askKnowledge/)
})

test('photo cat observation remains available while cloud function sources stay outside upload package', () => {
  const appConfig = JSON.parse(read('app.json'))
  const projectConfig = JSON.parse(read('project.config.json'))
  const apiService = read('services/api.js')
  const ignoredFolders = projectConfig.packOptions.ignore
    .filter(item => item.type === 'folder')
    .map(item => item.value)

  assert.ok(appConfig.pages.includes('pages/identify/index'))
  assert.match(apiService, /async function identify\(imagePath\)/)
  assert.ok(ignoredFolders.includes('cloudfunctions'))
})
