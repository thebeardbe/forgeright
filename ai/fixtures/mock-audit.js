/**
 * Illustrative audit fixture used by the mock provider.
 *
 * ILLUSTRATIVE DATA. Generated to demonstrate the analysis. Not a real client.
 *
 * This is the structured contract the scoring layer consumes: one record per
 * workflow, with the raw inputs the score is computed from. Real providers must
 * emit this same shape.
 *
 * The data is deliberately imperfect. `invoice-processing` carries a genuine
 * contradiction: the same workflow is reported by two people with very
 * different time estimates. `proposal-drafting` is judgement-heavy and should
 * score low despite high effort, which is the case that separates a diagnostic
 * from a wish list.
 *
 * Each workflow carries:
 *   id             stable key
 *   title          human label
 *   frequencyPerWeek  how often one instance happens, per week
 *   minutesPerInstance how long one instance takes
 *   peopleAffected how many people touch the workflow
 *   judgementScore 1-5, where 1 = pure judgement, 5 = pure rules
 *   stepsConsistent  true when the steps are the same every time
 *   tools          what is used today
 *   reportedBy     who gave this estimate, so conflicts are visible
 */

const WORKFLOWS = [
    {
        id: 'invoice-processing',
        title: 'Invoice intake and processing',
        frequencyPerWeek: 40,
        minutesPerInstance: 8,
        peopleAffected: 3,
        judgementScore: 5,
        stepsConsistent: true,
        tools: ['Email', 'Excel', 'Bookkeeping package'],
        reportedBy: 'Finance'
    },
    {
        id: 'invoice-processing-2',
        title: 'Invoice intake and processing (second respondent)',
        frequencyPerWeek: 40,
        minutesPerInstance: 22,
        peopleAffected: 3,
        judgementScore: 4,
        stepsConsistent: false,
        tools: ['Email', 'Excel'],
        reportedBy: 'Finance (second respondent)',
        // Same workflow, different answers. This one exists to prove the
        // analysis surfaces the disagreement rather than silently averaging it.
        conflictsWith: 'invoice-processing'
    },
    {
        id: 'payroll-checks',
        title: 'Monthly payroll pre-checks',
        frequencyPerWeek: 2,
        minutesPerInstance: 90,
        peopleAffected: 2,
        judgementScore: 5,
        stepsConsistent: true,
        tools: ['Excel', 'Payroll package'],
        reportedBy: 'Payroll'
    },
    {
        id: 'safety-incident-logging',
        title: 'Safety incident logging and reporting',
        frequencyPerWeek: 5,
        minutesPerInstance: 30,
        peopleAffected: 4,
        judgementScore: 4,
        stepsConsistent: true,
        tools: ['Paper form', 'Email', 'Excel'],
        reportedBy: 'Safety'
    },
    {
        id: 'contract-review',
        title: 'Contract clause review',
        frequencyPerWeek: 6,
        minutesPerInstance: 75,
        peopleAffected: 3,
        judgementScore: 1,
        stepsConsistent: false,
        tools: ['Word', 'Email'],
        reportedBy: 'Legal'
    },
    {
        id: 'timesheet-collection',
        title: 'Collecting and chasing timesheets',
        frequencyPerWeek: 10,
        minutesPerInstance: 25,
        peopleAffected: 6,
        judgementScore: 5,
        stepsConsistent: true,
        tools: ['Excel', 'Email'],
        reportedBy: 'Finance'
    },
    {
        id: 'proposal-drafting',
        title: 'Drafting client proposals',
        frequencyPerWeek: 3,
        minutesPerInstance: 120,
        peopleAffected: 2,
        judgementScore: 1,
        stepsConsistent: false,
        tools: ['Word', 'Email', 'CRM'],
        reportedBy: 'Sales'
    },
    {
        id: 'supplier-onboarding',
        title: 'Supplier onboarding paperwork',
        frequencyPerWeek: 1,
        minutesPerInstance: 45,
        peopleAffected: 3,
        judgementScore: 4,
        stepsConsistent: true,
        tools: ['Email', 'PDF forms'],
        reportedBy: 'Finance'
    }
];

const DATA_NOTE = {
    nl: 'Illustratieve antwoorden, gegenereerd om de analyse te demonstreren.',
    en: 'Illustrative responses, generated to demonstrate the analysis.',
    fr: 'Réponses illustratives, générées pour démontrer l\'analyse.'
};

/**
 * @param {string} lang One of nl, en, fr.
 * @returns {{illustrative: boolean, note: string, workflows: Array<object>}}
 */
export function buildMockAudit(lang = 'en') {
    const note = DATA_NOTE[lang] || DATA_NOTE.en;
    // Deep copy so a caller mutating one response cannot corrupt the next.
    return {
        illustrative: true,
        note,
        workflows: WORKFLOWS.map((w) => ({ ...w, tools: [...w.tools] }))
    };
}
