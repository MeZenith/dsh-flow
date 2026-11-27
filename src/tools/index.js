/**
 * Flow 全部 9 个工具的聚合装配入口（静态注册，绝不随模式增删）。
 *
 * @module dsh-flow/tools
 */
import { createDispatchStore } from '../workflow/dispatch.js'
import { docFileName, docsNote } from '../workflow/docs.js'
import { docIdsOf, projectNameOf, TOOL_MESSAGES } from './common.js'
import { createRouteTool, ROUTE_TOOL } from './route.js'
import { createGateTool, GATE_TOOL } from './gate.js'
import { createDocsTools, DOCS_CHECK_TOOL, DOCS_INIT_TOOL, DOCS_WRITE_TOOL, SEND_DOC_TOOL } from './docs.js'
import { createUiSkillTool, UI_SKILL_TOOL } from './ui-skill.js'
import { createDispatchTool, DISPATCH_TOOL } from './dispatch.js'
import { createQaHandoffTool, QA_HANDOFF_TOOL } from './qa.js'

export {
  ROUTE_TOOL,
  GATE_TOOL,
  DOCS_INIT_TOOL,
  DOCS_CHECK_TOOL,
  DOCS_WRITE_TOOL,
  SEND_DOC_TOOL,
  UI_SKILL_TOOL,
  DISPATCH_TOOL,
  QA_HANDOFF_TOOL,
  TOOL_MESSAGES,
}

export const TOOL_INTERNALS = Object.freeze({ projectNameOf, docIdsOf, docFileName, docsNote })

export function createFlowTools({
  ctx, getConfig, switchMode, logger, getUserQuestions, notifier, im, email, tickets, uiSkills, remoteHub, stateStore, dispatchStore: externalDispatchStore, reworkTracker,
}) {
  const dispatchStore = externalDispatchStore ?? createDispatchStore({ stateStore })

  return [
    createRouteTool({ ctx, getConfig, switchMode, getUserQuestions, stateStore }),
    createGateTool({ getConfig, logger, notifier, im, email, tickets, dispatchStore, remoteHub, stateStore }),
    ...createDocsTools({ getConfig, tickets, email, im, remoteHub, stateStore }),
    createUiSkillTool({ uiSkills }),
    createDispatchTool({ ctx, dispatchStore }),
    createQaHandoffTool({ getConfig, notifier, remoteHub, stateStore, reworkTracker }),
  ]
}
