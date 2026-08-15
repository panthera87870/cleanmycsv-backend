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
import { Resend } from 'resend';

import { cleanCsv } from "./services/cleaner.js";
import { 
    analyzeReport, 
    generateCleanFilenames
} from "./services/reporter.js";

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const JWT_SECRET = process.env.JWT_SECRET || "une_cle_de_secours";
const SERVER_MESSAGES = {
    fr: {
        no_file: "Aucun fichier fourni.",
        too_large: "Le fichier est trop volumineux pour votre forfait.",
        server_error: "Erreur serveur lors du traitement.",
        cors_error: "Accès interdit par la politique CORS.",
        too_many_requests: "Trop de tentatives de nettoyage. Veuillez patienter 1 minute."
    },
    en: {
        no_file: "No file uploaded.",
        too_large: "File too large for your current plan.",
        server_error: "Server error during processing.",
        cors_error: "Not allowed by CORS policy.",
        too_many_requests: "Too many cleaning attempts. Please wait 1 minute."
    }
};

const ipUsage = new Map();
setInterval(() => ipUsage.clear(), 24 * 60 * 60 * 1000);

// NOUVEAU : Mémoire pour limiter l'utilisation d'un même token Premium
const tokenUsage = new Map();
setInterval(() => tokenUsage.clear(), 24 * 60 * 60 * 1000); // Reset toutes les 24h

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
    allowedHeaders: ['Content-Type', 'X-Warmup-Key', 'x-access-token', 'stripe-signature'],
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
    limits: { fileSize: 100 * 1024 * 1024 }, // Limite maximale absolue
    fileFilter: (req, file, cb) => {
        // Liste blanche (Whitelisting) des types MIME acceptés pour un CSV
        const allowedMimeTypes = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
        
        // Vérification combinée : Type MIME + Extension
        const isValidMime = allowedMimeTypes.includes(file.mimetype);
        const isCsvExtension = file.originalname.toLowerCase().endsWith('.csv');

        if (isValidMime && isCsvExtension) {
            cb(null, true); // On accepte le fichier
        } else {
            cb(new Error("Invalid format. Only valid .csv files are accepted."), false); // On rejette direct
        }
    }
});

const globalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, 
    max: 300, 
    message: "Too many requests global.",
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: { xForwardedForHeader: false, trustProxy: false }
});
app.use(globalLimiter);

const cleaningLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 10, 
    handler: (req, res) => {
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

const identifyUser = (req, res, next) => {
    const token = req.headers['x-access-token']; 
    req.userPlan = 'freemium'; 
    req.tokenData = null; // NOUVEAU : On prépare la variable

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.userPlan = decoded.plan; 
            req.tokenData = decoded; // On sauvegarde tout (plan, email, tokenId)
        } catch (err) {
            console.log("Invalid or expired token");
        }
    }
    next();
};

