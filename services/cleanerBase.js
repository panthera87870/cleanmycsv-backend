import fs from "fs";
import { join } from "path";
import Papa from "papaparse";
import chardet from "chardet";
import iconv from "iconv-lite";
// Importation de 'path' a été retirée car seul 'join' est nécessaire.

// --- FONCTIONS DE NORMALISATION INTELLIGENTE ---

/**
 * Normalise un montant en retirant les symboles de monnaie et en utilisant le point comme décimal.
 * Ex: "CAD488,49" -> 488.49
 * @param {string} value - La valeur du montant.
 * @returns {string} Le montant normalisé (formaté en XX.XX) ou la valeur nettoyée si non convertible.
 */
function normalizeAmount(value) {
    if (!value) return '';

    // 1. Supprimer les symboles de devise courants et les espaces
    let normalized = value.toUpperCase().trim()
        .replace(/[€$£CADAUD]/g, '')
        .replace(/\s/g, '');

    // 2. Normaliser le séparateur décimal
    if (normalized.includes(',')) {
        // Supprime les points (séparateurs de milliers potentiels) puis remplace la virgule par un point.
        normalized = normalized.replace(/\./g, '').replace(/,/g, '.');
    }

    // 3. Supprimer tout ce qui n'est pas un chiffre ou un point final
    normalized = normalized.replace(/[^\d.]/g, '');

    // 4. Vérification finale: si c'est un nombre valide, on le retourne
    if (!isNaN(parseFloat(normalized))) {
        return parseFloat(normalized).toFixed(2);
    }
    
    // Si la conversion échoue, on retourne la valeur nettoyée
    return normalized;
}

/**
 * Normalise les formats de date courants en ISO 8601 (AAAA-MM-JJ).
 * Gère JJ/MM/AAAA, YYYY-MM-DD, DD-MON-YY.
 * @param {string} value - La valeur de la date.
 * @returns {string} La date normalisée (AAAA-MM-JJ) ou la valeur d'origine si impossible.
 */
