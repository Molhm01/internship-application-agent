import { createHash } from 'node:crypto';
import {
  answerContextBundleSchema,
  assessPromptInjection,
  type AnswerContextBundle,
  type ApprovedAnswer,
  type DocumentExtraction,
  type EvidenceCategory,
  type EvidenceItem,
  type GenerateAnswerRequest,
  type Profile,
  type QuestionClassification,
} from '@internship-agent/shared';

const CONTEXT_TEXT_LIMIT = 24_000;
const STOP_WORDS = new Set([
  'about',
  'and',
  'are',
  'describe',
  'for',
  'from',
  'have',
  'how',
  'interested',
  'please',
  'that',
  'the',
  'this',
  'what',
  'when',
  'where',
  'why',
  'with',
  'would',
  'your',
]);

function id(reference: string): string {
  return `ev-${createHash('sha256').update(reference).digest('hex').slice(0, 20)}`;
}

function tokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9+#.]{2,}/g) ?? []).filter((token) => !STOP_WORDS.has(token)),
  );
}

function makeEvidence(
  source: EvidenceItem['source'],
  sourceReference: string,
  category: EvidenceCategory,
  text: string,
  facts: string[],
): EvidenceItem | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return {
    id: id(`${source}:${sourceReference}`),
    source,
    sourceReference,
    category,
    text: normalized.slice(0, 6000),
    facts: facts
      .map((fact) => fact.trim())
      .filter(Boolean)
      .slice(0, 100),
    relevanceScore: 0,
    sensitive: false,
    verified: true,
  };
}

function add(target: EvidenceItem[], item: EvidenceItem | null): void {
  if (item) target.push(item);
}

function profileEvidence(profile: Profile): EvidenceItem[] {
  const result: EvidenceItem[] = [];
  for (const education of profile.education) {
    const facts = [
      education.institution,
      education.degree,
      education.major,
      education.minor,
      ...education.coursework,
      ...education.honors,
      ...education.activities,
    ].filter((value): value is string => Boolean(value));
    add(
      result,
      makeEvidence(
        'profile',
        `profile.education.${education.id}`,
        'education',
        facts.join('. '),
        facts,
      ),
    );
    if (education.activities.length) {
      add(
        result,
        makeEvidence(
          'profile',
          `profile.education.${education.id}.activities`,
          'activity',
          education.activities.join('. '),
          education.activities,
        ),
      );
    }
  }
  for (const experience of profile.experience) {
    const facts = [
      experience.employer,
      experience.title,
      ...experience.responsibilities,
      ...experience.achievements,
    ].filter((value): value is string => Boolean(value));
    add(
      result,
      makeEvidence(
        'profile',
        `profile.experience.${experience.id}`,
        'experience',
        facts.join('. '),
        facts,
      ),
    );
  }
  for (const project of profile.projects) {
    const facts = [
      project.name,
      project.description,
      ...project.technologies,
      ...project.accomplishments,
    ].filter((value): value is string => Boolean(value));
    add(
      result,
      makeEvidence('profile', `profile.projects.${project.id}`, 'project', facts.join('. '), facts),
    );
  }
  for (const volunteering of profile.volunteering) {
    const facts = [volunteering.organization, volunteering.role, volunteering.description].filter(
      (value): value is string => Boolean(value),
    );
    add(
      result,
      makeEvidence(
        'profile',
        `profile.volunteering.${volunteering.id}`,
        'volunteering',
        facts.join('. '),
        facts,
      ),
    );
  }
  const skills = [
    ...profile.skills.technical,
    ...profile.skills.programmingLanguages,
    ...profile.skills.engineeringSoftware,
    ...profile.skills.hardware,
  ];
  add(result, makeEvidence('profile', 'profile.skills', 'skill', skills.join(', '), skills));
  if (profile.preferences.targetRoles.length || profile.preferences.industries.length) {
    const facts = [
      ...profile.preferences.targetRoles.map((role) => `Target role: ${role}`),
      ...profile.preferences.industries.map((industry) => `Industry interest: ${industry}`),
    ];
    add(result, makeEvidence('profile', 'profile.preferences', 'other', facts.join('. '), facts));
  }
  return result;
}

