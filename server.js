import express from "express";
import cors from "cors"; 
import { Storage } from "@google-cloud/storage";
import multer from "multer";
import compression from "compression";
import { randomUUID } from "crypto"; 
import helmet from "helmet";
import rateLimit from 'express-rate-limit';
import Stripe from "stripe";
import jwt from "jsonwebtoken";

import { cleanCsv } from "./services/cleaner.js";
import { 
    analyzeReport, 
    generateCleanFilenames
} from "./services/reporter.js";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET || "une_cle_de_secours";
const SERVER_MESSAGES = {
    fr: {
        no_file: "Aucun fichier fourni.",
        too_large: "Le fichier est trop volumineux (Max 15Mo).",
        server_error: "Erreur serveur lors du traitement.",
        cors_error: "Accès interdit par la politique CORS.",
        too_many_requests: "Trop de tentatives de nettoyage. Veuillez patienter 1 minute."
    },
    en: {
        no_file: "No file uploaded.",
        too_large: "File too large (Max 15MB).",
        server_error: "Server error during processing.",
        cors_error: "Not allowed by CORS policy.",
        too_many_requests: "Too many cleaning attempts. Please wait 1 minute."
    }
};

const storage = new Storage(); 
const bucketName = "cleanmycsv-temp-stockage-prod";

app.enable('trust proxy'); 

const allowedOrigins = [
    'https://www.cleanmycsv.fr',
    'https://cleanmycsv.fr',
    'https://cleanmycsv-frontend.vercel.app',
    'http://localhost:5500', 
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Warmup-Key', 'x-access-token'],
    credentials: true
}));

app.use(compression());

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"], 
            scriptSrc: ["'self'"], 
            styleSrc: ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:"], 
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

const upload = multer({ 
    storage: multer.memoryStorage(), 
    limits: { fileSize: 15 * 1024 * 1024 } 
});

// --- 1. LIMITEUR GLOBAL (SÉCURITÉ DE BASE) ---
// Protège contre le DDOS général, mais laisse naviguer tranquillement
// 300 requêtes par 5 minutes (très large pour charger CSS/JS/Fonts)
const globalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, 
    max: 300, 
    message: "Too many requests global.",
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, trustProxy: false }
});
app.use(globalLimiter);

// --- 2. LIMITEUR STRICT (POUR LE CLEANER) ---
// Protège ton CPU et ton portefeuille.
// 10 nettoyages par minute max par IP.
const cleaningLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 10, 
    handler: (req, res) => {
        // Réponse personnalisée bilingue en cas de blocage
        const userLang = req.query.lang === 'fr' ? 'fr' : 'en';
        res.status(429).json({ 
            success: false, 
            message: SERVER_MESSAGES[userLang].too_many_requests 
        });
    },
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, trustProxy: false }
});

// --- 1. MIDDLEWARE : QUI EST L'UTILISATEUR ? ---
const identifyUser = (req, res, next) => {
    const token = req.headers['x-access-token']; // Le frontend enverra ça
    req.userPlan = 'freemium'; // Par défaut, c'est un gratuit

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.userPlan = decoded.plan; // 'single', '24h', ou 'lifetime'
        } catch (err) {
            console.log("Token invalide (peut-être expiré)");
        }
    }
    next();
};

// --- 2. LIMITEUR POUR LES GRATUITS (FREEMIUM) ---
// Utilise 'express-rate-limit' que vous avez déjà importé
const freemiumLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 heures
    max: 2, // 2 essais par IP par jour
    message: { 
        code: 'LIMIT_REACHED', 
        message: "Freemium limit reached" // Le front traduira ce message
    },
skip: (req) => req.method === 'OPTIONS' || req.userPlan !== 'freemium'
});

