/**
 * Mock adapter.
 *
 * A first-class provider, not a test double bolted on. It lets the whole flow
 * (questionnaire -> structured audit -> scoring -> roadmap) run with no key and
 * no network, which is what makes the UI and the scoring layer developable
 * before any provider credential exists.
 *
 * Behaviour: it asks the scripted questions in order, using the message count to
 * decide where it is, then emits a complete structured audit. The final payload
 * is deliberately shaped exactly like a real provider's output so nothing
 * downstream knows or cares that it is canned.
 */
import { buildMockAudit } from '../fixtures/mock-audit.js';

const QUESTIONS = {
    nl: [
        'Hoe vaak komt deze taak voor? Bijvoorbeeld dagelijks, wekelijks of maandelijks.',
        'Hoe lang duurt een enkele keer dat je dit doet, in minuten?',
        'Hoeveel mensen in het bedrijf zijn hierbij betrokken?',
        'Volgt dit altijd dezelfde stappen, of verschilt het per keer?',
        'Heb je hierbij je eigen oordeel nodig, of volgt het vaste regels?',
        'Wie anders is hierbij betrokken, en hoe bereikt het werk hen?',
        'Wat is het vervelendste deel van deze taak?',
        'Welke tools of systemen gebruik je hier nu voor?'
    ],
    en: [
        'How often does this task happen? Daily, weekly, monthly?',
        'How long does one instance take, in minutes?',
        'How many people in the company are involved in this?',
        'Does it always follow the same steps, or does it vary?',
        'Does this need your judgement, or does it follow fixed rules?',
        'Who else is involved, and how does the work reach them?',
        'What is the worst part of doing this task?',
        'Which tools or systems do you use for it today?'
    ],
    fr: [
        'À quelle fréquence cette tâche a-t-elle lieu ? Chaque jour, chaque semaine, chaque mois ?',
        'Combien de temps prend une seule fois, en minutes ?',
        'Combien de personnes dans l\'entreprise y participent ?',
        'Suit-elle toujours les mêmes étapes, ou est-ce variable ?',
        'Cela nécessite-t-il votre jugement, ou suit-il des règles fixes ?',
        'Qui d\'autre est impliqué, et comment le travail leur parvient-il ?',
        'Quelle est la pire partie de cette tâche ?',
        'Quels outils ou systèmes utilisez-vous aujourd\'hui ?'
    ]
};

const DONE_MESSAGE = {
    nl: 'Bedankt. Ik heb genoeg om de analyse op te maken.',
    en: 'Thank you. I have enough to produce the analysis.',
    fr: 'Merci. J\'ai assez d\'informations pour produire l\'analyse.'
};

const TOTAL_QUESTIONS = 8;

/**
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages Conversation so far.
 * @returns {Promise<string>} A JSON string, matching the real providers' contract.
 */
export async function generate({ messages, providerConfig }) {
    const lang = providerConfig?.lang && QUESTIONS[providerConfig.lang] ? providerConfig.lang : 'en';

    // Count user turns: each one is an answer to the previous question.
    const userTurns = messages.filter((m) => m.role === 'user').length;
    const questions = QUESTIONS[lang];

    if (userTurns < TOTAL_QUESTIONS) {
        return JSON.stringify({
            status: 'asking',
            content: questions[Math.min(userTurns, questions.length - 1)]
        });
    }

    return JSON.stringify({
        status: 'complete',
        content: DONE_MESSAGE[lang],
        audit: buildMockAudit(lang)
    });
}
