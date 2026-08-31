import { expect, test } from 'vitest'

import {
  defaultScheduleDraft,
  draftToScheduleInput,
  scheduleToDraft,
} from './schedule-draft'

test('new Schedule drafts disable optional context while existing policies map exactly', () => {
  expect(defaultScheduleDraft()).toMatchObject({
    loadSkills: false,
    loadIntegrations: false,
  })
  expect(scheduleToDraft({
    capabilities: { skills: 'inherit', integrations: 'disabled' },
  })).toMatchObject({ loadSkills: true, loadIntegrations: false })
})

test('Schedule payload maps context switches to exact capability modes', () => {
  const draft = {
    ...defaultScheduleDraft(),
    title: 'Daily report',
    prompt: 'Write the daily report.',
    workspace: '/tmp/project',
    loadSkills: true,
    loadIntegrations: false,
  }
  expect(draftToScheduleInput(draft).capabilities).toEqual({
    skills: 'inherit',
    integrations: 'disabled',
  })
})
