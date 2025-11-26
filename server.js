import express from "express";
import cors from "cors"; // 1. Import du paquet cors
import multer from "multer";
import fs from "fs";

import Papa from "papaparse";
import chardet from "chardet";
import iconv from "iconv-lite";

import { dirname, join, parse } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto"; 

// On importe votre fonction depuis votre fichier de service
import { cleanCsv } from "./services/cleanerBase.js";

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

// REMPLACER ICI par l'URL exacte que Vercel vous a donnée (ex: https://cleanmycsv-xyz.vercel.app)
const VERCEL_URL = 'https://cleanmycsv-frontend.vercel.app'; 

app.use(cors({ 
    origin: VERCEL_URL // 2. Seul ce site (le "guichet d'accueil") est autorisé à parler à l'API.
}));

// 📂 Créer uploads/ et outputs/ si non existants
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("outputs")) fs.mkdirSync("outputs");

// --- AJOUT : Constantes pour le Nettoyage Automatique ---
const OUTPUTS_DIR = join(__dirname, "outputs");
const STALE_TIME_MS = 30 * 60 * 1000; // 30 minutes en millisecondes

// --- Stockage temporaire des fichiers uploadés ---
const upload = multer({ dest: "uploads/" });

// --- Servir les fichiers du dossier public ---
// app.use(express.static(join(__dirname, "public")));

// --- Servir les fichiers nettoyés et les rapports JSON ---
// Cette route est appelée par le front-end pour télécharger le résultat
app.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  // Ne pas autoriser la navigation dans les répertoires
  if (filename.includes("..")) {
    return res.status(400).send("Nom de fichier invalide.");
  }
  const filePath = join(__dirname, "outputs", filename);

  if (fs.existsSync(filePath)) {
    const isCsv = filename.endsWith('.csv');
    // Le nom de fichier public (téléchargé par l'utilisateur) est envoyé via un paramètre query
    const publicDownloadName = req.query.publicName || filename;

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${publicDownloadName}"`
    );
    res.setHeader("Content-Type", isCsv ? "text/csv" : "application/json");

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    // Suppression après l'envoi (cleanup)
    fileStream.on("close", () => {
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupErr) {
        console.error(`Erreur lors du cleanup du fichier ${filename}:`, cleanupErr);
      }
    });

    fileStream.on("error", (err) => {
      console.error("Erreur lors de l'envoi du stream:", err);
      res.status(500).end();
    });
  } else {
    res.status(404).send("Fichier non trouvé.");
  }
});


/**
 * Analyse le rapport JSON et génère un résumé en langage humain.
 * @param {Array<object>} report - Le tableau de changements généré par cleanCsv.
 * @param {number} originalRowsCount - Nombre de lignes avant suppression.
 * @param {number} cleanedRowsCount - Nombre de lignes après suppression.
 * @returns {object} Un objet de résumé contenant les métriques et les phrases clés.
 */
