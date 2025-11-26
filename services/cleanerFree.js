import { cleanCsv } from "./cleanerBase.js";
import fs from "fs";

/**
 * Plan gratuit
 * - Nettoyage complet
 * - Fichiers max 1 Mo
 * - Limité à 1 export / semaine (à gérer dans server.js)
 */
export async function cleanFree(filePath) {
  // Vérification taille (1 Mo max)
  const stats = fs.statSync(filePath);
  if (stats.size > 1 * 1024 * 1024) {
    throw new Error("Fichier trop volumineux pour le plan gratuit (1 Mo max).");
  }

  const result = cleanCsv(filePath, "free");

  return {
    ...result,
    note: "Plan Gratuit : nettoyage complet, limite 1 Mo et 1 fichier/semaine."
  };
}
