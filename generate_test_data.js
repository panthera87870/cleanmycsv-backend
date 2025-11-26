import fs from 'fs/promises';
import path from 'path';

// --- Configuration ---
const NUM_LINES = 50000;
const OUTPUT_FILE = path.join(process.cwd(), 'public', 'test_data_dirty.csv');
const SEPARATOR = ';'; // Utilisation du point-virgule comme séparateur "officiel"

// --- Fonctions utilitaires pour créer de la saleté ---

// Génère une valeur avec 5% de chance d'être une valeur nulle incohérente
const generateDirtyValue = (baseValue) => {
    const random = Math.random();
    if (random < 0.02) return 'N/A';
    if (random < 0.04) return ''; // Chaîne vide
    if (random < 0.06) return ' NULL '; // Espace et format erroné
    return baseValue;
};

// Génère une date dans 3 formats aléatoires
const generateDirtyDate = (i) => {
    const d = new Date(Date.now() - (i * 86400000) / 10);
    const formats = [
        `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`, // JJ/MM/AAAA
        `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`, // AAAA-MM-JJ
        `${d.getDate()}-${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()]}-${d.getFullYear().toString().slice(2)}` // DD-MON-YY
    ];
    return formats[Math.floor(Math.random() * formats.length)];
};

// Génère un montant avec des séparateurs décimaux mélangés et des symboles
const generateDirtyAmount = (i) => {
    let amount = (Math.random() * 1000 + 10).toFixed(2);
    
    // 30% de chance d'utiliser une virgule au lieu d'un point
    if (Math.random() < 0.3) {
        amount = amount.replace('.', ','); 
    }
    // 20% de chance d'ajouter un symbole de devise étrange
    if (Math.random() < 0.2) {
        const symbols = ['€', '$', '£', 'CAD'];
        amount = symbols[Math.floor(Math.random() * symbols.length)] + amount;
    }
    return amount;
};

// --- Création du Contenu ---

const header = ['ID', 'Date_Transaction', 'Montant', 'Nom_Client', 'Description_Produit', 'Statut'].join(SEPARATOR) + '\n';
let content = header;

// Stocke les lignes pour créer des doublons
const generatedLines = [];

for (let i = 1; i <= NUM_LINES; i++) {
    const id = i;
    const date = generateDirtyDate(i);
    const amount = generateDirtyAmount(i);
    const name = `Client ${Math.floor(i / 100)}`;
    
    // Ajouter un caractère bizarre au milieu de la description
    let description = `Achat de produit X${i} pour la campagne Y.`;
    if (i % 7 === 0) description += ' | (Séparateur Intrus)'; 
    if (i % 11 === 0) description += ' \u{20AC}'; // Symbole Euro mal placé

    const status = (i % 2 === 0) ? 'COMPLETED' : 'PENDING';

    const lineData = [
        id,
        generateDirtyValue(date),
        generateDirtyValue(amount),
        generateDirtyValue(name),
        generateDirtyValue(description),
        generateDirtyValue(status)
    ];

    const newLine = lineData.join(SEPARATOR) + '\n';
    generatedLines.push(newLine);
    content += newLine;

    // Ajouter un doublon partiel ou total pour 15% des lignes
    if (i % 6 === 0) {
        // Dupliquer la ligne précédente (doublon total)
        content += generatedLines[generatedLines.length - 1]; 
    }
    if (i % 10 === 0) {
        // Doublon partiel (même nom, même montant, ID différent)
        const partialDup = [
            id + 100000, // Nouvel ID
            generateDirtyValue(date),
            generateDirtyValue(amount),
            generateDirtyValue(name), // Même Nom
            generateDirtyValue(description),
            'REPLACED' // Statut modifié
        ].join(SEPARATOR) + '\n';
        content += partialDup;
    }
}

// --- Écriture du fichier ---
(async () => {
    try {
        await fs.writeFile(OUTPUT_FILE, content, 'utf-8');
        console.log(`✅ Fichier de ${NUM_LINES} lignes (et ses doublons) créé avec succès : ${OUTPUT_FILE}`);
        console.log(`Le fichier contient des dates, montants et séparateurs incohérents.`);
    } catch (err) {
        console.error('Erreur lors de l\'écriture du fichier:', err);
    }
})();