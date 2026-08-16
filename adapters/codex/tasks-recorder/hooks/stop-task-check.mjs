#!/usr/bin/env node

import { readHookInput } from './src/hook-context.mjs'
import { fetchSessionContext } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  if (
    process.env.AGENT_SUPERVISOR_ROLE !== 'worker'
    && !input.stop_hook_active
    && input.session_id
  ) {
    const context = await fetchSessionContext(input.session_id)
    const pendingPlan = Number(context.pending_plan_observation_count) > 0
    const unassigned = Number(context.unassigned_execution_count) > 0
    const activeTask = Array.isArray(context.active_executions)
      && context.active_executions.some((execution) => (
        execution.task_id !== null && execution.classification !== 'non_work'
      ))
    if (pendingPlan || unassigned || activeTask) {
      const reasons = [
        ...(pendingPlan ? ['存在尚未同步的 update_plan。'] : []),
        ...(unassigned ? ['存在未绑定 execution；请分配到 Task，普通聊天则标记为 non_work。'] : []),
        ...(activeTask ? ['存在仍活跃的 Task execution，请同步最终状态。'] : []),
      ]
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `${reasons.join('')}调用 agent_tasks_context 后，以 agent_tasks_sync_tree 或 Task mutation 完成收口；这是本 turn 唯一一次 continuation。`,
      }))
      process.exit(0)
    }
  }
} catch {
  // Stop maintenance must fail open.
}
process.stdout.write('{}')