// --- 3. ROUTE DE RETOUR STRIPE (C'est ici que la magie opère) ---
app.get('/verify-payment', async (req, res) => {
    try {
        const { session_id } = req.query;
        if (!session_id) return res.redirect('https://cleanmycsv.fr');

        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status === 'paid') {
            let plan = 'single';
            let duration = '2h'; // Par défaut 9€

            // Détection de l'offre selon le montant (en centimes)
            // ATTENTION : Si vous vendez en USD, Stripe renvoie aussi en centimes (2900 pour 29.00)
            const amount = session.amount_total; 

            if (amount >= 2900 && amount < 9000) { // Offre 29€/$
                plan = '24h';
                duration = '24h';
            } else if (amount >= 9900) { // Offre 99€/$
                plan = 'lifetime';
                duration = '36500d'; // 100 ans
            }

            // Création du passe-droit (Token)
            const token = jwt.sign({ plan }, JWT_SECRET, { expiresIn: duration });

            // On renvoie l'utilisateur vers l'accueil avec son passe-droit
            res.redirect(`https://cleanmycsv.fr/?token=${token}&plan=${plan}`);
        } else {
            res.redirect(`https://cleanmycsv.fr/?error=payment_failed`);
        }
    } catch (err) {
        console.error("Erreur Stripe:", err);
        res.redirect(`https://cleanmycsv.fr/?error=server_error`);
    }
});

// --- ROUTES ---

// ROUTE RACINE (évite l'erreur 500 sur /)
app.get("/", (req, res) => {
    res.status(200).send("CleanMyCSV Backend is running and secure.");
});

// ROUTE DE WARM-UP (RÉVEIL)
app.get("/wakeup", (req, res) => {
    const key = req.headers['x-warmup-key'];
    if (key === 'warmup_cleanmyCSV_26_!') {
        res.set('Cache-Control', 'no-store'); // Force le réveil sans cache
        return res.status(200).send('Ready');
    }
    res.status(403).send("Forbidden");
});

// ROUTE : UPLOAD ET NETTOYAGE
app.post("/clean-file", cleaningLimiter, identifyUser, freemiumLimiter, upload.single("csv_file_to_clean"), async (req, res) => {
    
    const userLang = req.query.lang === 'fr' ? 'fr' : 'en';
    const t = SERVER_MESSAGES[userLang];

    try {

        if (!req.file) {
            return res.status(400).json({ success: false, message: t.no_file });
        }

        // VERIFICATION TAILLE FICHIER POUR LES GRATUITS
        // Si c'est un gratuit et que le fichier fait + de 2Mo
        if (req.userPlan === 'freemium' && req.file.size > 2 * 1024 * 1024) {
            return res.status(400).json({ success: false, code: 'FILE_TOO_LARGE_FREE' });
        }

        const originalName = req.file.originalname;
        const publicNames = generateCleanFilenames(originalName);
        const uniqueId = randomUUID();
        
        const cleanFileName = `cleaned_${uniqueId}.csv`;
        const reportFileName = `report_${uniqueId}.json`;

        // A. NETTOYAGE (En mémoire)
        const result = await cleanCsv(req.file.buffer, userLang);

        // B. UPLOAD VERS G-CLOUD (En parallèle)
        const fileUploadPromise = storage.bucket(bucketName).file(cleanFileName).save(result.csvContent, {
            resumable: false,
            contentType: 'text/csv',
        });

        const reportUploadPromise = storage.bucket(bucketName).file(reportFileName).save(JSON.stringify(result.reportData, null, 2), {
            resumable: false,
            contentType: 'application/json',
        });

        await Promise.all([fileUploadPromise, reportUploadPromise]);

        // C. URL Signées
        const [csvUrl] = await storage.bucket(bucketName).file(cleanFileName).getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000,
            promptSaveAs: publicNames.cleanCsvName
        });

        const [reportUrl] = await storage.bucket(bucketName).file(reportFileName).getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000,
            promptSaveAs: publicNames.reportJsonName
        });

        // D. GÉNÉRATION DU RÉSUMÉ
        const summary = analyzeReport(
            result.reportData, 
            result.originalRowsCount, 
            result.cleanedRowsCount, 
            result.originalColumnCount,
            userLang
        );

        // E. RÉPONSE
        res.json({
            success: true,
            summary: summary,
            preview: result.preview,
            downloadUrl: csvUrl,
            downloadName: publicNames.cleanCsvName,
            reportDownloadUrl: reportUrl,
            reportDownloadName: publicNames.reportJsonName
        });

    } catch (err) {
        console.error("ERREUR /clean-file:", err); 
        
        // Gestion fine des erreurs avec traduction
        if (err.code === 'LIMIT_FILE_SIZE') {
             return res.status(400).json({ success: false, message: t.too_large });
        }
        
        // Erreur générique
        res.status(500).json({ success: false, message: t.server_error });
    }
});

const PORT = process.env.PORT || 8080; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});