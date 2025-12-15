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

// 🆕 AMÉLIORATION 1 : Limite de sécurité pour éviter un JSON de 50 Mo
const MAX_REPORT_DETAILS = 1000; 

/**
 * Nettoie un fichier CSV (Buffer) et génère un rapport.
 */
export async function cleanCsv(fileBuffer, csvOutputFilename, reportOutputFilename, OUTPUT_DIR) {
    
    const finalCsvPath = join(OUTPUT_DIR, csvOutputFilename);
    const finalReportPath = join(OUTPUT_DIR, reportOutputFilename);

    const report = [];
    const extractedCurrencies = {};

    // Helper pour ajouter au rapport sans exploser la mémoire
    const safeReportPush = (entry) => {
        if (report.length < MAX_REPORT_DETAILS) {
            report.push(entry);
        } else if (report.length === MAX_REPORT_DETAILS) {
            report.push({
                row: -1,
                column: "INFO",
                before: "...",
                after: "...",
                reason: "⚠️ Limite d'affichage atteinte (1000+ corrections). Le nettoyage continue mais les détails ne sont plus listés."
            });
        }
        // On continue de nettoyer, mais on arrête de logger les détails.
    };

    try {
        // --- 1. DÉTECTION ET DÉCODAGE ROBUSTE (V2 : UTF-8 > Win1252 > MacRoman) ---
        let content;
        let detectedEncoding = "UTF-8";

        // Étape A: Essai strict en UTF-8
        const contentUtf8 = iconv.decode(fileBuffer, "utf8");
        // On compte les caractères de remplacement (les losanges )
        const errorsUtf8 = (contentUtf8.match(/\uFFFD/g) || []).length;

        if (errorsUtf8 === 0) {
            // C'est du propre
            content = contentUtf8;
            detectedEncoding = "UTF-8";
        } else {
            // Étape B: Fallback Windows-1252 (Standard Excel France)
            const contentAnsi = iconv.decode(fileBuffer, "win1252");
            const errorsAnsi = (contentAnsi.match(/\uFFFD/g) || []).length;

            if (errorsAnsi === 0) {
                // Windows-1252 est propre
                content = contentAnsi;
                detectedEncoding = "Windows-1252";
                
                safeReportPush({ 
                    row: 0, 
                    column: "METADATA", 
                    before: "Format Excel (Ancien)", 
                    after: "Format Universel (UTF-8)", 
                    reason: "Conversion de l'encodage pour garantir l'affichage des accents." 
                });
            } else {
                // 🆕 AMÉLIORATION 2 : Ajout du Fallback MacRoman (Pour les vieux fichiers Apple)
                console.log(`[ENCODAGE] Win1252 a des erreurs (${errorsAnsi}). Tentative MacRoman...`);
                const contentMac = iconv.decode(fileBuffer, "macroman");
                
                // On prend MacRoman en dernier recours
                content = contentMac;
                detectedEncoding = "MacRoman";

                safeReportPush({ 
                    row: 0, 
                    column: "METADATA", 
                    before: "Format Apple (Legacy)", 
                    after: "Format Universel (UTF-8)", 
                    reason: "Conversion de l'encodage Mac pour garantir l'affichage des accents." 
                });
            }
        }

        console.log(`[DEBUG] Encodage final retenu : ${detectedEncoding}`);

        // 2. Détection du séparateur
        const separator = detectSeparator(content);
        console.log(`[DEBUG] Séparateur gagnant : "${separator}"`);

        // 3. Parsing
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

        // Fix "Faux CSV" (Ligne entière entre guillemets)
        if (rows.length > 0 && rows[0].length === 1) {
            const firstCell = rows[0][0];
            if (typeof firstCell === 'string' && firstCell.includes(separator)) {
                console.log(`[FIX] Format 'Ligne entière entre guillemets' détecté.`);
                rows = rows.map(row => {
                    if (row.length === 1 && typeof row[0] === 'string') {
                        return row[0].split(separator);
                    }
                    return row;
                });
            }
        }

        const originalRowsCount = rows.length; 
        const originalColumnCount = rows.length > 0 ? rows[0].length : 0;

        // 🆕 AMÉLIORATION 3 : Nettoyage des En-têtes (Trim + suppression BOM)
        // Indispensable pour éviter que "Email " ne matche pas "Email" dans un CRM
        let headers = rows[0] || [];
        if (headers.length > 0) {
            headers = headers.map(h => h ? h.toString().trim().replace(/^[\ufeff]/, '') : '');
            rows[0] = headers; // On remet les headers propres dans les données
        }

        // Déterminer les index (Logique existante conservée)
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
        
        let hasFoundAnyCurrency = false;

        // 4. Boucle de nettoyage
        rows = rows.map((row, rowIndex) =>
            row.map((cell, colIndex) => {
                if (rowIndex === 0 || !cell) return cell;

                let original = cell;
                let value = cell.trim();
                let fixed = value;

                // 4.1 Nettoyage Général
                value = value.replace(/^\+([A-Za-z])/, "$1"); 
                value = value.replace(/\s+/g, " "); 
                value = value.replace(/^(NULL|N\/A|-|undefined|none|nan)$/i, ""); 

                if (colIndex !== montantIndex) {
                    value = value.replace(/[|]/g, ''); 
                }

                // 4.2 Nettoyage Spécifique

                // DATE
                if (colIndex === dateIndex) {
                    fixed = normalizeDate(value);
                    if (fixed !== value) {
                        safeReportPush({
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
                    const result = normalizeAmount(value);
                    fixed = result.amount;
                    if (result.currency) {
                        if (!extractedCurrencies[rowIndex]) extractedCurrencies[rowIndex] = {};
                        extractedCurrencies[rowIndex][colIndex] = result.currency;
                        hasFoundAnyCurrency = true;
                    }
                    if (fixed !== value) {
                        safeReportPush({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: original,
                            after: fixed,
                            reason: "montant normalisé"
                        });
                        value = fixed;
                    }
                }

                // EMAIL
                else if (colIndex === emailIndex) {
                    fixed = value.toLowerCase()
                        .replace(/@+/g, "@")
                        .replace(/\.\.+/g, ".")
                        .replace(/\s/g, "");
                    if (fixed !== value) {
                        safeReportPush({
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
                    let digits = value.replace(/\D/g, "");
                    if (digits.length >= 9) {
                        if (digits.startsWith("330")) digits = "33" + digits.slice(3); 
                        if (digits.startsWith("0") && digits.length >= 10) digits = "33" + digits.slice(1); 
                        
                        fixed = "+" + digits;
                        if (fixed !== value) {
                            safeReportPush({
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

                // CODE POSTAL
                else if (colIndex === cpIndex) {
                    fixed = normalizePostalCode(value);
                    if (fixed !== value) {
                        safeReportPush({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: original,
                            after: fixed,
                            reason: "Code postal corrigé"
                        });
                        value = fixed;
                    }
                }

                // NOMS PROPRES
                else if (nameIndices.includes(colIndex)) {
                    fixed = normalizeName(value);
                    if (fixed !== original) {
                        value = fixed;
                    }
                }
                
                // Log nettoyage général (seulement si significatif)
                const isSpecific = colIndex === dateIndex || colIndex === montantIndex || 
                                   (headers[colIndex] && /email|tel/i.test(headers[colIndex]));
                
                if (value !== original && !isSpecific) {
                    const trimmedOriginal = original.trim().replace(/\s+/g, " ");
                    if (value !== trimmedOriginal) {
                        safeReportPush({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: original,
                            after: value,
                            reason: "nettoyage général"
                        });
                    }
                }

                // SÉCURITÉ : Anti-CSV Injection
                if (typeof value === 'string' && /^[=\+\-@]/.test(value)) {
                    const isSafeNumber = /^[\+\-][\d\s\.\,]*$/.test(value);
                    if (!isSafeNumber) {
                        value = "'" + value; 
                        // NOUVEAU : On logue explicitement cette action de sécurité
                        safeReportPush({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: unsafeValue,
                            after: value,
                            reason: "🛡️ SÉCURITÉ : Formule neutralisée (Anti-Injection CSV)"
                        });
                    }
                }

                return value;
            })
        );

        // 5. Insertion colonne Devise
        if (montantIndex !== -1 && hasFoundAnyCurrency) {
            safeReportPush({ 
                row: 0, 
                column: "STRUCTURE", 
                before: "Non", 
                after: "Oui", 
                reason: "COLUMNS_MODIFIED: Ajout de la colonne Devise" 
            });
            headers.splice(montantIndex + 1, 0, 'Devise');
            rows[0] = headers;
            rows = rows.map((row, rowIndex) => {
                if (rowIndex === 0) return row;
                const currency = extractedCurrencies[rowIndex] ? extractedCurrencies[rowIndex][montantIndex] || '' : '';
                row.splice(montantIndex + 1, 0, currency);
                return row;
            });
        }

        // 6. Harmonisation des colonnes
        const maxColumns = Math.max(...rows.map(r => r.length));
        rows = rows.map(r => {
            while (r.length < maxColumns) r.push("");
            if (r.length > maxColumns) r = r.slice(0, maxColumns);
            return r;
        });

        // 7. Suppression doublons/vides
        let finalRows = [rows[0]];
        const seen = new Set();
        for(let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const rowKey = row.join("|");
            
            const isRowEmpty = row.every(cell => !cell || cell.trim() === "");
            if (isRowEmpty) {
                safeReportPush({ row: i, column: "ROW", before: "Ligne vide", after: "Supprimée", reason: "Ligne vide" });
                continue;
            }
            if (seen.has(rowKey)) {
                safeReportPush({ row: i, column: "ROW", before: "Doublon", after: "Supprimée", reason: "Doublon" });
                continue;
            }
            seen.add(rowKey);
            finalRows.push(row);
        }
        
        // 8. Sauvegarde
        const utf8Bom = '\ufeff'; 
        const cleanCsvContent = Papa.unparse(finalRows, { delimiter: separator });

        await fs.writeFile(finalCsvPath, utf8Bom + cleanCsvContent, 'utf8');
        await fs.writeFile(finalReportPath, JSON.stringify(report, null, 2), 'utf-8');

        return { 
            cleaned: finalRows, 
            report: report,
            originalRowsCount: originalRowsCount,     
            originalColumnCount: originalColumnCount  
        };

    } catch (error) {
        console.error("Erreur critique dans cleanCsv:", error.message);
        throw error;
    }
}