import express from "express";
import cors from "cors"; 
import multer from "multer";
import fsStandard from "fs"; 
import fs from "fs/promises";

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto"; 
import helmet from "helmet"; 

import { cleanCsv } from "./services/cleaner.js";
import { 
    analyzeReport, 
    generateCleanFilenames
} from "./services/reporter.js";

const app = express();
const __dirname = dirname(fileURLToPath(import.meta.url));

// --- SPÉCIFIQUE CLOUD RUN (PROD) ---
// Indispensable car Cloud Run gère le SSL (HTTPS) via un Load Balancer.
// Sans ça, Express pense qu'il est en HTTP et HSTS ne fonctionne pas.
app.enable('trust proxy'); 

const allowedOrigins = [
    'https://www.cleanmycsv.fr',
    'https://cleanmycsv.fr',
    'https://cleanmycsv-frontend.vercel.app'
];

// 🔥 CONFIGURATION HELMET : SÉCURITÉ MAXIMALE POUR LA PROD
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"], 
            
            // Scripts : Uniquement tes fichiers JS locaux
            scriptSrc: ["'self'"], 
            
            // Styles : Ton CSS + Google Fonts + FontAwesome CDN
            styleSrc: [
                "'self'", 
                "https://fonts.googleapis.com",
                "https://cdnjs.cloudflare.com" 
            ],
            
            // Polices : Google Fonts + FontAwesome CDN
            fontSrc: [
                "'self'", 
                "https://fonts.gstatic.com",
                "https://cdnjs.cloudflare.com"
            ],
            
            // Images : Tes images locales + images base64 (data:)
            imgSrc: ["'self'", "data:"], 
            
            // Connexions AJAX : Uniquement vers ton serveur
            connectSrc: ["'self'"], 
            
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: [],
        },
    },
    // 🔥 HSTS ACTIVÉ EN PROD (Force le HTTPS pendant 1 an)
    hsts: {
        maxAge: 31536000, 
        includeSubDomains: true,
        preload: true
    }
}));

// Configuration CORS (On garde ta config de prod)
app.use(cors({ 
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS')); 
        }
    }
}));

const OUTPUTS_DIR = join(__dirname, "outputs");
const STALE_TIME_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

if (!fsStandard.existsSync(OUTPUTS_DIR)) fsStandard.mkdirSync(OUTPUTS_DIR);

// CONFIGURATION MULTER SÉCURISÉE
const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 50 * 1024 * 1024 } 
});

// --- ROUTES ---

// ROUTE 1: Téléchargement 
app.get("/download/:filename", async (req, res) => { 
    const filename = req.params.filename;
    
    if (filename.includes("..")) return res.status(400).send("Nom de fichier invalide.");
    const filePath = join(OUTPUTS_DIR, filename);

    try {
        await fs.stat(filePath); 

        const isCsv = filename.endsWith('.csv'); 
        const publicDownloadName = req.query.publicName || filename;

        res.setHeader("Content-Disposition", `attachment; filename="${publicDownloadName}"`);
        res.setHeader("Content-Type", isCsv ? "text/csv" : "application/json");

        const fileStream = fsStandard.createReadStream(filePath);
        fileStream.pipe(res);
        fileStream.on("close", async () => {
            try { await fs.unlink(filePath); } catch (cleanupErr) { console.error(`Erreur cleanup ${filename}:`, cleanupErr.message); }
        });
        
        fileStream.on("error", (err) => { res.status(500).end(); });

    } catch (err) {
        res.status(404).send("Fichier non trouvé ou expiré.");
    }
});

// ROUTE 2: Upload et Nettoyage
app.post("/clean-file", upload.single("csv_file_to_clean"), async (req, res) => {
    let originalRowsCount = 0;
    let originalColumnCount = 0;
    const originalFileName = req.file?.originalname; 
    
    let tempCsvFileName;
    let tempReportFileName;

    try {
        if (!req.file) throw new Error("Aucun fichier n'a été téléversé.");
        
        const fileBuffer = req.file.buffer; 
        const publicNames = generateCleanFilenames(originalFileName);

        const tempUuid = randomUUID();
        tempCsvFileName = `clean-${tempUuid}.csv`;
        tempReportFileName = `report-${tempUuid}.json`;

        const result = await cleanCsv(fileBuffer, tempCsvFileName, tempReportFileName, OUTPUTS_DIR);

        req.file.buffer = null; 

        originalRowsCount = result.originalRowsCount; 
        originalColumnCount = result.originalColumnCount; 

        const tempReportPath = join(OUTPUTS_DIR, tempReportFileName);
        const reportRaw = await fs.readFile(tempReportPath, 'utf-8');
        const summary = analyzeReport(JSON.parse(reportRaw), originalRowsCount, result.cleaned.length, originalColumnCount);

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

        if (err.code === 'LIMIT_FILE_SIZE') {
             return res.status(400).json({ success: false, message: "Le fichier est trop volumineux (Max 50Mo)." });
        }
        res.status(500).json({ success: false, message: "Erreur serveur." });

        try {
            if (tempCsvFileName) await fs.unlink(join(OUTPUTS_DIR, tempCsvFileName)).catch(() => {});
            if (tempReportFileName) await fs.unlink(join(OUTPUTS_DIR, tempReportFileName)).catch(() => {});
        } catch (e) { /* ignore */ }
    }
});

// --- TÂCHE DE FOND (NETTOYAGE) ---
async function cleanupStaleFiles() {
    try {
        const files = await fs.readdir(OUTPUTS_DIR);
        const now = Date.now();
        for (const file of files) {
            if (file.startsWith('.')) continue;
            const filePath = join(OUTPUTS_DIR, file);
            try {
                const stats = await fs.stat(filePath); 
                if ((now - stats.mtimeMs) > STALE_TIME_MS) {
                    await fs.unlink(filePath); 
                    console.log(`[NETTOYAGE] Supprimé : ${file}`);
                }
            } catch (e) { }
        }
    } catch (err) { console.error("[NETTOYAGE] Erreur:", err.message); }
}

// PORT POUR CLOUD RUN (8080)
const PORT = process.env.PORT || 8080; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur Production lancé sur le port ${PORT}`);
    cleanupStaleFiles();
    setInterval(cleanupStaleFiles, CLEANUP_INTERVAL_MS);
});