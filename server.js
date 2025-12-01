import express from "express";
import cors from "cors"; // 1. Import du paquet cors
import multer from "multer";
import fsStandard from "fs"; 
import fs from "fs/promises";

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto"; 

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

app.use(cors({ 
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(null, true); // <--- SOLUTION RAPIDE SI LE DOMAINE FINAL EST LE SEUL ORIGIN ATTENDU
        }
    }
}));

const OUTPUTS_DIR = join(__dirname, "outputs");
const UPLOADS_DIR = join(__dirname, "uploads");
const STALE_TIME_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("outputs")) fs.mkdirSync("outputs");

const upload = multer({ dest: "uploads/" });

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
                console.error(`Erreur cleanup ${filename}:`, cleanupErr);
            }
        });
        
        fileStream.on("error", (err) => {
            console.error("Erreur stream:", err);
            res.status(500).end();
        });

    } catch (err) {
        // Si fs.stat échoue (fichier non trouvé)
        res.status(404).send("Fichier non trouvé ou expiré.");
    }
});

// ROUTE 2: Upload et Nettoyage
app.post("/clean-file", upload.single("csv_file_to_clean"), async (req, res) => {
    let filePath;
    let originalRowsCount = 0;
    let originalColumnCount = 0; // 🛑 AJOUT : Déclaration ici
    const originalFileName = req.file?.originalname; 
    
    let tempCsvFileName;
    let tempReportFileName;

    try {
        if (!req.file) throw new Error("Aucun fichier n'a été téléversé.");
        
        filePath = req.file.path; // Chemin temporaire Multer
        
        // 🛑 SUPPRESSION DU BLOC DE PRE-ANALYSE
        // Le parsing, l'encodage et le comptage initial sont maintenant gérés par cleanCsv.
        /*
        const buffer = await fs.readFile(filePath); // Lecture async
        const encoding = chardet.detect(buffer) || "UTF-8";
        const originalContent = iconv.decode(buffer, encoding);
        const originalParsed = Papa.parse(originalContent, { skipEmptyLines: true });
        originalRowsCount = originalParsed.data.length > 0 ? originalParsed.data.length - 1 : 0; 
        */

        const publicNames = generateCleanFilenames(originalFileName);

        // Noms temporaires (UUID)
        const tempUuid = randomUUID();
        tempCsvFileName = `clean-${tempUuid}.csv`;
        tempReportFileName = `report-${tempUuid}.json`;

        const result = await cleanCsv(
            filePath, 
            tempCsvFileName, 
            tempReportFileName, 
            OUTPUTS_DIR
        );

        const cleanedRowsCount = result.cleaned.length // > 0 ? result.cleaned.length - 1 : 0;
        
        originalRowsCount = result.originalRowsCount; // Lignes totales initiales (avec en-tête)
        originalColumnCount = result.originalColumnCount; // Colonnes initiales

        const tempReportPath = join(OUTPUTS_DIR, tempReportFileName);
        const reportRaw = await fs.readFile(tempReportPath, 'utf-8');
        const reportContent = JSON.parse(reportRaw);

        // Résumé Humain
        const summary = analyzeReport(reportContent, originalRowsCount, cleanedRowsCount, originalColumnCount);

        // Suppression du fichier uploadé en Async
        if (await fs.access(filePath).then(() => true).catch(() => false)) {
            await fs.unlink(filePath);
        }

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
        console.error("ERREUR /clean-file:", err);
        res.status(500).json({ success: false, message: "Erreur serveur : " + err.message });

        // Nettoyage d'urgence (Async)
        try {
            if (filePath) await fs.unlink(filePath).catch(() => {});
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
        console.error("[NETTOYAGE] Erreur:", err);
    }
}

const PORT = process.env.PORT || 8080; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);

    cleanupStaleFiles();
    setInterval(cleanupStaleFiles, CLEANUP_INTERVAL_MS);
});