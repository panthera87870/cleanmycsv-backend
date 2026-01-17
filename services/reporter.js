import { parse } from "path";

// 1. DICTIONNAIRE DE TRADUCTION COMPLET
const TRANSLATIONS = {
    fr: {
        // --- Titres et Labels ---
        original: "Fichier original :",
        final: "Fichier final :",
        rows: "lignes",
        cols: "colonnes",
        header_note: "(dont 1 en-tête)",
        details_title: "Détails des actions :",
        
        // --- Phrases d'impact ---
        impact_msg: "L'opération a touché un total de <strong>{n} lignes uniques</strong> (lignes de données affectées par au moins une correction ou suppression).<br><br>",
        perfect_msg: "<strong>Votre fichier était parfait !</strong><br>L'opération n'a détecté aucune valeur à corriger.<br><br>",
        finished_msg: "<strong>Nettoyage terminé !</strong><br>",
        encoding_msg: "<strong>Encodage corrigé :</strong> Votre fichier était au format Excel/Ancien. Il a été converti en format Universel pour sécuriser les accents.<br><br>",

        // --- Détails des actions ---
        structure_title: "Modification Structurelle :",
        structure_currency: "La colonne \"Devise\" a été insérée à côté du montant.",
        
        deletion_title: "Suppressions de Lignes :",
        deletion_detail: "{total} lignes ont été retirées (Doublons : {dup}, Vides : {empty}).",
        
        normalization_title: "Normalisation des Valeurs :",
        
        // --- Items spécifiques (Ta logique) ---
        item_date: "dates uniformisées",
        item_amount: "montants normalisés",
        item_email: "e-mails formatés",      // <-- Conservé
        item_phone: "téléphones normalisés",  // <-- Conservé
        item_postal: "codes postaux réparés",
        item_general: "corrections générales"
    },
    en: {
        // --- Titles and Labels ---
        original: "Original file:",
        final: "Cleaned file:",
        rows: "rows",
        cols: "columns",
        header_note: "(incl. 1 header)",
        details_title: "Action details:",

        // --- Impact Phrases ---
        impact_msg: "The operation affected a total of <strong>{n} unique rows</strong> (data rows affected by at least one correction or removal).<br><br>",
        perfect_msg: "<strong>Your file was perfect!</strong><br>No values needed correction.<br><br>",
        finished_msg: "<strong>Cleaning finished!</strong><br>",
        encoding_msg: "<strong>Encoding fixed:</strong> Your file was in an old Excel format. It has been converted to Universal format to secure special characters.<br><br>",

        // --- Action Details ---
        structure_title: "Structural Change:",
        structure_currency: "The \"Currency\" column was inserted next to the amount.",
        
        deletion_title: "Row Deletions:",
        deletion_detail: "{total} rows removed (Duplicates: {dup}, Empty: {empty}).",
        
        normalization_title: "Value Normalization:",
        
        // --- Specific Items ---
        item_date: "dates standardized",
        item_amount: "amounts normalized",
        item_email: "emails formatted",
        item_phone: "phones normalized",
        item_postal: "zip codes fixed",
        item_general: "general fixes"
    }
};

/**
 * Formate un nombre selon la langue (ex: 1 000 en FR, 1,000 en EN)
 */
function formatNumber(num, lang = 'en') {
    if (typeof num !== 'number') return num;
    const locale = lang === 'fr' ? 'fr-FR' : 'en-US';
    return num.toLocaleString(locale);
}

export function generateCleanFilenames(originalName) {
    if (!originalName) return { cleanCsvName: 'cleaned-file.csv', reportJsonName: 'report.json' };
    
    const { name, ext } = parse(originalName);
    const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
    const baseName = safeName.endsWith('-dirty') ? safeName.replace('-dirty', '') : safeName;

    return {
        cleanCsvName: `${baseName}-clean${ext}`,
        reportJsonName: `${baseName}-report.json`
    };
}

/**
 * Fonction optimisée pour la traduction, conservant 100% de ta logique métier.
 */
