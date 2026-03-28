import { z } from 'zod';
import type { ToolContext } from './index.js';
import type { WriteResult } from '../domain/types.js';
import { BootstrapSessionManager } from '../bootstrap/session.js';
import { BOOTSTRAP_SECTIONS, TOTAL_SECTIONS, getSectionByNumber } from '../bootstrap/sections.js';
import { invalidInput } from '../errors/index.js';

export const BootstrapInputSchema = z.object({
  action: z.enum(['start', 'submit', 'status', 'reset']),
  section: z.number().int().min(1).max(TOTAL_SECTIONS).optional(),
  answers: z.string().min(1).max(500000).optional(),
  namespace: z.string().regex(/^[a-zA-Z0-9/-]{1,200}$/).default('profile'),
}).strict();

export type BootstrapInput = z.infer<typeof BootstrapInputSchema>;

export async function handleBootstrap(ctx: ToolContext, args: unknown): Promise<unknown> {
  const input = parseBootstrapInput(args);
  const sessionMgr = new BootstrapSessionManager(ctx.storage.sqlite);

  switch (input.action) {
    case 'start':
      return handleStart(sessionMgr, input.namespace);
    case 'submit':
      return handleSubmit(ctx, sessionMgr, input);
    case 'status':
      return handleStatus(sessionMgr, input.namespace);
    case 'reset':
      return handleReset(ctx, sessionMgr, input);
  }
}

function parseBootstrapInput(args: unknown): BootstrapInput {
  try {
    return BootstrapInputSchema.parse(args);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const messages = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw invalidInput(messages);
    }
    throw err;
  }
}

function handleStart(sessionMgr: BootstrapSessionManager, namespace: string) {
  const sections = sessionMgr.createOrResume(namespace);
  const firstIncomplete = sessionMgr.getFirstIncompleteSection(sections);

  if (firstIncomplete === null) {
    const status = sessionMgr.getStatus(namespace)!;
    return {
      complete: true,
      message: 'All sections are complete.',
      total_memories: status.total_memories,
      sections: sections.map(s => ({
        section: s.section_number,
        status: s.status,
        memory_count: s.memory_ids.length,
      })),
    };
  }

  const sectionDef = getSectionByNumber(firstIncomplete)!;
  return {
    complete: false,
    current_section: firstIncomplete,
    title: sectionDef.title,
    questions: sectionDef.questions,
    instructions: `Answer the questions for Section ${firstIncomplete}: ${sectionDef.title}. Then call bootstrap with action: "submit", section: ${firstIncomplete}, and your answers.`,
    progress: {
      complete: sections.filter(s => s.status === 'complete').length,
      total: TOTAL_SECTIONS,
    },
  };
}

async function handleSubmit(ctx: ToolContext, sessionMgr: BootstrapSessionManager, input: BootstrapInput) {
  if (!input.section) {
    throw invalidInput('section is required for submit action');
  }
  if (!input.answers) {
    throw invalidInput('answers is required for submit action');
  }

  const sectionNumber = input.section;
  const sectionDef = getSectionByNumber(sectionNumber);
  if (!sectionDef) {
    throw invalidInput(`Invalid section number: ${sectionNumber}`);
  }

  if (!sessionMgr.exists(input.namespace)) {
    throw invalidInput('No bootstrap session found. Call start first.');
  }

  const sections = sessionMgr.createOrResume(input.namespace);
  const sectionRow = sections.find(s => s.section_number === sectionNumber);
  if (sectionRow?.status === 'complete') {
    throw invalidInput(`Section ${sectionNumber} is already complete. Use action: "reset" to clear it first.`);
  }

  // Split answers by paragraphs and store each as a memory
  const chunks = input.answers.split(/\n\s*\n/).map(c => c.trim()).filter(c => c.length > 0);
  const memoryIds: string[] = [];

  for (const chunk of chunks) {
    const results: WriteResult[] = await ctx.pipeline.process({
      content: chunk,
      namespace: input.namespace,
      collection: sectionDef.collection,
      type: sectionDef.type,
      tags: [...sectionDef.tags],
      importance: sectionDef.importance,
      source: 'agent',
      retention_tier: sectionDef.retention_tier,
      device_id: ctx.config.device.id ?? null,
    });

    for (const result of results) {
      if (result.operation !== 'NOOP') {
        memoryIds.push(result.id);
      }
    }
  }

  sessionMgr.markComplete(input.namespace, sectionNumber, memoryIds);

  // Return next section info
  const updatedSections = sessionMgr.createOrResume(input.namespace);
  const nextIncomplete = sessionMgr.getFirstIncompleteSection(updatedSections);

  if (nextIncomplete === null) {
    const status = sessionMgr.getStatus(input.namespace)!;
    return {
      submitted: sectionNumber,
      memories_stored: memoryIds.length,
      complete: true,
      message: 'All sections are complete! Bootstrap finished.',
      total_memories: status.total_memories,
    };
  }

  const nextDef = getSectionByNumber(nextIncomplete)!;
  return {
    submitted: sectionNumber,
    memories_stored: memoryIds.length,
    complete: false,
    next_section: nextIncomplete,
    title: nextDef.title,
    questions: nextDef.questions,
    progress: {
      complete: updatedSections.filter(s => s.status === 'complete').length,
      total: TOTAL_SECTIONS,
    },
  };
}

function handleStatus(sessionMgr: BootstrapSessionManager, namespace: string) {
  const status = sessionMgr.getStatus(namespace);
  if (!status) {
    return {
      exists: false,
      message: 'No bootstrap session found. Call bootstrap with action: "start" to begin.',
    };
  }

  return {
    exists: true,
    namespace: status.namespace,
    complete_sections: status.complete_sections,
    total_sections: status.total_sections,
    total_memories: status.total_memories,
    last_updated: status.last_updated,
    sections: status.sections.map(s => ({
      section: s.section_number,
      title: getSectionByNumber(s.section_number)?.title ?? `Section ${s.section_number}`,
      status: s.status,
      memory_count: s.memory_ids.length,
    })),
  };
}

async function handleReset(ctx: ToolContext, sessionMgr: BootstrapSessionManager, input: BootstrapInput) {
  if (!input.section) {
    throw invalidInput('section is required for reset action');
  }

  const sectionNumber = input.section;
  if (!getSectionByNumber(sectionNumber)) {
    throw invalidInput(`Invalid section number: ${sectionNumber}`);
  }

  if (!sessionMgr.exists(input.namespace)) {
    throw invalidInput('No bootstrap session found. Call start first.');
  }

  const sections = sessionMgr.createOrResume(input.namespace);
  const sectionRow = sections.find(s => s.section_number === sectionNumber);
  if (sectionRow?.status === 'pending') {
    return {
      section: sectionNumber,
      message: `Section ${sectionNumber} is already pending. Nothing to reset.`,
      memories_removed: 0,
    };
  }

  const memoryIds = sessionMgr.resetSection(input.namespace, sectionNumber);

  // Delete the tracked memories
  let deleted = 0;
  for (const id of memoryIds) {
    const removed = await ctx.storage.deleteMemory(id);
    if (removed) deleted++;
  }

  return {
    section: sectionNumber,
    message: `Section ${sectionNumber} reset. ${deleted} memories removed.`,
    memories_removed: deleted,
  };
}