function analyzeReport(report, originalRowsCount, cleanedRowsCount) {
  const stats = {
    totalChanges: report.length,
    rowsRemoved: originalRowsCount - cleanedRowsCount,
    dateNormalizations: 0,
    amountNormalizations: 0,
    emailCorrections: 0,
    phoneCorrections: 0,
    generalFixes: 0,
    rowsAffected: new Set(),
  };

  report.forEach(change => {
    stats.rowsAffected.add(change.row);
    if (change.reason.includes("date normalisée")) stats.dateNormalizations++;
    else if (change.reason.includes("montant normalisé")) stats.amountNormalizations++;
    else if (change.reason.includes("email auto-corrigé")) stats.emailCorrections++;
    else if (change.reason.includes("téléphone normalisé")) stats.phoneCorrections++;
    else if (change.reason.includes("nettoyage général")) stats.generalFixes++;
  });
  
  const totalRowsAffected = stats.rowsAffected.size;

  let humanSummary = "Voici ce que nous avons fait pour vous :";
  let corrections = [];

  if (stats.dateNormalizations > 0) corrections.push(`<strong>Dates uniformisées :</strong> ${stats.dateNormalizations} cellules ont été converties au format AAAA-MM-JJ.`);
  if (stats.amountNormalizations > 0) corrections.push(`<strong>Montants corrigés :</strong> ${stats.amountNormalizations} montants ont vu leurs devises retirées et les virgules décimales normalisées en points.`);
  if (stats.rowsRemoved > 0) corrections.push(`<strong>Lignes superflues :</strong> ${stats.rowsRemoved} lignes totalement vides ou des doublons complets ont été supprimés.`);
  if (stats.emailCorrections > 0) corrections.push(`<strong>Adresses e-mail :</strong> ${stats.emailCorrections} adresses ont été formatées (espaces, doubles @, etc.).`);
  if (stats.phoneCorrections > 0) corrections.push(`<strong>Numéros de téléphone :</strong> ${stats.phoneCorrections} numéros ont été normalisés au format international (+33...).`);
  
  if (corrections.length === 0 && stats.rowsRemoved === 0) {
      humanSummary = "Votre fichier était déjà incroyablement propre ! Nous avons vérifié et harmonisé les formats, mais aucune correction majeure n'a été nécessaire.";
  } else {
      humanSummary = "<strong>Corrections principales :</strong><ul>" + corrections.map(c => `<li>${c}</li>`).join('') + "</ul>";
  }

  return {
    ...stats,
    humanSummary,
    totalRowsAffected,
    originalRowsCount: originalRowsCount,
    cleanedRowsCount: cleanedRowsCount
  };
}

/**
 * Tâche de nettoyage :
 * Scanne le dossier /outputs et supprime tous les fichiers
 * dont la date de modification est plus ancienne que STALE_TIME_MS (30 min).
 */
async function cleanupStaleFiles() {
  console.log(`[NETTOYAGE] Tâche de nettoyage périodique démarrée...`);
  try {
    const files = fs.readdirSync(OUTPUTS_DIR);

    for (const file of files) {
      // Ignorer les fichiers système ou de configuration (ex: .gitkeep)
      if (file.startsWith('.')) continue;

      const filePath = join(OUTPUTS_DIR, file);

      try {
        const stats = fs.statSync(filePath);
        const now = new Date().getTime();
        const fileTime = new Date(stats.mtime).getTime(); // Date de dernière modification

        // Si le fichier est plus vieux que 30 minutes
        if ((now - fileTime) > STALE_TIME_MS) {
          fs.unlinkSync(filePath);
          console.log(`[NETTOYAGE] Fichier obsolète supprimé : ${file}`);
        }
      } catch (statErr) {
        // Le fichier a peut-être été supprimé par un téléchargement
        console.warn(`[NETTOYAGE] Impossible de lire les stats de ${file}: ${statErr.message}`);
      }
    }
  } catch (readErr) {
    console.error("[NETTOYAGE] Erreur lors de la lecture du dossier outputs:", readErr);
  }
}

/**
 * Génère des noms de fichiers publics propres.
 * @param {string} originalName Nom de fichier original (ex: mon_fichier.csv)
 * @returns {{cleanCsvName: string, reportJsonName: string}}
 */
function generateCleanFilenames(originalName) {
    const { name, ext } = parse(originalName);
    
    // Nettoyage des caractères spéciaux et remplacement des espaces par des underscores
    const safeName = name.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
    
    // Le nom de base pour les fichiers
    const baseName = safeName.endsWith('-dirty') ? safeName.replace('-dirty', '') : safeName;

    let cleanCsvName = `${baseName}-clean${ext}`;
    let reportJsonName = `${baseName}-report.json`;

    return {
        cleanCsvName: cleanCsvName,
        reportJsonName: reportJsonName,
    };
}