// --- NOUVEAU : LE WEBHOOK STRIPE ---
// Il DOIT utiliser express.raw pour valider la signature cryptographique de Stripe
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // Validation que la requête vient bien de Stripe
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`❌ Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const sessionData = event.data.object;
        const customerEmail = sessionData.customer_details?.email;

        if (!customerEmail) {
            console.error("❌ Missing email in Stripe session.");
            return res.json({received: true});
        }

        try {
            // NOUVEAU : On interroge Stripe pour obtenir le Price ID exact
            const sessionWithItems = await stripe.checkout.sessions.retrieve(
                sessionData.id,
                { expand: ['line_items'] }
            );

            const priceId = sessionWithItems.line_items.data[0].price.id;

            let plan = 'plan1'; 
            let duration = '24h'; 

            // ⚠️ À FAIRE : Remplace par tes VRAIS Price IDs trouvés sur ton dashboard Stripe (ex: price_1Pxxxxxx)
            const STRIPE_PRICE_24H = 'prod_U1doMMuf58YkaZ'; 
            const STRIPE_PRICE_7D = 'prod_U1iG6iwVtnM1Kv';
            const STRIPE_PRICE_1Y = 'prod_U1iHv7OwTwcoOi';

            if (priceId === STRIPE_PRICE_7D) { 
                plan = 'plan2';
                duration = '7d'; 
            } else if (priceId === STRIPE_PRICE_1Y) { 
                plan = 'plan3';
                duration = '365d'; 
            }

            // NOUVEAU : On ajoute un ID unique et l'email dans le JWT
            const tokenId = randomUUID();
            const token = jwt.sign({ plan, email: customerEmail, tokenId }, JWT_SECRET, { expiresIn: duration });
            const magicLink = `https://cleanmycsv.fr/?token=${token}&plan=${plan}`;

            // Envoi de l'email via Resend
            await resend.emails.send({
                from: 'CleanMyCSV <contact@cleanmycsv.fr>',
                to: customerEmail,
                subject: '🚀 Votre accès CleanMyCSV / Your CleanMyCSV Access',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; text-align: center;">
                        <h2>Merci pour votre achat ! / Thank you for your purchase!</h2>
                        <p>Voici votre lien d'accès personnel. / Here is your personal access link.</p>
                        <div style="margin: 30px 0;">
                            <a href="${magicLink}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Accéder à l'outil / Access Tool</a>
                        </div>
                        <p style="color: #666; font-size: 14px; border-top: 1px solid #eee; padding-top: 20px;">
                            <strong>Gardez cet email précieusement.</strong> Ce lien est votre clé d'accès unique.<br>
                            <strong>Keep this email safe.</strong> This link is your unique access key.
                        </p>
                    </div>
                `
            });
            console.log(`✅ Email successfully sent to ${customerEmail}`);
            
        } catch (error) {
            console.error('❌ Error processing complete session or email:', error);
        }
    }

    // On répond 200 à Stripe pour dire qu'on a bien reçu le message
    res.json({received: true});
});

// --- MODIFIÉ : LA ROUTE DE RETOUR ---
app.get('/verify-payment', async (req, res) => {
    try {
        const { session_id } = req.query;
        if (!session_id) return res.redirect('https://cleanmycsv.fr');

        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (session.payment_status === 'paid') {
            // Le token est géré par le Webhook. Ici on redirige juste vers une page de succès.
            // Ton frontend devra afficher : "Paiement réussi, vérifiez vos emails pour le lien d'accès."
            res.redirect(`https://cleanmycsv.fr/?payment=success_check_email`);
        } else {
            res.redirect(`https://cleanmycsv.fr/?error=payment_failed`);
        }
    } catch (err) {
        console.error("Stripe Error:", err);
        res.redirect(`https://cleanmycsv.fr/?error=server_error`);
    }
});

app.get("/", (req, res) => {
    res.status(200).send("CleanMyCSV Backend is running and secure.");
});

app.get("/wakeup", (req, res) => {
    const key = req.headers['x-warmup-key'];
    if (key === 'warmup_cleanmyCSV_26_!') {
        res.set('Cache-Control', 'no-store'); 
        return res.status(200).send('Ready');
    }
    res.status(403).send("Forbidden");
});

