/**
 * MCP prompts primitive (task 4): `bootstrap-interview` drives the
 * multi-section onboarding interview via the `bootstrap` tool;
 * `session-context` returns the budgeted `memory://inject` context block via
 * the existing `ResourceHandler` — no duplicated budgeting logic. See
 * design.md "Prompts".
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Prompt, GetPromptResult, PromptMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ResourceHandler } from '../resources/index.js';
import { BOOTSTRAP_SECTIONS, TOTAL_SECTIONS, getSectionByNumber } from '../bootstrap/sections.js';

export const MCP_PROMPT_DEFINITIONS: Prompt[] = [
  {
    name: 'bootstrap-interview',
    title: 'Bootstrap Interview',
    description: `Walks through the ${TOTAL_SECTIONS}-section onboarding interview that builds a persistent profile, driven through the "bootstrap" tool.`,
    arguments: [
      {
        name: 'section',
        description: `Section number to jump to (1-${TOTAL_SECTIONS}). Omit for an overview of all sections.`,
        required: false,
      },
    ],
  },
  {
    name: 'session-context',
    title: 'Session Context',
    description: 'Returns the budgeted memory://inject context block for priming a new session with relevant memories and policy categories.',
    arguments: [
      {
        name: 'hint',
        description: 'Optional text used to select the memory section by hybrid relevance instead of recency.',
        required: false,
      },
    ],
  },
];

/** Task 2.4-style lockstep set, so a typo in a handler's `case` can't silently 404. */
export const MCP_PROMPT_NAMES: ReadonlySet<string> = new Set(MCP_PROMPT_DEFINITIONS.map(p => p.name));

function textMessage(role: 'user' | 'assistant', text: string): PromptMessage {
  return { role, content: { type: 'text', text } };
}

function overviewMessage(): PromptMessage {
  const sectionList = BOOTSTRAP_SECTIONS.map(s => `${s.section}. ${s.title}`).join('\n');
  return textMessage(
    'user',
    `Guide me through the BHGBrain bootstrap interview. It has ${TOTAL_SECTIONS} sections:\n\n${sectionList}\n\n` +
    'Call the "bootstrap" tool with action: "start" to begin (or resume) at the first incomplete section. ' +
    'For each section, ask the listed questions, then call "bootstrap" with action: "submit", the section ' +
    'number, and my answers.',
  );
}

function sectionMessage(section: number): PromptMessage {
  const def = getSectionByNumber(section)!;
  const questions = def.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return textMessage(
    'user',
    `Guide me through section ${section} of the BHGBrain bootstrap interview: "${def.title}".\n\nAsk me:\n${questions}\n\n` +
    `Once I answer, call the "bootstrap" tool with action: "submit", section: ${section}, and my answers.`,
  );
}

function buildBootstrapInterviewResult(args: Record<string, string> | undefined): GetPromptResult {
  const rawSection = args?.section;
  if (rawSection === undefined || rawSection === '') {
    return { description: 'Bootstrap interview overview', messages: [overviewMessage()] };
  }

  const section = Number(rawSection);
  if (!Number.isInteger(section) || section < 1 || section > TOTAL_SECTIONS) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `section must be an integer between 1 and ${TOTAL_SECTIONS}, got "${rawSection}"`,
    );
  }

  return {
    description: `Bootstrap interview - section ${section}`,
    messages: [sectionMessage(section)],
  };
}

async function buildSessionContextResult(
  resources: ResourceHandler,
  args: Record<string, string> | undefined,
): Promise<GetPromptResult> {
  const hint = args?.hint?.trim();
  const uri = hint ? `memory://inject/${encodeURIComponent(hint)}` : 'memory://inject';
  const payload = await resources.handle(uri);

  return {
    description: 'Session context for priming a new conversation',
    messages: [textMessage('user', JSON.stringify(payload))],
  };
}

/**
 * Handles `prompts/get` for both defined prompts. Unknown prompt names throw
 * `McpError(ErrorCode.InvalidParams)`, matching the CallTool unknown-tool
 * guard's error taxonomy (task 3).
 */
export async function handleGetPrompt(
  resources: ResourceHandler,
  name: string,
  args: Record<string, string> | undefined,
): Promise<GetPromptResult> {
  switch (name) {
    case 'bootstrap-interview':
      return buildBootstrapInterviewResult(args);
    case 'session-context':
      return buildSessionContextResult(resources, args);
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
}
