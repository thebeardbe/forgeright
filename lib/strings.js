/**
 * UI strings.
 *
 * Kept in one module rather than scattered through the template, so the copy
 * can be reviewed and translated in one place. Trilingual, matching the
 * prompt sets.
 */
export const STRINGS = {
    nl: {
        lang: 'nl',
        pageTitle: 'Workflow Audit',
        brand: 'Workflow Audit',
        subtitle: 'Diagnose, geen verkoopgesprek',
        heading: 'Waar kan AI echt het verschil maken?',
        intro: 'Een korte vragenlijst over het werk dat je doet. De analyse toont welke taken zich lenen voor automatisering, welke niet, en waarom.',
        unlockPlaceholder: 'Toegangscode',
        startButton: 'Starten',
        inputPlaceholder: 'Typ je antwoord...',
        aiLabel: 'Analist',
        userLabel: 'Jij',
        initialMessage: 'Laten we beginnen met één taak die veel tijd kost. Welke taak komt bij jou het vaakst terug?',
        invalidCode: 'Ongeldige code.',
        networkError: 'Netwerkfout. Probeer opnieuw.',
        docReady: 'De analyse is klaar.',
        analysisTitle: 'Analyse',
        illustrativeBanner: 'Illustratieve antwoorden, gegenereerd om de analyse te demonstreren. Dit is geen echte klant.',
        doFirst: 'Eerst doen',
        doLater: 'Later doen',
        judgementBound: 'Niet automatiseren',
        conflictsTitle: 'Tegenstrijdige antwoorden',
        totalRecoverable: 'Persoonuren per week, over alle betrokkenen',
        notMeasured: 'niet gemeten',
        scoringFailed: 'De analyse kon niet worden berekend. Je antwoorden zijn bewaard, probeer opnieuw.',
        downloadMarkdown: 'Download Markdown',
        downloadPdf: 'Download PDF'
    },
    en: {
        lang: 'en',
        pageTitle: 'Workflow Audit',
        brand: 'Workflow Audit',
        subtitle: 'A diagnosis, not a sales call',
        heading: 'Where can AI actually make a difference?',
        intro: 'A short questionnaire about the work you do. The analysis shows which tasks are worth automating, which are not, and why.',
        unlockPlaceholder: 'Access code',
        startButton: 'Start',
        inputPlaceholder: 'Type your answer...',
        aiLabel: 'Analyst',
        userLabel: 'You',
        initialMessage: 'Let us start with one task that takes up a lot of time. Which task comes back most often for you?',
        invalidCode: 'Invalid code.',
        networkError: 'Network error. Please try again.',
        docReady: 'The analysis is ready.',
        analysisTitle: 'Analysis',
        illustrativeBanner: 'Illustrative responses, generated to demonstrate the analysis. This is not a real client.',
        doFirst: 'Do first',
        doLater: 'Do later',
        judgementBound: 'Do not automate',
        conflictsTitle: 'Conflicting answers',
        totalRecoverable: 'Person-hours per week, across everyone involved',
        notMeasured: 'not measured',
        scoringFailed: 'The analysis could not be computed. Your answers are kept; please try again.',
        downloadMarkdown: 'Download Markdown',
        downloadPdf: 'Download PDF'
    },
    fr: {
        lang: 'fr',
        pageTitle: 'Audit des processus',
        brand: 'Audit des processus',
        subtitle: 'Un diagnostic, pas un appel commercial',
        heading: 'Où l\'IA peut-elle vraiment faire la différence ?',
        intro: 'Un court questionnaire sur votre travail. L\'analyse montre quelles tâches méritent d\'être automatisées, lesquelles non, et pourquoi.',
        unlockPlaceholder: 'Code d\'accès',
        startButton: 'Commencer',
        inputPlaceholder: 'Tapez votre réponse...',
        aiLabel: 'Analyste',
        userLabel: 'Vous',
        initialMessage: 'Commençons par une tâche qui prend beaucoup de temps. Quelle tâche revient le plus souvent chez vous ?',
        invalidCode: 'Code invalide.',
        networkError: 'Erreur réseau. Veuillez réessayer.',
        docReady: 'L\'analyse est prête.',
        analysisTitle: 'Analyse',
        illustrativeBanner: 'Réponses illustratives, générées pour démontrer l\'analyse. Ce n\'est pas un vrai client.',
        doFirst: 'À faire d\'abord',
        doLater: 'À faire plus tard',
        judgementBound: 'Ne pas automatiser',
        conflictsTitle: 'Réponses contradictoires',
        totalRecoverable: 'Heures-personne par semaine, toutes personnes confondues',
        notMeasured: 'non mesuré',
        scoringFailed: 'L\'analyse n\'a pas pu être calculée. Vos réponses sont conservées ; veuillez réessayer.',
        downloadMarkdown: 'Télécharger Markdown',
        downloadPdf: 'Télécharger PDF'
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
