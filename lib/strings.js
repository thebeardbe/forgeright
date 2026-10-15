/**
 * UI strings, in one module so the copy can be reviewed and translated in one place. Trilingual, matching
 * the prompt sets.
 */
export const STRINGS = {
    nl: {
        lang: 'nl',
        pageTitle: 'Workflow Audit',
        subtitle: 'Diagnose, geen verkoopgesprek',
        heading: 'Waar kan AI echt het verschil maken?',
        intro: 'Een korte vragenlijst over het werk dat je doet. De analyse toont welke taken zich lenen voor automatisering, welke niet, en waarom.',
        inputPlaceholder: 'Typ je antwoord...',
        aiLabel: 'Analist',
        userLabel: 'Jij',
        initialMessage: 'Laten we beginnen met één taak die veel tijd kost. Welke taak komt bij jou het vaakst terug?',
        resumedNotice: 'Welkom terug. Hierboven staat wat je al verteld hebt. Ga verder waar je gebleven was.',
        networkError: 'Netwerkfout. Probeer opnieuw.',
        analysisTitle: 'Analyse',
        illustrativeBanner: 'Illustratieve antwoorden, gegenereerd om de analyse te demonstreren. Dit is geen echte klant.',
        doFirst: 'Eerst doen',
        doLater: 'Later doen',
        judgementBound: 'Niet automatiseren',
        conflictsTitle: 'Tegenstrijdige antwoorden',
        totalRecoverable: 'Persoonuren per week, over alle betrokkenen',
        notMeasured: 'niet gemeten',
        // Shown where a factor was answered IN WORDS, so no figure exists to multiply.
        // The score is a real zero; what is missing is the number, not the work.
        effortNotMeasured: 'inzet niet te meten',
        totalIsFloor: 'minstens',

        scoringFailed: 'De analyse kon niet worden berekend. Je antwoorden zijn bewaard, probeer opnieuw.',
        downloadMarkdown: 'Download Markdown',
    },
    en: {
        lang: 'en',
        pageTitle: 'Workflow Audit',
        subtitle: 'A diagnosis, not a sales call',
        heading: 'Where can AI actually make a difference?',
        intro: 'A short questionnaire about the work you do. The analysis shows which tasks are worth automating, which are not, and why.',
        inputPlaceholder: 'Type your answer...',
        aiLabel: 'Analyst',
        userLabel: 'You',
        initialMessage: 'Let us start with one task that takes up a lot of time. Which task comes back most often for you?',
        resumedNotice: 'Welcome back. Above is what you have already told us. Carry on from where you stopped.',
        networkError: 'Network error. Please try again.',
        analysisTitle: 'Analysis',
        illustrativeBanner: 'Illustrative responses, generated to demonstrate the analysis. This is not a real client.',
        doFirst: 'Do first',
        doLater: 'Do later',
        judgementBound: 'Do not automate',
        conflictsTitle: 'Conflicting answers',
        totalRecoverable: 'Person-hours per week, across everyone involved',
        notMeasured: 'not measured',
        // Shown where a factor was answered IN WORDS, so no figure exists to multiply.
        // The score is a real zero; what is missing is the number, not the work.
        effortNotMeasured: 'effort not measured',
        totalIsFloor: 'at least',

        scoringFailed: 'The analysis could not be computed. Your answers are kept; please try again.',
        downloadMarkdown: 'Download Markdown',
    },
    fr: {
        lang: 'fr',
        pageTitle: 'Audit des processus',
        subtitle: 'Un diagnostic, pas un appel commercial',
        heading: 'Où l\'IA peut-elle vraiment faire la différence ?',
        intro: 'Un court questionnaire sur votre travail. L\'analyse montre quelles tâches méritent d\'être automatisées, lesquelles non, et pourquoi.',
        inputPlaceholder: 'Tapez votre réponse...',
        aiLabel: 'Analyste',
        userLabel: 'Vous',
        initialMessage: 'Commençons par une tâche qui prend beaucoup de temps. Quelle tâche revient le plus souvent chez vous ?',
        resumedNotice: 'Bon retour. Ce qui précède est ce que vous nous avez déjà dit. Reprenez où vous vous êtes arrêté.',
        networkError: 'Erreur réseau. Veuillez réessayer.',
        analysisTitle: 'Analyse',
        illustrativeBanner: 'Réponses illustratives, générées pour démontrer l\'analyse. Ce n\'est pas un vrai client.',
        doFirst: 'À faire d\'abord',
        doLater: 'À faire plus tard',
        judgementBound: 'Ne pas automatiser',
        conflictsTitle: 'Réponses contradictoires',
        totalRecoverable: 'Heures-personne par semaine, toutes personnes confondues',
        notMeasured: 'non mesuré',
        // Shown where a factor was answered IN WORDS, so no figure exists to multiply.
        // The score is a real zero; what is missing is the number, not the work.
        effortNotMeasured: 'charge non mesurée',
        totalIsFloor: 'au moins',

        scoringFailed: 'L\'analyse n\'a pas pu être calculée. Vos réponses sont conservées ; veuillez réessayer.',
        downloadMarkdown: 'Télécharger Markdown',
    }
};

export const SUPPORTED_LANGS = ['nl', 'en', 'fr'];
export const DEFAULT_LANG = 'en';

/**
 * @param {string} lang
 * @returns {object} Strings for the language, falling back to the default.
 */
export function stringsFor(lang) {
    return STRINGS[lang] || STRINGS[DEFAULT_LANG];
}
