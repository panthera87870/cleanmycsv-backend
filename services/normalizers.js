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
 * Normalise les formats de date courants en ISO 8601 (AAAA-MM-JJ).
 * Gère JJ/MM/AAAA, YYYY-MM-DD, DD-MON-YY.
 * @param {string} value - La valeur de la date.
 * @returns {string} La date normalisée (AAAA-MM-JJ) ou la valeur d'origine si impossible.
 */
export function normalizeDate(value) {
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
    // --- AJOUT : Format AAAA/MM/JJ (ex: 2023/02/20) ---
    // On remplace simplement les slashes par des tirets pour le rendre ISO
    if (value.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
        return value.replace(/\//g, "-");
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

    // Format 4 : JJ.MM.AAAA (ex: 25.12.2023)
    if (value.match(/^\d{2}\.\d{2}\.\d{4}$/)) {
        // On remplace les points par des tirets et on inverse pour ISO
        parts = value.split('.');
        const [d, m, y] = parts;
        return `${y}-${m}-${d}`;
    }
    
    // Format 5 : Nombre Excel (ex: 45290 pour une date récente)
    // On vérifie si c'est un nombre à 5 chiffres (dates entre 1927 et 2173)
    if (value.match(/^\d{5}$/)) {
        const serial = parseInt(value);
        // Formule magique pour convertir le serial Excel en Date JS
        // (Excel commence le 30/12/1899 techniquement à cause d'un bug d'année bissextile en 1900)
        const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
        
        // Vérifions que ça donne une date valide
        if (!isNaN(date.getTime())) {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
    }

    // Si aucune logique ne fonctionne, on retourne la valeur d'origine
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
 * Détecte le séparateur le plus probable d'un CSV. NEW
 */
export function detectSeparator(content) {
    // On prend juste les premières lignes pour aller vite et éviter les biais
    const snippet = content.slice(0, 5000); 
    
    const candidates = [",", ";", "\t", "|"];
    
    // On compte simplement combien de fois chaque séparateur apparaît
    const counts = candidates.map(sep => ({
        sep,
        // On découpe la chaîne par le séparateur et on compte les morceaux (-1)
        count: snippet.split(sep).length - 1
    }));

    // On trie pour avoir le gagnant en premier
    counts.sort((a, b) => b.count - a.count);

    console.log("Séparateurs détectés:", counts); // Pour le débogage serveur

    // Si aucun séparateur n'est trouvé (count 0), on fallback sur la virgule
    return counts[0].count > 0 ? counts[0].sep : ",";
}