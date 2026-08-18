import assert from 'node:assert/strict'
import test from 'node:test'

import { rendererErrorPresentation } from '../ui/src/renderer-error-state.mjs'

test('presents renderer failures without exposing exception details', () => {
  assert.deepEqual(rendererErrorPresentation(new Error('secret implementation detail')), {
    title: 'Timeline 暂时无法显示',
    message: '任务数据仍由 taskd 保存。请刷新页面重试；若问题持续，请检查 taskd 日志。',
    logMessage: 'secret implementation detail',
  })
  assert.equal(rendererErrorPresentation('invalid').logMessage, 'Unknown renderer error')
})
