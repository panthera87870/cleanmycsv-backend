import express from "express";
import cors from "cors"; 
import { Storage } from "@google-cloud/storage"; // ✅ AJOUT : Import du SDK Google Storage
import multer from "multer";
import compression from "compression";
import { randomUUID } from "crypto"; 
import helmet from "helmet";
import rateLimit from 'express-rate-limit';

// 🗑️ SUPPRESSION : fs, path, url (Inutiles car on ne stocke plus rien en local)

import { cleanCsv } from "./services/cleaner.js";
import { 
    analyzeReport, 
    generateCleanFilenames
} from "./services/reporter.js";

const app = express();

// --- CONFIGURATION STORAGE ---
const storage = new Storage(); // Cloud Run détecte les infos automatiquement
const bucketName = "cleanmycsv-temp-stockage-prod"; // <--- ⚠️ À REMPLIR

// --- SPÉCIFIQUE CLOUD RUN (PROD) ---
app.enable('trust proxy'); 

const allowedOrigins = [
    'https://www.cleanmycsv.fr',
    'https://cleanmycsv.fr',
    'https://cleanmycsv-frontend.vercel.app'
];

app.use(compression());

// 🔥 CONFIGURATION HELMET : SÉCURITÉ MAXIMALE POUR LA PROD
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"], 
            scriptSrc: ["'self'"], 
            styleSrc: ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:"], 
            // ✅ MODIF : On autorise la connexion au storage Google
            connectSrc: ["'self'", "https://storage.googleapis.com"], 
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: [],
        },
    },
    hsts: {
        maxAge: 31536000, 
        includeSubDomains: true,
        preload: true
    }
}));

// Configuration CORS
app.use(cors({ 
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS')); 
        }
    }
}));

// 🗑️ SUPPRESSION : OUTPUTS_DIR, STALE_TIME, mkdirSync (Plus de dossier local)

// CONFIGURATION MULTER (Mémoire uniquement)
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 15 * 1024 * 1024 } 
});

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20, // Max 10 requêtes par IP par minute
    message: { 
        success: false, 
        message: "Vous allez trop vite ! Veuillez attendre une petite minute avant de réessayer." 
    },
    standardHeaders: 'draft-7', // Standard moderne pour les headers
    legacyHeaders: false,
    // ✅ C'est ICI que la magie opère pour nettoyer tes logs :
    // On désactive les validations qui créent les fausses alertes sur Cloud Run
    validate: {
        xForwardedForHeader: false,
        trustProxy: false
    }
});

// --- ROUTES ---

// --- ROUTE DE WARM-UP (RÉVEIL) ---
// Cette route ne fait rien d'autre que répondre "Présent !" pour allumer le serveur.
app.get("/wakeup", (req, res) => {
    res.status(200).json({ status: "ready", message: "Serveur prêt et chaud !" });
});

// 🗑️ SUPPRESSION COMPLÈTE DE LA ROUTE "GET /download/:filename"
// Raison : C'est Google qui va gérer le téléchargement via une URL sécurisée directe.

// ROUTE : Upload et Nettoyage
app.post("/clean-file", limiter, upload.single("csv_file_to_clean"), async (req, res) => {
    try {
        if (!req.file) throw new Error("Aucun fichier n'a été téléversé.");
        
        // 1. On prépare les jolis noms pour l'utilisateur
        const publicNames = generateCleanFilenames(req.file.originalname);
        const fileBuffer = req.file.buffer; 

        // 2. On lance le nettoyage
        // 'result' contient TOUT : le csv propre, le rapport json, et les stats
        const result = await cleanCsv(fileBuffer);

        // Identifiant unique pour ce nettoyage
        const fileId = randomUUID();

        // --- A. GESTION DU CSV (Fichier propre) ---
        const csvBlob = storage.bucket(bucketName).file(`clean-${fileId}.csv`);
        
        // On envoie le CSV dans le bucket
        await csvBlob.save(result.csvContent, { contentType: 'text/csv', resumable: false });

        // On crée le lien de téléchargement pour le CSV
        const [csvUrl] = await csvBlob.getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000, // Lien valide 15 min
            promptSaveAs: publicNames.cleanCsvName // Force le nom "mon-fichier-clean.csv"
        });

        // --- B. GESTION DU RAPPORT JSON (Ce qu'il manquait) ---
        const reportBlob = storage.bucket(bucketName).file(`report-${fileId}.json`);
        
        // On envoie le JSON dans le bucket
        await reportBlob.save(JSON.stringify(result.reportData, null, 2), { 
            contentType: 'application/json', 
            resumable: false 
        });

        // On crée le lien de téléchargement pour le JSON
        const [reportUrl] = await reportBlob.getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000,
            promptSaveAs: publicNames.reportJsonName // Force le nom "mon-fichier-report.json"
        });

        // --- C. GÉNÉRATION DU RÉSUMÉ HUMAIN ---
        // On utilise les données contenues dans 'result'
        const summary = analyzeReport(
            result.reportData, 
            result.originalRowsCount, 
            result.cleanedRowsCount, 
            result.originalColumnCount
        );

        // --- D. RÉPONSE AU FRONTEND ---
        res.json({
            success: true,
            summary: summary,              // Le texte HTML pour ton site
            downloadUrl: csvUrl,           // Le lien pour télécharger le CSV
            downloadName: publicNames.cleanCsvName, // Le nom du fichier CSV
            
            reportDownloadUrl: reportUrl,  // ✅ Le lien pour télécharger le JSON
            reportDownloadName: publicNames.reportJsonName // Le nom du fichier JSON
        });

    } catch (err) {
        console.error("ERREUR /clean-file:", err); 
        if (err.code === 'LIMIT_FILE_SIZE') {
             return res.status(400).json({ success: false, message: "Le fichier est trop volumineux (Max 15Mo)." });
        }
        res.status(500).json({ success: false, message: "Erreur serveur lors du traitement." });
    }
});

const PORT = process.env.PORT || 8080; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur Production lancé sur le port ${PORT}`);
});