function resumeEvidence(extraction: DocumentExtraction | null): EvidenceItem[] {
  if (!extraction || extraction.status !== 'completed') return [];
  return extraction.sections.slice(0, 20).flatMap((section, index) => {
    const category: EvidenceCategory =
      section.name === 'education'
        ? 'education'
        : section.name === 'experience'
          ? 'experience'
          : section.name === 'projects'
            ? 'project'
            : section.name === 'skills'
              ? 'skill'
              : section.name === 'activities'
                ? 'activity'
                : 'other';
    const item = makeEvidence(
      'resume',
      `resume.${extraction.documentId}.${section.name}.${index}`,
      category,
      section.text,
      section.text
        .split(/[.\n•]+/)
        .map((fact) => fact.trim())
        .filter(Boolean)
        .slice(0, 100),
    );
    return item ? [item] : [];
  });
}

function jobEvidence(request: GenerateAnswerRequest): EvidenceItem[] {
  const job = request.jobContext;
  const result: EvidenceItem[] = [];
  if (job.company) {
    add(
      result,
      makeEvidence('job_context', 'jobContext.company', 'company', job.company, [job.company]),
    );
  }
  const jobFacts = [
    job.jobTitle,
    job.location,
    job.department,
    job.employmentType,
    ...(job.responsibilities ?? []),
    ...(job.qualifications ?? []),
  ].filter((value): value is string => Boolean(value));
  add(result, makeEvidence('job_context', 'jobContext.job', 'job', jobFacts.join('. '), jobFacts));
  if (job.description) {
    add(
      result,
      makeEvidence(
        'job_context',
        'jobContext.description',
        'job',
        job.description.slice(0, 6000),
        [],
      ),
    );
  }
  return result;
}

const CATEGORY_BOOSTS: Partial<Record<QuestionClassification, readonly EvidenceCategory[]>> = {
  why_company: ['company', 'job', 'skill', 'other'],
  why_role: ['job', 'skill', 'project', 'experience', 'other'],
  why_company_and_role: ['company', 'job', 'skill', 'project', 'experience'],
  tell_me_about_yourself: ['education', 'experience', 'project', 'skill'],
  relevant_experience: ['experience', 'project', 'skill'],
  relevant_project: ['project', 'skill', 'education'],
  technical_skills: ['skill', 'project', 'experience', 'education'],
  leadership: ['activity', 'volunteering', 'experience', 'project'],
  teamwork: ['experience', 'project', 'activity', 'volunteering'],
  challenge: ['experience', 'project', 'activity', 'volunteering'],
  conflict: ['experience', 'project', 'activity', 'volunteering'],
  failure: ['experience', 'project', 'activity'],
  achievement: ['experience', 'project', 'education', 'activity'],
  problem_solving: ['project', 'experience', 'skill'],
  career_goals: ['other', 'education', 'skill', 'job'],
  industry_interest: ['other', 'job', 'skill'],
  strengths: ['experience', 'project', 'skill', 'education'],
  qualifications_summary: ['experience', 'project', 'skill', 'education', 'job'],
  values_alignment: ['job', 'company', 'other', 'activity'],
};

function scoreEvidence(
  evidence: EvidenceItem,
  classification: QuestionClassification,
  queryTokens: Set<string>,
): EvidenceItem {
  const haystack = tokens(`${evidence.text} ${evidence.facts.join(' ')}`);
  let lexical = 0;
  for (const token of queryTokens) if (haystack.has(token)) lexical += 4;
  lexical = Math.min(lexical, evidence.source === 'job_context' ? 8 : 40);
  const categories = CATEGORY_BOOSTS[classification] ?? [];
  const categoryIndex = categories.indexOf(evidence.category);
  const categoryBoost = categoryIndex < 0 ? 0 : Math.max(4, 18 - categoryIndex * 3);
  const sourceBoost = evidence.source === 'user_override' ? 25 : 0;
  return {
    ...evidence,
    relevanceScore: Math.min(100, lexical + categoryBoost + sourceBoost),
  };
}

export interface EvidenceInput {
  request: GenerateAnswerRequest;
  classification: QuestionClassification;
  profile: Profile;
  approvedAnswers: ApprovedAnswer[];
  extraction: DocumentExtraction | null;
}

