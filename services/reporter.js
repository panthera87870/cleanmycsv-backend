import { parse } from "path";

/**
 * Formate un nombre en chaîne de caractères avec un espace comme séparateur de milliers.
 * @param {number} num Le nombre à formater.
 * @returns {string} Le nombre formaté (ex: 12 345).
 */
function formatNumber(num) {
    if (typeof num !== 'number') return num;
    // Utilise la méthode toLocaleString, qui gère nativement le format des milliers
    // 'fr-FR' utilise l'espace insécable comme séparateur de milliers
    return num.toLocaleString('fr-FR');
}

/**
 * Génère des noms de fichiers publics propres.
 * @param {string} originalName Nom de fichier original (ex: mon_fichier.csv)
 * @returns {{cleanCsvName: string, reportJsonName: string}}
 */
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
 * Analyse le rapport JSON brut et génère les statistiques et le résumé humain.
 * @param {Array<Object>} report Le tableau de changements du cleaner.
 * @param {number} originalRowsCount Le nombre de lignes originales (incluant l'en-tête).
 * @param {number} cleanedRowsCount Le nombre de lignes nettoyées (incluant l'en-tête).
 * @returns {Object} Un objet contenant le résumé humain et les statistiques détaillées.
 */

export function analyzeReport(report, originalRowsCount, cleanedRowsCount, originalColumnCount) {
    
    const totalOriginalRows = originalRowsCount;
    const totalCleanedRows = cleanedRowsCount;
    
    // Lignes de données (sans l'en-tête) pour les statistiques de suppression/correction
    const originalDataRows = Math.max(0, originalRowsCount - 1);
    
    const stats = {
        totalChanges: report.length,
        originalColumnCount: originalColumnCount,
        rowsRemoved: 0,
        rowsRemovedDoublons: 0,
        rowsRemovedVides: 0,
        columnAddedCurrency: 0,
        dateNormalizations: 0,
        amountNormalizations: 0,
        emailCorrections: 0,
        phoneCorrections: 0,
        generalFixes: 0,
        rowsAffected: new Set(),
    };

    report.forEach(change => {
        if (change.row > 0) { // Lignes > 0 (pas l'en-tête)
            stats.rowsAffected.add(change.row);
        }
        
        if (change.reason.includes("date normalisée")) stats.dateNormalizations++;
        else if (change.reason.includes("montant normalisé")) stats.amountNormalizations++;
        else if (change.reason.includes("email auto-corrigé")) stats.emailCorrections++;
        else if (change.reason.includes("téléphone normalisé")) stats.phoneCorrections++;
        else if (change.reason.includes("nettoyage général")) stats.generalFixes++;
        // Distinction des suppressions
        else if (change.reason.includes("Ligne vide")) stats.rowsRemovedVides++;
        else if (change.reason.includes("Doublon")) stats.rowsRemovedDoublons++;
        else if (change.reason.includes("COLUMNS_MODIFIED")) stats.columnAddedCurrency++;
    });

    const finalRowsRemoved = stats.rowsRemovedDoublons + stats.rowsRemovedVides;
    stats.rowsRemoved = finalRowsRemoved; // <-- Mise à jour du total corrigé

    const totalRowsAffected = stats.rowsAffected.size;
    const finalColumnCount = stats.columnAddedCurrency > 0 ? stats.originalColumnCount + 1 : stats.originalColumnCount;
    // const removalRate = originalDataRows > 0 ? ((stats.rowsRemoved / originalDataRows) * 100).toFixed(1) : 0;
    
    // --- GESTION DU RÉSUMÉ HUMAIN NOUVELLE STRUCTURE ---
    
    let humanSummary;
    let groupB_Actions = [];

    // Clarification de l'Impact Global
    const impactMessageText = totalRowsAffected > 0 
        ? `L'opération a touché un total de <strong>${formatNumber(totalRowsAffected)} lignes uniques</strong> (lignes de données affectées par au moins une correction ou suppression).<br><br>`
        : `L'opération n'a détecté aucune valeur à corriger, le fichier était parfait.`;

    // 1. Détermination du message initial
    if (totalRowsAffected === 0 && stats.rowsRemoved === 0 && stats.columnAddedCurrency === 0) {
        humanSummary = `<strong>Votre fichier était parfait !<strong><br>`;
    } else {
        humanSummary = `<strong>Nettoyage terminé !</strong><br> ${impactMessageText}`;
    }


    // 2. Détail des Actions (Pour la liste)
    
    // a) Colonnes (Structurel)
    if (stats.columnAddedCurrency > 0) {
        groupB_Actions.push(`<strong>Modification structurelle :</strong> La colonne "Devise" a été insérée à côté du montant.`);
    }

    // b) Suppressions (Structurel sur les lignes)
    if (stats.rowsRemoved > 0) {
        let detail = `${formatNumber(stats.rowsRemoved)} lignes ont été retirées (Doublons: ${formatNumber(stats.rowsRemovedDoublons)}, Vides: ${formatNumber(stats.rowsRemovedVides)}).`;
        groupB_Actions.push(`<strong>Suppressions de lignes :</strong> ${detail}`);
    }

    // c) Corrections de Valeurs (Cellulaire)
    let correctionsDetails = [];
    if (stats.dateNormalizations > 0) correctionsDetails.push(`${formatNumber(stats.dateNormalizations)} dates uniformisées.`);
    if (stats.amountNormalizations > 0) correctionsDetails.push(`${formatNumber(stats.amountNormalizations)} montants normalisés.`);
    if (stats.emailCorrections > 0) correctionsDetails.push(`${formatNumber(stats.emailCorrections)} e-mails formatés.`);
    if (stats.phoneCorrections > 0) correctionsDetails.push(`${formatNumber(stats.phoneCorrections)} téléphones normalisés.`);
    if (stats.generalFixes > 0) correctionsDetails.push(`${formatNumber(stats.generalFixes)} corrections générales.`);

    if (correctionsDetails.length > 0) {
        groupB_Actions.push(`<strong>Normalisation des valeurs :</strong> ${correctionsDetails.join(' | ')}.`);
    }

    // 3. Assemblage des blocs pour l'affichage final
    
    // Bloc de Diagnostic
    const diagnosticBlock = `
        <div class="report-diagnostic">
            <p><strong>Fichier original :</strong> ${formatNumber(totalOriginalRows)} lignes (dont 1 en-tête) et ${formatNumber(stats.originalColumnCount)} colonnes.</p>
            <p><strong>Fichier final :</strong> ${formatNumber(totalCleanedRows)} lignes (dont 1 en-tête) et ${formatNumber(finalColumnCount)} colonnes.<br><br></p>
        </div>
    `;
    
    // Ajout du diagnostic et des détails à la synthèse principale
    humanSummary += diagnosticBlock;
    
    if (groupB_Actions.length > 0) {
         const actionList = groupB_Actions.map(c => `<li>${c}</li>`).join('');
         humanSummary += `
            <h3>Détails des actions : <br></h3>
            <ul class="report-list">
                ${actionList}
            </ul>
        `;
    }

    // RETOUR FINAL (Le bloc qui manquait pour clôturer la fonction)
    return { 
        ...stats, 
        humanSummary, 
        totalRowsAffected, 
        originalRowsCount: totalOriginalRows, 
        cleanedRowsCount: totalCleanedRows,
    }; 
}