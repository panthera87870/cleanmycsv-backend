// --- FONCTIONS DE NORMALISATION INTELLIGENTE ---

/**
 * Normalise un montant en retirant les symboles de monnaie et en utilisant le point comme décimal.
 * Ex: "CAD488,49" -> 488.49
 * @param {string} value - La valeur du montant.
 * @returns {string} Le montant normalisé (formaté en XX.XX) ou la valeur nettoyée si non convertible.
 */
export function normalizeAmount(value, lang = 'en') {
    if (!value) return '';

    let originalValue = value.toUpperCase().trim();
    let currency = '';

    const currencyRegex = /([€$£¥]|CAD|AUD|USD|EUR|GBP|CHF|JPY|SEK)/i;
    const match = originalValue.match(currencyRegex);

    if (match) {
        currency = match[1].toUpperCase();
        if (currency === '€') currency = 'EUR';
        if (currency === '$') currency = 'USD';
        if (currency === '£') currency = 'GBP';
        if (currency === '¥') currency = 'JPY';
    }

    // 2. Nettoyage initial (retrait devise et symboles bizarres)
    let clean = originalValue.replace(currencyRegex, '').trim();

    // 3. LOGIQUE CONDITIONNELLE SELON LA LANGUE
    if (lang === 'fr') {
        // --- LOGIQUE FRANÇAISE ---
        // On vire les espaces (séparateur milliers FR)
        clean = clean.replace(/\s/g, '');
        // Si on a un point suivi de 3 chiffres (ex: 1.000,50), le point est un séparateur millier -> on le vire
        // Si on a juste un point (10.5), c'est peut-être une erreur de frappe pour une virgule, on garde pour le traitement standard
        if (/\.\d{3}/.test(clean)) {
            clean = clean.replace(/\./g, ''); 
        }
        // On remplace la virgule décimale par un point pour le JS
        clean = clean.replace(',', '.');
    } else {
        // --- LOGIQUE US/INTERNATIONALE (Défaut) ---
        // On vire les espaces (par sécurité)
        clean = clean.replace(/\s/g, '');
        // On vire les virgules (séparateur milliers US : 1,000.00 -> 1000.00)
        clean = clean.replace(/,/g, '');
        // Le point reste un point (décimale)
    }

    // 4. Nettoyage final (on ne garde que chiffres et le point décimal)
    clean = clean.replace(/[^\d.]/g, '');

    // 5. Validation et retour
    if (!isNaN(parseFloat(clean))) {
        return { amount: parseFloat(clean).toFixed(2), currency: currency || '' };
    }
    
    // Fallback : si échec, on renvoie la valeur d'origine nettoyée des espaces
    return originalValue.replace(/\s/g, '');
}

/**
 * Normalise une date en tenant compte de l'inversion Jour/Mois (US vs FR).
 * FR : JJ/MM/AAAA
 * US : MM/DD/YYYY
 */
export function normalizeDate(value, lang = 'en') {
    if (!value) return '';
    
    let clean = value.trim().toUpperCase();

    // 0. Excel Serial (inchangé)
    if (/^\d{5}$/.test(clean)) {
        const serial = parseInt(clean);
        const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
        if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
    }

    // 1. Mois Textuels (inchangé)
    const MONTHS = {
        'JAN': '01', 'FEB': '02', 'FÉV': '02', 'FEV': '02', 'MAR': '03', 'APR': '04', 
        'AVR': '04', 'MAY': '05', 'MAI': '05', 'JUN': '06', 'JUI': '06', 'JUL': '07', 
        'JUIL': '07', 'AUG': '08', 'AOU': '08', 'AOÛ': '08', 'SEP': '09', 'OCT': '10', 
        'NOV': '11', 'DEC': '12', 'DÉC': '12'
    };
    for (const [txt, num] of Object.entries(MONTHS)) {
        if (clean.includes(txt)) { clean = clean.replace(txt, num); break; }
    }

    // 2. Unification des séparateurs
    clean = clean.replace(/[\/\.\s]/g, '-');
    const parts = clean.split('-');

    // 3. ANALYSE AVEC CONTEXTE DE LANGUE
    if (parts.length === 3) {
        let p1 = parts[0];
        let p2 = parts[1];
        let p3 = parts[2];
        let y, m, d;

        // CAS 1 : Année au début (AAAA-MM-JJ) -> Universel (ISO)
        if (p1.length === 4) {
            y = p1; m = p2; d = p3;
        }
        // CAS 2 : Année à la fin (XX-XX-AAAA) -> C'est là que ça se joue
        else {
            y = p3;
            // Si on est en ANGLAIS (US First) -> On suppose MM-DD-YYYY
            if (lang === 'en') {
                m = p1; // Le mois en premier
                d = p2;
                
                // INTELLIGENCE : Si le "Mois" présumé est > 12 (ex: 13/01/2023), c'est impossible.
                // Donc l'utilisateur a probablement mis JJ/MM même en étant US (ou erreur). On inverse.
                if (parseInt(m) > 12) {
                    m = p2;
                    d = p1;
                }
            } 
            // Si on est en FRANÇAIS -> On suppose JJ-MM-AAAA
            else {
                d = p1; // Le jour en premier
                m = p2;
            }
        }

        // 4. Gestion Année 2 chiffres (inchangé)
        if (y.length === 2) {
            y = (parseInt(y) < 50 ? '20' : '19') + y;
        }

        // 5. Validation et Assemblage
        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            const mm = m.padStart(2, '0');
            const dd = d.padStart(2, '0');
            // Validité stricte
            if (parseInt(mm) >= 1 && parseInt(mm) <= 12 && parseInt(dd) >= 1 && parseInt(dd) <= 31) {
                return `${y}-${mm}-${dd}`;
            }
        }
    }

    return value;
}

