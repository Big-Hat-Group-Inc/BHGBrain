import type { MemoryType, RetentionTier } from '../domain/types.js';

export interface SectionDefinition {
  section: number;
  title: string;
  collection: string;
  type: MemoryType;
  retention_tier: RetentionTier;
  importance: number;
  tags: string[];
  questions: string[];
}

/**
 * The 10 storage-mapped sections from the BHGBrain bootstrap interview.
 * This is the single source of truth for section metadata used by both
 * the ProfileParser (bulk import) and the bootstrap tool (interactive).
 */
export const BOOTSTRAP_SECTIONS: SectionDefinition[] = [
  {
    section: 1,
    title: 'Identity & Role',
    collection: 'identity',
    type: 'semantic',
    retention_tier: 'T0',
    importance: 1.0,
    tags: ['identity', 'role', 'profile'],
    questions: [
      'What is your full name and preferred short name for work systems?',
      'What titles or roles do you currently operate under?',
      'Which role is primary?',
      'Which roles are internal vs client-facing vs technical?',
      'What kinds of decisions are you responsible for making?',
    ],
  },
  {
    section: 2,
    title: 'Responsibilities & Outcomes',
    collection: 'responsibilities',
    type: 'semantic',
    retention_tier: 'T1',
    importance: 0.8,
    tags: ['responsibilities', 'accountability', 'outcomes'],
    questions: [
      'What are you accountable for each week?',
      'What work do you personally own?',
      'What work do you influence but not own?',
      'What are the top outcomes you need this second brain to support?',
      'What would make this system feel immediately useful?',
    ],
  },
  {
    section: 3,
    title: 'Goals & Priorities',
    collection: 'goals',
    type: 'semantic',
    retention_tier: 'T1',
    importance: 0.75,
    tags: ['goals', 'priorities', 'timeline'],
    questions: [
      'What are your short-term goals for the next 30 days?',
      'What are your medium-term goals for the next quarter?',
      'What are your longer-term goals for the year?',
      'Which goals are most important right now?',
      'Where do you currently lose time, clarity, or momentum?',
    ],
  },
  {
    section: 4,
    title: 'Communication Style',
    collection: 'communication',
    type: 'semantic',
    retention_tier: 'T2',
    importance: 0.55,
    tags: ['communication', 'style', 'preferences'],
    questions: [
      'How do you prefer information to be presented?',
      'Do you prefer concise summaries, detailed breakdowns, or layered answers?',
      'What tone works best for you?',
      'How should a system challenge you when your thinking is unclear?',
      'How should it help you write messages, plans, or technical explanations?',
    ],
  },
  {
    section: 5,
    title: 'Work Patterns',
    collection: 'work-patterns',
    type: 'procedural',
    retention_tier: 'T2',
    importance: 0.55,
    tags: ['work-patterns', 'schedule', 'workflow'],
    questions: [
      'When do you do your best strategic thinking?',
      'When do you do your best execution work?',
      'How do you prefer to plan your day and week?',
      'Do you work better from checklists, dashboards, notes, or conversations?',
      'What recurring workflows should this second brain support?',
    ],
  },
  {
    section: 6,
    title: 'Tools & Systems',
    collection: 'tools',
    type: 'semantic',
    retention_tier: 'T1',
    importance: 0.7,
    tags: ['tools', 'systems', 'sources-of-truth'],
    questions: [
      'What tools do you use regularly?',
      'Which tools are sources of truth?',
      'Where do projects, code, meetings, decisions, and documentation currently live?',
      'What should this second brain reference often?',
      'What should it never treat as authoritative without checking?',
    ],
  },
  {
    section: 7,
    title: 'Company & Entity Mapping',
    collection: 'entities',
    type: 'semantic',
    retention_tier: 'T0',
    importance: 0.95,
    tags: ['entity', 'company', 'client', 'disambiguation'],
    questions: [
      'What companies, clients, or organizations do you work with?',
      'For each entity: What type is it? What is your relationship to it?',
      'What work do you do for each?',
      'Who owns each entity?',
      'How do entities relate to each other? Are any names commonly confused?',
    ],
  },
  {
    section: 8,
    title: 'GitHub & Repository Structure',
    collection: 'repositories',
    type: 'semantic',
    retention_tier: 'T0',
    importance: 0.9,
    tags: ['github', 'repo', 'org', 'disambiguation'],
    questions: [
      'Which GitHub orgs or accounts do you use?',
      'Which are personal vs company vs client-related?',
      'Which repositories belong to which entities?',
      'Are any repos used by one entity on behalf of another?',
      'Which names are commonly confused and need disambiguation?',
    ],
  },
  {
    section: 9,
    title: 'Tenants & Environments',
    collection: 'tenants',
    type: 'semantic',
    retention_tier: 'T0',
    importance: 0.9,
    tags: ['tenant', 'environment', 'azure', 'm365'],
    questions: [
      'What tenants or environments do you manage?',
      'For each: Who owns it? Who uses it?',
      'Is it dev, test, staging, production, or something else?',
      'Which product does it belong to?',
      'Which company pays for it (customer) vs operates it (provider)?',
    ],
  },
  {
    section: 10,
    title: 'Operating Rules',
    collection: 'operating-rules',
    type: 'procedural',
    retention_tier: 'T0',
    importance: 1.0,
    tags: ['rules', 'conventions', 'disambiguation', 'behavior'],
    questions: [
      'What naming conventions should the system follow?',
      'How should ambiguity be handled?',
      'How should the system distinguish customer vs provider?',
      'What default assumptions should it avoid?',
      'What should it ask about before acting when context is incomplete?',
    ],
  },
];

export const TOTAL_SECTIONS = BOOTSTRAP_SECTIONS.length;

export function getSectionByNumber(section: number): SectionDefinition | undefined {
  return BOOTSTRAP_SECTIONS.find(s => s.section === section);
}