// --- Upload et nettoyage (VERSION AVEC RÉPONSE JSON) ---
app.post("/clean-file", upload.single("csv_file_to_clean"), async (req, res) => {
  let filePath; // Chemin du fichier original uploadé
  let originalRowsCount = 0;
  const originalFileName = req.file?.originalname; // Récupère le nom original
  let tempCsvFileName; // Déclaré ici pour le nettoyage d'urgence
  let tempReportFileName; // Déclaré ici pour le nettoyage d'urgence


  try {
    if (!req.file) {
      throw new Error("Aucun fichier n'a été téléversé.");
    }
    filePath = req.file.path;
    
    // 1. Déterminer le nombre de lignes original (nécessite Papa, chardet, iconv)
    const encoding = chardet.detectFileSync(filePath) || "UTF-8";
    const originalContent = iconv.decode(fs.readFileSync(filePath), encoding);
    
    // On ignore les lignes vides lors du comptage
    const originalParsed = Papa.parse(originalContent, { skipEmptyLines: true }); 
    originalRowsCount = originalParsed.data.length - 1; // -1 pour l'en-tête (s'il existe)
    if (originalRowsCount < 0) originalRowsCount = 0; // Sécurité

    // --- Génération des noms de fichiers propres pour l'utilisateur ---
    const publicNames = generateCleanFilenames(originalFileName);

    // 2. Génération des noms de fichiers temporaires SÉCURISÉS (UUID) pour le serveur
    const tempUuid = randomUUID();
    tempCsvFileName = `clean-${tempUuid}.csv`;
    tempReportFileName = `report-${tempUuid}.json`;

    // 3. Lancement du nettoyage
    // NOTE: cleanCsv prend maintenant le chemin du fichier source et les noms des fichiers de sortie
    const result = cleanCsv(filePath, tempCsvFileName, tempReportFileName); 
    
    // Le nombre de lignes nettoyées vient de votre fonction
    const cleanedRowsCount = result.cleaned.length - 1; // -1 pour l'en-tête (s'il existe)

    // 4. Analyse du rapport pour le résumé UX
    const tempReportPath = join(__dirname, 'outputs', tempReportFileName);
    const reportContent = JSON.parse(fs.readFileSync(tempReportPath, 'utf-8'));
    const summary = analyzeReport(reportContent, originalRowsCount, cleanedRowsCount);

    // 5. Nettoyage du fichier original uploadé (le fichier dans /uploads)
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

    // 6. Réponse JSON au client (contient le résumé et les noms de fichiers temporaires et publics)
    res.json({
        success: true,
        summary: summary,
        
        // Nom de fichier TEMPORAIRE côté serveur (avec UUID)
        csvTempName: tempCsvFileName, 
        reportTempName: tempReportFileName, 
        
        // Nom de fichier PUBLIC pour le téléchargement par l'utilisateur (propre)
        downloadName: publicNames.cleanCsvName, 
        reportDownloadName: publicNames.reportJsonName, 
    });

  } catch (err) {
    console.error("ERREUR DANS LE BLOC /clean-file:", err);
    res.status(500).json({ success: false, message: "Erreur serveur : " + err.message });

    // Nettoyage d'urgence des fichiers temporaires (upload + sortie)
    try {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      // Supprimer les fichiers de sortie s'ils ont été créés
      if (tempCsvFileName) fs.unlinkSync(join(__dirname, 'outputs', tempCsvFileName));
      if (tempReportFileName) fs.unlinkSync(join(__dirname, 'outputs', tempReportFileName));
    } catch (cleanupErr) {
      // Ignorer l'erreur de cleanup
    }
  }
});

// --- DÉMARRAGE DU SERVEUR ET DU NETTOYEUR ---
// La variable process.env.PORT est donnée par Cloud Run.
// On utilise 8080 comme valeur par défaut si elle n'est pas trouvée (pour les tests locaux).
const PORT = process.env.PORT || 8080; 

// Le '0.0.0.0' dit au serveur d'écouter toutes les adresses disponibles.
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);

  // Lancer le nettoyage une première fois au démarrage
  cleanupStaleFiles();
  
  // Lancer le nettoyage toutes les 5 minutes
  const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; 
  setInterval(cleanupStaleFiles, CLEANUP_INTERVAL_MS);
});