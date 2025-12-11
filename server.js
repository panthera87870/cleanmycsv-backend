import express from "express";
import cors from "cors"; // 1. Import du paquet cors
import multer from "multer";
import fsStandard from "fs"; 
import fs from "fs/promises";

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto"; 
import helmet from "helmet"; // 🔥 MODIF: Ajout conseillé pour la sécurité (npm install helmet)

import { cleanCsv } from "./services/cleaner.js";
import { 
    analyzeReport, 
    generateCleanFilenames
} from "./services/reporter.js";

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

const allowedOrigins = [
    'https://www.cleanmycsv.fr',
    'https://cleanmycsv.fr',
    'https://cleanmycsv-frontend.vercel.app'
];

// 🔥 MODIF: Sécurité HTTP de base
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            scriptSrc: [
                "'self'", 
                "'unsafe-inline'",
                "https://kit.fontawesome.com"
            ], 
            styleSrc: [
                "'self'", 
                "'unsafe-inline'", 
                "https://fonts.googleapis.com", 
                "https://fonts.gstatic.com",
                "https://ka-f.fontawesome.com" // <-- AJOUT pour les CSS de Font Awesome
            ],
            // 🔥 AJOUT CRITIQUE pour Font Awesome (connect-src)
            connectSrc: [
                "'self'", 
                "https://ka-f.fontawesome.com"
            ], 
            imgSrc: ["'self'", "data:"], 
            defaultSrc: ["'self'"], 
            scriptSrcAttr: ["'unsafe-inline'"], 
        },
    },
    // Désactiver HSTS pour le développement local
    hsts: {
        maxAge: 0 
    }
}));

// Correction recommandée pour server.js
app.use(cors({ 
    origin: function (origin, callback) {
        // Autoriser les requêtes sans origine (comme curl ou Postman) ou les origines listées
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            // Rejeter les autres origines en production
            callback(new Error('Not allowed by CORS')); 
        }
    }
}));

const OUTPUTS_DIR = join(__dirname, "outputs");

const STALE_TIME_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

if (!fsStandard.existsSync(OUTPUTS_DIR)) fsStandard.mkdirSync(OUTPUTS_DIR);

// 🔥 MODIF: CONFIGURATION MULTER SÉCURISÉE (MÉMOIRE + LIMITE)
const upload = multer({ 
    storage: multer.memoryStorage(), // Stocke en RAM, pas sur le disque
    limits: { fileSize: 50 * 1024 * 1024 } // Limite stricte à 50 Mo
});

// --- ROUTES ---

// ROUTE 1: Téléchargement 
app.get("/download/:filename", async (req, res) => { // AJOUT: async
    const filename = req.params.filename;
    
    // Sécurité chemin
    if (filename.includes("..")) {
        return res.status(400).send("Nom de fichier invalide.");
    }
    const filePath = join(OUTPUTS_DIR, filename);

    try {
        await fs.stat(filePath); 

        const isCsv = filename.endsWith('.csv'); 
        const publicDownloadName = req.query.publicName || filename;

        res.setHeader("Content-Disposition", `attachment; filename="${publicDownloadName}"`);
        res.setHeader("Content-Type", isCsv ? "text/csv" : "application/json");

        // Lecture Stream 
        const fileStream = fsStandard.createReadStream(filePath);
        fileStream.pipe(res);
        fileStream.on("close", async () => {
            try {
                await fs.unlink(filePath); // unlink au lieu de unlinkSync
                // console.log(`[CLEANUP] Fichier supprimé : ${filename}`);
            } catch (cleanupErr) {
                console.error(`Erreur cleanup ${filename}:`, cleanupErr.message);
            }
        });
        
        fileStream.on("error", (err) => {
            console.error("Erreur stream:", err.message);
            res.status(500).end();
        });

    } catch (err) {
        // Si fs.stat échoue (fichier non trouvé)
        res.status(404).send("Fichier non trouvé ou expiré.");
    }
});