function normalizeDate(value) {
    if (!value) return '';

    const MONTHS = {
        'JAN': '01', 'FEB': '02', 'MAR': '03', 'APR': '04', 'MAY': '05', 'JUN': '06',
        'JUL': '07', 'AUG': '08', 'SEP': '09', 'OCT': '10', 'NOV': '11', 'DEC': '12'
    };

    let parts;

    // Format 1: JJ/MM/AAAA (ou JJ-MM-AAAA)
    if (value.match(/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/)) {
        parts = value.split(/[\/\-]/);
        if (parts.length === 3) {
            const [d, m, y] = parts;
            return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
    }
    
    // Format 2: AAAA-MM-JJ (Format ISO, on le conserve)
    if (value.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return value;
    }

    // Format 3: DD-MON-YY (ex: 6-MAR-12 ou 06-MAR-2012)
    if (value.match(/^\d{1,2}[-\/][A-Z]{3}[-\/]\d{2,4}$/i)) {
        parts = value.split(/[\/\-]/);
        if (parts.length === 3) {
            let [d, mon, y] = parts;
            mon = mon.toUpperCase();
            
            if (y.length === 2) { // Année sur 2 chiffres
                y = (parseInt(y) < 50 ? '20' : '19') + y;
            }

            if (MONTHS[mon]) {
                return `${y}-${MONTHS[mon]}-${d.padStart(2, '0')}`;
            }
        }
    }
    
    // Si aucune logique ne fonctionne, on retourne la valeur d'origine
    return value;
}

// --- FONCTION PRINCIPALE ---

/**
 * Nettoie un fichier CSV et écrit le résultat et le rapport
 * dans les chemins de sortie spécifiés par le serveur.
 * * @param {string} filePath - Chemin complet du fichier CSV à nettoyer (dans /uploads).
 * @param {string} csvOutputFilename - Nom du fichier CSV nettoyé à créer (ex: clean-uuid.csv).
 * @param {string} reportOutputFilename - Nom du rapport JSON à créer (ex: report-uuid.json).
 * @returns {{cleaned: Array<Array<string>>, report: Array<Object>}} Les données nettoyées et le rapport.
 */
export function cleanCsv(filePath, csvOutputFilename, reportOutputFilename) {
    
    const OUTPUT_DIR = join(process.cwd(), 'outputs');
    
    // Construction des chemins d'écriture complets sécurisés
    const finalCsvPath = join(OUTPUT_DIR, csvOutputFilename);
    const finalReportPath = join(OUTPUT_DIR, reportOutputFilename);

    const report = [];

    // 1. Détection d'encodage
    const encoding = chardet.detectFileSync(filePath) || "UTF-8";

    // 2. Lecture et conversion en UTF-8
    const buffer = fs.readFileSync(filePath);
    const content = iconv.decode(buffer, encoding);

    // 3. Détection automatique du séparateur
    const separator = detectSeparator(content);

    // 4. Parsing avec PapaParse
    const parsed = Papa.parse(content, {
      delimiter: separator,
      skipEmptyLines: false
    });

    let rows = parsed.data;
    const headers = rows[0] || [];

    // Déterminer les index des colonnes à nettoyer spécifiquement
    const columnIndex = headers.map(h => h.toLowerCase());
    const dateIndex = columnIndex.findIndex(h => h.includes('date'));
    const montantIndex = columnIndex.findIndex(h => h.includes('montant') || h.includes('amount'));

    // 5. Normalisation et nettoyage des cellules
    let initialRowCount = rows.length; // Pour le log

    rows = rows.map((row, rowIndex) =>
        row.map((cell, colIndex) => {
            // Pour la ligne d'en-tête, on la saute
            if (rowIndex === 0) return cell;

            if (!cell) return "";

            let original = cell;
            let value = cell.trim();
            let fixed = value; // Variable pour stocker la valeur corrigée temporairement

            // --- 5.1 Nettoyage Général (appliqué à toutes les cellules sauf l'en-tête) ---
            
            // Corriger erreurs ville genre "+Atampes"
            value = value.replace(/^\+([A-Za-z])/, "$1");

            // Compresser espaces multiples
            value = value.replace(/\s+/g, " ");

            // Nettoyer valeurs "nulles"
            value = value.replace(/^(NULL|N\/A|-|undefined|none|nan)$/i, "");

            // Retirer les séparateurs intrus (par défaut, on retire le | si ce n'est pas une colonne Montant/Date)
            if (colIndex !== montantIndex) {
                value = value.replace(/[|]/g, ''); 
            }

            // --- 5.2 Nettoyage Spécifique (Intelligent) ---

            // Correction DATE
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

            // Correction MONTANT
            else if (colIndex === montantIndex) {
                fixed = normalizeAmount(value);
                if (fixed !== value) {
                    report.push({
                        row: rowIndex,
                        column: headers[colIndex] || `col_${colIndex}`,
                        before: original,
                        after: fixed,
                        reason: "montant normalisé (symboles retirés, point décimal forcé)"
                    });
                    value = fixed;
                }
            }

            // Correction EMAIL
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

            // Correction TÉLÉPHONE
            else if (headers[colIndex] && headers[colIndex].toLowerCase().includes("tel")) {
                let digits = value.replace(/\D/g, ""); // garder que chiffres
                // On ne normalise que si on a suffisamment de chiffres
                if (digits.length >= 9) {
                    if (digits.startsWith("0")) digits = "33" + digits.slice(1);
                    else if (digits.length === 10 && !digits.startsWith("33")) digits = "33" + digits; 
                
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
            
            // Enregistrement des changements de nettoyage général (si non déjà logués par Date/Montant/Email/Tel)
            const isSpecificCorrection = colIndex === dateIndex || colIndex === montantIndex || 
                                         (headers[colIndex] && headers[colIndex].toLowerCase().includes("email")) ||
                                         (headers[colIndex] && headers[colIndex].toLowerCase().includes("tel"));
            
            if (value !== original && !isSpecificCorrection) {
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
        
        // Ligne vide?
        const isRowEmpty = row.every(cell => !cell || cell.trim() === "");
        if (isRowEmpty) {
            report.push({ row: i, column: "ROW", before: rowKey, after: "N/A", reason: "Ligne totalement vide supprimée." });
            continue;
        }

        // Doublon?
        if (seen.has(rowKey)) {
            report.push({ row: i, column: "ROW", before: rowKey, after: "N/A", reason: "Ligne identifiée comme doublon complet et supprimée." });
            continue;
        }
        
        seen.add(rowKey);
        finalRows.push(row);
    }
    
    // 8. Sauvegarde CSV nettoyé
    fs.writeFileSync(finalCsvPath, Papa.unparse(finalRows), 'utf-8');

    // 9. Sauvegarde rapport JSON
    fs.writeFileSync(finalReportPath, JSON.stringify(report, null, 2), 'utf-8');

    // On retourne les données pour qu'app.js puisse compter les lignes nettoyées
    return { cleaned: finalRows, report: report };
}


/**
 * Détecte le séparateur le plus probable d'un CSV.
 */
function detectSeparator(content) {
  const candidates = [",", ";", "\t", "|"];
  const counts = candidates.map(sep => ({
    sep,
    count: (content.match(new RegExp(`\\${sep}`, "g")) || []).length
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].sep || ",";
}