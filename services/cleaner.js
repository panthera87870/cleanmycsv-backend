import { join } from "path";
import Papa from "papaparse";
import chardet from "chardet";
import iconv from "iconv-lite";

// 💡 IMPORT DES FONCTIONS PURES (NORMALIZERS)
import { 
    normalizeAmount, 
    normalizeDate,
    detectSeparator
} from "./normalizers.js"; 

// Importation de fs/promises pour les opérations I/O asynchrones (Performance)
import fs from "fs/promises";

// --- FONCTION PRINCIPALE ---

/**
 * Nettoie un fichier CSV et écrit le résultat et le rapport.
 * @param {string} filePath Chemin complet du fichier CSV à nettoyer (dans /uploads).
 * @param {string} csvOutputFilename Nom du fichier CSV nettoyé à créer (ex: clean-uuid.csv).
 * @param {string} reportOutputFilename Nom du rapport JSON à créer (ex: report-uuid.json).
 * @param {string} OUTPUT_DIR Le chemin absolu du dossier de sortie. (Correction Robustesse)
 * @returns {Promise<{cleaned: Array<Array<string>>, report: Array<Object>}>} Les données nettoyées et le rapport.
 */
export async function cleanCsv(filePath, csvOutputFilename, reportOutputFilename, OUTPUT_DIR) {
    
    // Construction des chemins d'écriture complets sécurisés
    const finalCsvPath = join(OUTPUT_DIR, csvOutputFilename);
    const finalReportPath = join(OUTPUT_DIR, reportOutputFilename);

    const report = [];
    const extractedCurrencies = {}; // <-- AJOUT pour stocker les devises NEW

    // 1. Lecture asynchrone du fichier et détection d'encodage (Performance)
    try {
        // 1. Détection d'encodage NEW
        const buffer = await fs.readFile(filePath);

        let encoding = chardet.detectFileSync(filePath) || "UTF-8";
        let content;

        // Tentative de décodage avec l'encodage détecté, avec fallback sur Windows-1252
        try {
            content = iconv.decode(buffer, encoding);
        } catch (e) {
            encoding = 'win1252'; // Fallback pour les fichiers européens courants
            content = iconv.decode(buffer, encoding); 
            report.push({ 
                row: -1, 
                column: "ENCODAGE", 
                before: encoding, 
                after: "win1252", 
                reason: "La détection de l'encodage a été corrigée en 'windows-1252' pour assurer la lecture des accents." 
            });
        }

        // 2. Détection automatique du séparateur NEW
        const separator = detectSeparator(content);
  
        console.log(`[DEBUG] Séparateur gagnant utilisé pour le parsing : "${separator}"`);

        // 3. Parsing avec PapaParse (Correction Robustesse: Ajout du Try...Catch)
        let parsed;
        try {
            parsed = Papa.parse(content, {
                delimiter: separator, 
                header: false,
                skipEmptyLines: false 
            });
        } catch (e) {
            // Si Papa.parse lui-même lève une erreur inattendue (rare)
            throw new Error("Erreur critique lors du parsing CSV: " + e.message);
        }

        if (parsed.errors.length > 0) {
            // S'il y a des erreurs de parsing structurel (guillemets non fermés, etc.)
            console.error("Erreurs PapaParse:", parsed.errors);
            throw new Error(`Le fichier CSV est mal formaté (ligne ${parsed.errors[0].row + 1}): ${parsed.errors[0].message}`);
        }

        let rows = parsed.data;

        // --- DÉBUT DU CORRECTIF ROBUSTE --- NEW 
        // Détection du cas "Faux CSV" : Lignes entièrement entre guillemets
        // Si on a des données, une seule colonne détectée, et que cette colonne contient le séparateur
        if (rows.length > 0 && rows[0].length === 1) {
            const firstCell = rows[0][0];
            // On vérifie si la première cellule contient bien le séparateur détecté (ex: ';')
            if (typeof firstCell === 'string' && firstCell.includes(separator)) {
                console.log(`[FIX] Format 'Ligne entière entre guillemets' détecté. Correction de la structure...`);
                
                // On redécoupe manuellement chaque ligne
                rows = rows.map(row => {
                    // Si la ligne a bien été lue comme une seule colonne string
                    if (row.length === 1 && typeof row[0] === 'string') {
                        // On découpe en utilisant le séparateur qu'on avait détecté plus tôt
                        // PapaParse a déjà retiré les guillemets extérieurs, donc c'est propre.
                        return row[0].split(separator);
                    }
                    return row;
                });
            }
        }
        // --- FIN DU CORRECTIF ROBUSTE ---

        // 🛑 AJOUT 1: Capture des comptes initiaux (TOTAL LIGNES ET COLONNES)
        const originalRowsCount = rows.length; 
        const originalColumnCount = rows.length > 0 ? rows[0].length : 0;

        const headers = rows[0] || [];

        // Déterminer les index des colonnes à nettoyer spécifiquement
        const columnIndex = headers.map(h => h.toLowerCase());
        const dateIndex = columnIndex.findIndex(h => h.includes('date'));
        const montantIndex = columnIndex.findIndex(h => h.includes('montant') || h.includes('amount'));

        // 4. Boucle de nettoyage
        rows = rows.map((row, rowIndex) =>
            row.map((cell, colIndex) => {
                // Pour la ligne d'en-tête, on la saute
                if (rowIndex === 0 || !cell) return cell;

                let original = cell;
                let value = cell.trim();
                let fixed = value; // Variable pour stocker la valeur corrigée temporairement

                // 4.1 Nettoyage Général (appliqué à toutes les cellules sauf l'en-tête)
                value = value.replace(/^\+([A-Za-z])/, "$1"); // Corriger erreurs ville genre "+Atampes"
                value = value.replace(/\s+/g, " "); // Compresser espaces multiples
                value = value.replace(/^(NULL|N\/A|-|undefined|none|nan)$/i, ""); // Nettoyer valeurs "nulles"

                // Retirer les séparateurs intrus (par défaut, on retire le | si ce n'est pas une colonne Montant/Date)
                if (colIndex !== montantIndex) {
                    value = value.replace(/[|]/g, ''); 
                }

                // 4.2 Nettoyage Spécifique (Intelligent) ---

                // DATE
                if (colIndex === dateIndex) {
                    fixed = normalizeDate(value);
                    if (fixed !== value) {
                        report.push({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: original,
                            after: fixed,
                            reason: "date normalisée en AAAA-MM-JJ"
                        });
                        value = fixed;
                    }
                }

                // MONTANT
                else if (colIndex === montantIndex) {
                    const result = normalizeAmount(value); // NOUVEAU: obtient { amount, currency } NEW
                    fixed = result.amount;
                    if (result.currency) {
                        if (!extractedCurrencies[rowIndex]) extractedCurrencies[rowIndex] = {};
                        extractedCurrencies[rowIndex][colIndex] = result.currency;
                    }
                    if (fixed !== value) {
                        report.push({
                            row: rowIndex,
                            column: headers[colIndex] || `col_\${colIndex}`,
                            before: original,
                            after: fixed,
                            reason: "montant normalisé (symboles retirés, point décimal forcé et devise extraite" // Mise à jour de la raison
                        });
                        value = fixed;
                    }
                }

                // EMAIL
                else if (headers[colIndex] && headers[colIndex].toLowerCase().includes("email")) {
                    fixed = value
                        .replace(/@\s+@+/g, "@") // plusieurs @
                        .replace(/\.\.+/g, ".") // plusieurs ..
                        .replace(/\s/g, ""); // espaces
                    if (fixed !== value) {
                        report.push({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: original,
                            after: fixed,
                            reason: "email auto-corrigé"
                        });
                        value = fixed;
                    }
                }

                // TÉLÉPHONE
                else if (headers[colIndex] && headers[colIndex].toLowerCase().includes("tel")) {
                    let digits = value.replace(/\D/g, ""); // garder que chiffres
                    if (digits.length >= 9) {
                        if (digits.startsWith("0") && digits.length >= 10) { digits = "33" + digits.slice(1); }
                        fixed = "+" + digits;
                        if (fixed !== value) {
                            report.push({
                                row: rowIndex,
                                column: headers[colIndex] || `col_${colIndex}`,
                                before: original,
                                after: fixed,
                                reason: "téléphone normalisé en format +33"
                            });
                            value = fixed;
                        }
                    }
                }
                
                // Log nettoyage general
                const isSpecific = colIndex === dateIndex || colIndex === montantIndex || 
                                            (headers[colIndex] && headers[colIndex].toLowerCase().includes("email")) ||
                                            (headers[colIndex] && headers[colIndex].toLowerCase().includes("tel"));
                
                if (value !== original && !isSpecific) {
                    // On logue si le nettoyage général (trim, espaces, null) a eu un impact significatif
                    const trimmedOriginal = original.trim().replace(/\s+/g, " ");
                    if (value !== trimmedOriginal) {
                        report.push({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: original,
                            after: value,
                            reason: "nettoyage général de la chaîne de caractères (espaces, nulls, symboles)"
                        });
                    }
                }
                return value;
            })
        );

        // 5. Insertion colonne Devise
        if (montantIndex !== -1) {
            report.push({ 
                row: 0, 
                column: "STRUCTURE", 
                before: "Non", 
                after: "Oui", 
                reason: "COLUMNS_MODIFIED: Ajout de la colonne Devise" 
            });
            headers.splice(montantIndex + 1, 0, 'Devise');
            rows[0] = headers;
            rows = rows.map((row, rowIndex) => {
                if (rowIndex === 0) return row; // L'en-tête est déjà mis à jour
                // Récupère la devise stockée pour cette ligne
                const currency = extractedCurrencies[rowIndex] ? extractedCurrencies[rowIndex][montantIndex] || '' : '';
                // Insère la devise à côté du montant
                row.splice(montantIndex + 1, 0, currency);
                return row;
            });
        }

        // 6. Harmonisation du nombre de colonnes
        const maxColumns = Math.max(...rows.map(r => r.length));
        rows = rows.map(r => {
        while (r.length < maxColumns) r.push("");
        if (r.length > maxColumns) r = r.slice(0, maxColumns);
        return r;
        });

        // 7. Suppression des lignes totalement vides et doublons
        let finalRows = [rows[0]]; // Garde l'en-tête
        const seen = new Set();
        for(let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const rowKey = row.join("|");
            // Lignes vides?
            const isRowEmpty = row.every(cell => !cell || cell.trim() === "");
            if (isRowEmpty) {
                report.push({ row: i, column: "ROW", before: "Ligne vide", after: "Supprimée", reason: "Ligne vide" });
                continue;
            }
            // Doublon?
            if (seen.has(rowKey)) {
                report.push({ row: i, column: "ROW", before: "Doublon", after: "Supprimée", reason: "Doublon" });
                continue;
            }
            seen.add(rowKey);
            finalRows.push(row);
        }
        
        // 8. Sauvegarde CSV nettoyé NEW 
        const utf8Bom = '\ufeff'; // Caractère BOM UTF-8 (pour forcer Excel à bien lire les accents)
        // Utilisation de Papa.unparse avec le séparateur détecté (`separator`)
        const cleanCsvContent = Papa.unparse(finalRows, { delimiter: separator });

        await fs.writeFile(finalCsvPath, utf8Bom + cleanCsvContent, 'utf8');
        await fs.writeFile(finalReportPath, JSON.stringify(report, null, 2), 'utf-8');

        // On retourne les données pour que server.js puisse compter les lignes nettoyées
        return { 
            cleaned: finalRows, 
            report: report,
            // 🛑 MODIFICATION DU RETURN FINAL :
            originalRowsCount: originalRowsCount,     
            originalColumnCount: originalColumnCount  
        };

    } catch (error) {
        console.error("Erreur critique dans cleanCsv:", error);
        throw error;
    }
}