// ROUTE 2: Upload et Nettoyage (🔥 TOTALEMENT REVISITÉE)
app.post("/clean-file", upload.single("csv_file_to_clean"), async (req, res) => {
    let originalRowsCount = 0;
    let originalColumnCount = 0;
    const originalFileName = req.file?.originalname; 
    
    let tempCsvFileName;
    let tempReportFileName;

    try {
        if (!req.file) throw new Error("Aucun fichier n'a été téléversé.");
        
        // 🔥 MODIF: On récupère le BUFFER (mémoire) et non plus le path
        const fileBuffer = req.file.buffer; 

        const publicNames = generateCleanFilenames(originalFileName);

        // Noms temporaires (UUID) pour les fichiers de SORTIE (ceux-là vont sur le disque)
        const tempUuid = randomUUID();
        tempCsvFileName = `clean-${tempUuid}.csv`;
        tempReportFileName = `report-${tempUuid}.json`;

        // 🔥 MODIF: Appel de cleanCsv avec le buffer
        // (Rappel: Tu dois avoir modifié cleaner.js pour accepter le buffer en 1er argument)
        const result = await cleanCsv(
            fileBuffer, 
            tempCsvFileName, 
            tempReportFileName, 
            OUTPUTS_DIR
        );

        // 🔥 MODIF: Sécurité - On vide la mémoire manuellement
        req.file.buffer = null; 

        const cleanedRowsCount = result.cleaned.length // > 0 ? result.cleaned.length - 1 : 0;
        
        originalRowsCount = result.originalRowsCount; // Lignes totales initiales (avec en-tête)
        originalColumnCount = result.originalColumnCount; // Colonnes initiales

        const tempReportPath = join(OUTPUTS_DIR, tempReportFileName);
        const reportRaw = await fs.readFile(tempReportPath, 'utf-8');
        const reportContent = JSON.parse(reportRaw);

        // Résumé Humain
        const summary = analyzeReport(reportContent, originalRowsCount, cleanedRowsCount, originalColumnCount);

        // Suppression du fichier uploadé en Async
        // if (await fs.access(filePath).then(() => true).catch(() => false)) {
        //    await fs.unlink(filePath);
       // }

        // Réponse JSON
        res.json({
            success: true,
            summary: summary,
            csvTempName: tempCsvFileName,
            reportTempName: tempReportFileName,
            downloadName: publicNames.cleanCsvName,
            reportDownloadName: publicNames.reportJsonName,
        });

    } catch (err) {
        console.error("ERREUR /clean-file:", err.message);

        // Gestion des erreurs de taille de fichier (Multer)
        if (err.code === 'LIMIT_FILE_SIZE') {
             return res.status(400).json({ success: false, message: "Le fichier est trop volumineux (Max 50Mo)." });
        }

        res.status(500).json({ success: false, message: "Erreur serveur : " });

        // Nettoyage d'urgence (Async)
        try {
            if (tempCsvFileName) await fs.unlink(join(OUTPUTS_DIR, tempCsvFileName)).catch(() => {});
            if (tempReportFileName) await fs.unlink(join(OUTPUTS_DIR, tempReportFileName)).catch(() => {});
        } catch (e) { /* ignore */ }
    }
});


// --- TÂCHE DE FOND (NETTOYAGE) ---

async function cleanupStaleFiles() {
    // console.log(`[NETTOYAGE] Vérification...`);
    try {
        // Lecture async du dossier
        const files = await fs.readdir(OUTPUTS_DIR);
        const now = Date.now();

        for (const file of files) {
            if (file.startsWith('.')) continue;
            const filePath = join(OUTPUTS_DIR, file);

            try {
                const stats = await fs.stat(filePath); // Async stat
                if ((now - stats.mtimeMs) > STALE_TIME_MS) {
                    await fs.unlink(filePath); // Async delete
                    console.log(`[NETTOYAGE] Supprimé : ${file}`);
                }
            } catch (e) {
                // Fichier déjà parti, on ignore
            }
        }
    } catch (err) {
        console.error("[NETTOYAGE] Erreur:", err.message);
    }
}

const PORT = process.env.PORT || 8080; 
app.listen(PORT, '0.0.0.0', () => {
    // AJOUT D'UN COMMENTAIRE POUR FORCER LE BUILD
    console.log(`Serveur lancé sur le port ${PORT}`);

    cleanupStaleFiles();
    setInterval(cleanupStaleFiles, CLEANUP_INTERVAL_MS);
});