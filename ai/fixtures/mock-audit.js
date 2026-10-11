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
 *   id                 stable key
 *   title              human label
 *   frequencyPerWeek   how often one instance happens, per week
 *   timePerPeriod      the continuous case instead; null for everything here
 *   minutesPerInstance how long one instance takes
 *   peopleAffected     how many people touch the workflow
 *   tools              what is used today (the old name for `systems`)
 *   reportedBy         who gave this estimate, so conflicts are visible
 *
 * The DETAIL table below adds the completeness-matrix fields, including steps[]
 * with each step's decidedHow and its DERIVED needsReasoning flag.
 *
 * THERE IS NO PROCESS-LEVEL judgementScore, DELIBERATELY. It used to be here, and
 * it contradicted the per-step flags: contract-review was marked 1 ("needs a
 * person") while three of its four steps follow rules, which is exactly the
 * process-level reading the spec says hides the automation boundary. The scorer
 * derives the 1-5 band from the step flags, so keeping both would have meant the
 * stale field winning and the new data being ignored.
 */

const WORKFLOWS = [
    {
        id: 'invoice-processing',
        title: 'Invoice intake and processing',
        frequencyPerWeek: 40,
        minutesPerInstance: 8,
        peopleAffected: 3,
        tools: ['Email', 'Excel', 'Bookkeeping package'],
        reportedBy: 'Finance'
    },
    {
        id: 'invoice-processing-2',
        title: 'Invoice intake and processing (second respondent)',
        frequencyPerWeek: 40,
        minutesPerInstance: 22,
        peopleAffected: 3,
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
        tools: ['Excel', 'Payroll package'],
        reportedBy: 'Payroll'
    },
    {
        id: 'safety-incident-logging',
        title: 'Safety incident logging and reporting',
        frequencyPerWeek: 5,
        minutesPerInstance: 30,
        peopleAffected: 4,
        tools: ['Paper form', 'Email', 'Excel'],
        reportedBy: 'Safety'
    },
    {
        id: 'contract-review',
        title: 'Contract clause review',
        frequencyPerWeek: 6,
        minutesPerInstance: 75,
        peopleAffected: 3,
        tools: ['Word', 'Email'],
        reportedBy: 'Legal'
    },
    {
        id: 'timesheet-collection',
        title: 'Collecting and chasing timesheets',
        frequencyPerWeek: 10,
        minutesPerInstance: 25,
        peopleAffected: 6,
        tools: ['Excel', 'Email'],
        reportedBy: 'Finance'
    },
    {
        id: 'proposal-drafting',
        title: 'Drafting client proposals',
        frequencyPerWeek: 3,
        minutesPerInstance: 120,
        peopleAffected: 2,
        tools: ['Word', 'Email', 'CRM'],
        reportedBy: 'Sales'
    },
    {
        id: 'supplier-onboarding',
        title: 'Supplier onboarding paperwork',
        frequencyPerWeek: 1,
        minutesPerInstance: 45,
        peopleAffected: 3,
        tools: ['Email', 'PDF forms'],
        reportedBy: 'Finance'
    }
];

/**
 * The per-step detail each workflow needs, and the process-level fields the
 * matrix asks for beyond the effort figures.
 *
 * SEPARATE FROM THE ENVELOPE ABOVE so the numbers stay readable as a table and
 * the new fields are not buried in it. `decidedHow` is the participant's stated
 * BASIS, and `needsReasoning` is the derived flag: `false` for a fixed threshold
 * or a checklist, `true` where the decision turns on the case in front of them.
 *
 * ILLUSTRATIVE. Written to exercise the shape, not measured from a real client.
 *
 * Note `invoice-processing` and its second respondent: the SAME process, with one
 * step where the two disagree about the basis for deciding (a stock-level rule
 * versus a judgement about the supplier). That is deliberate, because a
 * disagreement on `needsReasoning` is exactly what changes a bucket.
 */
const DETAIL = {
    'invoice-processing': {
        task: "Matching supplier invoices to purchase orders and booking them",
        trigger: "an invoice arrives in the shared inbox",
        systems: ["Outlook", "Excel", "Bookkeeping package"],
        steps: [
            { name: 'Open the invoice', whatHappens: 'Read the incoming invoice email and save the PDF.', decidedHow: 'the invoice is in the shared inbox', needsReasoning: false },
            { name: 'Find the purchase order', whatHappens: 'Search the bookkeeping package by invoice number.', decidedHow: 'I search on the invoice number', needsReasoning: false },
            { name: 'Match the amounts', whatHappens: 'Compare the invoice total with the order total.', decidedHow: 'if they differ by more than 2 euros I stop and ask', needsReasoning: false },
            { name: 'Query a mismatch', whatHappens: 'Email the supplier or the buyer about the difference.', decidedHow: 'depends what the difference is and who replies fastest', needsReasoning: true },
            { name: 'Book the invoice', whatHappens: 'Key the invoice into the bookkeeping package.', decidedHow: 'the booking is per the matched order', needsReasoning: false }
        ],
        handoffTo: ['Finance manager'],
        waitsFor: ["the buyer's confirmation on a mismatch"],
        dependsOn: ['the goods being received'],
        touchedDepartments: ['Finance', 'Purchasing'],
        mistakesPerPeriod: 3,
        mistakeConsequence: 'The invoice is paid late and we lose the early-payment discount.',
        currentState: 'One person keys every invoice in by hand from a shared inbox.',
        frustration: 'The searching. It is the same ten minutes over and over.'
    },
    'invoice-processing-2': {
        task: "Matching supplier invoices to purchase orders and booking them",
        trigger: "an invoice arrives by email",
        systems: ["Outlook", "Excel"],
        steps: [
            { name: 'Open the invoice', whatHappens: 'Read the invoice email and save the PDF.', decidedHow: 'it arrives in the shared inbox', needsReasoning: false },
            { name: 'Find the purchase order', whatHappens: 'Search the bookkeeping package for the order.', decidedHow: 'I search on the supplier and the date', needsReasoning: false },
            { name: 'Match the amounts', whatHappens: 'Compare invoice and order totals.', decidedHow: 'depends on the supplier, sometimes we let a small difference through', needsReasoning: true },
            { name: 'Book the invoice', whatHappens: 'Key the invoice into the bookkeeping package.', decidedHow: 'per the matched order', needsReasoning: false }
        ],
        handoffTo: ['Finance manager'],
        waitsFor: ['the supplier to reply'],
        dependsOn: ['the goods being received'],
        touchedDepartments: ['Finance'],
        mistakesPerPeriod: 6,
        mistakeConsequence: 'Duplicate payments, which then have to be reclaimed.',
        currentState: 'Every invoice is checked by hand, twice when it is busy.',
        frustration: 'Being asked to justify every small difference.'
    },
    'payroll-checks': {
        task: "Checking the monthly payroll run before it goes out",
        trigger: "the month ending",
        systems: ["Time system", "Excel", "Payroll package"],
        steps: [
            { name: 'Pull the hours', whatHappens: 'Export hours from the time system into Excel.', decidedHow: 'the export is everything since the last run', needsReasoning: false },
            { name: 'Check against contracts', whatHappens: 'Compare each line with contracted hours.', decidedHow: 'over 10 hours of overtime I check with the manager first', needsReasoning: false },
            { name: 'Resolve an exception', whatHappens: 'Work out what someone should actually be paid.', decidedHow: 'depends on their contract and what they tell me', needsReasoning: true },
            { name: 'Release the run', whatHappens: 'Approve the payroll run for payment.', decidedHow: 'the totals match the previous month', needsReasoning: false }
        ],
        handoffTo: ['Payroll bureau'],
        waitsFor: ['the manager to confirm overtime'],
        dependsOn: ['the time system being closed'],
        touchedDepartments: ['Payroll', 'Operations'],
        mistakesPerPeriod: 1,
        mistakeConsequence: 'Someone is paid wrong and it takes a month to correct.',
        currentState: 'Exported to Excel and checked line by line.',
        frustration: 'Chasing managers for overtime approval.'
    },
    'safety-incident-logging': {
        task: "Logging safety incidents and reporting them monthly",
        trigger: "an incident on the line",
        systems: ["Paper form", "Excel", "Outlook"],
        steps: [
            { name: 'Record the incident', whatHappens: 'Fill in the paper form at the line.', decidedHow: 'the form has the fields it has', needsReasoning: false },
            { name: 'Rate the severity', whatHappens: 'Decide how serious it was.', decidedHow: 'depends what happened and whether anyone was hurt', needsReasoning: true },
            { name: 'Enter it in the register', whatHappens: 'Type the form into the Excel register.', decidedHow: 'the register mirrors the form', needsReasoning: false },
            { name: 'Report it', whatHappens: 'Email the monthly summary to the safety officer.', decidedHow: 'it goes out on the first Monday', needsReasoning: false }
        ],
        handoffTo: ['Safety officer'],
        waitsFor: ['the form to come back from the line'],
        dependsOn: ['the incident being witnessed'],
        touchedDepartments: ['Safety', 'Operations'],
        mistakesPerPeriod: 2,
        mistakeConsequence: 'A pattern across incidents is missed and the fix is late.',
        currentState: 'Paper form on the line, typed into Excel afterwards.',
        frustration: 'The paper form goes missing before anyone types it in.'
    },
    'contract-review': {
        task: "Reviewing client contracts before we sign",
        trigger: "a client sending a draft contract",
        systems: ["Word", "Outlook"],
        steps: [
            { name: 'Read the contract', whatHappens: 'Read the whole document, clause by clause.', decidedHow: 'clauses that limit our liability get a closer read', needsReasoning: false },
            { name: 'Judge the risk', whatHappens: 'Decide whether a clause is acceptable.', decidedHow: 'depends on the deal and on how the client negotiates', needsReasoning: true },
            { name: 'Write the comments', whatHappens: 'Mark up the document with track changes.', decidedHow: 'in our standard wording where we have it', needsReasoning: false },
            { name: 'Send it back', whatHappens: 'Email the marked-up contract to the client.', decidedHow: 'it goes to whoever sent it', needsReasoning: false }
        ],
        handoffTo: ['Sales', 'the client'],
        waitsFor: ['the client to come back on our comments'],
        dependsOn: ['the deal being agreed in principle'],
        touchedDepartments: ['Legal', 'Sales'],
        mistakesPerPeriod: 1,
        mistakeConsequence: 'An unfavourable clause is accepted and binds us for years.',
        currentState: 'Read by one of two lawyers, marked up in Word.',
        frustration: 'Reading the same boilerplate over and over.'
    },
    'timesheet-collection': {
        task: "Collecting weekly timesheets and chasing the late ones",
        trigger: "the week ending",
        systems: ["Excel", "Outlook"],
        steps: [
            { name: 'Send the reminder', whatHappens: 'Email everyone who has not submitted.', decidedHow: 'the Friday before, everyone on the list', needsReasoning: false },
            { name: 'Chase the stragglers', whatHappens: 'Contact the people still missing.', decidedHow: 'depends who it is and how often they are late', needsReasoning: true },
            { name: 'Check the entries', whatHappens: 'Check totals against the project codes.', decidedHow: 'a total over the contracted hours gets checked', needsReasoning: false },
            { name: 'Close the week', whatHappens: 'Lock the sheet and send it to payroll.', decidedHow: 'once every line is in', needsReasoning: false }
        ],
        handoffTo: ['Payroll'],
        waitsFor: ['everyone to submit'],
        dependsOn: ['the week ending'],
        touchedDepartments: ['Finance', 'every department'],
        mistakesPerPeriod: 8,
        mistakeConsequence: 'Late submission delays invoicing for the whole month.',
        currentState: 'One Excel sheet per department, collected by email.',
        frustration: 'Chasing the same people every single week.'
    },
    'proposal-drafting': {
        task: "Writing and pricing client proposals",
        trigger: "a client asking for a proposal",
        systems: ["Word", "Outlook", "CRM"],
        steps: [
            { name: 'Gather the requirements', whatHappens: 'Collect what the client asked for.', decidedHow: 'whatever is in the brief and the last call', needsReasoning: false },
            { name: 'Choose the approach', whatHappens: 'Decide how we would solve it.', decidedHow: 'depends on the client, the budget and what we have done before', needsReasoning: true },
            { name: 'Write the proposal', whatHappens: 'Draft the document from our template.', decidedHow: 'the template covers the structure', needsReasoning: false },
            { name: 'Price it', whatHappens: 'Work out what to charge.', decidedHow: 'I use the rate card and adjust for the deal', needsReasoning: true },
            { name: 'Send it', whatHappens: 'Email the proposal to the client.', decidedHow: 'after the partner has read it', needsReasoning: false }
        ],
        handoffTo: ['the client', 'the partner'],
        waitsFor: ['the partner to review'],
        dependsOn: ['the requirements call happening'],
        touchedDepartments: ['Sales'],
        mistakesPerPeriod: 1,
        mistakeConsequence: 'We underprice the work and the margin is gone.',
        currentState: 'Written from scratch in Word, reusing old proposals.',
        frustration: 'Rewriting the same sections every time.'
    },
    'supplier-onboarding': {
        task: "Onboarding a new supplier and checking their details",
        trigger: "a decision to buy from someone new",
        systems: ["Outlook", "PDF forms", "Bookkeeping package"],
        steps: [
            { name: 'Request the documents', whatHappens: 'Email the supplier for their details.', decidedHow: 'the checklist lists what we need', needsReasoning: false },
            { name: 'Check the documents', whatHappens: 'Verify the VAT number and the bank details.', decidedHow: 'the number matches the register and the bank letter matches', needsReasoning: false },
            { name: 'Judge an unusual supplier', whatHappens: 'Decide whether to accept a supplier outside the EU.', decidedHow: 'depends on the country and on what we are buying', needsReasoning: true },
            { name: 'Create the supplier record', whatHappens: 'Add the supplier to the bookkeeping package.', decidedHow: 'once everything checks out', needsReasoning: false }
        ],
        handoffTo: ['Purchasing'],
        waitsFor: ['the supplier to send their papers'],
        dependsOn: ['the purchase being agreed'],
        touchedDepartments: ['Finance', 'Purchasing'],
        mistakesPerPeriod: 1,
        mistakeConsequence: 'A payment goes to an account we cannot recover it from.',
        currentState: 'Email back and forth, checked against a paper checklist.',
        frustration: 'Suppliers who take a week to send one document.'
    }
};

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

    // Deep copy so a caller mutating one response cannot corrupt the next, and
    // merge in the per-step detail and the process-level fields, so the payload
    // exercises the whole completeness matrix rather than the effort figures
    // alone. `timePerPeriod` is null here because every workflow in this fixture
    // happens in instances; the continuous case is covered in the matrix tests.
    return {
        illustrative: true,
        note,
        workflows: WORKFLOWS.map((w) => ({
            ...w,
            ...DETAIL[w.id],
            steps: DETAIL[w.id].steps.map((step) => ({ ...step })),
            handoffTo: [...DETAIL[w.id].handoffTo],
            waitsFor: [...DETAIL[w.id].waitsFor],
            dependsOn: [...DETAIL[w.id].dependsOn],
            touchedDepartments: [...DETAIL[w.id].touchedDepartments],
            timePerPeriod: null,
            tools: [...w.tools]
        }))
    };
}
