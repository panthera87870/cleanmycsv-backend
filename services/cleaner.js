import Papa from "papaparse";
import chardet from "chardet";
import iconv from "iconv-lite";
import fs from "fs/promises";
import { join } from "path";
import { 
    normalizeAmount, 
    normalizeDate, 
    detectSeparator, 
    normalizePostalCode, 
    normalizeName 
} from "./normalizers.js"; 


/**
 * Nettoie un fichier CSV (Buffer) et génère un rapport.
 * @param {Buffer} fileBuffer - Le contenu du fichier en mémoire.
 * @param {string} tempCsvName - Nom du fichier de sortie CSV.
 * @param {string} tempReportName - Nom du fichier de rapport JSON.
 * @param {string} outputDir - Dossier où sauvegarder les fichiers.
 */
export async function cleanCsv(fileBuffer, csvOutputFilename, reportOutputFilename, OUTPUT_DIR) {
    
    // Construction des chemins d'écriture complets sécurisés
    const finalCsvPath = join(OUTPUT_DIR, csvOutputFilename);
    const finalReportPath = join(OUTPUT_DIR, reportOutputFilename);

    const report = [];
    const extractedCurrencies = {};

    try {
        // 1. Détection d'encodage NEW
        let encoding = chardet.detect(fileBuffer) || "UTF-8";
        let content;

        // Tentative de décodage avec l'encodage détecté, avec fallback sur Windows-1252
        try {
            content = iconv.decode(fileBuffer, encoding);
        } catch (e) {
            encoding = 'win1252'; // Fallback pour les fichiers européens courants
            content = iconv.decode(fileBuffer, encoding); 
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
        //console.log(`[DEBUG] Séparateur gagnant utilisé pour le parsing : "${separator}"`);

        // 3. Parsing avec PapaParse (Correction Robustesse: Ajout du Try...Catch)
        let parsed;
        try {
            parsed = Papa.parse(content, {
                delimiter: separator, 
                header: false,
                skipEmptyLines: false 
            });
        } catch (e) {
            throw new Error("Erreur critique lors du parsing CSV: " + e.message);
        }

        if (parsed.errors.length > 0) {
            console.error("Erreurs PapaParse:", parsed.errors);
            throw new Error(`Le fichier CSV est mal formaté (ligne ${parsed.errors[0].row + 1}): ${parsed.errors[0].message}`);
        }

        let rows = parsed.data;

        // --- DÉBUT DU CORRECTIF ROBUSTE : Détection du cas "Faux CSV" : Lignes entièrement entre guillemets
        if (rows.length > 0 && rows[0].length === 1) {
            const firstCell = rows[0][0];
            if (typeof firstCell === 'string' && firstCell.includes(separator)) {
                console.log(`[FIX] Format 'Ligne entière entre guillemets' détecté. Correction de la structure...`);
                
                // On redécoupe manuellement chaque ligne
                rows = rows.map(row => {
                    if (row.length === 1 && typeof row[0] === 'string') {
                        return row[0].split(separator);
                    }
                    return row;
                });
            }
        }
        // FIN DU CORRECTIF ROBUSTE ---

        // 🛑 AJOUT 1: Capture des comptes initiaux (TOTAL LIGNES ET COLONNES)
        const originalRowsCount = rows.length; 
        const originalColumnCount = rows.length > 0 ? rows[0].length : 0;

        const headers = rows[0] || [];

        // Déterminer les index des colonnes à nettoyer spécifiquement
        const columnIndex = headers.map(h => h.toLowerCase());
        const dateIndex = columnIndex.findIndex(h => /date|created_at|time/i.test(h));
        const montantIndex = columnIndex.findIndex(h => /montant|amount|price|prix|total/i.test(h));
        const emailIndex = columnIndex.findIndex(h => /email|mail|e-mail/i.test(h));
        const cpIndex = columnIndex.findIndex(h => /^(cp|zip|code\s?postal)$/i.test(h));
        const phoneRegex = /tél|tel|phone|mobile|portable|gsm/i;
        const nameRegex = /nom|name|prenom|firstname|lastname|ville|city|societe|company|pays|country/i;
        const nameIndices = headers
            .map((h, i) => nameRegex.test(h) ? i : -1)
            .filter(i => i !== -1);
        
        // 4. Boucle de nettoyage
        rows = rows.map((row, rowIndex) =>
            row.map((cell, colIndex) => {
                if (rowIndex === 0 || !cell) return cell;

                let original = cell;
                let value = cell.trim();
                let fixed = value;

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
                else if (colIndex === emailIndex) {
                    fixed = value
                        .replace(/@+/g, "@") // plusieurs @
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
                else if (headers[colIndex] && phoneRegex.test(headers[colIndex])) {
                    let digits = value.replace(/\D/g, ""); // garder que chiffres (enlève +, espaces, parenthèses)
                    
                    if (digits.length >= 9) {
                        // --- AJOUT : Correction du +33(0) ---
                        // Si le nombre nettoyé commence par 330 (ex: 3306...), on enlève le 0
                        if (digits.startsWith("330")) {
                            digits = "33" + digits.slice(3); 
                        }

                        // Ta logique existante (06 -> 336)
                        if (digits.startsWith("0") && digits.length >= 10) { 
                            digits = "33" + digits.slice(1); 
                        }
                        
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

                // NOUVEAU : CODE POSTAL
                else if (colIndex === cpIndex) {
                    fixed = normalizePostalCode(value);
                    if (fixed !== value) {
                        report.push({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: original,
                            after: fixed,
                            reason: "Code postal corrigé (ajout du 0 manquant)"
                        });
                        value = fixed;
                    }
                }

                // E. NOMS PROPRES (✅ NOUVELLE FONCTIONNALITÉ)
                else if (nameIndices.includes(colIndex)) {
                    fixed = normalizeName(value);
                    if (fixed !== original) {
                        value = fixed;
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

                // SÉCURITÉ : Anti-CSV Injection
                // Si une cellule commence par =, +, -, @ on ajoute une apostrophe
                if (typeof value === 'string' && /^[=\+\-@]/.test(value)) {
                    
                    // EXCEPTION : Si c'est juste un numéro (Téléphone ou Math)
                    // On regarde s'il n'y a QUE des chiffres, espaces, points ou virgules après le signe.
                    // Une formule malveillante contient forcément des lettres (ex: +CMD, +SUM, -DDE)
                    const isSafeNumber = /^[\+\-][\d\s\.\,]*$/.test(value);

                    // Si ce n'est PAS un nombre sûr (donc ça contient des lettres ou symboles bizarres), on protège.
                    if (!isSafeNumber) {
                        value = "'" + value; 
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
        console.error("Erreur critique dans cleanCsv:", error.message);
        throw error;
    }
}