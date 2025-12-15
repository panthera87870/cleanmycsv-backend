// --- FONCTIONS DE NORMALISATION INTELLIGENTE ---

/**
 * Normalise un montant en retirant les symboles de monnaie et en utilisant le point comme décimal.
 * Ex: "CAD488,49" -> 488.49
 * @param {string} value - La valeur du montant.
 * @returns {string} Le montant normalisé (formaté en XX.XX) ou la valeur nettoyée si non convertible.
 */
export function normalizeAmount(value) {
    if (!value) return '';

    // Remplacement des lignes à NEW
    let originalValue = value.toUpperCase().trim();
    let currency = '';

    // Regex pour identifier et capturer les symboles ou codes (ajout USD, EUR, GBP) NEW
    const currencyRegex = /([€$£¥]|CAD|AUD|USD|EUR|GBP|CHF|JPY|SEK)/i;
    const match = originalValue.match(currencyRegex);

    if (match) {
        currency = match[1].toUpperCase();
        // Normaliser les symboles en codes (ex: $ -> USD)
        if (currency === '€') currency = 'EUR';
        if (currency === '$') currency = 'USD';
        if (currency === '£') currency = 'GBP';
        if (currency === '¥') currency = 'JPY';
    }

    // 1. Supprimer les symboles de devise courants et les espaces du montant NEW
    let normalized = originalValue
        .replace(currencyRegex, '')
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
        // Retourne le montant nettoyé et la devise NEW
        return { amount: parseFloat(normalized).toFixed(2), currency: currency || '' };
    }
    
    // Si la conversion échoue, on retourne la valeur nettoyée
    return normalized;
}

/**
 * Normalise intelligemment une date vers le format ISO (AAAA-MM-JJ).
 * Gère : DD/MM/YY, YY-MM-DD, DD.MM.AAAA, Textes (Jan, Fév)...
 */
export function normalizeDate(value) {
    if (!value) return '';
    
    // Nettoyage de base
    let clean = value.trim().toUpperCase();

    // 0. Gérer Excel Serial (le nombre magique ex: 45290)
    if (/^\d{5}$/.test(clean)) {
        const serial = parseInt(clean);
        const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
        if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
        }
    }

    // 1. Gérer les mois textuels (ex: "5 Jan 2023" ou "05-FEV-23")
    // On remplace le texte par le chiffre correspondant pour simplifier la suite
    const MONTHS = {
        'JAN': '01', 'FEB': '02', 'FÉV': '02', 'FEV': '02', 'MAR': '03', 'APR': '04', 
        'AVR': '04', 'MAY': '05', 'MAI': '05', 'JUN': '06', 'JUI': '06', 'JUL': '07', 
        'JUIL': '07', 'AUG': '08', 'AOU': '08', 'AOÛ': '08', 'SEP': '09', 'OCT': '10', 
        'NOV': '11', 'DEC': '12', 'DÉC': '12'
    };
    
    // On cherche si un mois texte est présent et on le remplace
    for (const [txt, num] of Object.entries(MONTHS)) {
        if (clean.includes(txt)) {
            clean = clean.replace(txt, num);
            break; // On a trouvé, on arrête
        }
    }

    // 2. UNIFICATION : On remplace tous les séparateurs (/, ., espace) par des tirets
    // Ex: "24.02.01" devient "24-02-01"
    // Ex: "2023/01/01" devient "2023-01-01"
    clean = clean.replace(/[\/\.\s]/g, '-');

    // 3. ANALYSE STRUCTURELLE
    const parts = clean.split('-');

    // On ne traite que si on a bien 3 morceaux (Jour, Mois, Année)
    if (parts.length === 3) {
        let [p1, p2, p3] = parts;
        let y, m, d;

        // Cas A : L'année est au début (AAAA-MM-JJ ou YY-MM-DD)
        // Critère : p1 est grand (> 31) OU p1 a 4 chiffres
        if (p1.length === 4 || parseInt(p1) > 31) {
            y = p1;
            m = p2;
            d = p3;
        } 
        // Cas B : L'année est à la fin (JJ-MM-AAAA ou JJ-MM-YY) -> Standard Français
        else {
            d = p1;
            m = p2;
            y = p3;
        }

        // 4. GESTION DES ANNÉES À 2 CHIFFRES (Règle du Pivot)
        if (y.length === 2) {
            const yInt = parseInt(y);
            // Si < 50, on suppose 20xx (ex: 24 -> 2024)
            // Si >= 50, on suppose 19xx (ex: 99 -> 1999)
            y = (yInt < 50 ? '20' : '19') + y;
        }

        // 5. Validation et Formatage final
        // On s'assure que tout est numérique
        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            // Padding (ex: 1 -> 01)
            const mm = m.padStart(2, '0');
            const dd = d.padStart(2, '0');
            
            // Vérification basique de validité (Mois entre 1 et 12)
            if (parseInt(mm) >= 1 && parseInt(mm) <= 12 && parseInt(dd) >= 1 && parseInt(dd) <= 31) {
                return `${y}-${mm}-${dd}`;
            }
        }
    }

    // Si rien n'a marché, on renvoie la valeur d'origine (fallback)
    return value;
}