export function assembleAnswerContext(input: EvidenceInput): AnswerContextBundle {
  const { request, classification, profile, approvedAnswers, extraction } = input;
  const approved = approvedAnswers.filter(
    (answer) =>
      answer.approved &&
      !answer.sensitive &&
      typeof answer.answer === 'string' &&
      (answer.tailoringAllowed || answer.canonicalQuestion === request.question),
  );
  const approvedEvidence = approved.flatMap((answer) => {
    const item = makeEvidence(
      'approved_answer',
      `approvedAnswers.${answer.id}`,
      'other',
      String(answer.answer),
      [String(answer.answer)],
    );
    return item ? [item] : [];
  });
  const userEvidence = request.userEvidence.flatMap((text, index) => {
    const item = makeEvidence('user_override', `userEvidence.${index}`, 'other', text, [text]);
    return item ? [item] : [];
  });
  const all = [
    ...profileEvidence(profile),
    ...resumeEvidence(extraction),
    ...approvedEvidence,
    ...jobEvidence(request),
    ...userEvidence,
  ];
  const query = tokens(
    [
      request.question,
      request.jobContext.jobTitle,
      ...(request.jobContext.qualifications ?? []),
      ...(request.jobContext.responsibilities ?? []),
    ]
      .filter(Boolean)
      .join(' '),
  );
  const ranked = all
    .map((evidence) => scoreEvidence(evidence, classification, query))
    .filter((evidence) => evidence.verified && !evidence.sensitive && evidence.relevanceScore > 0)
    .sort(
      (left, right) =>
        right.relevanceScore - left.relevanceScore ||
        left.sourceReference.localeCompare(right.sourceReference),
    );
  const selected: EvidenceItem[] = [];
  let size = 0;
  for (const evidence of ranked) {
    if (selected.length >= 20) break;
    if (size + evidence.text.length > CONTEXT_TEXT_LIMIT) continue;
    selected.push(evidence);
    size += evidence.text.length;
  }
  const injection = assessPromptInjection(request.question, request.jobContext.description);
  return answerContextBundleSchema.parse({
    question: request.question,
    classification,
    constraints: request.constraints ?? {},
    jobContext: request.jobContext,
    evidence: selected,
    approvedAnswerExamples: approved.map((answer) => String(answer.answer)).slice(0, 10),
    stylePreferences: {
      tone: request.settings.preferredTone,
      verbosity: request.settings.defaultAnswerLength,
      useStarWhenAppropriate: true,
      avoidCliches: true,
    },
    promptInjectionWarnings: injection.warnings,
  });
}

const STORY_TYPES = new Set<QuestionClassification>([
  'leadership',
  'teamwork',
  'challenge',
  'conflict',
  'failure',
  'achievement',
  'problem_solving',
]);

export function missingEvidenceForContext(context: AnswerContextBundle): string[] {
  const nonJob = context.evidence.filter(
    (item) => item.source !== 'job_context' && item.source !== 'approved_answer',
  );
  if (STORY_TYPES.has(context.classification)) {
    const story = nonJob.filter((item) =>
      ['experience', 'project', 'activity', 'volunteering', 'other'].includes(item.category),
    );
    const requiredSignals: Partial<Record<QuestionClassification, RegExp>> = {
      leadership: /\b(lead|managed|mentor|coordinat|organized)\b/i,
      teamwork: /\b(team|collaborat|partner|group)\b/i,
      challenge: /\b(challenge|obstacle|difficult|overcame|problem)\b/i,
      conflict: /\b(conflict|disagree|dispute|tension|resolved)\b/i,
      failure: /\b(fail|mistake|error|went wrong|learned)\b/i,
      achievement: /\b(?:achiev\w*|accomplish\w*|improv\w*|award\w*|success\w*)\b/i,
      problem_solving: /\b(problem|debug|solve|troubleshoot|fix)\b/i,
    };
    const signal = requiredSignals[context.classification];
    if (!story.length || (signal && !story.some((item) => signal.test(item.text)))) {
      return ['A verified situation or example', 'Your specific action', 'The verified outcome'];
    }
  }
  if (
    ['why_company', 'why_role', 'why_company_and_role'].includes(context.classification) &&
    !nonJob.length
  ) {
    return ['A saved skill, project, experience, interest, or career goal relevant to this role'];
  }
  if (!nonJob.length)
    return ['Verified information from your profile, resume, or an explicit note'];
  return [];
}
