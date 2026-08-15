import Papa from "papaparse";
import iconv from "iconv-lite";
import { 
    normalizeAmount, 
    normalizeDate, 
    detectSeparator, 
    normalizePostalCode, 
    normalizeName,
    normalizePhone 
} from "./normalizers.js"; 

const MAX_REPORT_DETAILS = 1000; 

/**
 * Nettoie un fichier CSV (Buffer) avec logique locale (FR/US).
 * Output: JSON "English First".
 */
export async function cleanCsv(fileBuffer, lang = 'en') {
    
    const report = [];
    const extractedCurrencies = {};

    const safeReportPush = (entry) => {
        if (report.length < MAX_REPORT_DETAILS) {
            report.push(entry);
        } else if (report.length === MAX_REPORT_DETAILS) {
            report.push({
                row: -1,
                column: "INFO",
                before: "...",
                after: "...",
                reason: "⚠️ Display limit reached (1000+ fixes). Process continues but details are hidden."
            });
        }
    };

    try {
        // --- 1. DÉTECTION ET DÉCODAGE OPTIMISÉ (ANTI-OOM) ---
        let content;
        let detectedEncoding = "utf8";

        // Échantillonnage sécurisé des 16 premiers Ko pour détecter l'encodage sans saturer la RAM
        const sampleBuffer = fileBuffer.subarray(0, 16384);
        const sampleUtf8 = iconv.decode(sampleBuffer, "utf8");
        
        if ((sampleUtf8.match(/\uFFFD/g) || []).length > 0) {
            const sampleAnsi = iconv.decode(sampleBuffer, "win1252");
            if ((sampleAnsi.match(/\uFFFD/g) || []).length === 0) {
                detectedEncoding = "win1252";
                safeReportPush({ row: 0, column: "METADATA", before: "Windows-1252", after: "UTF-8", reason: "Encoding conversion (Excel) to UTF-8" });
            } else {
                detectedEncoding = "macroman";
                safeReportPush({ row: 0, column: "METADATA", before: "MacRoman", after: "UTF-8", reason: "Encoding conversion (Mac) to UTF-8" });
            }
        }

        // Décodage unique de l'ensemble du fichier avec l'encodage validé
        content = iconv.decode(fileBuffer, detectedEncoding);

        // --- SÉCURITÉ MÉMOIRE (ANTI-CRASH) ---
        if (content && content.length > 5000) {
            const debutDuFichier = content.slice(0, 5000); 
            const aUnSautDeLigne = /[\n\r]/.test(debutDuFichier);

            if (!aUnSautDeLigne) {
                throw new Error("Format invalide : Structure CSV non détectée.");
            }
        }

        // --- 2. SEPARATEUR INTELLIGENT ---
        const separator = detectSeparator(content, lang);
        
        let parsed;
        try {
            parsed = Papa.parse(content, {
                delimiter: separator, 
                header: false,
                skipEmptyLines: false 
            });
        } catch (e) {
            throw new Error("Critical CSV parsing error: " + e.message);
        }

        if (parsed.errors.length > 0) {
            if (parsed.errors[0].code !== "TooManyFields") {
                 throw new Error(`CSV Format Error (Line ${parsed.errors[0].row + 1}): ${parsed.errors[0].message}`);
            }
        }

        let rows = parsed.data;

        // --- FIX : Ligne entière entre guillemets ---
        if (rows.length > 0 && rows[0].length === 1) {
            const firstCell = rows[0][0];
            if (typeof firstCell === 'string' && firstCell.includes(separator)) {
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

        // --- 3. IDENTIFICATION DES COLONNES ---

        let headers = rows[0] || [];
        if (headers.length > 0) {
            headers = headers.map(h => h ? h.toString().trim().replace(/^[\ufeff]/, '') : '');
            rows[0] = headers;
        }

        const columnIndex = headers.map(h => h.toLowerCase());
        const dateIndex = columnIndex.findIndex(h => /date|created_at|time|jour|day/i.test(h));
        const montantIndex = columnIndex.findIndex(h => /montant|amount|price|prix|total|value/i.test(h));
        const emailIndex = columnIndex.findIndex(h => /email|mail|e-mail|courriel/i.test(h));
        const cpIndex = columnIndex.findIndex(h => /^(cp|zip|code\s?postal|postcode)$/i.test(h));
        const phoneRegex = /phone|tél|tel|mobile|portable|gsm|whatsapp|contact_no/i;        
        const nameRegex = /nom|name|prenom|firstname|lastname|ville|city|societe|company|pays|country|state/i;
        const nameIndices = headers
            .map((h, i) => {
                if (/url|link|slug/i.test(h)) return -1;
                return nameRegex.test(h) ? i : -1;
            })
            .filter(i => i !== -1);
        
        let hasFoundAnyCurrency = false;

        // --- 4. BOUCLE DE NETTOYAGE ---
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
                    fixed = normalizeDate(value, lang);
                    if (fixed !== value) {
                        safeReportPush({
                            row: rowIndex, column: headers[colIndex],
                            before: original, after: fixed,
                            reason: "Date normalized"
                        });
                        value = fixed;
                    }
                }

                // MONTANT
                else if (colIndex === montantIndex) {
                    const result = normalizeAmount(value, lang);
                    fixed = result.amount;
                    if (result.currency) {
                        if (!extractedCurrencies[rowIndex]) extractedCurrencies[rowIndex] = {};
                        extractedCurrencies[rowIndex][colIndex] = result.currency;
                        hasFoundAnyCurrency = true;
                    }
                    if (fixed !== value) {
                        safeReportPush({
                            row: rowIndex, column: headers[colIndex],
                            before: original, after: fixed,
                            reason: "Amount normalized"
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
                            row: rowIndex, column: headers[colIndex],
                            before: original, after: fixed,
                            reason: "Email auto-fixed"
                        });
                        value = fixed;
                    }
                }

                // TÉLÉPHONE
                else if (headers[colIndex] && phoneRegex.test(headers[colIndex])) {
                    fixed = normalizePhone(value, lang); // Appel à l'intelligence externe
                    
                    if (fixed !== original) {
                        safeReportPush({
                            row: rowIndex,
                            column: headers[colIndex] || `col_${colIndex}`,
                            before: original,
                            after: fixed,
                            reason: "Phone normalized"
                        });
                        value = fixed;
                    }
                }

                // CODE POSTAL
                else if (colIndex === cpIndex) {
                    fixed = normalizePostalCode(value, lang);
                    if (fixed !== value) {
                        safeReportPush({
                            row: rowIndex, column: headers[colIndex],
                            before: original, after: fixed,
                            reason: "Zip code fixed"
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
                
                // Nettoyage général
                const isSpecific = colIndex === dateIndex || colIndex === montantIndex || 
                                   (headers[colIndex] && /email|tel/i.test(headers[colIndex]));
                
                if (value !== original && !isSpecific) {
                    const trimmedOriginal = original.trim().replace(/\s+/g, " ");
                    if (value !== trimmedOriginal) {
                        safeReportPush({
                            row: rowIndex, column: headers[colIndex],
                            before: original, after: value,
                            reason: "General cleanup"
                        });
                    }
                }

                // SÉCURITÉ
                if (typeof value === 'string' && /^[=\+\-@]/.test(value)) {
                    const isSafeNumber = /^[\+\-][\d\s\.\,]*$/.test(value);
                    if (!isSafeNumber) {
                        let unsafeValue = value;
                        value = "'" + value; 
                        safeReportPush({
                            row: rowIndex, column: headers[colIndex],
                            before: unsafeValue, after: value,
                            reason: "🛡️ SECURITY: Formula neutralized"
                        });
                    }
                }

                return value;
            })
        );

        // --- 5. FINITIONS ---
        
        // Ajout colonne Devise
        if (montantIndex !== -1 && hasFoundAnyCurrency) {
            safeReportPush({ row: 0, column: "STRUCTURE", before: "No", after: "Yes", reason: "Currency column added" });
            
            const currencyHeader = lang === 'fr' ? 'Devise' : 'Currency';

            headers.splice(montantIndex + 1, 0, currencyHeader);
            rows[0] = headers;
            rows = rows.map((row, rowIndex) => {
                if (rowIndex === 0) return row;
                const currency = extractedCurrencies[rowIndex] ? extractedCurrencies[rowIndex][montantIndex] || '' : '';
                row.splice(montantIndex + 1, 0, currency);
                return row;
            });
        }

        // Harmonisation & Suppression
        const maxColumns = Math.max(...rows.map(r => r.length));
        rows = rows.map(r => {
            while (r.length < maxColumns) r.push("");
            if (r.length > maxColumns) r = r.slice(0, maxColumns);
            return r;
        });

        let finalRows = [rows[0]];
        const seen = new Set();
        for(let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const rowKey = row.join("|");
            
            const isRowEmpty = row.every(cell => !cell || cell.trim() === "");
            if (isRowEmpty) {
                safeReportPush({ row: i, column: "ROW", before: "Empty row", after: "Removed", reason: "Empty row" });
                continue;
            }
            if (seen.has(rowKey)) {
                safeReportPush({ row: i, column: "ROW", before: "Duplicate", after: "Removed", reason: "Duplicate row" });
                continue;
            }
            seen.add(rowKey);
            finalRows.push(row);
        }

        // Création de l'objet Preview (Top 5 lignes)
        const previewRows = [];
        const limit = Math.min(finalRows.length, 6); // 6 pour avoir header + 5 rows
        for(let i=0; i<limit; i++) {
            previewRows.push({
                original: rows[i] || [], // Tableau brut
                cleaned: finalRows[i]    // Tableau brut
            });
        }
        
        const utf8Bom = '\ufeff'; 
        const csvString = Papa.unparse(finalRows, { delimiter: separator });
        const finalCsvContent = utf8Bom + csvString;

        return { 
            csvContent: finalCsvContent,      
            reportData: report,               
            originalRowsCount: originalRowsCount,     
            cleanedRowsCount: finalRows.length, 
            originalColumnCount: originalColumnCount,
            preview: previewRows  
        };

    } catch (error) {
        console.error("Critical cleanCsv error:", error.message);
        throw error;
    }
}