// normalizers.js

/**
 * Normalise un code postal français.
 * Si le code fait 4 chiffres (ex: 6100), rajoute le 0 devant (06100).
 * Ne touche pas aux codes complexes (étrangers, corses 2A/2B s'ils sont bien formattés).
 */
export function normalizePostalCode(value) {
    if (!value) return value;
    
    // On nettoie les espaces
    let clean = value.toString().trim().replace(/\s+/g, "");

    // Cas spécifique France : 4 chiffres -> on rajoute le 0
    // Ex: "6100" devient "06100"
    if (/^\d{4}$/.test(clean)) {
        return "0" + clean;
    }

    // Si c'est déjà 5 chiffres, on s'assure juste que c'est propre
    if (/^\d{5}$/.test(clean)) {
        return clean;
    }

    // Sinon (Code étranger ou corse 2A...), on renvoie tel quel
    return value;
}

export function normalizeName(value) {
    if (!value) return '';
    
    // 1. Capitalisation classique (Tout en Titre)
    let formatted = value.toString().toLowerCase().replace(/(?:^|[\s-])\w/g, m => m.toUpperCase());

    // 2. Gestion des exceptions (particules nobles)
    // On remplace " De " par " de ", " Du " par " du " (mais pas au début de la phrase)
    const particles = [" De ", " Du ", " Des ", " Le ", " La ", " Van ", " Von "];
    particles.forEach(p => {
        // Regex : On cherche la particule entourée d'espaces, pas au début du string
        formatted = formatted.replace(new RegExp(p, 'g'), p.toLowerCase());
    });

    return formatted;
}

/**
 * Détecte le séparateur le plus probable avec une préférence pour le point-virgule (standard FR).
 */
export function detectSeparator(content) {
    // On prend un échantillon plus large (10k caractères) pour être sûr
    const snippet = content.slice(0, 10000); 
    
    const candidates = [
        { char: ";", weight: 1.1 }, // Bonus x1.1 pour le standard français
        { char: ",", weight: 1.0 },
        { char: "\t", weight: 1.0 },
        { char: "|", weight: 1.0 }
    ];
    
    // On compte et on applique le poids
    const counts = candidates.map(c => {
        // Astuce performante pour compter les occurrences sans regex lourde
        const count = snippet.split(c.char).length - 1;
        return {
            sep: c.char,
            score: count * c.weight // Le score inclut le bonus
        };
    });

    // On trie par score décroissant (le plus grand en premier)
    counts.sort((a, b) => b.score - a.score);

    console.log("[DEBUG] Scores séparateurs:", counts.map(c => `${c.sep}=${c.score.toFixed(1)}`)); 

    // Si le vainqueur a un score de 0 (cas fichier vide ou bizarre), on fallback sur la virgule
    return counts[0].score > 0 ? counts[0].sep : ",";
}