export function analyzeReport(report, originalRowsCount, cleanedRowsCount, originalColumnCount, lang = 'en') {
    
    const totalOriginalRows = originalRowsCount;
    const totalCleanedRows = cleanedRowsCount;
    
    // Sélection du dictionnaire (FR ou EN)
    const t = TRANSLATIONS[lang] || TRANSLATIONS.en;

    // --- 1. COLLECTE DES STATISTIQUES (Identique à ton code original) ---
    const stats = {
        totalChanges: report.length,
        originalColumnCount: originalColumnCount,
        rowsRemoved: 0,
        rowsRemovedDoublons: 0,
        rowsRemovedVides: 0,
        columnAddedCurrency: 0,
        dateNormalizations: 0,
        amountNormalizations: 0,
        emailCorrections: 0,  // Ta logique conservée
        phoneCorrections: 0,  // Ta logique conservée
        postalCodeCorrections: 0,
        generalFixes: 0,
        encodingFixed: false, 
        rowsAffected: new Set(),
    };

    report.forEach(change => {
        if (change.row > 0) { 
            stats.rowsAffected.add(change.row);
        }
        
        // On check les raisons venant du cleaner (qui sont maintenant en anglais)
        const reason = change.reason || "";

        if (change.column === "METADATA" && reason.includes("Encoding conversion")) {
            stats.encodingFixed = true;
        }
        else if (reason.includes("Date normalized")) stats.dateNormalizations++;
        else if (reason.includes("Amount normalized")) stats.amountNormalizations++;
        else if (reason.includes("Email auto-fixed")) stats.emailCorrections++;
        else if (reason.includes("Phone normalized")) stats.phoneCorrections++;
        else if (reason.includes("Zip code fixed")) stats.postalCodeCorrections++;
        else if (reason.includes("General cleanup")) stats.generalFixes++;
        
        else if (reason.includes("Empty row")) stats.rowsRemovedVides++;
        else if (reason.includes("Duplicate row")) stats.rowsRemovedDoublons++;
        else if (reason.includes("Currency column added")) stats.columnAddedCurrency++;
    });

    const finalRowsRemoved = stats.rowsRemovedDoublons + stats.rowsRemovedVides;
    stats.rowsRemoved = finalRowsRemoved;

    const totalRowsAffected = stats.rowsAffected.size;
    const finalColumnCount = stats.columnAddedCurrency > 0 ? stats.originalColumnCount + 1 : stats.originalColumnCount;

    
    // --- 2. GÉNÉRATION DU RÉSUMÉ HUMAIN (TRADUIT) ---
    
    let humanSummary;
    let groupB_Actions = [];

    // Message d'impact global
    const impactMessageText = totalRowsAffected > 0 
        ? t.impact_msg.replace('{n}', formatNumber(totalRowsAffected, lang))
        : t.perfect_msg;

    // Phrase spéciale Encodage
    let encodingMessage = "";
    if (stats.encodingFixed) {
        encodingMessage = t.encoding_msg;
    }

    // Message initial (Titre + Impact + Encodage)
    if (totalRowsAffected === 0 && stats.rowsRemoved === 0 && stats.columnAddedCurrency === 0 && !stats.encodingFixed) {
        humanSummary = t.perfect_msg;
    } else {
        humanSummary = `${t.finished_msg} ${impactMessageText} ${encodingMessage}`;
    }

    // Détail des Actions
    
    // a) Colonnes (Structurel)
    if (stats.columnAddedCurrency > 0) {
        groupB_Actions.push(`<strong>${t.structure_title}</strong> ${t.structure_currency}`);
    }

    // b) Suppressions (Remplacement dynamique des variables {total}, {dup}, {empty})
    if (stats.rowsRemoved > 0) {
        let detail = t.deletion_detail
            .replace('{total}', formatNumber(stats.rowsRemoved, lang))
            .replace('{dup}', formatNumber(stats.rowsRemovedDoublons, lang))
            .replace('{empty}', formatNumber(stats.rowsRemovedVides, lang));
            
        groupB_Actions.push(`<strong>${t.deletion_title}</strong> ${detail}`);
    }

    // c) Corrections de Valeurs (Liste complète conservée)
    let correctionsDetails = [];
    if (stats.dateNormalizations > 0) correctionsDetails.push(`${formatNumber(stats.dateNormalizations, lang)} ${t.item_date}`);
    if (stats.amountNormalizations > 0) correctionsDetails.push(`${formatNumber(stats.amountNormalizations, lang)} ${t.item_amount}`);
    if (stats.emailCorrections > 0) correctionsDetails.push(`${formatNumber(stats.emailCorrections, lang)} ${t.item_email}`); // Ajouté
    if (stats.phoneCorrections > 0) correctionsDetails.push(`${formatNumber(stats.phoneCorrections, lang)} ${t.item_phone}`); // Ajouté
    if (stats.postalCodeCorrections > 0) correctionsDetails.push(`${formatNumber(stats.postalCodeCorrections, lang)} ${t.item_postal}`);
    if (stats.generalFixes > 0) correctionsDetails.push(`${formatNumber(stats.generalFixes, lang)} ${t.item_general}`);

    if (correctionsDetails.length > 0) {
        // On joint avec " | " ou ", " selon ton goût, ici j'ai gardé ton style
        groupB_Actions.push(`<strong>${t.normalization_title}</strong> ${correctionsDetails.join(' | ')}.`);
    }

    // 3. Assemblage Final HTML
    
    const diagnosticBlock = `
        <div class="report-diagnostic">
            <p><strong>${t.original}</strong> ${formatNumber(totalOriginalRows, lang)} ${t.rows} ${t.header_note} | ${formatNumber(stats.originalColumnCount, lang)} ${t.cols}.</p>
            <p><strong>${t.final}</strong> ${formatNumber(totalCleanedRows, lang)} ${t.rows} ${t.header_note} | ${formatNumber(finalColumnCount, lang)} ${t.cols}.<br><br></p>
        </div>
    `;
    
    humanSummary += diagnosticBlock;
    
    if (groupB_Actions.length > 0) {
         const actionList = groupB_Actions.map(c => `<li>${c}</li>`).join('');
         humanSummary += `
            <h3>${t.details_title}<br></h3>
            <ul class="report-list">
                ${actionList}
            </ul>
        `;
    }

    return { 
        ...stats, 
        humanSummary, // C'est ici que la version FR ou EN est renvoyée
        totalRowsAffected, 
        originalRowsCount: totalOriginalRows, 
        cleanedRowsCount: totalCleanedRows,
    }; 
}