/**
 * Normalise un Code Postal (US ZIP & FR)
 * - US : Gère le padding (2110 -> 02110) et le format ZIP+4 (123456789 -> 12345-6789)
 * - FR : Gère le padding (6100 -> 06100)
 */
export function normalizePostalCode(value, lang = 'en') {
    if (!value) return value;
    
    // Conversion en string et nettoyage de base
    let clean = value.toString().trim();

    if (lang === 'en') {
        // --- LOGIQUE US (ZIP & ZIP+4) ---
        
        // 1. On ne garde que les chiffres et le tiret
        clean = clean.replace(/[^0-9-]/g, "");

        // Cas A : 3 ou 4 chiffres (ex: "2110" pour Boston) -> On remet le zéro devant (02110)
        if (/^\d{3,4}$/.test(clean)) {
            return clean.padStart(5, '0');
        }

        // Cas B : 9 chiffres collés (ex: "123456789") -> Format ZIP+4 (12345-6789)
        if (/^\d{9}$/.test(clean)) {
            return `${clean.substring(0, 5)}-${clean.substring(5)}`;
        }

        // Cas C : Format déjà valide (5 chiffres ou 5+4 avec tiret) -> On garde
        if (/^\d{5}$/.test(clean) || /^\d{5}-\d{4}$/.test(clean)) {
            return clean;
        }

    } else {
        // --- LOGIQUE FR (5 chiffres) ---
        clean = clean.replace(/\D/g, "");

        // Cas : 4 chiffres (ex: "6100") -> Ajout du zéro (06100)
        if (/^\d{4}$/.test(clean)) {
            return '0' + clean;
        }
    }

    // Si aucun pattern n'est reconnu, on renvoie la valeur brute nettoyée ou l'originale
    return clean || value;
}

export function normalizeName(value) {
    if (!value) return '';
    let formatted = value.toString().toLowerCase().replace(/(?:^|[\s-])\w/g, m => m.toUpperCase());
    const particles = [" De ", " Du ", " Des ", " Le ", " La ", " Van ", " Von ", " Mc", " O'"]; // Ajout Mc/O' pour US
    particles.forEach(p => {
        formatted = formatted.replace(new RegExp(p, 'g'), p.toLowerCase());
    });
    return formatted;
}

/**
 * Détecte le séparateur.
 * Si FR : Préférence pour le point-virgule (;).
 * Si EN : Préférence pour la virgule (,).
 */
export function detectSeparator(content, lang = 'en') {
    const snippet = content.slice(0, 10000); 
    
    // Adaptation des poids selon la langue
    let semiWeight = 1.0;
    let commaWeight = 1.0;

    if (lang === 'fr') {
        semiWeight = 1.2; // Bonus FR pour ;
    } else {
        commaWeight = 1.1; // Bonus US pour ,
    }

    const candidates = [
        { char: ";", weight: semiWeight }, 
        { char: ",", weight: commaWeight },
        { char: "\t", weight: 1.0 },
        { char: "|", weight: 1.0 }
    ];
    
    const counts = candidates.map(c => {
        const count = snippet.split(c.char).length - 1;
        return { sep: c.char, score: count * c.weight };
    });

    counts.sort((a, b) => b.score - a.score);
    // console.log(`[DEBUG SEPARATOR] Lang: ${lang}, Scores:`, counts.map(c => `${c.sep}=${c.score.toFixed(1)}`)); 

    return counts[0].score > 0 ? counts[0].sep : (lang === 'fr' ? ";" : ",");
}