app.post("/clean-file", cleaningLimiter, identifyUser, (req, res, next) => {
    
    const userLang = req.query.lang === 'fr' ? 'fr' : 'en';
    const t = SERVER_MESSAGES[userLang];

    upload.single("csv_file_to_clean")(req, res, function (err) {
        // Interception des erreurs de limite de taille
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: t.too_large });
            }
            return res.status(400).json({ success: false, message: "Uploading Error." });
        } 
        // Interception de l'erreur de ton fileFilter (Mauvais format)
        else if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }
        
        // Tout va bien, on passe à la suite du code
        next();
    });

}, async (req, res) => {

    const userLang = req.query.lang === 'fr' ? 'fr' : 'en';
    const t = SERVER_MESSAGES[userLang];

    try {

        if (!req.file) {
            return res.status(400).json({ success: false, message: t.no_file });
        }

        // --- NOUVEAU : VÉRIFICATION "MAGIC BYTES" BASIQUE ---
        // On scanne les premiers 512 octets à la recherche d'octets nuls (0x00)
        // Un fichier CSV UTF-8 propre ne contient pas d'octets nuls.
        const headerBuffer = req.file.buffer.subarray(0, 512);
        const isBinary = headerBuffer.some(byte => byte === 0);
        
        if (isBinary) {
            return res.status(400).json({ 
                success: false, 
                message: "The file appears to contain non-textual data (binary detected). Operation aborted for security reasons."            });
        }

        let requiresPayment = false;
        let paymentReason = null;

        // --- DÉBUT DE LA MODIFICATION 2 ---
        const ip = req.ip;
        const usage = ipUsage.get(ip) || 0;

        // Définition de tes limites exactes en octets
        const LIMIT_FREE = 5 * 1024 * 1024;   // 5 Mo
        const LIMIT_PLAN1 = 100 * 1024 * 1024;
        const LIMIT_MAX = 100 * 1024 * 1024;  // 100 Mo (Plans 2 et 3)

        // --- NOUVEAU : SÉCURITÉ ANTI-PARTAGE POUR LES PREMIUM ---
        if (req.userPlan !== 'freemium' && req.tokenData && req.tokenData.tokenId) {
            const tId = req.tokenData.tokenId;
            const currentTokenUsage = tokenUsage.get(tId) || 0;
            const MAX_UPLOADS_PER_TOKEN = 300; // Limite généreuse mais qui bloque le partage massif

            if (currentTokenUsage >= MAX_UPLOADS_PER_TOKEN) {
                return res.status(429).json({ 
                    success: false, 
                    message: "Security quota exceeded for this link. Please contact support if this is a mistake."                });
            }
            tokenUsage.set(tId, currentTokenUsage + 1);
        }
        // --- FIN NOUVEAU ---

        if (req.userPlan === 'freemium') {
            if (usage >= 2) {
                requiresPayment = true;
                paymentReason = 'LIMIT_REACHED';
            } else if (req.file.size > LIMIT_FREE) {
                requiresPayment = true;
                paymentReason = 'FILE_TOO_LARGE_FREE'; // Ton frontend pourra dire "Passez au Plan 1"
            } else {
                ipUsage.set(ip, usage + 1);
            }
        } 
        else if (req.userPlan === 'plan1') {
            if (req.file.size > LIMIT_PLAN1) {
                requiresPayment = true;
                paymentReason = 'FILE_TOO_LARGE_PLAN1'; // Ton frontend pourra dire "Passez au Plan 2 ou 3"
            }
        } 
        else if (req.userPlan === 'plan2' || req.userPlan === 'plan3') {
            if (req.file.size > LIMIT_MAX) {
                requiresPayment = true;
                paymentReason = 'FILE_TOO_LARGE_MAX';
            }
        }
        // --- FIN DE LA MODIFICATION 2 ---

        const originalName = req.file.originalname;
        const publicNames = generateCleanFilenames(originalName);
        const uniqueId = randomUUID();
        
        const cleanFileName = `cleaned_${uniqueId}.csv`;
        const reportFileName = `report_${uniqueId}.json`;

        const result = await cleanCsv(req.file.buffer, userLang);

        const summary = analyzeReport(
            result.reportData, 
            result.originalRowsCount, 
            result.cleanedRowsCount, 
            result.originalColumnCount,
            userLang
        );

        if (requiresPayment) {
            return res.status(402).json({ 
                success: false, 
                code: paymentReason, 
                preview: result.preview,
                summary: summary 
            });
        }

        const fileUploadPromise = storage.bucket(bucketName).file(cleanFileName).save(result.csvContent, {
            resumable: false,
            contentType: 'text/csv',
        });

        const reportUploadPromise = storage.bucket(bucketName).file(reportFileName).save(JSON.stringify(result.reportData, null, 2), {
            resumable: false,
            contentType: 'application/json',
        });

        await Promise.all([fileUploadPromise, reportUploadPromise]);

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
        res.status(500).json({ success: false, message: t.server_error });
    }
});

const PORT = process.env.PORT || 8080; 
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});